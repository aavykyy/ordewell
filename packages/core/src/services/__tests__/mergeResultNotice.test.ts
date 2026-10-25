import { describe, it, expect } from 'vitest';
import { blockNotice, blockNotices, describeMergeResult, mergeOutcome, repairedLanded, repairedNotice } from '../mergeResultNotice';
import type { IsolationLandedTask } from '../../interfaces/IWorktreeIsolation';

const repairedTask = (order: number, files?: string[]): IsolationLandedTask => ({
  taskId: `r${order}`, order, title: `Task ${order}`, ...(files ? { repairedFiles: files } : {}),
});

describe('repairedNotice — the landing note a surface appends', () => {
  it('says nothing when no landed task was repaired', () => {
    expect(repairedNotice({ landed: [{ taskId: 'p', order: 1, title: 'Task p' }] })).toBe('');
  });

  it('names a repaired task and its files, as a leading-space sentence', () => {
    expect(repairedNotice({ landed: [repairedTask(1, ['a.ts', 'b.ts'])] })).toBe(' Task 1 (a.ts, b.ts) landed through a conflict repair.');
  });

  it('names more than one repaired task', () => {
    expect(repairedNotice({ landed: [repairedTask(1, ['a.ts']), repairedTask(2, ['b.ts']), repairedTask(3)] }))
      .toBe(' Task 1 (a.ts) and Task 2 (b.ts) landed through conflict repairs.');
  });

  it('names no task whose repair listed no file, and leaves no empty brackets', () => {
    expect(repairedNotice({ landed: [repairedTask(1, [])] })).toBe('');
    expect(repairedLanded({ landed: [repairedTask(1, [])] })).toEqual([]);
  });

  it('leaves no empty brackets in a merge note either', () => {
    expect(mergeOutcome({ outcome: 'merged' }, 'ordewell/r1/integration', false, [repairedTask(1, [])]).message)
      .toBe('Merged ordewell/r1/integration into your checked-out branch.');
  });
});

