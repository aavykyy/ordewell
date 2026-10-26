import { spawn as nodeSpawn } from 'child_process';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
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
  type SessionFrame,
  type ApprovalRequestMessage,
  type StreamStamp,
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
  type PlannerSelectionCurrent,
  StructuredRunner,
  CodexSandboxAvailability,
  detectInstalledPlanner,
  installedPlannerAnswered,
  PlannerNotReadyError,
  PlannerTurnDiscardedError,
  PlannerTurnStoppedError,
  type LeaseHost,
  workspaceEnvOf,
} from '@ordewell/core';
import { WebConfig, type PlannerPick } from '../adapters/WebConfig';
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

/**
 * The installation checks a host supplies the pool. `refresh` is optional so a
 * test may hand in only the two probes; the real `RunnerInstallation` always
 * has it, and a refresh then re-probes a CLI installed since the last look.
 */
type RunnerInstall = Pick<RunnerInstallation, 'filterInstalled' | 'plannerUsability'> & Partial<Pick<RunnerInstallation, 'refresh'>>;

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
  runnerInstallation?: RunnerInstall;
  /**
   * The host whose leases the pool's sessions hold (ADR-0049); this process's
   * unless a test runs two pools as two hosts.
   */
  leaseHost?: LeaseHost;
}

export class OrchestratorPool {
  private sessions = new Map<string, Session>();
  private clients = new Map<string, Set<WebSocket>>();
  /**
   * This process's broadcast numbering (see `StreamStamp`), per session id
   * rather than per Session object: a session replaced under the same id
   * keeps counting up, so a client never mistakes its first broadcast for one
   * of the old session's it already showed.
   */
  private readonly stream = randomUUID();
  private sequence = new Map<string, number>();
  private registry: CoreRunnerRegistry = new RunnerRegistry();
  private modelResolver: ModelResolver;
  private runnerInstallation: RunnerInstall;
  /**
   * A host that supplied its own probe (a test, or a surface that owns one).
   * Everything else asks {@link installationFor}, which keys a real probe by
   * the workspace whose account it is judging (ADR-0016).
   */
  private suppliedRunnerInstallation: RunnerInstall | undefined;
  private workspaceInstallations = new Map<string, RunnerInstall>();
  private cachedProviderLists: Record<string, string[]> | undefined;
  private settingsService = new SettingsService();
  private plannerModelMemory = new PlannerModelMemory(this.settingsService);
  /**
   * The model a settings write picked in this daemon. The environment's model
   * is otherwise inherited, and an agent planning only because detection
   * found it does not plan with an inherited model it cannot be shown to run.
   */
  private pickedModel: PlannerPick | undefined;
  private runner: IRunner;
  /** One probe per daemon, asked again whenever the runner list is refreshed (ADR-0033). */
  private codexSandbox: Pick<CodexSandboxAvailability, 'ensure' | 'refresh'>;
  private readonly leaseHost: LeaseHost | undefined;

