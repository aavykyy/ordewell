import { tmpdir } from 'os';
import type { AccountLimitBucket, AccountLimitWindow } from '../../models/AccountLimits';
import type { AccountLimitCollector, AccountLimitReading } from '../AccountLimitMonitor';
import type { AgentProcessDeps } from './AgentAdapter';
import { APP_SERVER_CLIENT_INFO, openAppServer } from './appServerModels';
import type { RpcResponse } from './codexRpc';
import { settleWithin } from './settleWithin';
import { workspaceEnvOf } from '../workspaceEnv';

/** Spawn, handshake, account and limits together; the limits handler has no deadline of its own. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** JSON-RPC's "method not found": a Codex too old to read its account this way. */
const METHOD_NOT_FOUND = -32601;
/** What `account/rateLimits/read` answers for an account whose login has no ChatGPT windows. */
const INVALID_REQUEST = -32600;

export interface CodexAccountLimitOptions {
  /** The manifest's `app-server` launch. */
  command?: string;
  args?: string[];
  timeoutMs?: number;
  /** Installed, not enabled: an account's limits are worth showing before Codex is given a task. */
  isInstalled: () => Promise<boolean>;
  /** The workspace the planner and its tasks run in; its environment can choose another account than the host's (ADR-0016). */
  workspaceRoot?: () => string | undefined;
  /** Tests inject the process boundary; the real call stays on the defaults. */
  deps?: Partial<AgentProcessDeps>;
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * Codex's account limits, read the way its own clients read them:
 * `initialize` → `initialized` → `account/read` → `account/rateLimits/read`,
 * on a short-lived `app-server` that is taken down after every read. Nothing
 * here opens a thread, starts a turn, logs in or out, or asks Codex to
 * refresh its token, and Codex's `auth.json` is never read.
 *
 * It runs from the temp directory, so a project's config and hooks are not
 * run on every poll, but with the workspace's environment on top of the
 * host's, as the planner and its tasks run: a `CODEX_HOME` the workspace sets
 * decides whose account it is, not the host's.
 */
export function codexAccountLimitCollector(options: CodexAccountLimitOptions): AccountLimitCollector {
  const command = options.command ?? 'codex';
  const args = options.args ?? ['app-server'];
  return {
    harness: 'codex',
    label: 'Codex',
    scope: () => [command, ...args, process.env.CODEX_HOME ?? ''].join('\0'),
    acquire: async (signal) => {
      if (!(await options.isInstalled())) return { kind: 'not_installed' };
      if (signal.aborted) return { kind: 'failed' };
      return readCodexAccountLimits(command, args, options, signal);
    },
  };
}

async function readCodexAccountLimits(command: string, args: string[], options: CodexAccountLimitOptions, signal: AbortSignal): Promise<AccountLimitReading> {
  let accountRead = false;
  let accountChanged = false;
  let followUp = false;
  let owner: string | undefined;
  const root = options.workspaceRoot?.();
  const server = await openAppServer(command, args, {
    cwd: tmpdir(),
    deps: { ...(root ? { workspaceEnv: () => workspaceEnvOf(root) } : {}), ...options.deps },
    onMessage: (message) => {
      // Codex announces the account it resolved at startup, unprompted, and
      // the account/read answer that follows already reflects it. After that
      // answer, no stable identity comes with one, so whatever this read says
      // may be the account that was just replaced.
      if (message.method === 'account/updated') accountChanged ||= accountRead;
      // Sparse: it says something moved, not what the whole picture is.
      else if (message.method === 'account/rateLimits/updated') followUp = true;
      // Nothing this connection does gives Codex a reason to ask anything.
      if (message.method && message.id !== undefined) server?.rpc.respondError(message.id, METHOD_NOT_FOUND, 'Ordewell answers no requests here.');
    },
  });
  if (!server) return { kind: 'failed' };
  const { rpc } = server;
  const failed = (): AccountLimitReading => (accountChanged ? { kind: 'account_changed' } : { kind: 'failed', ...(owner ? { owner } : {}) });

  const asked = (async (): Promise<AccountLimitReading> => {
    const initialized = await rpc.call('initialize', { clientInfo: APP_SERVER_CLIENT_INFO });
    if (!initialized.ok) return failed();
    server.notify('initialized', {});
    // `refreshToken: false`: the account as Codex holds it, without asking it to refresh anything.
    // Marked on the answer's own line, where CodexRpc runs its handlers: a
    // microtask later, an announcement on the next line of the same chunk
    // would already have been let through.
    const account = await new Promise<RpcResponse>((resolve) => rpc.send('account/read', { refreshToken: false }, (response) => {
      accountRead = true;
      resolve(response);
    }));
    if (!account.ok) return account.code === METHOD_NOT_FOUND ? { kind: 'unsupported' } : failed();
    const who = codexAccountOwner(account.result);
    if (typeof who !== 'string') return who;
    owner = who;
    const limits = await rpc.call('account/rateLimits/read', {});
    if (!limits.ok) return limits.code === METHOD_NOT_FOUND || limits.code === INVALID_REQUEST ? { kind: 'unsupported' } : failed();
    const read = codexLimitBuckets(limits.result);
    if (!read || accountChanged) return failed();
    return {
      kind: 'limits',
      owner,
      ...(read.plan ? { plan: read.plan } : {}),
      buckets: read.buckets,
      ...(followUp ? { followUp: true } : {}),
    };
  })();

  // The spawn is awaited above, so the abort may already have come and gone.
  const cancelled = signal.aborted
    ? Promise.resolve()
    : new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  try {
    return await settleWithin(asked, {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onTimeout: failed,
      ended: Promise.race([server.gone, cancelled]),
      onEnded: failed,
    });
  } finally {
    server.dispose();
  }
}

/**
 * Whose account an `account/read` names, as a key compared between reads and
 * never shown; or why there are no limits to read. A ChatGPT workspace is part
 * of it where Codex reports one, since one email can switch between several.
 */
function codexAccountOwner(result: Json): string | AccountLimitReading {
  const account = result.account;
  if (!isRecord(account)) return result.requiresOpenaiAuth === false ? { kind: 'unsupported' } : { kind: 'signed_out' };
  const type = text(account.type);
  // An API key has no plan windows to read.
  if (!type || type === 'apiKey') return { kind: 'unsupported' };
  const routing = isRecord(result.workspaceRouting) ? text(result.workspaceRouting.chatgptAccountId) : undefined;
  return [type, text(account.email) ?? '', routing ?? ''].join('\0');
}

/**
 * A full `account/rateLimits/read`: every bucket it reports, each with only
 * the windows it reports. It replaces what was known; a bucket or window it
 * leaves out is gone, not kept. The per-limit map wins whenever present, even
 * empty — the single `rateLimits` is the same bucket again, for older clients.
 */
function codexLimitBuckets(result: Json): { buckets: AccountLimitBucket[]; plan?: string } | null {
  const byId = result.rateLimitsByLimitId;
  const legacy = result.rateLimits;
  let entries: [string, unknown][];
  if (isRecord(byId)) entries = Object.entries(byId);
  else if (isRecord(legacy)) entries = [[text(legacy.limitId) ?? 'codex', legacy]];
  else return null;
  const buckets = entries.flatMap(([id, raw]) => {
    if (!isRecord(raw)) return [];
    const windows = [codexWindow('primary', raw.primary), codexWindow('secondary', raw.secondary)].filter((w): w is AccountLimitWindow => w !== null);
    const name = text(raw.limitName);
    return [{ id, ...(name ? { name } : {}), windows }];
  });
  // The account's own bucket first, the per-model ones after it in the order given.
  buckets.sort((a, b) => Number(b.id === 'codex') - Number(a.id === 'codex'));
  const plan = [legacy, ...entries.map(([, raw]) => raw)]
    .map((raw) => (isRecord(raw) ? text(raw.planType) : undefined))
    .find((p) => p !== undefined && p !== 'unknown');
  return { buckets, ...(plan ? { plan } : {}) };
}

/** `usedPercent` is a percentage, the duration minutes, `resetsAt` Unix seconds; anything else is unreported. */
function codexWindow(slot: AccountLimitWindow['slot'], raw: unknown): AccountLimitWindow | null {
  if (!isRecord(raw)) return null;
  const used = finite(raw.usedPercent);
  const minutes = finite(raw.windowDurationMins);
  const reset = finite(raw.resetsAt);
  const resetsAt = reset === null ? null : new Date(reset * 1000);
  const window: AccountLimitWindow = {
    slot,
    usedPercent: used !== null && used >= 0 ? used : null,
    durationMinutes: minutes !== null && minutes > 0 ? minutes : null,
    resetsAt: resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt.toISOString() : null,
  };
  return window.usedPercent === null && window.durationMinutes === null && window.resetsAt === null ? null : window;
}
