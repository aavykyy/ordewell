import { afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Gives every test in the calling file a planner that passes the daemon's
 * readiness check. These tests exercise the turn's plumbing with the session's
 * turn stubbed; without a key and model the daemon would refuse before the
 * stub is reached, and which tests pass would depend on the developer's own
 * environment.
 *
 * The daemon also reads the user's saved runner choice from the global
 * settings file and, with none saved, the agents the host has installed. Both
 * are the developer's, not the test's: a machine that disabled claude-code or
 * lacks it would refuse the runners these tests request, while CI's empty home
 * passes. A settings file of the test's own and one pinned enabled set keep
 * every host on the same input.
 */
export function withReadyPlanner(): void {
  let settingsDir: string | undefined;
  beforeEach(() => {
    vi.stubEnv('AI_PROVIDER', 'openrouter');
    vi.stubEnv('ORCHESTRATOR_MODEL', 'openrouter/auto');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    settingsDir = mkdtempSync(join(tmpdir(), 'ordewell-ready-planner-'));
    vi.stubEnv('ORDEWELL_SETTINGS_PATH', join(settingsDir, 'settings.json'));
    vi.stubEnv('ORDEWELL_ENABLED_RUNNERS', 'claude-code');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    if (settingsDir) rmSync(settingsDir, { recursive: true, force: true });
    settingsDir = undefined;
  });
}
