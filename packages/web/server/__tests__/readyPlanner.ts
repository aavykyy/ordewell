import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Gives every test in the calling file a planner that passes the daemon's
 * readiness check. These tests exercise the turn's plumbing with the session's
 * turn stubbed; without a key and model the daemon would refuse before the
 * stub is reached, and which tests pass would depend on the developer's own
 * environment.
 */
export function withReadyPlanner(): void {
  beforeEach(() => {
    vi.stubEnv('AI_PROVIDER', 'openrouter');
    vi.stubEnv('ORCHESTRATOR_MODEL', 'openrouter/auto');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
  });
  afterEach(() => vi.unstubAllEnvs());
}
