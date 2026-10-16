import { spawn as nodeSpawn } from 'child_process';
import { WebSocket } from 'ws';
import {
  Session,
  createSession,
  type ConversationCompaction,
  type ConversationFork,
  type RunView,
  type SessionMessage,
  type SessionNotice,
  type SessionRuntimeSettings,
  ModelResolver,
  RunnerRegistry,
  removedPluginNotice,
  RunnerInstallation,
  listSessions,
  loadSession,
  deleteSession,
  SettingsService,
  sessionRuntimeSettings,
  type GlobalRunSettings,
  type PlanState,
  type LegacyPlanState,
  migratePlanState,
  type RunnerId,
  type DiscoveredModel,
  type ModelsResponse,
  type RunnersResponse,
  type SettingsResponse,
  type SettingsUpdateResponse,
  SessionNotFoundError,
  runnerModesFrom,
  configuredProviders,
  assertWorkspaceExists,
  assertWorkspaceIsProject,
  WorkspaceNotAProjectError,
  ensureStateDirIgnored,
  runnerForProvider,
  PlannerModelMemory,
  selectPlanner,
  admitSettingsEnv,
  PROVIDER_CREDENTIAL_ENV,
  type PlannerBackendId,
  type PlannerModelCandidate,
  type PlannerSelectionChange,
  type PlannerSelectionState,
  StructuredRunner,
  CodexSandboxAvailability,
  detectInstalledPlanner,
  installedPlannerAnswered,
  installedPlannerDetected,
  PlannerTurnDiscardedError,
} from '@ordewell/core';
import { WebConfig } from '../adapters/WebConfig';
import { scanWorkspaces as scanWorkspacesImpl } from '../utils/workspaceScanner';
import { PoolFileSystem } from '../adapters/PoolFileSystem';
import { PoolAwareRunner } from '../adapters/PoolAwareRunner';
import type { ApprovalAnswer, RunnerRegistry as CoreRunnerRegistry, IRunner } from '@ordewell/core';

/** A fork the pool has adopted: addressable at once, its plan read back from the file it was written to. */
export interface AdoptedFork {
  sessionId: string;
  goal: string;
  plan: LegacyPlanState;
}

export interface OrchestratorPoolDeps {
  /**
   * Where every plan's tasks run (ADR-0018), shared across sessions behind
   * each plan's `PoolAwareRunner`. Defaulted to a real one; tests inject a fake.
   */
  runner?: IRunner;
  /**
   * Overrides the pool's own `ModelResolver`. Left undefined, behavior is
   * unchanged; tests inject one built with fake exec/fetch impls so a
   * planner-switch catalog lookup can be seeded without spawning real CLIs.
   */
  modelResolver?: ModelResolver;
  /** Overrides the pool's Codex sandbox probe; tests inject one so no real `codex` is started. */
  codexSandbox?: Pick<CodexSandboxAvailability, 'ensure' | 'refresh'>;
  /** Overrides the pool's installation checks; tests inject one so no real agent binary is asked. */
  runnerInstallation?: Pick<RunnerInstallation, 'filterInstalled' | 'plannerUsability'>;
}

interface PendingStart { stopped: boolean }

export class OrchestratorPool {
  private sessions = new Map<string, Session>();
  /** Starts waiting on the installed-planner probe, by the session they would run in. */
  private pendingStarts = new WeakMap<Session, Set<PendingStart>>();
  private clients = new Map<string, Set<WebSocket>>();
  private registry: CoreRunnerRegistry = new RunnerRegistry();
  private modelResolver: ModelResolver;
  private runnerInstallation: Pick<RunnerInstallation, 'filterInstalled' | 'plannerUsability'>;
  private cachedProviderLists: Record<string, string[]> | undefined;
  private settingsService = new SettingsService();
  private plannerModelMemory = new PlannerModelMemory(this.settingsService);
  private runner: IRunner;
  /** One probe per daemon, asked again whenever the runner list is refreshed (ADR-0033). */
  private codexSandbox: Pick<CodexSandboxAvailability, 'ensure' | 'refresh'>;

