import {
  IFileSystem,
  BashOptions,
  ReadFileOpts,
  GrepOptions,
  GlobOptions,
  FindSymbolOptions,
  ToolOutcome,
  GREP_DEFAULT_HEAD_LIMIT,
} from '../interfaces/IFileSystem';
import { IApproval, DENY_ALL, type ApprovalRequest } from '../interfaces/IApproval';
import { cdUnfollowed, classifyCommand, excludedBy, pathRefs, type CommandPolicyOptions } from './commandPolicy';
import { resolveResearchShell, researchShellWarning, researchPolicyOptions, type ResearchShell, type ShellLaunch } from './researchShell';
import { PlannerShellSandbox, SEALED_FAILURE_NOTE, sandboxedFailureNote, sealedRunHeader } from './sandbox/plannerSandbox';
import { resolveWithin, resolveRef, grantScopeFor, isInertDevice } from './pathScope';
import { definitionPattern, referencePattern, languageForId, includeGlobFor } from './symbolPatterns';
import { resolveAll, vetEgress, type ResolveAll } from './egressGuard';
import { carriesSecret, sensitiveEnvValues } from './outboundSecrets';
import { READ_REFUSAL_HINT, disableWebCommandStartup, pinWebCommandAddresses, wgetVersionCommands } from './webCommands';

export { AUTO_COMMANDS, GIT_READONLY_SUBCOMMANDS, REFUSED_COMMANDS, classifyCommand, pathLikeArgs } from './commandPolicy';

const SED_HINT = ` To read lines of a file, "head", "tail" and "sed -n '10,40p' FILE" run without approval.`;
const CD_HINT = ' A "cd" is followed only on a line joined by "&&" alone, so after ";", "||", "&" or a newline every path is judged from the workspace root. Join the commands with "&&", or give paths from the root.';

function refusal(output: string): ToolOutcome {
  return { success: false, output, truncated: false };
}

/**
 * The policy half of the planner's filesystem: path confinement, the tiered
 * `bash` gate, and the definition-first symbol lookup. Adapters supply only the
 * mechanics (`*Impl`), so the rules live in one place across the web server and
 * the VS Code extension rather than being re-derived per surface.
 *
 * Every public method resolves and authorizes before delegating, and every
 * `*Impl` therefore receives an absolute, already-approved path. Previously
 * each adapter did its own resolution, and `path.isAbsolute(p) ? p : …` meant
 * an absolute path walked straight out of the workspace with no prompt and no
 * record.
 */
export abstract class BaseFileSystem implements IFileSystem {
  private approval: IApproval = DENY_ALL;
  private outboundSecrets: () => Iterable<string> = () => [];

  constructor(
    private readonly resolveWebHost: ResolveAll = resolveAll,
    private readonly sandbox: PlannerShellSandbox = new PlannerShellSandbox(),
  ) {}

  /**
   * The interpreter `execBashImpl` will hand the command to. Owned here rather
   * than per-adapter because {@link classifyCommand} has to be told the same
   * answer: a command lexed under POSIX rules and then run by cmd.exe is a
   * command this class did not actually classify.
   */
  protected readonly researchShell: ResearchShell = resolveResearchShell();

  /** Surfaces inject the human channel here; without it, external access is denied. */
  setApproval(approval: IApproval): void {
    this.approval = approval;
  }

  setOutboundSecrets(secrets: () => Iterable<string>): void {
    this.outboundSecrets = secrets;
  }

  setNotice(notice: (message: string) => void): void {
    this.sandbox.setNotice(notice);
  }

  endSession(): void {
    this.sandbox.end();
  }

  canSeal(): Promise<boolean> {
    return this.sandbox.canSeal();
  }

  abstract getWorkspaceRoot(): string;