describe('blockNotice — one repo, one line', () => {
  it('words each reason a Merge all can stop on', () => {
    const branch = 'ordewell/r1/integration';
    expect(blockNotice({ repo: 'api', reason: 'merge-in-progress', files: [] })).toBe('api has a merge in progress');
    expect(blockNotice({ repo: 'api', reason: 'conflict', files: ['a.ts', 'b.ts'] })).toBe('api would conflict in a.ts, b.ts');
    expect(blockNotice({ repo: 'api', reason: 'uncommitted-changes', files: ['a.ts'] })).toBe('api has uncommitted changes to a.ts');
    expect(blockNotice({ repo: 'api', reason: 'partial-landing', files: [] })).toBe('api holds part of a task whose landing could not be rolled back');
    expect(blockNotice({ repo: 'api', reason: 'git-error', files: [] })).toBe('git could not check api');
    expect(blockNotice({ repo: '.', reason: 'wrong-branch', files: [], expected: 'main', actual: 'feature-x' }))
      .toBe('your checkout is on feature-x; this run started on main');
    expect(blockNotice({ repo: 'api', reason: 'wrong-branch', files: [], expected: 'main', rebasing: true }))
      .toBe('api is in the middle of a rebase; this run started on main');
    expect(blockNotice({ repo: 'api', reason: 'wrong-branch', files: [], expected: branch, actual: undefined }))
      .toBe(`api is on a detached HEAD; this run started on ${branch}`);
  });

  it('keeps every blocked repo in the order Merge all named them', () => {
    expect(blockNotices([
      { repo: 'api', reason: 'conflict', files: ['a.ts'] },
      { repo: 'web', reason: 'uncommitted-changes', files: ['b.ts'] },
    ])).toEqual(['api would conflict in a.ts', 'web has uncommitted changes to b.ts']);
  });
});

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

  it('sends a repository mid-rebase to finish or abort it, not to check a branch out', () => {
    const { message } = describeMergeResult({
      outcome: 'blocked',
      blocked: [{ repo: 'api', reason: 'wrong-branch', files: [], expected: 'main', rebasing: true }],
    }, branch, true);
    expect(message).toBe(
      'Merged nothing, so every tree is as it was: api is in the middle of a rebase; this run started on main. Finish or abort the rebase in api, then press Merge all again.',
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

describe('describeMergeResult — a merge git refused', () => {
  const branch = 'ordewell/r1/integration';

  it('quotes what git said for a lone repository instead of sending the user to a merge in progress', () => {
    const { level, message } = describeMergeResult({ outcome: 'failed', repo: '.', error: 'error: Your local changes to the following files would be overwritten by merge:' }, branch, false);
    expect(level).toBe('error');
    expect(message).toBe(`Could not merge ${branch}: git said "error: Your local changes to the following files would be overwritten by merge:". Your tree is as it was.`);
  });

  it('quotes what git said for the repository of a group, and names those already merged', () => {
    const { message } = describeMergeResult({ outcome: 'failed', repo: 'web', error: 'lint: subject is too long', landed: ['api'] }, branch, true);
    expect(message).toBe(`Could not merge ${branch} in web: git said "lint: subject is too long". api was merged already and stays merged.`);
  });

  it('still sends the user to their own merge in progress when git was never asked', () => {
    expect(describeMergeResult({ outcome: 'failed', repo: '.' }, branch, false).message)
      .toBe(`Could not merge ${branch}: finish or abort the merge already in progress, then try again.`);
    expect(describeMergeResult({ outcome: 'failed', repo: 'web', landed: ['api'] }, branch, true).message)
      .toBe(`Could not merge ${branch} in web: finish or abort any merge in progress there, then try again. api was merged already and stays merged.`);
  });
});

describe('mergeOutcome — the next step every surface gives', () => {
  const branch = 'ordewell/r1/integration';

  it('tells a lone repo with a conflict to merge it with git', () => {
    expect(mergeOutcome({ outcome: 'conflict', repo: '.', files: ['a.txt'] }, branch, false)).toEqual({
      ok: false,
      message: `Merging ${branch} conflicted, so it was aborted: your tree is as it was. Merge it with git and resolve the conflict there.`,
    });
  });

  it('tells a group that did not merge that each branch can be merged by hand', () => {
    const { ok, message } = mergeOutcome({
      outcome: 'blocked',
      blocked: [{ repo: 'api', reason: 'conflict', files: ['src/a.ts'] }],
    }, branch, true);

    expect(ok).toBe(false);
    expect(message).toBe(
      `Merged nothing, so every tree is as it was: api would conflict in src/a.ts. Each repository's ${branch} is a plain branch you can merge by hand.`,
    );
  });

  it('words a clean merge of a lone repo as the branch the user has checked out', () => {
    expect(mergeOutcome({ outcome: 'merged' }, branch, false)).toEqual({ ok: true, message: `Merged ${branch} into your checked-out branch.` });
  });

  it('names each repo that blocked a group, why and in which files, before the hand-merge line', () => {
    const { ok, message } = mergeOutcome({
      outcome: 'blocked',
      blocked: [
        { repo: 'api', reason: 'conflict', files: ['src/a.ts'] },
        { repo: 'web', reason: 'uncommitted-changes', files: ['index.html'] },
      ],
    }, branch, true);

    expect(ok).toBe(false);
    expect(message).toContain('api would conflict in src/a.ts; web has uncommitted changes to index.html');
    expect(message).toContain(`Each repository's ${branch} is a plain branch you can merge by hand.`);
  });

  it('says which repos had landed when a group stopped part-way, and still offers the hand-merge', () => {
    const { ok, message } = mergeOutcome({ outcome: 'conflict', repo: 'web', files: ['w.txt'], landed: ['api'] }, branch, true);

    expect(ok).toBe(false);
    expect(message).toContain('conflicted in web (w.txt)');
    expect(message).toContain('api was merged already and stays merged.');
    expect(message).toContain(`Each repository's ${branch} is a plain branch you can merge by hand.`);
  });

  it('adds no hand-merge advice to a clean merge or a lone repo', () => {
    expect(mergeOutcome({ outcome: 'merged' }, branch, true)).toEqual({
      ok: true,
      message: `Merged ${branch} into the checked-out branch of every repository.`,
    });
    expect(mergeOutcome({ outcome: 'failed', repo: '.' }, branch, false).message)
      .toBe(`Could not merge ${branch}: finish or abort the merge already in progress, then try again.`);
  });
});
