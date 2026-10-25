import { homedir } from 'os';
import type { AccountLimitBucket, AccountLimitWindow } from '../../models/AccountLimits';
import type { AccountLimitCollector, AccountLimitReading } from '../AccountLimitMonitor';
import { workspaceEnvOf } from '../workspaceEnv';
import { openCodeGoLoginReader, openCodeStorePaths, type OpenCodeGoCredential, type OpenCodeGoLoginReaderDeps } from './openCodeCredentials';

/*
 * Fixed, and the only places a credential is sent: never a provider's
 * configured base URL, a login's own `metadata.server`, or a redirect.
 * The Console route is the one the Console's own Go page reads, answered for a
 * signed-in member's organization (checked live on 2026-10-25); the key route
 * is the API-key quota read (v1.18.34 console/app/src/routes/zen/go/v1/usage.ts).
 */
const CONSOLE_STATUS_URL = 'https://opencode.ai/console/api/go/status';
const KEY_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

/** The whole request, answer and all. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** A signed-in Go account's answer is under a kilobyte. */
const MAX_BODY_BYTES = 64 * 1024;
/** A sign-in this close to its expiry is OpenCode's to refresh before anyone uses it. */
const EXPIRY_MARGIN_MS = 60_000;
/** More digits than any allowance has: a longer amount is not read. */
const MAX_AMOUNT_DIGITS = 30;

const FIVE_HOURS = 5 * 60;
const WEEK = 7 * 24 * 60;

export interface OpenCodeGoAccountLimitOptions {
  /** Installed, not enabled: an account's limits are worth showing before OpenCode is given a task. */
  isInstalled: () => Promise<boolean>;
  /** The workspace the planner and its tasks run in; its environment can point OpenCode at another store (ADR-0016). */
  workspaceRoot?: () => string | undefined;
  /** Tests inject the network, the environment and the store's location; the real call stays on the defaults. */
  deps?: {
    fetch?: typeof fetch;
    now?: () => number;
    env?: () => NodeJS.ProcessEnv;
    workspaceEnv?: (root: string) => Promise<Record<string, string>>;
    reader?: OpenCodeGoLoginReaderDeps;
    timeoutMs?: number;
  };
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * OpenCode Go's plan windows — five hours, the week and the plan month — for
 * the login OpenCode would pay for a Go model with (ADR-0051). The login is
 * read from OpenCode's own store, the one it selects and nothing else, and
 * sent only to OpenCode's fixed quota addresses: no OpenCode process is
 * started, no model is called, nothing is refreshed, written or kept.
 *
 * The limits meter `opencode-go/…` models only, so a task OpenCode runs on
 * another provider is not shown them.
 */
export function openCodeGoAccountLimitCollector(options: OpenCodeGoAccountLimitOptions): AccountLimitCollector {
  const deps = options.deps ?? {};
  const env = deps.env ?? (() => process.env);
  const reader = openCodeGoLoginReader(deps.reader);
  return {
    harness: 'opencode',
    label: 'OpenCode Go',
    provider: 'opencode-go',
    scope: () => {
      const paths = openCodeStorePaths(env(), (deps.reader?.homedir ?? homedir)());
      return ['opencode', paths.db ?? ':memory:', paths.auth].join('\0');
    },
    acquire: async (signal) => {
      if (!(await options.isInstalled())) return { kind: 'not_installed' };
      const root = options.workspaceRoot?.();
      const workspace = root ? await (deps.workspaceEnv ?? workspaceEnvOf)(root) : {};
      if (signal.aborted) return { kind: 'failed' };
      const found = await reader.read({ ...env(), ...workspace }, signal);
      switch (found.kind) {
        case 'none': return { kind: 'signed_out' };
        case 'unsupported': return { kind: 'unsupported' };
        case 'unreadable': return { kind: 'failed' };
        case 'login': return readGoLimits(found.login, signal, deps);
      }
    },
  };
}

async function readGoLimits(login: OpenCodeGoCredential, signal: AbortSignal, deps: NonNullable<OpenCodeGoAccountLimitOptions['deps']>): Promise<AccountLimitReading> {
  const owner = login.owner;
  const now = deps.now ?? Date.now;
  // An unusable token is no answer about the quota: what was read under this login stays, stale.
  if (login.route === 'console' && login.expires <= now() + EXPIRY_MARGIN_MS) return { kind: 'failed', owner };

  const answer = login.route === 'console'
    ? await getJson(CONSOLE_STATUS_URL, { authorization: `Bearer ${login.access}`, accept: 'application/json', ...(login.orgID ? { 'x-org-id': login.orgID } : {}) }, signal, deps)
    : await getJson(KEY_USAGE_URL, { authorization: `Bearer ${login.key}`, accept: 'application/json' }, signal, deps);
  if (answer.kind === 'failed') return { kind: 'failed', owner };

  switch (answer.status) {
    case 200: break;
    case 401: return { kind: 'signed_out' };
    // The key route's own "no Go subscription"; any other refusal is a denial, which keeps nothing.
    case 403: return entitlementError(answer.body) ? { kind: 'unsupported' } : { kind: 'failed' };
    case 404: return { kind: 'unsupported' };
    default: return { kind: 'failed', owner, ...(answer.retryAfterMs !== undefined ? { retryAfterMs: answer.retryAfterMs } : {}) };
  }
  const read = login.route === 'console' ? consoleLimits(answer.body) : keyLimits(answer.body);
  if (read === 'no_plan') return { kind: 'unsupported' };
  if (!read || !read.buckets.some((bucket) => bucket.windows.some((window) => window.usedPercent !== null))) return { kind: 'failed', owner };
  return { kind: 'limits', owner, ...(read.plan ? { plan: read.plan } : {}), buckets: read.buckets };
}

type Answer = { kind: 'answer'; status: number; body: unknown; retryAfterMs?: number } | { kind: 'failed' };

/**
 * One GET within a deadline and a size bound, cancelled with the read. A
 * redirect is refused before it is followed, so the credential reaches no
 * other address; an answer's body is always read to its end or cancelled.
 */
async function getJson(url: string, headers: Record<string, string>, signal: AbortSignal, deps: NonNullable<OpenCodeGoAccountLimitOptions['deps']>): Promise<Answer> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const timer = setTimeout(stop, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  try {
    const response = await (deps.fetch ?? fetch)(url, { method: 'GET', headers, redirect: 'error', signal: controller.signal });
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'failed' };
    }
    const text = await readCapped(response, MAX_BODY_BYTES);
    if (text === null) return { kind: 'failed' };
    const retryAfterMs = retryAfter(response.headers.get('retry-after'), (deps.now ?? Date.now)());
    return { kind: 'answer', status: response.status, body: parseJson(text), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  } catch {
    // The error may quote the request; nothing of it is kept.
    return { kind: 'failed' };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}

/** The body as text, or null past `max` bytes, the stream then cancelled. */
async function readCapped(response: Response, max: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** `Retry-After` as seconds or a date, in milliseconds from now. */
function retryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d{1,9}$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) && at > now ? at - now : undefined;
}

