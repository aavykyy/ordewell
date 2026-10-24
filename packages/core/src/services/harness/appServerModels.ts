import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import { LineBuffer, type AgentProcessDeps } from './AgentAdapter';
import { CodexRpc, type RpcMessage } from './codexRpc';
import { RunnerProcess } from './runnerProcess';
import { settleWithin } from './settleWithin';

/**
 * One raw model entry from an app-server `model/list` response. Field names are
 * the protocol's, not Ordewell's.
 */
export interface AppServerModel {
  id: string;
  displayName?: string;
  hidden?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[];
}

const DEFAULT_TIMEOUT_MS = 20_000;

export interface AppServerModelsOptions {
  /** How long the whole handshake gets before the call answers `null`. */
  timeout?: number;
  /** Tests inject the process boundary; the real call stays on the defaults. */
  deps?: Partial<AgentProcessDeps>;
}

/** A protocol line, or null for the banners some CLIs print beside their JSON. */
function parseRpcLine(line: string): RpcMessage | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' ? (value as RpcMessage) : null;
  } catch {
    return null;
  }
}

/**
 * The live model catalog of a runner that speaks Codex's `app-server`
 * protocol: spawn it, run `initialize` → `model/list`, and take the list —
 * null on any failure (missing binary, an early exit, no answer before the
 * deadline, a malformed response) so the caller falls through to its cache.
 *
 * This is the adapter path's process and RPC client, not a second copy of
 * them: {@link RunnerProcess} owns the group kill, the EPIPE-safe stdin, the
 * stderr tail and UTF-8 decoding across chunk boundaries, and {@link CodexRpc}
 * owns the ids and the pending-response map. The process is always taken down
 * tree-wide, so a `codex` shim's interpreter cannot outlive the call.
 */
export async function discoverAppServerModels(
  command: string,
  args: string[],
  options: AppServerModelsOptions = {},
): Promise<AppServerModel[] | null> {
  const runner = new RunnerProcess({
    spawn: nodeSpawn,
    fetch: globalThis.fetch,
    // Discovery has no workspace of its own: it asks the CLI for its catalog
    // before any workspace is chosen, so it must not pay a direnv round trip
    // (or inherit a project's variables) before a spawn that has a deadline.
    workspaceEnv: async () => ({}),
    ...options.deps,
  });

  let child: ChildProcess | null = null;
  const rpc = new CodexRpc((payload) => {
    try {
      child?.stdin?.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // The process is gone; `ended` is what answers the call.
    }
  });
  const lines = new LineBuffer();
  const deliver = (line: string) => {
    const message = parseRpcLine(line);
    if (message) rpc.dispatch(message, () => {});
  };

  // A server that stopped reading its input can keep running forever; the
  // write racing its death fails with EPIPE, and no answer will ever come, so
  // that failure ends the wait like the process ending does.
  let inputBroken!: () => void;
  const broken = new Promise<void>((resolve) => { inputBroken = resolve; });

  try {
    await runner.start(process.cwd(), () => ({ command, args }), (started) => {
      child = started;
      started.stdin?.on('error', () => inputBroken());
      runner.readStdout(
        (text) => lines.push(text, deliver),
        () => {
          const rest = lines.flush();
          if (rest) deliver(rest);
        },
      );
      return Promise.resolve();
    });
  } catch {
    runner.dispose();
    return null;
  }

  // A request still waiting when the process ends fails at once instead of
  // sitting out the deadline, and a late `model/list` write is dropped.
  void runner.ended.then(() => rpc.close('The app-server process ended.'));

  const asked = (async (): Promise<AppServerModel[] | null> => {
    const initialized = await rpc.call('initialize', {
      clientInfo: { name: 'ordewell', title: 'Ordewell', version: '0.1.0' },
    });
    if (!initialized.ok) return null;
    const listed = await rpc.call('model/list', {});
    if (!listed.ok) return null;
    const data = listed.result.data;
    return Array.isArray(data) ? (data as AppServerModel[]) : null;
  })();

  try {
    return await settleWithin(asked, {
      timeoutMs: options.timeout ?? DEFAULT_TIMEOUT_MS,
      onTimeout: () => null,
      ended: Promise.race([runner.ended, broken]),
      onEnded: () => null,
    });
  } finally {
    runner.dispose();
  }
}
