import { describe, it, expect } from 'vitest';
import { handoffOf, migratePlanIsolation, taskIsolationOf, type Adr0013PlanIsolation, type Adr0013TaskRecord } from '../isolationRecord';
import { capConflictFiles } from '../conflictFiles';
import type { IsolationRun, IsolationTaskRecord, IsolationTaskStatus, PlanIsolation } from '../../interfaces/IWorktreeIsolation';

const legacyTask = (taskId: string, order: number, status: IsolationTaskStatus, linked: string[] = []): Adr0013TaskRecord => ({
  taskId, order, title: `Task ${taskId}`, branch: `ordewell/r1/${order}-${taskId}`, worktree: `/work/app/.ordewell/worktrees/r1/${order}-${taskId}`, status, linked,
});

// As 0.4.23 wrote it to `LegacyPlanState.isolation`.
const legacy = (over: Partial<Adr0013PlanIsolation['run']> = {}, resolvers: Record<string, string> = {}): Adr0013PlanIsolation => ({
  run: {
    id: 'r1',
    workspaceRoot: '/work/app',
    baseRef: '0123abcd',
    baseBranch: 'main',
    integrationBranch: 'ordewell/r1/integration',
    tasks: {},
    ...over,
  },
  resolvers,
});

describe('migratePlanIsolation', () => {
  it('turns an ADR-0013 run into a group of one at `.`, keeping its refs', () => {
    expect(migratePlanIsolation(legacy())).toEqual({
      run: {
        id: 'r1',
        workspaceRoot: '/work/app',
        repos: [{ path: '.', root: '/work/app', baseRef: '0123abcd', baseBranch: 'main', integrationBranch: 'ordewell/r1/integration' }],
        shared: [],
        sharedRepos: [],
        tasks: {},
      },
      resolvers: {},
    });
  });

  it('converts a task record in every status', () => {
    const tasks = {
      a: legacyTask('a', 1, 'active', ['node_modules', '.env']),
      k: legacyTask('k', 2, 'kept'),
      c: legacyTask('c', 3, 'conflict'),
      f: legacyTask('f', 4, 'failed'),
      m: legacyTask('m', 5, 'merged'),
    };

    const { run } = migratePlanIsolation(legacy({ tasks }));

    const wt = (name: string) => `/work/app/.ordewell/worktrees/r1/${name}`;
    expect(run.tasks).toEqual({
      a: {
        taskId: 'a', order: 1, title: 'Task a', branch: 'ordewell/r1/1-a', workspace: wt('1-a'), status: 'active',
        repos: { '.': { worktree: wt('1-a'), linked: ['node_modules', '.env'] } },
      },
      k: {
        taskId: 'k', order: 2, title: 'Task k', branch: 'ordewell/r1/2-k', workspace: wt('2-k'), status: 'kept',
        repos: { '.': { worktree: wt('2-k'), linked: [] } },
      },
      c: {
        taskId: 'c', order: 3, title: 'Task c', branch: 'ordewell/r1/3-c', workspace: wt('3-c'), status: 'conflict',
        repos: { '.': { worktree: wt('3-c'), linked: [] } },
        conflictRepo: '.',
      },
      f: {
        taskId: 'f', order: 4, title: 'Task f', branch: 'ordewell/r1/4-f', workspace: wt('4-f'), status: 'failed',
        repos: { '.': { worktree: wt('4-f'), linked: [] } },
      },
      m: {
        taskId: 'm', order: 5, title: 'Task m', branch: 'ordewell/r1/5-m', workspace: wt('5-m'), status: 'merged',
        repos: { '.': { worktree: wt('5-m'), linked: [], changed: true } },
      },
    });
  });

  it('keeps which resolver task resolves which conflict', () => {
    const state = legacy({ tasks: { c: legacyTask('c', 1, 'conflict'), r: legacyTask('r', 2, 'active') } }, { r: 'c' });

    expect(migratePlanIsolation(state).resolvers).toEqual({ r: 'c' });
  });

  it('leaves the base branch out for a run started on a detached HEAD', () => {
    const { run } = migratePlanIsolation(legacy({ baseBranch: undefined }));

    expect(run.repos).toEqual([{ path: '.', root: '/work/app', baseRef: '0123abcd', integrationBranch: 'ordewell/r1/integration' }]);
    expect('baseBranch' in run.repos[0]).toBe(false);
  });

  it('hands off a converted run exactly as the ADR-0013 run would have: its branch, its base, what landed in plan order', () => {
    const tasks = { m2: legacyTask('m2', 2, 'merged'), c: legacyTask('c', 3, 'conflict'), m1: legacyTask('m1', 1, 'merged') };
    const landed = [
      { taskId: 'm1', order: 1, title: 'Task m1' },
      { taskId: 'm2', order: 2, title: 'Task m2' },
    ];

    expect(handoffOf(migratePlanIsolation(legacy({ tasks })).run)).toEqual({
      repos: [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: '0123abcd', baseBranch: 'main', landed }],
      landed,
    });
  });

  it('carries no base branch for a run that started on a detached HEAD', () => {
    const { run } = migratePlanIsolation(legacy({ baseBranch: undefined }));

    expect(handoffOf(run).repos[0]).not.toHaveProperty('baseBranch');
  });

  it('leaves a record already in the repo-group shape as it is', () => {
    const current: PlanIsolation = {
      run: {
        id: 'r2',
        workspaceRoot: '/work/app',
        repos: [{ path: '.', root: '/work/app', baseRef: 'feedbeef', integrationBranch: 'ordewell/r2/integration' }],
        shared: [],
        sharedRepos: [],
        tasks: {},
      },
      resolvers: { x: 'y' },
    };

    expect(migratePlanIsolation(structuredClone(current))).toEqual(current);
  });
});

