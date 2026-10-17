import { describe, it, expect } from 'vitest';
import { checkoutRule, handoffBase, isolationOfPlan, isRepoGroup, mergeOutcome, mergeTarget, repairedNotice, repoResultLines, taskRepoNames } from '../isolation';
import type { HandoffView } from '../tui/state';

const record = (taskId: string, order: number, status: string) => ({
  taskId, order, title: `Task ${taskId}`, branch: `ordewell/r1/${order}-${taskId}`, worktree: `/ws/.ordewell/worktrees/r1/${order}-${taskId}`, status, linked: [],
});

const plan = {
  tasks: [],
  isolation: {
    resolvers: {},
    run: {
      id: 'r1', workspaceRoot: '/ws', baseRef: 'abc123', baseBranch: 'main', integrationBranch: 'ordewell/r1/integration',
      tasks: {
        b: record('b', 2, 'merged'),
        a: record('a', 1, 'merged'),
        c: record('c', 3, 'conflict'),
        d: record('d', 4, 'failed'),
        e: record('e', 5, 'active'),
      },
    },
  },
};

describe('isolationOfPlan', () => {
  it('lists what landed in plan order, not record order', () => {
    const landed = [{ taskId: 'a', order: 1, title: 'Task a' }, { taskId: 'b', order: 2, title: 'Task b' }];
    expect(isolationOfPlan(plan)!.handoff).toEqual({
      repos: [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: 'abc123', baseBranch: 'main', landed }],
      landed,
    });
  });

  it('names each task\'s state the way a surface shows it', () => {
    const { tasks } = isolationOfPlan(plan)!;
    expect(Object.fromEntries(Object.entries(tasks).map(([id, t]) => [id, t.state]))).toEqual({
      a: 'integrated', b: 'integrated', c: 'conflict', d: 'kept', e: 'active',
    });
    expect(tasks.c.branch).toBe('ordewell/r1/3-c');
  });

  it('reads a repo-group record as it reads the ADR-0013 one, for a group of one', () => {
    const groupRecord = (taskId: string, order: number, status: string) => ({
      taskId, order, title: `Task ${taskId}`, branch: `ordewell/r1/${order}-${taskId}`, workspace: `/ws/.ordewell/worktrees/r1/${order}-${taskId}`, status,
      repos: { '.': { worktree: `/ws/.ordewell/worktrees/r1/${order}-${taskId}`, linked: [], ...(status === 'merged' ? { changed: true } : {}) } },
      ...(status === 'conflict' ? { conflictRepo: '.' } : {}),
    });
    const groupPlan = {
      tasks: [],
      isolation: {
        resolvers: {},
        run: {
          id: 'r1', workspaceRoot: '/ws', shared: [],
          repos: [{ path: '.', root: '/ws', baseRef: 'abc123', baseBranch: 'main', integrationBranch: 'ordewell/r1/integration' }],
          tasks: {
            b: groupRecord('b', 2, 'merged'),
            a: groupRecord('a', 1, 'merged'),
            c: groupRecord('c', 3, 'conflict'),
            d: groupRecord('d', 4, 'failed'),
            e: groupRecord('e', 5, 'active'),
          },
        },
      },
    };

    expect(isolationOfPlan(groupPlan)).toEqual(isolationOfPlan(plan));
    expect(isolationOfPlan(groupPlan)!.tasks.c).toEqual({
      state: 'conflict', branch: 'ordewell/r1/3-c', worktree: '/ws/.ordewell/worktrees/r1/3-c', repos: [], conflictRepo: '.',
    });
  });

  it.each([null, undefined, {}, { tasks: [] }, { isolation: {} }, 'nope'])('says nothing for %j', (payload) => {
    expect(isolationOfPlan(payload)).toBeNull();
  });

  it('reads a repairing task, and the files a landed one was repaired for (ADR-0015)', () => {
    const repairingPlan = {
      tasks: [],
      isolation: {
        resolvers: {},
        run: {
          id: 'r1', workspaceRoot: '/ws', baseRef: 'abc123', integrationBranch: 'ordewell/r1/integration',
          tasks: {
            r: { ...record('r', 1, 'repairing'), conflictFiles: ['a.ts'], repairs: 1, repairedFiles: ['a.ts'] },
            m: { ...record('m', 2, 'merged'), repairs: 1, repairedFiles: ['b.ts'] },
          },
        },
      },
    };

    const { tasks, handoff } = isolationOfPlan(repairingPlan)!;
    expect(tasks.r).toMatchObject({ state: 'repairing', conflictFiles: ['a.ts'], repairedFiles: ['a.ts'] });
    expect(handoff.landed).toEqual([{ taskId: 'm', order: 2, title: 'Task m', repairedFiles: ['b.ts'] }]);
  });
});