  constructor(deps: OrchestratorPoolDeps = {}) {
    const pluginNotice = removedPluginNotice();
    if (pluginNotice) console.warn(pluginNotice);
    this.runner = deps.runner ?? new StructuredRunner();
    // The login probe must ask the account the planner will use (ADR-0016).
    // This installation is the daemon's own cwd for detection; a runner list
    // request naming a workspace is judged by that workspace's own probe.
    this.suppliedRunnerInstallation = deps.runnerInstallation;
    this.runnerInstallation = deps.runnerInstallation
      ?? new RunnerInstallation(this.registry, undefined, undefined, { env: () => workspaceEnvOf(process.cwd()) });
    this.modelResolver = deps.modelResolver ?? new ModelResolver(this.registry, new WebConfig());
    this.codexSandbox = deps.codexSandbox
      ?? new CodexSandboxAvailability(this.registry, { spawn: nodeSpawn, fetch: globalThis.fetch }, { cwd: process.cwd(), env: process.env });
    this.leaseHost = deps.leaseHost;
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
   * A new session's first planner turn. It waits for that probe at the
   * session's own planner gate, where a reply sent meanwhile queues behind
   * it, and a Stop or the session closing or being replaced ends the wait.
   */
  private async firstTurn<T>(sessionId: string, session: Session, turn: () => Promise<T>): Promise<T> {
    try {
      return await turn();
    } catch (err) {
      // Judged once the probe answered: a refused session is never left
      // addressable, as when it is judged before it is registered.
      if (err instanceof PlannerNotReadyError && this.sessions.get(sessionId) === session) this.destroy(sessionId);
      // Stopped before it opened, the session holds no conversation for a
      // reply to continue: for the client its goal was discarded.
      if (err instanceof PlannerTurnStoppedError && !session.planState) throw new PlannerTurnDiscardedError();
      throw err;
    }
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
    const seq = (this.sequence.get(sessionId) ?? 0) + 1;
    this.sequence.set(sessionId, seq);
    const payload = JSON.stringify({ ...msg, stream: this.stream, seq } satisfies SessionFrame);
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
  /** The planner turn answering in a session this process holds, if one is. */
  plannerTurnId(sessionId: string): string | undefined { return this.sessions.get(sessionId)?.plannerTurnId; }
  /** The planner compaction running in a session this process holds, as its start was announced; it has no turn to name. */
  plannerCompaction(sessionId: string): ReturnType<Session['plannerCompaction']> { return this.sessions.get(sessionId)?.plannerCompaction(); }
  /** The planner's approval requests still waiting, as they were announced. */
  announcedApprovals(sessionId: string): ApprovalRequestMessage[] { return this.sessions.get(sessionId)?.announcedApprovals() ?? []; }
  /** The last broadcast of the session so far: a snapshot taken now accounts for it and everything before. */
  streamPosition(sessionId: string): StreamStamp { return { stream: this.stream, seq: this.sequence.get(sessionId) ?? 0 }; }

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
      ...(this.leaseHost ? { leaseHost: this.leaseHost } : {}),
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
      pickedModel: () => this.pickedModel,
      agentCatalog: (provider) => this.plannerCatalogFor(provider).map((model) => model.id),
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
    // Worked out from the file as it is when written, not from an earlier read.
    this.settingsService.updateEnabledRunners((saved) => {
      const current = saved ?? new WebConfig().enabledRunners;
      return enabled
        ? (current.includes(id) ? current : [...current, id])
        : current.filter((r) => r !== id);
    });
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
    // against what was actually in effect a moment ago. The model and effort
    // too, with where they came from: a detected agent does not plan with a
    // vendor model left in the environment, and judging against it would
    // remember that model as the agent's own pick.
    const current: PlannerSelectionCurrent = this.plannerConfig().planner;

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
    // switch may have just cleared that model. An `inherited` write is no
    // pick at all: it is the environment a client was started under, which
    // the daemon would have inherited had the client spawned it, so it is
    // written as it stands and nothing in it is remembered.
    const plannerChange: PlannerSelectionChange = changes.inherited === true ? {} : {
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
      // An effort on its own leaves the configured model as it was: a
      // detected agent's model in effect can be its remembered one, which a
      // key added later must not find written over the configured model.
      if (plannerChange.provider !== undefined || plannerChange.model !== undefined) process.env.ORCHESTRATOR_MODEL = selection.next.model;
      process.env.ORDEWELL_PLANNER_EFFORT = selection.next.effort;
      // Read once the env above is written: the pick is for whoever that
      // routes to, which a switch or the model's own catalog may have changed.
      if (plannerChange.model !== undefined) this.pickedModel = { model: selection.next.model, provider: this.plannerProviderInEffect() };
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
      orchestratorModel: this.plannerConfig().orchestratorModel,
      providers,
      orchestratorModels,
      providerErrors,
    };
  }

  getRunnerState(): { enabledRunners: RunnerId[]; orchestratorModel: string } {
    const config = this.plannerConfig();
    return { enabledRunners: config.enabledRunners, orchestratorModel: config.orchestratorModel };
  }

  /**
   * The probe that judges a login for `workspace`, cached so its install and
   * auth verdicts survive between runner-list refreshes. Without a workspace
   * the daemon's cwd is what the request would plan with anyway.
   */
  private installationFor(workspace: string | undefined): RunnerInstall {
    if (this.suppliedRunnerInstallation) return this.suppliedRunnerInstallation;
    if (!workspace) return this.runnerInstallation;
    const key = resolve(workspace);
    let installation = this.workspaceInstallations.get(key);
    if (!installation) {
      installation = new RunnerInstallation(this.registry, undefined, undefined, { env: () => workspaceEnvOf(key) });
      this.workspaceInstallations.set(key, installation);
    }
    return installation;
  }

  /**
   * Runners whose CLI is actually installed on the host, with display name and
   * enabled state. Only these should be offered for selection — an uninstalled
   * runner can't be spawned. `workspace` names whose account the auth verdict
   * is about; without it the daemon's cwd stands in.
   */
  async getInstalledRunners(workspace?: string): Promise<RunnersResponse['runners']> {
    // The runner list is the one place a user who just fixed their host looks
    // again, so every cached answer is asked afresh: the Codex sandbox, the
    // install verdicts, and the agent detection behind the no-choice defaults.
    await this.codexSandbox.refresh();
    const installation = this.installationFor(workspace);
    installation.refresh?.();
    await this.detectInstalledPlanner();

    const config = new WebConfig({ enabledRunners: this.enabledRunnerOverride() });
    const enabled = new Set(config.enabledRunners);
    const runners = this.registry.list();
    const installedIds = new Set(
      await installation.filterInstalled(runners.map((p) => p.manifest.name)),
    );
    // The auth verdict rides along, never gating the list: a signed-out agent
    // is installed and offered, and a surface flags it. The probe was just
    // asked above and its answer is cached, so this costs no second spawn.
    return Promise.all(
      runners
        .filter((p) => installedIds.has(p.manifest.name))
        .map(async (p) => {
          const { auth } = await installation.plannerUsability(p.manifest.name);
          return {
            id: p.manifest.name,
            name: p.manifest.displayName,
            enabled: enabled.has(p.manifest.name),
            ...(auth ? { auth } : {}),
          };
        }),
    );
  }

  async generatePlan(sessionId: string, goal: string, runners: RunnerId[] | undefined, workspace: string, modelOverride?: string, options?: { allowInit?: boolean }): Promise<PlanState> {
    const session = this.openPlanningSession(sessionId, runners, workspace, modelOverride, options);
    return migratePlanState(await this.firstTurn(sessionId, session, () => session.generatePlan(goal, runners)));
  }

  /**
   * Build the session a new planning conversation runs in and register it in
   * place of any live one, for {@link firstTurn} to run its first turn on.
   */
  private openPlanningSession(sessionId: string, runners: RunnerId[] | undefined, workspace: string, modelOverride?: string, options?: { allowInit?: boolean }): Session {
    const session = this.createSessionFor(sessionId, workspace, modelOverride, options);
    // Judged on the new session's config (which carries the request's model)
    // and before the old session is destroyed, so a refusal leaves it alone.
    // Not while the installed-planner probe is out: its answer can be the
    // planner, and judging the openrouter fallback now would refuse the very
    // keyless first run the probe exists for, so that judgement is the first
    // turn's own gate. The runners are judged on the same terms: before the
    // probe answers, the enabled set is a guess a refusal must not rest on.
    if (installedPlannerAnswered()) {
      session.assertPlannerReady();
      session.assertRunnersEnabled(runners);
    }
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
    return session;
  }

  /**
   * Conversational planning (ADR-0002): start the planner dialogue for a
   * session. Returns the current plan state — a committed plan when the
   * planner had enough context, otherwise the dialogue so far (last
   * assistant message lives in conversationHistory).
   */
  async startPlanning(sessionId: string, goal: string, runners: RunnerId[] | undefined, workspace: string, modelOverride?: string, options?: { allowInit?: boolean }): Promise<LegacyPlanState> {
    const session = this.openPlanningSession(sessionId, runners, workspace, modelOverride, options);
    return this.firstTurn(sessionId, session, () => session.startPlanning(goal, runners));
  }

  /**
   * Continue the planner dialogue with the user's reply: queued behind the
   * first turn, even while it waits for the installed-planner probe, and
   * refused only while a turn of another kind holds the conversation. The
   * session's own planner gate waits for the probe and judges the planner, as
   * it does for every turn.
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
    // A first turn still waiting for the probe is the session's to stop too.
    return this.sessions.get(sessionId)?.abortPlannerTurn() ?? false;
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
    // instead of forking the session under a fresh identity. Refused while
    // another live host runs the session (ADR-0049); the session built for
    // it is let go, and the one live here, if any, keeps running.
    try {
      session.loadPlan(saved.plan, saved.meta.goal, workspace, { sessionId: saved.meta.id });
    } catch (err) {
      session.destroy();
      throw err;
    }
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

  /**
   * Stop a session and drop it. A replacement under the same id (re-planning,
   * adopting) keeps its subscribers: they are watching the id, and the new
   * session's broadcasts continue on the same socket. An explicit delete or
   * close is different — the surface must stop drawing a session that no
   * longer exists — so those pass `notifyClients`.
   */
  destroy(sessionId: string, options?: { notifyClients?: boolean }): void {
    this.sessions.get(sessionId)?.destroy();
    this.sessions.delete(sessionId);
    if (!options?.notifyClients) return;
    const clients = this.clients.get(sessionId);
    if (!clients) return;
    this.broadcast(sessionId, { type: 'notice', level: 'info', message: 'Session closed.' });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.close(1001, 'Session closed');
    }
    this.clients.delete(sessionId);
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