describe('handoffOf', () => {
  it('names the files a landed task was repaired for, and leaves other landed tasks without them', () => {
    const repaired: IsolationTaskRecord = {
      taskId: 'r', order: 1, title: 'Task r', branch: 'ordewell/r1/1-r', workspace: '/wt/1-r',
      status: 'merged', repos: { '.': { worktree: '/wt/1-r', linked: [], changed: true } },
      repairs: 1, repairedFiles: ['a.ts', 'b.ts'],
    };
    const plain: IsolationTaskRecord = {
      taskId: 'p', order: 2, title: 'Task p', branch: 'ordewell/r1/2-p', workspace: '/wt/2-p',
      status: 'merged', repos: { '.': { worktree: '/wt/2-p', linked: [], changed: true } },
    };
    const run: IsolationRun = {
      id: 'r1', workspaceRoot: '/work/app',
      repos: [{ path: '.', root: '/work/app', baseRef: '0123abcd', integrationBranch: 'ordewell/r1/integration' }],
      shared: [], sharedRepos: [],
      tasks: { r: repaired, p: plain },
    };

    const landed = [
      { taskId: 'r', order: 1, title: 'Task r', repairedFiles: ['a.ts', 'b.ts'] },
      { taskId: 'p', order: 2, title: 'Task p' },
    ];
    expect(handoffOf(run)).toEqual({
      repos: [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: '0123abcd', landed }],
      landed,
    });
  });
});

describe('taskIsolationOf', () => {
  const base: IsolationTaskRecord = {
    taskId: 'c', order: 1, title: 'Task c', branch: 'ordewell/r1/1-c', workspace: '/work/app/.ordewell/worktrees/r1/1-c',
    status: 'conflict', repos: { '.': { worktree: '/work/app/.ordewell/worktrees/r1/1-c', linked: [] } }, conflictRepo: '.',
  };

  it('carries the conflicting files onto the surface view', () => {
    expect(taskIsolationOf({ ...base, conflictFiles: ['a.ts', 'b.ts'] }, 2)).toMatchObject({ conflictFiles: ['a.ts', 'b.ts'] });
  });

  it('leaves conflictFiles out when the record has none', () => {
    expect(taskIsolationOf(base, 2)).not.toHaveProperty('conflictFiles');
  });

  it('shows a repair in flight as repairing, with its attempt out of the most a task may have', () => {
    const repairing: IsolationTaskRecord = { ...base, status: 'repairing', repairs: 1, repairBase: { '.': 'abc' }, conflictFiles: ['a.ts'], repairedFiles: ['a.ts'] };
    expect(taskIsolationOf(repairing, 2)).toEqual({
      state: 'repairing', branch: 'ordewell/r1/1-c', worktree: '/work/app/.ordewell/worktrees/r1/1-c', repos: [],
      conflictRepo: '.', conflictFiles: ['a.ts'], repair: { attempt: 1, limit: 2 }, repairedFiles: ['a.ts'],
    });
  });

  it('keeps what repairs a conflicted or landed task went through, and says nothing of repair before the first', () => {
    expect(taskIsolationOf({ ...base, repairs: 2, repairedFiles: ['a.ts'] }, 2)).toMatchObject({ state: 'conflict', repair: { attempt: 2, limit: 2 }, repairedFiles: ['a.ts'] });
    expect(taskIsolationOf({ ...base, status: 'merged', repairs: 1, repairedFiles: ['a.ts'] }, 2)).toMatchObject({ state: 'integrated', repair: { attempt: 1, limit: 2 } });
    expect(taskIsolationOf(base, 2)).not.toHaveProperty('repair');
    expect(taskIsolationOf(base, 2)).not.toHaveProperty('repairedFiles');
  });
});

describe('capConflictFiles', () => {
  it('joins every file when there are no more than the cap', () => {
    expect(capConflictFiles(['a.ts', 'b.ts'])).toBe('a.ts, b.ts');
  });

  it('caps the list and counts the rest', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];
    expect(capConflictFiles(files)).toBe('a.ts, b.ts, c.ts, d.ts, e.ts, +2 more');
  });
});
