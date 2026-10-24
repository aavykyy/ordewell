import { assertWorkspaceExists } from '../../utils/workspace';
import { augmentedPath } from '../../utils/shellPath';
import { PlannerShellSandbox } from '../sandbox/plannerSandbox';
import { createNativeShellLauncher, type NativeShellLauncher } from '../sandbox/nativeShellLauncher';
import type { AgentProcessDeps, AgentStartOptions } from './AgentAdapter';

export interface PreparedNativeShell {
  launcher: NativeShellLauncher;
  /** Removes the launcher script and ends the sandbox that holds its scratch directory. */
  release(): void;
}

/**
 * Prepare a planner's own shell before its harness starts, or fail the start
 * rather than run the shell outside a sandbox (ADR-0036 N2). Null when this
 * start did not ask for one: only a planner with the opt-in on gets a shell.
 *
 * Shared by the harnesses that have a shell of their own to seal — Claude Code
 * names the launcher as a prefix and OpenCode as a shell, and what they do with
 * it is theirs. The launcher and its sandbox are one resource: ending one
 * without the other leaks a scratch directory or a sandbox profile.
 */
export async function prepareNativeShell(opts: AgentStartOptions, deps: AgentProcessDeps): Promise<PreparedNativeShell | null> {
  if (opts.kind !== 'planner' || opts.nativeShell !== true) return null;
  // The launcher resolves the workspace on disk before the runner's own check
  // would run, so a missing one must be reported as itself.
  assertWorkspaceExists(opts.cwd, { isDirectory: deps.isDirectory });
  const sandbox = (deps.nativeShellSandbox ?? (() => new PlannerShellSandbox()))();
  try {
    // The same PATH the harness itself starts with, so a command finds the
    // tools the user's CLI does even when the host was launched from a GUI.
    const PATH = await (deps.resolvePath ?? augmentedPath)();
    const launcher = await createNativeShellLauncher({
      workspace: opts.cwd,
      sandbox,
      platform: deps.platform,
      env: { ...process.env, PATH },
    });
    return { launcher, release: () => { launcher.remove(); sandbox.end(); } };
  } catch (err) {
    sandbox.end();
    throw new Error(`The native-shell setting is on, but Ordewell could not put this planner's shell in its sandbox (${err instanceof Error ? err.message : String(err)}). Turn the setting off, or fix the sandbox, and start the conversation again.`);
  }
}