const t = (order: number) => ({ taskId: `t${order}`, order, title: `Task ${order}` });
const group: HandoffView = {
  repos: [
    { path: 'api', integrationBranch: 'ordewell/r1/integration', baseRef: 'aaa', landed: [t(1), t(2), t(3)] },
    { path: 'web', integrationBranch: 'ordewell/r1/integration', baseRef: 'bbb', landed: [t(3)] },
    { path: 'infra', integrationBranch: 'ordewell/r1/integration', baseRef: 'ccc', landed: [] },
  ],
  landed: [t(1), t(2), t(3)],
};
const single: HandoffView = {
  repos: [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: 'aaa', landed: [t(1)] }],
  landed: [t(1)],
};

describe('a repo group in a handoff', () => {
  it('is any handoff but a lone repo at the workspace root', () => {
    expect(isRepoGroup(group)).toBe(true);
    expect(isRepoGroup({ ...group, repos: [group.repos[0]] })).toBe(true);
    expect(isRepoGroup(single)).toBe(false);
  });

  it('says per repo what landed, or that there is nothing to merge', () => {
    expect(repoResultLines(group)).toEqual(['api: 3 tasks landed', 'web: 1 task landed', 'infra: nothing to merge']);
  });

  it('names the repos of a task, and none for a group of one', () => {
    expect(taskRepoNames({ state: 'integrated', repos: ['api', 'web'] })).toEqual(['api', 'web']);
    expect(taskRepoNames({ state: 'integrated', repos: ['.'] })).toEqual([]);
    expect(taskRepoNames({ state: 'active' })).toEqual([]);
  });
});