  protected abstract readFileImpl(absPath: string, opts?: ReadFileOpts): Promise<ToolOutcome>;
  protected abstract globImpl(pattern: string, absRoot: string, headLimit: number): Promise<ToolOutcome>;
  protected abstract grepImpl(pattern: string, absRoot: string, opts: GrepOptions): Promise<ToolOutcome>;
  protected abstract listDirImpl(absPath: string, depth: number): Promise<ToolOutcome>;
  /** Run `command` through `shell`, appending it after `shell.args`; `shell.file: null` is `shell: true`. */
  protected abstract execBashImpl(command: string, shell: ShellLaunch, signal?: AbortSignal): Promise<ToolOutcome>;

  /**
   * Resolve `p` and confirm the planner may touch it. In-workspace paths pass
   * silently; anything else needs one approval, remembered per containing
   * directory so a second file in the same place does not prompt again.
   */
  protected async authorizePath(
    p: string,
    kind: 'file' | 'directory' = 'file',
  ): Promise<{ ok: true; abs: string } | { ok: false; outcome: ToolOutcome }> {
    const root = this.getWorkspaceRoot();
    const { abs, inside } = resolveWithin(root, p);
    if (inside) return { ok: true, abs };

    const granted = await this.approval.request({
      kind: 'external_path',
      subject: abs,
      scope: grantScopeFor(abs, kind),
      detail: `Planner research wants to read ${abs}, outside the workspace (${root}).`,
    });
    if (granted) return { ok: true, abs };

    return {
      ok: false,
      outcome: {
        success: false,
        output: `Access denied: "${abs}" is outside the workspace root (${root}) and was not approved. Keep research inside the workspace, or ask the user to approve this location.`,
        truncated: false,
      },
    };
  }

  async readFile(p: string, opts?: ReadFileOpts): Promise<ToolOutcome> {
    const auth = await this.authorizePath(p, 'file');
    return auth.ok ? this.readFileImpl(auth.abs, opts) : auth.outcome;
  }

  async readFiles(paths: string[]): Promise<ToolOutcome> {
    const results: string[] = [];
    let truncated = false;
    for (const p of paths) {
      const r = await this.readFile(p);
      // Denials are reported inline: silently dropping them would let the model
      // believe a file was empty rather than out of bounds.
      if (r.success) {
        results.push(`--- ${p} ---\n${r.output}`);
        if (r.truncated) truncated = true;
      } else if (r.output) {
        results.push(`--- ${p} ---\n[not read] ${r.output}`);
      }
    }
    if (results.length === 0) return { success: false, output: 'No files read.', truncated: false };
    return { success: true, output: results.join('\n\n'), truncated };
  }

  async glob(pattern: string, opts?: GlobOptions): Promise<ToolOutcome> {
    const auth = await this.authorizePath(opts?.path ?? '.', 'directory');
    if (!auth.ok) return auth.outcome;
    return this.globImpl(pattern, auth.abs, opts?.headLimit ?? 200);
  }

  async grep(pattern: string, opts?: GrepOptions): Promise<ToolOutcome> {
    const auth = await this.authorizePath(opts?.path ?? '.', 'directory');
    if (!auth.ok) return auth.outcome;
    return this.grepImpl(pattern, auth.abs, {
      ...opts,
      headLimit: opts?.headLimit ?? GREP_DEFAULT_HEAD_LIMIT,
      outputMode: opts?.outputMode ?? 'content',
    });
  }

  async listDir(p: string, depth?: number): Promise<ToolOutcome> {
    const auth = await this.authorizePath(p, 'directory');
    return auth.ok ? this.listDirImpl(auth.abs, depth ?? 1) : auth.outcome;
  }

