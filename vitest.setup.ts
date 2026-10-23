import { vi } from 'vitest';

// No test reaches ordewell.ai (ADR-0048). A test of the version check passes
// its own env, so this only silences the CLI, daemon and extension code that
// starts one as a side effect, and every child process they spawn.
process.env.ORDEWELL_NO_VERSION_CHECK = '1';

// vi.waitFor gives up after one second, and vitest has no setting for that.
// Much here waits on real I/O (git, file-system events, child processes), which
// a loaded machine slows past a second: the full suite, under coverage, on a CI
// runner. A wait that succeeds returns as soon as it does, so a longer default
// costs time only in a test that is failing anyway. A timeout a call passes
// itself still wins.
const WAIT_FOR_TIMEOUT_MS = 10_000;

const waitFor = vi.waitFor;
vi.waitFor = ((callback, options) =>
  waitFor(callback, typeof options === 'number' ? options : { timeout: WAIT_FOR_TIMEOUT_MS, ...options })) as typeof vi.waitFor;