  constructor(deps: OrchestratorPoolDeps = {}) {
    const pluginNotice = removedPluginNotice();
    if (pluginNotice) console.warn(pluginNotice);
    this.runner = deps.runner ?? new StructuredRunner();
    this.runnerInstallation = deps.runnerInstallation ?? new RunnerInstallation(this.registry);
    this.modelResolver = deps.modelResolver ?? new ModelResolver(this.registry, new WebConfig());
    this.codexSandbox = deps.codexSandbox
      ?? new CodexSandboxAvailability(this.registry, { spawn: nodeSpawn, fetch: globalThis.fetch }, { cwd: process.cwd(), env: process.env });
  }

  /**
   * Not awaited: planning must start at once, and the daemon already warms the
   * probe at startup through the catalog. This only covers a daemon that was
   * asked to plan before that finished.
   */
  private warmCodexSandbox(): void {
    this.codexSandbox.ensure().catch((err) => console.error(`[web] codex sandbox probe failed: ${err instanceof Error ? err.message : err}`));
  }

  /**
   * Find the coding agent that plans when the user has chosen no planner and
   * set no vendor key (ADR-0009), for the daemon to start as it starts. Every
   * planner turn waits on it, so a goal typed the instant the TUI opens
   * does not plan with an openrouter key nobody set.
   */
  detectInstalledPlanner(): Promise<PlannerBackendId | null> {
    return detectInstalledPlanner(this.runnerInstallation);
  }

  /**
   * Wait for that probe before a new session's first planner turn, which is
   * judged here, ahead of the session it replaces going. A session closed or
   * replaced meanwhile must not start one: no client would hear it, and
   * nothing is left to stop it. Every later turn passes the session's own gate.
   */
  private async plannerTurnMayStart(sessionId: string, session: Session): Promise<void> {
    // Stop has no turn to abort while the probe is out, so the wait itself is
    // what it cancels: otherwise the goal the user stopped starts anyway.
    const wait: PendingStart = { stopped: false };
    let waits = this.pendingStarts.get(session);
    if (!waits) this.pendingStarts.set(session, (waits = new Set()));
    waits.add(wait);
    try {
      await installedPlannerDetected();
    } finally {
      waits.delete(wait);
      if (waits.size === 0) this.pendingStarts.delete(session);
    }
    if (wait.stopped || this.sessions.get(sessionId) !== session) throw new PlannerTurnDiscardedError();
  }

  subscribe(sessionId: string, ws: WebSocket): void {
    if (!this.clients.has(sessionId)) this.clients.set(sessionId, new Set());
    this.clients.get(sessionId)!.add(ws);
  }

  unsubscribe(sessionId: string, ws: WebSocket): void {
    this.clients.get(sessionId)?.delete(ws);
    if (this.clients.get(sessionId)?.size === 0) this.clients.delete(sessionId);
  }