  /**
   * Definitions first, then a reference tally. Two bounded searches beat one
   * unbounded `grep` because the 100-row budget gets spent on the rows that
   * answer the question.
   */
  async findSymbol(symbol: string, opts?: FindSymbolOptions): Promise<ToolOutcome> {
    const name = symbol.trim();
    if (!name) {
      return { success: false, output: 'find_symbol requires a non-empty "symbol".', truncated: false };
    }

    const auth = await this.authorizePath(opts?.path ?? '.', 'directory');
    if (!auth.ok) return auth.outcome;

    const language = opts?.language ? languageForId(opts.language) : undefined;
    if (opts?.language && !language) {
      return {
        success: false,
        output: `Unknown language "${opts.language}". Omit it to search every language, or pass a file extension such as ".go".`,
        truncated: false,
      };
    }
    const include = language ? includeGlobFor(language) : undefined;

    const [defs, refs] = await Promise.all([
      this.grepImpl(definitionPattern(name, language), auth.abs, { include, outputMode: 'content', headLimit: 40 }),
      this.grepImpl(referencePattern(name), auth.abs, { include, outputMode: 'count', headLimit: 40 }),
    ]);

    const sections: string[] = [];
    const foundDefs = defs.success && defs.output.trim() && !/^No matches/i.test(defs.output.trim());
    sections.push(foundDefs
      ? `=== Definitions of "${name}" ===\n${defs.output.trim()}`
      : `=== Definitions of "${name}" ===\nNone matched the definition patterns. The symbol may be generated, re-exported, or defined in a language find_symbol does not cover — fall back to grep.`);

    if (refs.success && refs.output.trim() && !/^No matches/i.test(refs.output.trim())) {
      sections.push(`=== References by file (match count) ===\n${refs.output.trim()}`);
    }

    return {
      success: true,
      output: sections.join('\n\n'),
      truncated: defs.truncated || refs.truncated,
    };
  }

  /**
   * Path confinement for `bash`: an `auto`-tier binary (`cat`, `find`, `rg`, …)
   * is only auto because *reading* is read-only — its arguments can still
   * name a path outside the workspace, which is the exact escape confinement
   * closes for `readFile`/`glob`/`grep`. Each escaping path is scoped to its
   * containing directory, one entry per distinct scope.
   */
  private outsidePaths(command: string): Array<{ abs: string; scope: string }> {
    const root = this.getWorkspaceRoot();
    const found = new Map<string, string>();
    for (const ref of pathRefs(command, this.policyOptions())) {
      const { abs, inside } = resolveRef(root, ref);
      if (inside || isInertDevice(abs)) continue;
      const scope = grantScopeFor(abs, 'file');
      if (!found.has(scope)) found.set(scope, abs);
    }
    return [...found].map(([scope, abs]) => ({ abs, scope }));
  }

  private policyOptions(): CommandPolicyOptions {
    return researchPolicyOptions(this.researchShell);
  }

