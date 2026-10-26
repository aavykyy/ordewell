import type * as vscode from 'vscode';
import { runnerForProvider, workspaceEnvOf, type INotification, type PlannerBackendId, type RunnerInstallation, type RunnerRegistry } from '@ordewell/core';
import type { HostToWebview } from '../shared/protocol';

const POLL_MS = 2_000;
/** Long enough for a browser OAuth or a device code, short enough to end a forgotten one. */
const TIMEOUT_MS = 5 * 60_000;

const CLOSED_MESSAGE = 'The terminal closed before sign-in finished.';
const TIMEOUT_MESSAGE = 'Sign-in did not finish in time.';
const TERMINAL_FAILED_MESSAGE = 'The login terminal could not be opened.';

export interface PlannerLoginDeps {
  runnerInstallation: Pick<RunnerInstallation, 'plannerUsability' | 'refresh'>;
  /** Only to name the agent and refuse an id the host does not know. */
  runnerRegistry: Pick<RunnerRegistry, 'getManifest'>;
  config: { readonly aiProvider: PlannerBackendId };
  workspaceRoot: () => string;
  /**
   * The workspace's own variables (ADR-0016), for the terminal the login runs
   * in. Injectable so a test needs no `.envrc` on disk.
   */
  env?: (root: string) => Promise<Record<string, string>>;
  /** Push the fresh planner list, so the pill and the empty state redraw without the flag. */
  sendState: () => Promise<void>;
  post: (msg: HostToWebview) => void;
  notifications: Pick<INotification, 'info' | 'warn'>;
  /** The terminal to run the login in, and the word that the user closed it. */
  window: Pick<typeof vscode.window, 'createTerminal' | 'onDidCloseTerminal'>;
  /** Awaited between polls; injectable so tests never wait real seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock the timeout is measured against; injectable with `sleep`. */
  now?: () => number;
  /** The poll interval and the budget, each overridable by a test. */
  pollMs?: number;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One argv item as the terminal's own shell reads it. The argv comes from the
 * runner's manifest, never from the webview, so this is about spaces rather
 * than an injection: PowerShell takes a doubled quote inside single quotes, a
 * POSIX shell a closed-then-escaped one.
 */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  if (process.platform === 'win32') return `'${arg.replace(/'/g, "''")}'`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The manifest's login as one line for the shell. */
export function commandLine(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ');
}

/**
 * Sign a coding agent in from the chat (ADR-0009): run the runner's own login
 * in an integrated terminal, because every one of them is interactive — a
 * browser, a device code, a pasted one — and none can run in the extension
 * host's stdio.
 *
 * The login belongs to an agent, not to the planner choice: a named runner is
 * signed in without switching to it, and no path writes `config.aiProvider`.
 * Only the agent's own status command decides it worked; a terminal that closes
 * or five minutes of polling ends the attempt as a failure the surface shows
 * inline, never as a silent success.
 */
export async function loginPlanner(deps: PlannerLoginDeps, runnerId?: string): Promise<void> {
  const runner = runnerId ?? runnerForProvider(deps.config.aiProvider) ?? undefined;
  // A webview names a runner in free text: only one the registry holds is a
  // login Ordewell may run.
  const manifest = runner === undefined ? undefined : deps.runnerRegistry.getManifest(runner);
  if (!runner || !manifest) {
    deps.log?.(`Ignored a login for the unknown coding agent "${runnerId ?? deps.config.aiProvider}".`);
    return;
  }

  const label = manifest.displayName;
  const auth = (await deps.runnerInstallation.plannerUsability(runner)).auth;
  const command = auth?.loginCommand ?? [];
  if (command.length === 0) {
    // Nothing to run: say so, and still close the surface's pending state.
    const message = `Ordewell has no login for ${label}.`;
    deps.post({ type: 'plannerLoginEnded', runner, ok: false, message });
    deps.notifications.info(message);
    return;
  }

  const root = deps.workspaceRoot();
  let terminal: vscode.Terminal;
  try {
    terminal = deps.window.createTerminal({
      name: `${label} login`,
      cwd: root,
      // The agent's own account is chosen by the workspace environment (ADR-0016),
      // so the terminal that logs in must see the same one a spawn would.
      env: await (deps.env ?? workspaceEnvOf)(root),
    });
  } catch (err) {
    // The one failure the row cannot explain by itself: nothing opened to run
    // the login in, so the reason is the host's to say.
    deps.log?.(`Could not open a ${label} login terminal: ${err instanceof Error ? err.message : String(err)}`);
    deps.post({ type: 'plannerLoginEnded', runner, ok: false, message: TERMINAL_FAILED_MESSAGE });
    deps.notifications.info(`Could not open a terminal to sign in to ${label}.`);
    return;
  }
  let closed = false;
  const closedListener = deps.window.onDidCloseTerminal((t) => {
    if (t === terminal) closed = true;
  });

  const sleep = deps.sleep ?? wait;
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? POLL_MS;
  const deadline = now() + (deps.timeoutMs ?? TIMEOUT_MS);

  const end = async (ok: boolean, message?: string): Promise<void> => {
    if (ok) {
      // The probe cached its verdict; the login just changed it.
      deps.runnerInstallation.refresh();
      try {
        await deps.sendState();
      } catch (err) {
        // The login itself worked: reporting it as failed would be a lie. The
        // next state push redraws the pill.
        deps.log?.(`Planner state refresh after signing in to ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      deps.post({ type: 'plannerLoginEnded', runner, ok: true });
      deps.notifications.info(`Signed in to ${label}.`);
      return;
    }
    deps.post({ type: 'plannerLoginEnded', runner, ok: false, ...(message ? { message } : {}) });
    deps.notifications.warn(`Ordewell could not confirm the ${label} login. ${message ?? 'It ended without an answer.'}`);
  };

  try {
    terminal.show();
    terminal.sendText(commandLine(command));

    let signedIn = false;
    while (!closed && terminal.exitStatus === undefined && now() < deadline) {
      await sleep(pollMs);
      // Closed while we waited: the attempt is over, and polling a terminal
      // that is gone would only delay the answer.
      if (closed || terminal.exitStatus !== undefined) break;
      // Refresh before every look: a cached verdict would hide a login that
      // finished within the last half minute.
      deps.runnerInstallation.refresh();
      if ((await deps.runnerInstallation.plannerUsability(runner)).auth?.state === 'signed-in') {
        signedIn = true;
        break;
      }
    }
    if (signedIn) {
      await end(true);
      return;
    }
    await end(false, closed || terminal.exitStatus !== undefined ? CLOSED_MESSAGE : TIMEOUT_MESSAGE);
  } finally {
    closedListener.dispose();
  }
}
