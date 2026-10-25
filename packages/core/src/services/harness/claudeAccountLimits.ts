import { spawn as nodeSpawn } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AccountLimitBucket, AccountLimitWindow } from '../../models/AccountLimits';
import type { AccountLimitCollector, AccountLimitReading } from '../AccountLimitMonitor';
import type { AgentProcessDeps } from './AgentAdapter';
import { ClaudeCodeAdapter, type ClaudeControlAnswer } from './ClaudeCodeAdapter';
import { settleWithin } from './settleWithin';
import { workspaceEnvOf } from '../workspaceEnv';

/** Spawn, `initialize` and `get_usage` together; the usage handler fetches from the network with no deadline of its own. */
const DEFAULT_TIMEOUT_MS = 20_000;
const INITIALIZE_TIMEOUT_MS = 10_000;
const USAGE_TIMEOUT_MS = 10_000;

/** How the CLI answers a control request it has no handler for (checked on 2.1.309). */
const UNSUPPORTED_REQUEST = /unsupported control request subtype/i;
/** How a CLI too old for one of the probe's flags refuses to start. */
const UNKNOWN_OPTION = /unknown option/i;

const HOUR = 60;
const WEEK = 7 * 24 * HOUR;

/** The account's own windows, in `get_usage`'s `rate_limits`: the five-hour session and the week. */
const ACCOUNT_WINDOWS = [
  { field: 'five_hour', slot: 'primary', minutes: 5 * HOUR },
  { field: 'seven_day', slot: 'secondary', minutes: WEEK },
] as const;

/** The weekly windows metered apart from the account's, each under a name of Ordewell's. */
const SCOPED_WINDOWS = [
  { field: 'seven_day_oauth_apps', name: 'OAuth apps' },
  { field: 'seven_day_opus', name: 'Opus' },
  { field: 'seven_day_sonnet', name: 'Sonnet' },
] as const;

export interface ClaudeAccountLimitOptions {
  timeoutMs?: number;
  /** Installed, not enabled: an account's limits are worth showing before Claude Code is given a task. */
  isInstalled: () => Promise<boolean>;
  /** The workspace the planner and its tasks run in; its environment can choose another account than the host's (ADR-0016). */
  workspaceRoot?: () => string | undefined;
  /** Tests inject the process boundary; the real call stays on the defaults. */
  deps?: Partial<AgentProcessDeps>;
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

/**
 * Claude Code's plan limits, read the way the Agent SDK reads them: the
 * `initialize` and `get_usage` control requests, on a process of its own
 * started for nothing else and taken down after every read. Nothing here
 * writes a user message, so no model is called, and nothing logs in or out,
 * resumes or saves a session, or reads a credential: the CLI uses its own
 * login, as it would for a planner.
 *
 * It runs from an empty directory of its own, so no project's settings or
 * hooks run on every poll, but with the workspace's environment on top of the
 * host's, as the planner and its tasks run: a `CLAUDE_CONFIG_DIR` the
 * workspace sets decides whose account it is, not the host's.
 */
export function claudeAccountLimitCollector(options: ClaudeAccountLimitOptions): AccountLimitCollector {
  return {
    harness: 'claude-code',
    label: 'Claude Code',
    scope: () => ['claude', process.env.CLAUDE_CONFIG_DIR ?? ''].join('\0'),
    acquire: async (signal) => {
      if (!(await options.isInstalled())) return { kind: 'not_installed' };
      if (signal.aborted) return { kind: 'failed' };
      return readClaudeAccountLimits(options, signal);
    },
  };
}

async function readClaudeAccountLimits(options: ClaudeAccountLimitOptions, signal: AbortSignal): Promise<AccountLimitReading> {
  const cwd = mkdtempSync(join(tmpdir(), 'ordewell-claude-limits-'));
  const removeCwd = () => { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* still the cwd of a dying process on Windows: its exit retries */ } };
  const root = options.workspaceRoot?.();
  const adapter = new ClaudeCodeAdapter({
    spawn: nodeSpawn,
    fetch: globalThis.fetch,
    // Resolved from the workspace, not the probe's empty cwd, which has no environment of its own.
    workspaceEnv: root ? () => workspaceEnvOf(root) : async () => ({}),
    ...options.deps,
  });
  adapter.onProcessExit(removeCwd);
  let owner: string | undefined;
  const failed = (): AccountLimitReading => ({ kind: 'failed', ...(owner ? { owner } : {}) });