describe('what Merge all says', () => {
  const branch = 'ordewell/r1/integration';

  it('words a group of one as before', () => {
    expect(mergeOutcome({ outcome: 'merged' }, branch, false)).toEqual({ ok: true, message: `Merged ${branch} into your checked-out branch.` });
    expect(mergeOutcome({ outcome: 'conflict', repo: '.', files: ['a.txt'] }, branch, false)).toEqual({
      ok: false,
      message: `Merging ${branch} conflicted, so it was aborted: your tree is as it was. Merge it with git and resolve the conflict there.`,
    });
    expect(mergeOutcome({ outcome: 'failed', repo: '.' }, branch, false)).toEqual({
      ok: false,
      message: `Could not merge ${branch}: finish or abort the merge already in progress, then try again.`,
    });
  });

  it('says a group merged into every repository', () => {
    expect(mergeOutcome({ outcome: 'merged' }, branch, true)).toEqual({ ok: true, message: `Merged ${branch} into the checked-out branch of every repository.` });
  });

  it('names each repo that blocked it, why, and its files, and says the branches can be merged by hand', () => {
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

  it('says which repos had landed when git without merge-tree stopped part-way', () => {
    const { message } = mergeOutcome({ outcome: 'conflict', repo: 'web', files: ['w.txt'], landed: ['api'] }, branch, true);

    expect(message).toContain('conflicted in web (w.txt)');
    expect(message).toContain('api was merged already and stays merged.');
  });

  it('names a task that only landed after a conflict repair, and its files (ADR-0015)', () => {
    const { message } = mergeOutcome(
      { outcome: 'merged' }, branch, false, [{ taskId: 't1', order: 1, title: 'Task t1', repairedFiles: ['a.ts'] }],
    );

    expect(message).toBe(`Merged ${branch} into your checked-out branch. Task t1 (a.ts) landed through a conflict repair.`);
  });
});

describe('repairedNotice', () => {
  it('says nothing when no landed task was repaired', () => {
    expect(repairedNotice(single)).toBe('');
  });

  it('names a repaired task and its files, before the merge lands it (ADR-0015)', () => {
    const handoff: HandoffView = { ...single, landed: [{ ...single.landed[0], repairedFiles: ['a.ts', 'b.ts'] }] };

    expect(repairedNotice(handoff)).toBe(' Task 1 (a.ts, b.ts) landed through a conflict repair.');
  });

  it('names more than one repaired task', () => {
    const handoff: HandoffView = {
      ...group,
      landed: [{ ...group.landed[0], repairedFiles: ['a.ts'] }, { ...group.landed[1], repairedFiles: ['b.ts'] }, group.landed[2]],
    };

    expect(repairedNotice(handoff)).toBe(' Task 1 (a.ts) and Task 2 (b.ts) landed through conflict repairs.');
  });
});

describe('where the run forked from', () => {
  const named = (path: string, baseBranch: string | undefined, baseRef: string, startedDetached = baseBranch === undefined) => (
    { path, integrationBranch: 'ordewell/r1/integration', baseRef, ...(baseBranch ? { baseBranch } : {}), ...(startedDetached ? { startedDetached: true as const } : {}), landed: [t(1)] }
  );

  it('names the branch and the commit for a lone repo, and a detached HEAD as that', () => {
    expect(handoffBase({ repos: [named('.', 'main', 'abcdef1234567890')], landed: [] }, 12)).toBe('main @ abcdef123456');
    expect(handoffBase({ repos: [named('.', undefined, 'abcdef1234567890')], landed: [] }, 8)).toBe('detached at abcdef12');
  });

  it('does not call a record that never noted its branch detached', () => {
    expect(handoffBase({ repos: [named('.', undefined, 'abcdef1234567890', false)], landed: [] }, 8)).toBe('base abcdef12');
  });

  it('reads the detached marker from a saved run, and leaves it off a legacy one', () => {
    const plan = { isolation: { run: { repos: [
      { path: 'api', root: '/ws/api', baseRef: 'aaa', startedDetached: true, integrationBranch: 'ordewell/r1/integration' },
      { path: 'web', root: '/ws/web', baseRef: 'bbb', integrationBranch: 'ordewell/r1/integration' },
    ], tasks: {} } } };

    expect(isolationOfPlan(plan)!.handoff.repos.map((r) => r.startedDetached)).toEqual([true, undefined]);
  });

  it('heads each repo of a group', () => {
    const handoff: HandoffView = { repos: [named('api', 'main', 'aaaa1111'), named('web', undefined, 'bbbb2222')], landed: [] };

    expect(handoffBase(handoff, 12)).toBe('api: main @ aaaa1111, web: detached at bbbb2222');
  });

  it('is read from a saved run, for a group and for an ADR-0013 record', () => {
    const groupPlan = { isolation: { run: { repos: [
      { path: 'api', root: '/ws/api', baseRef: 'aaa', baseBranch: 'develop', integrationBranch: 'ordewell/r1/integration' },
      { path: 'web', root: '/ws/web', baseRef: 'bbb', integrationBranch: 'ordewell/r1/integration' },
    ], tasks: {} } } };

    expect(isolationOfPlan(groupPlan)!.handoff.repos.map((r) => r.baseBranch)).toEqual(['develop', undefined]);
  });
});

describe('where Merge all lands, for a confirmation', () => {
  const named = (path: string, baseBranch: string | undefined, landed = [t(1)]) => (
    { path, integrationBranch: 'ordewell/r1/integration', baseRef: 'aaa', ...(baseBranch ? { baseBranch } : {}), landed }
  );

  it('names the branch for a lone repo, and the branch that must be checked out', () => {
    const handoff: HandoffView = { repos: [named('.', 'main')], landed: [t(1)] };

    expect(mergeTarget(handoff)).toBe('main');
    expect(checkoutRule(handoff)).toBe(' Nothing is merged unless main is checked out.');
  });

  it('keeps saying the branch you have checked out for a run that started detached', () => {
    const handoff: HandoffView = { repos: [named('.', undefined)], landed: [t(1)] };

    expect(mergeTarget(handoff)).toBe('the branch you have checked out');
    expect(checkoutRule(handoff)).toBe('');
  });

  it('names one branch once for a group, and each repo with its own when they differ', () => {
    const same: HandoffView = { repos: [named('api', 'main'), named('web', 'main'), named('infra', 'main', [])], landed: [t(1)] };
    const mixed: HandoffView = { repos: [named('api', 'main'), named('web', 'develop'), named('docs', undefined)], landed: [t(1)] };

    expect(mergeTarget(same)).toBe('main in each of api, web');
    expect(mergeTarget(mixed)).toBe('each of api (main), web (develop), docs (as checked out)');
    expect(checkoutRule(mixed)).toBe(' Nothing is merged unless each repository is on the branch it started on.');
  });
});

describe('what Merge all says when a repo is on another branch', () => {
  it('names the branch to check out', () => {
    const { ok, message } = mergeOutcome({
      outcome: 'blocked',
      blocked: [{ repo: '.', reason: 'wrong-branch', files: [], expected: 'main', actual: 'feature-x' }],
    }, 'ordewell/r1/integration', false);

    expect(ok).toBe(false);
    expect(message).toBe('Merged nothing, so every tree is as it was: your checkout is on feature-x; this run started on main. Check out main and press Merge all again.');
  });
});