function entitlementError(body: unknown): boolean {
  return isRecord(body) && body.type === 'error' && isRecord(body.error) && body.error.type === 'EntitlementError';
}

type Read = { buckets: AccountLimitBucket[]; plan?: string } | 'no_plan' | null;

/**
 * The Console's Go status: `access` is the member's Go plan, null without
 * one, and its `meters` are amounts of the plan's allowance — not spending —
 * of which only their ratio is read. Every other field, payment and identity
 * included, is left unread.
 */
function consoleLimits(body: unknown): Read {
  if (!isRecord(body)) return null;
  if (body.access === null || body.access === undefined) return 'no_plan';
  if (!isRecord(body.access) || !isRecord(body.access.meters)) return null;
  const meters = body.access.meters;
  const windows = [
    meterWindow({ slot: 'primary', durationMinutes: FIVE_HOURS }, meters.fiveHour),
    meterWindow({ slot: 'secondary', durationMinutes: WEEK }, meters.week),
    meterWindow({ slot: 'tertiary', period: 'month', durationMinutes: null }, meters.month),
  ].filter((window): window is AccountLimitWindow => window !== null);
  const plan = typeof body.product === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/.test(body.product) ? body.product : undefined;
  return { buckets: [{ id: 'opencode-go', windows }], ...(plan ? { plan } : {}) };
}

/** The key route's windows: each its used percentage and reset, as the service floors and caps them. */
function keyLimits(body: unknown): Read {
  if (!isRecord(body) || !isRecord(body.usage)) return null;
  const usage = body.usage;
  const windows = [
    percentWindow({ slot: 'primary', durationMinutes: FIVE_HOURS }, usage.rolling),
    percentWindow({ slot: 'secondary', durationMinutes: WEEK }, usage.weekly),
    percentWindow({ slot: 'tertiary', period: 'month', durationMinutes: null }, usage.monthly),
  ].filter((window): window is AccountLimitWindow => window !== null);
  return { buckets: [{ id: 'opencode-go', windows }] };
}

type Shape = Pick<AccountLimitWindow, 'slot' | 'durationMinutes' | 'period'>;

function meterWindow(shape: Shape, raw: unknown): AccountLimitWindow | null {
  if (!isRecord(raw)) return null;
  return window(shape, meterShare(raw.usedMicroCents, raw.limitMicroCents), raw.resetsAt);
}

function percentWindow(shape: Shape, raw: unknown): AccountLimitWindow | null {
  if (!isRecord(raw)) return null;
  const percent = raw.percent;
  return window(shape, typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null, raw.resetsAt);
}

function window(shape: Shape, usedPercent: number | null, reset: unknown): AccountLimitWindow | null {
  const at = typeof reset === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)$/.test(reset) ? Date.parse(reset) : NaN;
  const resetsAt = Number.isFinite(at) ? new Date(at).toISOString() : null;
  if (usedPercent === null && resetsAt === null) return null;
  return { slot: shape.slot, ...(shape.period ? { period: shape.period } : {}), usedPercent, durationMinutes: shape.durationMinutes, resetsAt };
}

/**
 * `used / limit` as a percentage to a hundredth, rounded up so a sliver of use
 * never reads as none and capped at all of it. Whole amounts only, as numbers
 * or digit strings, computed exactly at any size; no allowance is no share.
 */
function meterShare(used: unknown, limit: unknown): number | null {
  const u = amount(used);
  const l = amount(limit);
  if (u === null || l === null || l === 0n) return null;
  const hundredths = (u * 10_000n + l - 1n) / l;
  return Number(hundredths > 10_000n ? 10_000n : hundredths) / 100;
}

function amount(value: unknown): bigint | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === 'string' && value.length <= MAX_AMOUNT_DIGITS && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