  const asked = (async (): Promise<AccountLimitReading> => {
    const initialized = await adapter.openAccountQuery(cwd, INITIALIZE_TIMEOUT_MS);
    if (initialized.kind !== 'answered') {
      return initialized.kind === 'silent' && UNKNOWN_OPTION.test(initialized.lastWords ?? '') ? { kind: 'unsupported' } : failed();
    }
    const account = isRecord(initialized.response) ? initialized.response.account : undefined;
    owner = claudeAccountOwner(account);
    const usage = await adapter.queryUsage(USAGE_TIMEOUT_MS);
    if (usage.kind === 'refused' && UNSUPPORTED_REQUEST.test(usage.error)) return { kind: 'unsupported' };
    return claudeLimitReading(usage, owner, isRecord(account) ? text(account.subscriptionType) : undefined) ?? failed();
  })().catch(failed);

  const cancelled = signal.aborted
    ? Promise.resolve()
    : new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  try {
    return await settleWithin(asked, {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onTimeout: failed,
      ended: cancelled,
      onEnded: failed,
    });
  } finally {
    // Its input ending is what a CLI waiting on stdin exits on by itself.
    adapter.endInput();
    adapter.dispose();
    removeCwd();
  }
}

/**
 * Whose account `initialize` names, as a key compared between reads and never
 * shown. Not its plan, which an account changes and another can share. A
 * login that names nobody gets a key of its own, so a later read can never
 * keep its limits as another login's.
 */
function claudeAccountOwner(account: unknown): string {
  const email = isRecord(account) ? text(account.email) : undefined;
  if (!isRecord(account) || !email) return `unnamed\0${randomUUID()}`;
  return [text(account.apiProvider) ?? '', email, text(account.organization) ?? ''].join('\0');
}

/**
 * A full `get_usage` answer: every documented window it reports, each scoped
 * one under its own name after the account's. It replaces what was known; a
 * window it leaves out is gone, not kept. Null for an answer that does not
 * read as one, which fails the read rather than show an empty account.
 */
function claudeLimitReading(usage: ClaudeControlAnswer, owner: string, accountPlan: string | undefined): AccountLimitReading | null {
  if (usage.kind !== 'answered' || !isRecord(usage.response)) return null;
  const { rate_limits_available: available, rate_limits: limits, subscription_type: plan } = usage.response;
  // An API key or a cloud provider's login: there is no plan to have limits.
  if (available === false) return { kind: 'unsupported' };
  if (available !== true || !isRecord(limits)) return null;

  const own: AccountLimitBucket = {
    id: 'claude',
    windows: ACCOUNT_WINDOWS.flatMap(({ field, slot, minutes }) => claudeWindow(slot, minutes, limits[field]) ?? []),
  };
  const fixed = SCOPED_WINDOWS.flatMap(({ field, name }): AccountLimitBucket[] => {
    const window = claudeWindow('primary', WEEK, limits[field]);
    return window ? [{ id: field, name, windows: [window] }] : [];
  });
  // Absent when the CLI answered from its cache: nothing is known of them then, so none is shown.
  const models = (Array.isArray(limits.model_scoped) ? limits.model_scoped : []).flatMap((raw): AccountLimitBucket[] => {
    const name = isRecord(raw) ? text(raw.display_name) : undefined;
    const window = name ? claudeWindow('primary', WEEK, raw) : null;
    return name && window ? [{ id: `model:${name}`, name, windows: [window] }] : [];
  });
  const shownPlan = text(plan) ?? accountPlan;
  // The account's own bucket stays first even when empty: the first bucket is worded as the account's.
  return { kind: 'limits', owner, ...(shownPlan ? { plan: shownPlan } : {}), buckets: [own, ...fixed, ...models] };
}

/**
 * `utilization` is a percentage, 0 to 100, and `resets_at` an ISO instant;
 * anything else — a numeric string, a share past the range, a time with no
 * offset to place it — is unreported, never coerced.
 */
function claudeWindow(slot: AccountLimitWindow['slot'], minutes: number, raw: unknown): AccountLimitWindow | null {
  if (!isRecord(raw)) return null;
  const used = raw.utilization;
  const usedPercent = typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= 100 ? used : null;
  const resetsAt = isoInstant(raw.resets_at);
  if (usedPercent === null && resetsAt === null) return null;
  return { slot, usedPercent, durationMinutes: minutes, resetsAt };
}

/** A date and time with its offset, as an ISO string in UTC; null for one `Date.parse` would read in the local zone. */
function isoInstant(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}