  /**
   * Three tiers (see `commandPolicy.ts`): read-only inspection runs silently,
   * anything else asks once and is remembered, and writes are refused outright
   * because a planner that mutates the workspace has stopped being a planner.
   * Where the sandbox can seal a command, what the envelope would refuse
   * without asking anyone runs sealed instead (ADR-0036 S2): the classifier's
   * refusal, and the approval mode's. A person's denial still refuses.
   *
   * Everything a command needs — its own approval and every outside directory
   * it touches — is one request, so one command is one prompt. Each scope is
   * still granted separately: approving the pair does not approve another
   * directory the next command names.
   */
  async bash(command: string, signal?: AbortSignal, opts: BashOptions = {}): Promise<ToolOutcome> {
    command = disableWebCommandStartup(command, this.researchShell.dialect);
    const allow = this.approval.allowlist?.();
    const { tier, scope, reason, allowedBy, perInvocation, scopes: commandScopes, webUrls, webOutboundTexts } = classifyCommand(command, {
      ...this.policyOptions(), ...this.approval.commandPolicy?.(), ...(allow ? { allow } : {}),
    });

    const root = this.getWorkspaceRoot();
    const outside = this.outsidePaths(command);
    const asks = tier === 'ask';
    const scopes = [...(asks ? commandScopes ?? [scope] : []), ...outside.map((o) => o.scope)];
    const touched = outside.map((o) => o.abs).join(', ');
    const request: ApprovalRequest | undefined = scopes.length === 0 ? undefined : {
      kind: asks ? 'shell_command' : 'external_path',
      ...(perInvocation ? { perInvocation } : {}),
      subject: asks ? command : outside[0].abs,
      scope: scopes[0],
      ...(scopes.length > 1 ? { scopes } : {}),
      ...(asks && allowedBy ? { allowedBy } : {}),
      detail: outside.length > 0
        ? `Planner research wants to run "${command}", which touches ${touched}, outside the workspace (${root}).`
        : `Planner research wants to run: ${command}`,
    };

    if (opts.sealed) {
      if (!(await this.sandbox.canSeal())) return refusal(`Command refused: this machine has no sandbox to run a command sealed in. Run it without "sealed", and Ordewell's command rules judge it as they do every command.`);
      return this.runSealed(command, request, 'asked', signal);
    }

    if (tier === 'refuse') return this.sealedInstead(command, request, refusal(`Command refused: ${reason}`), signal);

    if (webUrls?.length && carriesSecret([...(webOutboundTexts ?? []), ...webUrls.map((url) => url.href)], [...this.outboundSecrets(), ...sensitiveEnvValues(process.env)])) {
      return refusal('Command refused: a web command contains what looks like a secret. Fetch the page with your web fetch tool, without credentials.');
    }

    const vettedAddresses = new Map<string, string>();
    for (const url of webUrls ?? []) {
      const check = await vetEgress(url.hostname, url.port, this.resolveWebHost);
      if (!check.ok) return refusal(`Command refused: Blocked host: ${check.reason}. ${READ_REFUSAL_HINT}`);
      vettedAddresses.set(url.origin, check.addresses[0]);
    }

    if (request) {
      const denied = refusal(outside.length > 0
        ? `Access denied: "${command}" touches ${touched}, outside the workspace root (${root}), and was not approved. Keep research inside the workspace, or ask the user to approve this location.${cdUnfollowed(command, this.policyOptions()) ? CD_HINT : ''}`
        : `Command not approved: ${command}\nIt is outside the auto-allowed read-only set and the planner allowlist (${scope}). Continue without it. If it would change something outside the repository, add it to the plan as an ops task; if it only reads, ask the user to approve it or add it to the planner allowlist.${/(^| )g?sed( |$)/.test(scope) ? SED_HINT : ''}`);
      // The approval mode refuses without asking anyone, so where a sealed run
      // can start that is what runs (S2). Elsewhere the request goes in, and
      // the mode's refusal is recorded as it always was.
      const standing = this.approval.peek?.(request);
      if (standing?.decision === 'deny' && standing.source === 'mode' && await this.sandbox.canSeal()) return this.runSealed(command, request, 'refused', signal);
      if (!(await this.approval.request(request))) return denied;
    }

    if (webUrls?.length) {
      const latest = classifyCommand(command, { ...this.policyOptions(), ...this.approval.commandPolicy?.(), allow: this.approval.allowlist?.() });
      if (latest.tier === 'refuse') return refusal(`Command refused: ${latest.reason}`);
    }

    for (const probe of wgetVersionCommands(command, this.researchShell.dialect)) {
      if (!probe) return refusal(`Command refused: the wget executable cannot be checked in an uncertain working directory. ${READ_REFUSAL_HINT}`);
      const version = await this.runShell(probe, false, signal);
      if (!version.success || !/^GNU Wget 1\./.test(version.output)) {
        return refusal(`Command refused: only GNU Wget 1.x is supported; wget2 can write persistent databases. ${READ_REFUSAL_HINT}`);
      }
    }

    const pinned = pinWebCommandAddresses(command, vettedAddresses, this.researchShell.dialect);
    command = pinned.command;
    if (webUrls?.length) {
      const latest = classifyCommand(command, { ...this.policyOptions(), ...this.approval.commandPolicy?.(), allow: this.approval.allowlist?.(), trustedWebResolves: pinned.resolves });
      if (latest.tier === 'refuse') return refusal(`Command refused: ${latest.reason}`);
    }
    // The network follows the tier (ADR-0011 B3): an `ask` command got here
    // approved, by the user, a standing grant, the allowlist or the mode, and
    // keeps it. An `auto` one, including one approved only for the paths it
    // names, has none.
    return this.runShell(command, tier === 'ask', signal);
  }

