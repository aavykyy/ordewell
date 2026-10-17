import { describe, it, expect } from 'vitest';
import { describeMergeResult } from '../mergeResultNotice';
import type { IsolationLandedTask } from '../../interfaces/IWorktreeIsolation';

describe('describeMergeResult — repaired tasks (ADR-0015)', () => {
  const repaired: IsolationLandedTask[] = [
    { taskId: 'r', order: 1, title: 'Task r', repairedFiles: ['a.ts', 'b.ts'] },
  ];

  it('names a repaired task and its files alongside a clean merge', () => {
    const { message } = describeMergeResult({ outcome: 'merged' }, 'ordewell/r1/integration', false, repaired);
    expect(message).toBe(
      'Merged ordewell/r1/integration into your checked-out branch. Task r (a.ts, b.ts) landed through a conflict repair.',
    );
  });

  it('names more than one repaired task', () => {
    const both = [...repaired, { taskId: 's', order: 2, title: 'Task s', repairedFiles: ['c.ts'] }];
    const { message } = describeMergeResult({ outcome: 'merged' }, 'ordewell/r1/integration', true, both);
    expect(message).toBe(
      'Merged ordewell/r1/integration into the checked-out branch of every repository. Task r (a.ts, b.ts) and Task s (c.ts) landed through conflict repairs.',
    );
  });

  it('says nothing extra when no landed task was repaired', () => {
    const { message } = describeMergeResult({ outcome: 'merged' }, 'ordewell/r1/integration', false, []);
    expect(message).toBe('Merged ordewell/r1/integration into your checked-out branch.');
  });

  it('defaults to no repaired tasks when the caller has none to report', () => {
    const { message } = describeMergeResult({ outcome: 'merged' }, 'ordewell/r1/integration', false);
    expect(message).toBe('Merged ordewell/r1/integration into your checked-out branch.');
  });
});

describe('describeMergeResult — a repo off the branch the run started on', () => {
  const branch = 'ordewell/r1/integration';

  it('names the branch checked out, the one the run started on, and the fix', () => {
    const { level, message } = describeMergeResult({
      outcome: 'blocked',
      blocked: [{ repo: 'api', reason: 'wrong-branch', files: [], expected: 'main', actual: 'feature-x' }],
    }, branch, true);
    expect(level).toBe('warn');
    expect(message).toBe(
      'Merged nothing, so every tree is as it was: api is on feature-x; this run started on main. Check out main and press Merge all again.',
    );
  });

  it('speaks of the checkout for a lone repository, and of a detached HEAD', () => {
    const { message } = describeMergeResult({
      outcome: 'blocked',
      blocked: [{ repo: '.', reason: 'wrong-branch', files: [], expected: 'main' }],
    }, branch, false);
    expect(message).toBe(
      'Merged nothing, so every tree is as it was: your checkout is on a detached HEAD; this run started on main. Check out main and press Merge all again.',
    );
  });

  it('names every repository that is off, with the branch each started on', () => {
    const { message } = describeMergeResult({
      outcome: 'blocked',
      blocked: [
        { repo: 'api', reason: 'wrong-branch', files: [], expected: 'main', actual: 'x' },
        { repo: 'web', reason: 'wrong-branch', files: [], expected: 'develop', actual: 'main' },
      ],
    }, branch, true);
    expect(message).toBe(
      'Merged nothing, so every tree is as it was: api is on x; this run started on main; web is on main; this run started on develop. Check out the branch each repository started on and press Merge all again.',
    );
  });
});
