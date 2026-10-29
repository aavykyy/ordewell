import * as path from 'path';
import type * as fsModule from 'fs';
import { claudeManagedSettingsDir } from '../../plugins/builtin/claudeModels';

/**
 * `fs` with this machine's Claude Code managed settings out of sight, for a
 * `vi.mock('fs')` factory. Claude discovery reads that system directory, which
 * no HOME or CLAUDE_CONFIG_DIR override reaches, and an admin's lineup there
 * would replace the one a test wrote.
 */
export function hidingClaudeManagedSettings(actual: typeof fsModule): typeof fsModule {
  const managed = claudeManagedSettingsDir();
  const hidden = (p: unknown): boolean => typeof p === 'string' && (p === managed || p.startsWith(managed + path.sep));
  const missing = (p: unknown): never => {
    throw Object.assign(new Error(`ENOENT: no such file or directory, '${String(p)}'`), { code: 'ENOENT' });
  };
  const call = (fn: unknown, args: unknown[]): unknown => (fn as (...a: unknown[]) => unknown)(...args);
  return {
    ...actual,
    readFileSync: (p: unknown, ...rest: unknown[]) => (hidden(p) ? missing(p) : call(actual.readFileSync, [p, ...rest])),
    readdirSync: (p: unknown, ...rest: unknown[]) => (hidden(p) ? missing(p) : call(actual.readdirSync, [p, ...rest])),
  } as typeof fsModule;
}