  /** A refusal the envelope reached without asking anyone, run sealed where this host can (ADR-0036 S2), or `refused` as it was (S6). */
  private async sealedInstead(command: string, request: ApprovalRequest | undefined, refused: ToolOutcome, signal?: AbortSignal): Promise<ToolOutcome> {
    return (await this.sandbox.canSeal()) ? this.runSealed(command, request, 'refused', signal) : refused;
  }

  /**
   * One sealed run (S1): no network, no home, nothing it writes reaching the
   * workspace, and nobody asked. What the user said no to stays refused (S3):
   * a `!` exclusion naming the command or a path it touches, and a denial
   * given on the card this session.
   */
  private async runSealed(command: string, request: ApprovalRequest | undefined, why: 'asked' | 'refused', signal?: AbortSignal): Promise<ToolOutcome> {
    const allow = this.approval.allowlist?.();
    const rule = allow ? excludedBy(command, allow, this.policyOptions()) : undefined;
    if (rule) return refusal(`Command refused: the planner allowlist excludes it ("${rule}"), and an exclusion holds for a sealed run too.`);
    const standing = request ? this.approval.peek?.(request) : undefined;
    if (request && standing?.decision === 'deny' && standing.source === 'excluded') {
      return refusal(`Command refused: the planner allowlist excludes ${request.subject === command ? 'it' : `"${request.subject}"`}, and an exclusion holds for a sealed run too.`);
    }
    if (standing?.decision === 'deny' && standing.source === 'remembered') {
      return refusal(`Command not approved: ${command}\nThe user denied it this session, and a denial holds for a sealed run too. Continue without it.`);
    }

    let shell: ShellLaunch;
    try {
      shell = await this.sandbox.launchSealed(this.researchShell, { workspace: this.getWorkspaceRoot() });
    } catch (err) {
      return refusal(`Command not run: its sealed sandbox could not be prepared (${err instanceof Error ? err.message : String(err)}).`);
    }
    const outcome = await this.execBashImpl(command, shell, signal);
    if (signal?.aborted) return outcome;
    const output = `${sealedRunHeader(why)}\n${outcome.output}${outcome.success ? '' : `\n\n[${SEALED_FAILURE_NOTE}]`}`;
    return { ...outcome, output };
  }

  /** Every command the planner's shell starts goes through here, inside the sandbox where this host has one (ADR-0011 B1, B6). */
  private async runShell(command: string, network: boolean, signal?: AbortSignal): Promise<ToolOutcome> {
    let shell: ShellLaunch;
    let sandboxed: boolean;
    try {
      ({ launch: shell, sandboxed } = await this.sandbox.launch(this.researchShell, { network }));
    } catch (err) {
      // The sandbox runs on this host, so running the command outside it is not a fallback.
      return { success: false, output: `Command not run: the planner's sandbox could not be prepared (${err instanceof Error ? err.message : String(err)}).`, truncated: false };
    }
    const outcome = await this.execBashImpl(command, shell, signal);
    if (outcome.success) return outcome;

    // A command that failed under cmd.exe most likely failed because the tool
    // does not exist there, and one that failed in the sandbox on a denied
    // write or a missing network because of the sandbox. Saying so turns
    // "exited 1" into something the model can act on — and, per the
    // fail-visibly contract, keeps a limit of the shell from reading as a
    // repository that simply had no answer.
    const warning = sandboxed ? sandboxedFailureNote(outcome.output, network) : researchShellWarning(this.researchShell);
    return warning ? { ...outcome, output: `${outcome.output}\n\n[${warning}]` } : outcome;
  }
}