  private broadcast(sessionId: string, msg: SessionMessage | SessionNotice): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.clients.get(sessionId) ?? []) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  hasSession(sessionId: string): boolean { return this.sessions.has(sessionId); }

  /** Answer an approval prompt, the planner's or a task runner's. False means the id was unknown or already settled. */
  resolveApproval(sessionId: string, approvalId: string, answer: ApprovalAnswer): boolean {
    return this.sessions.get(sessionId)?.resolveApproval(approvalId, answer) ?? false;
  }

  outstandingApprovals(sessionId: string) {
    return this.sessions.get(sessionId)?.outstandingApprovals() ?? [];
  }

  approvedScopes(sessionId: string): string[] {
    return this.sessions.get(sessionId)?.approvedScopes() ?? [];
  }
  isExecuting(sessionId: string): boolean { return this.sessions.get(sessionId)?.isExecuting ?? false; }
  getPlan(sessionId: string): LegacyPlanState | null { return this.sessions.get(sessionId)?.planState ?? null; }
  /**
   * The plan of a session this process is holding, straight from its store —
   * null for an id the pool never adopted. Reading it through the saved file
   * instead answers as if nothing were running.
   */
  getPlanState(sessionId: string): PlanState | null {
    return this.sessions.get(sessionId)?.currentPlanState ?? null;
  }
  getGoal(sessionId: string): string { return this.sessions.get(sessionId)?.currentGoal ?? ''; }
  /** Null for a session this process is not holding: there is no run to describe. */
  runSnapshot(sessionId: string): RunView | null { return this.sessions.get(sessionId)?.runSnapshot() ?? null; }

  private runtimeSettings(): SessionRuntimeSettings {
    return sessionRuntimeSettings(this.settingsService.getAll());
  }

  private createSessionFor(sessionId: string, workspace: string, modelOverride?: string, options: { allowInit?: boolean } = {}): Session {
    // Rejected here rather than left to the planner: a non-existent workspace
    // otherwise reaches the harness adapter's `spawn` as an ENOENT that reads
    // as a missing agent binary, not a missing directory.
    assertWorkspaceExists(workspace);
    // Rejected here too: without a project marker, the filesystem root or an
    // arbitrary system directory becomes the confinement boundary for every
    // read, search and permitted command the planner runs. `allowInit` only
    // ever arrives here on the retry of a call the user already saw and
    // explicitly confirmed (the TUI's "initialize this as a new workspace?"
    // prompt) — never as a default, so an unmarked directory is still never
    // admitted silently.
    try {
      assertWorkspaceIsProject(workspace);
    } catch (err) {
      if (!(err instanceof WorkspaceNotAProjectError) || !options.allowInit) throw err;
      ensureStateDirIgnored(workspace);
      assertWorkspaceIsProject(workspace);
    }
    const config = this.plannerConfig(modelOverride);
    const fsAdapter = new PoolFileSystem(workspace);
    const broadcast = (msg: SessionMessage) => this.broadcast(sessionId, msg);
    const runner = new PoolAwareRunner(sessionId, broadcast, this.runner);
    return createSession({
      config,
      notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
      runner,
      registry: this.registry,
      workspaceRoot: () => workspace,
      fsAdapter,
      broadcast,
      // The notification channel above is silent here; this is how a client hears how the run isolates.
      onNotice: (notice) => this.broadcast(sessionId, notice),
      modelResolver: this.modelResolver,
      settings: () => this.runtimeSettings(),
      sessionId,
    });
  }

  /**
   * The one way the pool builds a config that answers "who plans": sessions,
   * the settings response and the switch judgement all route through it, so
   * what the settings route reports is what the next turn plans with. The
   * lists are handed over as a reader, not a snapshot, so a credential change
   * reaches a session that is already open.
   */
  private plannerConfig(modelOverride?: string): WebConfig {
    return new WebConfig({
      enabledRunners: this.enabledRunnerOverride(),
      modelOverride,
      providerModelLists: () => this.cachedProviderLists,
    });
  }

  /**
   * The user's runner choice, or undefined when they have never made one —
   * which is what lets `WebConfig` fall back to the environment's defaults.
   * Read per call rather than cached: the settings file is shared with the
   * VS Code extension host, and `getAll()` already invalidates on mtime.
   */
  private enabledRunnerOverride(): string[] | undefined {
    return this.settingsService.getEnabledRunners();
  }

  /**
   * Persisted, not held in memory: the daemon dies with the TUI, and a
   * process-local override meant every reopen silently reinstated the
   * environment's defaults over what the user had chosen.
   */
  setRunnerEnabled(id: string, enabled: boolean): void {
    const current = this.enabledRunnerOverride() ?? new WebConfig().enabledRunners;
    const next = enabled
      ? (current.includes(id) ? current : [...current, id])
      : current.filter((r) => r !== id);
    this.settingsService.setEnabledRunners(next);
  }

  getSettings(): SettingsResponse {
    const config = this.plannerConfig();
    const userSettings = this.settingsService.getAll();
    return {
      orchestratorModel: config.orchestratorModel,
      // Who plans (ADR-0009) — a vendor id, or one of the three harness
      // planners. Surfaces need it to render the planner picker and to know
      // whether the planner model comes from a runner catalog or a vendor one.
      aiProvider: config.aiProvider,
      // A harness planner's thinking effort (ADR-0009). Surfaces need it back
      // to render the current level; without it the picker shows "default"
      // for a planner that is running at "high".
      plannerThinkingEffort: config.plannerThinkingEffort ?? '',
      maxParallel: config.maxParallelSessions,
      modelAllowlist: userSettings.modelAllowlist,
      // The model remembered per planner backend (this task), so a surface can
      // render what's remembered without a second round-trip.
      plannerModels: userSettings.plannerModels,
      run: this.settingsService.getRunSettings(),
    };
  }

  /**
   * Save the user's run settings, and apply them at once to `sessionId`'s run
   * when that session is open here (ADR-0030). Other sessions' runs keep
   * theirs. Throws a {@link RunSettingsError}, saving nothing, for a value
   * out of range.
   */
  updateRunSettings(changes: Partial<GlobalRunSettings>, sessionId?: string): SettingsResponse {
    this.settingsService.updateRunSettings(changes);
    if (sessionId) this.sessions.get(sessionId)?.applyRunSettings(changes);
    return this.getSettings();
  }

  /**
   * The catalog `selectPlanner` should judge `provider`'s
   * remembered model against — a harness planner's own runner catalog, or the
   * cross-provider picker list for a vendor (ADR-0009), same split as
   * `plannerModelItems` in the TUI reducer. Read from whatever the resolver
   * has already cached so this stays synchronous; a cold cache degrades to an
   * empty catalog rather than kicking off discovery mid-settings-write.
   */
  private plannerCatalogFor(provider: PlannerBackendId): PlannerModelCandidate[] {
    const runner = runnerForProvider(provider);
    if (runner) {
      return this.modelResolver.getCachedRunnerModels(runner).map((m) => ({ id: m.modelId, variants: m.variants }));
    }
    return this.modelResolver.getCachedPickerOptions().map((o) => ({ id: o.id }));
  }

  /**
   * The provider planning right now. A vendor planner is resolved from its
   * model id, so this is read again after a write rather than carried over.
   */
  private plannerProviderInEffect(): PlannerBackendId {
    return this.plannerConfig().aiProvider;
  }

  updateSettings(changes: Record<string, unknown>): SettingsUpdateResponse {
    // Read before any of this call's changes land, so a switch is judged
    // against what was actually in effect a moment ago.
    const current: PlannerSelectionState = {
      provider: this.plannerProviderInEffect(),
      model: process.env.ORCHESTRATOR_MODEL ?? '',
      effort: process.env.ORDEWELL_PLANNER_EFFORT ?? '',
    };

    // Only allowlisted keys reach `process.env`, and everything else comes back
    // to the caller by name — the daemon's environment is inherited by every
    // runner it spawns, so this write is the whole of `admitSettingsEnv`'s
    // reason to exist. All downstream reads below use `envChanges`, which is
    // the admitted subset, never the raw body.
    const rawEnv = changes.env && typeof changes.env === 'object' && !Array.isArray(changes.env)
      ? (changes.env as Record<string, unknown>)
      : undefined;
    const admission = rawEnv ? admitSettingsEnv(rawEnv) : undefined;
    const envChanges = admission ? admission.accepted : undefined;

    // A pick arrives either as a top-level field (a vendor model, `ordewell
    // model set`) or through env (`ordewell planner-effort`, the TUI's
    // pickers); env wins, as it did when both were written in that order. The
    // provider is the name the client sent, never re-derived from the model: a
    // switch may have just cleared that model.
    const plannerChange: PlannerSelectionChange = {
      provider: envChanges?.AI_PROVIDER,
      model: envChanges?.ORCHESTRATOR_MODEL ?? stringField(changes.orchestratorModel),
      effort: envChanges?.ORDEWELL_PLANNER_EFFORT ?? stringField(changes.plannerThinkingEffort),
    };
    const touchesPlanner = Object.values(plannerChange).some((v) => v !== undefined);
    // Judged against the incoming provider's catalog as already discovered —
    // before the credential refresh below clears the resolver's cache — so a
    // settings write never waits on (async) discovery.
    const selection = touchesPlanner
      ? selectPlanner(current, plannerChange, this.plannerModelMemory, this.plannerCatalogFor(plannerChange.provider ?? current.provider))
      : undefined;

    if (envChanges) {
      let touched = false;
      for (const [key, value] of Object.entries(envChanges)) {
        process.env[key] = value;
        // Only a credential or endpoint change touches what a catalog
        // contains. A planner, model or effort pick does not, and invalidating
        // on one would wipe the very cache `plannerCatalogFor` reads
        // synchronously, right before the next call's switch needs it.
        if (PROVIDER_CREDENTIAL_ENV.has(key)) touched = true;
      }
      // The scheduler reads the limit on every tick, but a raised one would
      // only be seen at the next verdict; the runs waiting for a slot start now.
      if (envChanges.ORDEWELL_MAX_PARALLEL !== undefined) {
        for (const [id, session] of this.sessions) {
          session.reschedule().catch((err) => {
            console.error(`[web] reschedule failed for session ${id}: ${err instanceof Error ? err.message : err}`);
          });
        }
      }
      // A new/changed provider key or base URL must re-probe the catalog;
      // without this the picker keeps serving the pre-key cache until restart.
      if (touched) {
        this.modelResolver.invalidate();
        this.modelResolver.refreshRunnerModels();
        this.dropUnkeyedProviderLists();
      }
    }

    if (selection) {
      process.env.ORCHESTRATOR_MODEL = selection.next.model;
      process.env.ORDEWELL_PLANNER_EFFORT = selection.next.effort;
    }

    if (changes.modelAllowlist && typeof changes.modelAllowlist === 'object') {
      const allowlist = changes.modelAllowlist as Record<string, unknown>;
      for (const [runner, ids] of Object.entries(allowlist)) {
        if (Array.isArray(ids)) {
          this.settingsService.setModelAllowlist(runner, ids.map(String));
        } else if (ids === null) {
          this.settingsService.setModelAllowlist(runner, undefined);
        }
      }
    }

    if (selection?.remember) {
      const { provider, model, effort } = selection.remember;
      // Without a switch a vendor pick is keyed by the provider its model id
      // resolves to now, which the env written above already reflects.
      const switched = provider !== current.provider;
      this.plannerModelMemory.remember(switched ? provider : this.plannerProviderInEffect(), model, effort);
    }

    // Refused keys are named back rather than dropped: a client that sent one
    // wrote it to `.env` on the strength of this response, and would otherwise
    // reinstate the refusal as the next daemon's startup environment.
    const rejectedEnvKeys = admission?.rejected ?? [];
    const settings: SettingsUpdateResponse = this.getSettings();
    if (rejectedEnvKeys.length > 0) settings.rejectedEnvKeys = rejectedEnvKeys;
    if (selection?.recall) settings.switchRecall = selection.recall;
    return settings;
  }

  /**
   * A vendor whose credential is gone keeps no list to route a model to it,
   * or the next turn would be sent to a planner the settings response no
   * longer names. Pruned rather than cleared: the vendors that still hold a
   * key keep routing their models until the catalog is discovered again, so
   * adding a second key does not move the planner off the first.
   */
  private dropUnkeyedProviderLists(): void {
    if (!this.cachedProviderLists) return;
    const keyed = new Set<string>(configuredProviders(new WebConfig()));
    this.cachedProviderLists = Object.fromEntries(
      Object.entries(this.cachedProviderLists).filter(([provider]) => keyed.has(provider)),
    );
  }

  setOrchestratorModel(model: string): string {
    process.env.ORCHESTRATOR_MODEL = model;
    return model;
  }

  async getProviderModels(): Promise<ModelsResponse> {
    const config = new WebConfig();

    const runnerIds = this.registry.list().map((p) => p.manifest.name);
    const [runnerModels, providerLists] = await Promise.all([
      this.modelResolver.modelsForRunners(runnerIds),
      this.modelResolver.refresh(),
      this.codexSandbox.ensure(),
    ]);

    // `refresh()` populates the picker cache, so this is the same fetch — no
    // second network round-trip. Errors are whatever that fetch recorded.
    const orchestratorModels = await this.modelResolver.pickerOptions();
    const providerErrors = this.modelResolver.getDiscoveryErrors();

    this.cachedProviderLists = providerLists;

    const allModels: DiscoveredModel[] = [];
    const seen = new Set<string>();
    const modelsByRunner: Record<string, DiscoveredModel[]> = {};

    for (const id of runnerIds) {
      modelsByRunner[id] = runnerModels[id] ?? [];
      for (const m of modelsByRunner[id]) {
        if (!seen.has(m.modelId)) {
          seen.add(m.modelId);
          allModels.push(m);
        }
      }
    }

    const providers = configuredProviders(config);

    return {
      models: allModels,
      modelsByRunner,
      modesByRunner: runnerModesFrom(this.registry, runnerIds),
      orchestratorModel: process.env.ORCHESTRATOR_MODEL || '',
      providers,
      orchestratorModels,
      providerErrors,
    };
  }

  getRunnerState(): { enabledRunners: RunnerId[]; orchestratorModel: string } {
    const config = new WebConfig({ enabledRunners: this.enabledRunnerOverride() });
    return { enabledRunners: config.enabledRunners, orchestratorModel: config.orchestratorModel };
  }

  /**
   * Runners whose CLI is actually installed on the host, with display name and
   * enabled state. Only these should be offered for selection — an uninstalled
   * runner can't be spawned.
   */
  async getInstalledRunners(): Promise<RunnersResponse['runners']> {
    const config = new WebConfig({ enabledRunners: this.enabledRunnerOverride() });
    const enabled = new Set(config.enabledRunners);
    // The runner list is the one place a user who just fixed their host looks
    // again, so it is where the cached answer is asked afresh.
    await this.codexSandbox.refresh();
    const runners = this.registry.list();
    const installedIds = new Set(
      await this.runnerInstallation.filterInstalled(runners.map((p) => p.manifest.name)),
    );
    return runners
      .filter((p) => installedIds.has(p.manifest.name))
      .map((p) => ({
        id: p.manifest.name,
        name: p.manifest.displayName,
        enabled: enabled.has(p.manifest.name),
      }));
  }

  async generatePlan(sessionId: string, goal: string, runners: RunnerId[], workspace: string, modelOverride?: string, options?: { allowInit?: boolean }): Promise<PlanState> {
    const session = await this.openPlanningSession(sessionId, workspace, modelOverride, options);
    return migratePlanState(await session.generatePlan(goal, runners));
  }

  /**
   * Build the session a new planning conversation runs in, register it in
   * place of any live one, and return once its first planner turn may start.
   */
  private async openPlanningSession(sessionId: string, workspace: string, modelOverride?: string, options?: { allowInit?: boolean }): Promise<Session> {
    const session = this.createSessionFor(sessionId, workspace, modelOverride, options);
    // Judged on the new session's config (which carries the request's model)
    // and before the old session is destroyed, so a refusal leaves it alone.
    // Not while the installed-planner probe is out: its answer can be the
    // planner, and judging the openrouter fallback now would refuse the very
    // keyless first run the probe exists for, so that judgement waits below.
    const judgedNow = installedPlannerAnswered();
    if (judgedNow) session.assertPlannerReady();
    // After the new session is built, so a refusal above leaves the live one
    // alone; before the set, so its runners and planner turn stop broadcasting.
    this.destroy(sessionId);
    // Registered before the blocking call, not after: research inside
    // the first planner turn can raise an approval and await the answer, and
    // that answer arrives over POST /api/approvals/:sessionId — which 404s
    // until the session is in this map. Registering only on return made the
    // first approval of every session unanswerable until its 5-minute timeout.
    this.sessions.set(sessionId, session);
    this.warmCodexSandbox();
    await this.plannerTurnMayStart(sessionId, session);
    if (!judgedNow) {
      try {
        session.assertPlannerReady();
      } catch (err) {
        // A refused session is never left addressable, as when judged above.
        this.destroy(sessionId);
        throw err;
      }
    }
    return session;
  }

  /**
   * Conversational planning (ADR-0002): start the planner dialogue for a
   * session. Returns the current plan state — a committed plan when the
   * planner had enough context, otherwise the dialogue so far (last
   * assistant message lives in conversationHistory).
   */
  async startPlanning(sessionId: string, goal: string, runners: RunnerId[], workspace: string, modelOverride?: string, options?: { allowInit?: boolean }): Promise<LegacyPlanState> {
    const session = await this.openPlanningSession(sessionId, workspace, modelOverride, options);
    return session.startPlanning(goal, runners);
  }

  /**
   * Continue the planner dialogue with the user's reply; refused while a
   * planner turn is in flight. The session's own planner gate waits for the
   * installed-planner probe and judges the planner, as it does for every turn.
   */
  async continuePlanning(sessionId: string, message: string): Promise<LegacyPlanState> {
    return this.session(sessionId).continueConversation(message);
  }

  /** Condense a session's conversation. The summary turn is a planner turn, so `cancelPlanning` stops it. */
  async compactConversation(sessionId: string): Promise<ConversationCompaction & { plan: LegacyPlanState }> {
    const session = this.session(sessionId);
    const compaction = await session.compactConversation();
    return { ...compaction, plan: session.planState! };
  }

  /**
   * Abort the planner turn in flight for a session, if any. Answers whether
   * there was one to cancel — the route reports that rather than 404ing a
   * session that simply is not planning right now.
   */
  cancelPlanning(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    // Keyed by session, not id: a goal sent after the Stop replaces the
    // session under the same id and its own wait must not be cancelled.
    let cancelledWait = false;
    for (const wait of this.pendingStarts.get(session) ?? []) {
      if (!wait.stopped) cancelledWait = true;
      wait.stopped = true;
    }
    // Both run: a turn can be in flight while a later one is still waiting.
    const aborted = session.abortPlannerTurn();
    return aborted || cancelledWait;
  }

  /**
   * Register a session persisted on disk so its plan becomes executable and
   * editable. Only sessions planned in this process are otherwise addressable,
   * which left a restored plan readable but inert — every task endpoint
   * answered "Session not found".
   *
   * No LLM call happens here: the plan is adopted as saved, and the planner is
   * only contacted when the user next sends a message.
   */
  adoptSavedSession(sessionId: string, workspace: string): LegacyPlanState {
    // Re-adopting would clear the execution log and drop a running plan back to
    // its saved state, so a live session wins over the file.
    const live = this.sessions.get(sessionId);
    if (live?.planState) return live.planState;

    const saved = loadSession(sessionId, workspace);
    if (!saved) throw new SessionNotFoundError();

    const session = this.createSessionFor(sessionId, workspace);
    // The saved id is adopted too, so later persists rewrite the same file
    // instead of forking the session under a fresh identity.
    session.loadPlan(saved.plan, saved.meta.goal, workspace, { sessionId: saved.meta.id });
    // A live session with no plan yet is mid-planning; replacing it must stop that turn.
    this.destroy(sessionId);
    this.sessions.set(sessionId, session);

    return session.planState ?? saved.plan;
  }

  /**
   * Fork a session's conversation into a new session and adopt it, so the
   * fork is addressable at once — through the same path a saved session is
   * adopted by, reading back the file the fork was written to. The original
   * keeps running, or planning, untouched.
   */
  forkConversation(sessionId: string): AdoptedFork {
    return this.adoptFork(this.session(sessionId).forkConversation());
  }

  /** A rewind is a fork from an earlier point, so it is adopted the same way. */
  rewindConversation(sessionId: string, index: number): AdoptedFork & { rewoundMessage: string } {
    const fork = this.session(sessionId).rewindConversation(index);
    return { ...this.adoptFork(fork), rewoundMessage: fork.rewoundMessage };
  }

  private adoptFork(fork: ConversationFork): AdoptedFork {
    return { sessionId: fork.sessionId, goal: fork.goal, plan: this.adoptSavedSession(fork.sessionId, fork.workspace) };
  }

  /**
   * Direct access to a session's interface — routes call the Session; the
   * pool only registers sessions and fans broadcasts out to WS clients.
   */
  session(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError();
    return session;
  }

  destroy(sessionId: string): void {
    this.sessions.get(sessionId)?.destroy();
    this.sessions.delete(sessionId);
  }

  destroyAll(): void { for (const id of this.sessions.keys()) this.destroy(id); }
}

export const scanWorkspaces = scanWorkspacesImpl;

export function getSessionList(workspace: string) { return listSessions(workspace); }
export function getSession(sessionId: string, workspace: string) { return loadSession(sessionId, workspace); }
export function removeSession(sessionId: string, workspace: string) { return deleteSession(sessionId, workspace); }

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
