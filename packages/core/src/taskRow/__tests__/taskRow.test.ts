import { describe, it, expect } from 'vitest';
import {
  taskRowView, taskStatusKind, isTaskRunning, awaitingLabel, approvalLabel, resumeLabel, resumeTime, taskRowActions, markAction, markRequestFor, opsEditable,
  titledRefs, dependentsNotice, pastGateConfirmation, newTaskFields, blockedByLabel, skippedLabel, type TaskRowSubject, type TaskRowAction,
} from '..';
import { taskRef, titledTaskRef } from '../../services/TaskRefs';

const STATUSES = ['pending', 'approved', 'blocked', 'in_progress', 'awaiting_user', 'completed', 'failed', 'skipped'] as const;

const subject = (over: Partial<TaskRowSubject> = {}): TaskRowSubject => ({
  id: 't2', order: 2, type: 'ai', status: 'pending', dependencies: [], ...over,
});
const tasks = [{ id: 't1', order: 1, title: 'One' }, { id: 't2', order: 2, title: 'Two' }];

describe('status kind', () => {
  it.each([
    ['pending', null, 'todo', false],
    ['approved', null, 'todo', false],
    ['blocked', null, 'blocked', false],
    ['in_progress', null, 'running', true],
    ['in_progress', '2026-01-01T00:00:00Z', 'quiet', true],
    ['running', null, 'running', true],
    ['running', '2026-01-01T00:00:00Z', 'running', true],
    ['awaiting_user', null, 'awaiting', false],
    ['completed', null, 'done', false],
    ['completed', '2026-01-01T00:00:00Z', 'done', false],
    ['failed', null, 'failed', false],
    ['skipped', null, 'skipped', false],
    ['something-new', null, 'todo', false],
  ])('%s, silent since %s, is %s', (status, idleSince, kind, running) => {
    expect(taskStatusKind({ status, idleSince })).toBe(kind);
    expect(isTaskRunning({ status })).toBe(running);
  });
});

describe('labels', () => {
  it.each([
    ['input', 'Waiting for your input'],
    ['checkpoint', 'Checkpoint'],
    ['conflict', 'Merge conflict'],
    ['files-changed', 'Changed tracked files'],
    ['usage-limit', 'Paused on a usage limit'],
  ] as const)('an awaiting task waiting on %s reads "%s"', (awaitingReason, label) => {
    expect(awaitingLabel({ status: 'awaiting_user', awaitingReason })).toBe(label);
  });

  it.each(STATUSES.filter((s) => s !== 'awaiting_user'))('a reason left on a %s task says nothing', (status) => {
    expect(awaitingLabel({ status, awaitingReason: 'input' })).toBeNull();
  });

  it('says nothing for a wait with no saved reason', () => {
    expect(awaitingLabel({ status: 'awaiting_user' })).toBeNull();
  });

  it.each([
    [undefined, null],
    [0, null],
    [1, 'Waiting for approval'],
    [2, 'Waiting for approval (2)'],
  ])('%s approvals read %s', (count, label) => {
    expect(approvalLabel(count)).toBe(label);
  });

  it('refers to a task by its order, dotted under a parent', () => {
    expect(taskRef({ order: 3 })).toBe('#3');
    expect(taskRef({ order: 1 }, { order: 2 })).toBe('#2.1');
    expect(titledTaskRef({ order: 3, title: 'Deploy' })).toBe('#3 Deploy');
  });
});

describe('a task paused on a usage limit', () => {
  const now = new Date(2026, 9, 11, 17, 0);
  const paused = { status: 'awaiting_user', type: 'ai' as const, awaitingReason: 'usage-limit' as const };

  it('shows no resume time when the saved one does not parse', () => {
    expect(resumeLabel({ ...paused, resumeAt: 'not a date' }, now)).toBeNull();
  });

  it('reads when it resumes, on the reader\'s clock, with the date when it is not today', () => {
    expect(resumeTime(new Date(2026, 9, 11, 20, 10), now)).toBe('8:10pm');
    expect(resumeTime(new Date(2026, 9, 11, 9, 0), now)).toBe('9am');
    expect(resumeTime(new Date(2026, 9, 14, 12, 5), now)).toBe('Oct 14, 12:05pm');
    expect(resumeLabel({ ...paused, resumeAt: new Date(2026, 9, 11, 20, 10).toISOString() }, now)).toBe('Resumes at 8:10pm');
  });

  it('offers to cancel the resume only while one is scheduled', () => {
    const resumeAt = new Date(2026, 9, 11, 20, 10).toISOString();
    expect(taskRowActions({ ...paused, resumeAt })).toEqual(['cancel-resume', 'skip', 'complete']);
    expect(taskRowActions({ ...paused, resumeAt }, 'subtask')).toEqual(['cancel-resume', 'complete']);
    expect(taskRowActions(paused)).toEqual(['skip', 'complete']);
    expect(taskRowView(subject({ ...paused, resumeAt }), { now }).resumes).toBe('Resumes at 8:10pm');
    expect(taskRowView(subject(paused), { now }).resumes).toBeNull();
  });

  it('offers to resume now when its session was saved, with or without a resume time, before not resuming', () => {
    const resumeAt = new Date(2026, 9, 11, 20, 10).toISOString();
    expect(taskRowActions({ ...paused, resumeAt, continuable: true })).toEqual(['resume-now', 'cancel-resume', 'skip', 'complete']);
    expect(taskRowActions({ ...paused, continuable: true })).toEqual(['resume-now', 'skip', 'complete']);
    expect(taskRowActions({ ...paused, resumeAt, continuable: true }, 'subtask')).toEqual(['resume-now', 'cancel-resume', 'complete']);
    expect(taskRowActions({ status: 'failed', type: 'ai', continuable: true })).not.toContain('resume-now');
    expect(taskRowActions({ status: 'awaiting_user', type: 'ai', awaitingReason: 'input', continuable: true })).not.toContain('resume-now');
  });

  it('says nothing of a resume time left on a task in any other state', () => {
    const resumeAt = new Date(2026, 9, 11, 20, 10).toISOString();
    expect(resumeLabel({ status: 'awaiting_user', awaitingReason: 'input', resumeAt })).toBeNull();
    expect(resumeLabel({ status: 'pending', awaitingReason: 'usage-limit', resumeAt })).toBeNull();
    expect(taskRowActions({ status: 'pending', type: 'ai', awaitingReason: 'usage-limit', resumeAt })).toEqual(['force-start']);
  });
});

describe('actions per status', () => {
  const table: [string, 'ai' | 'user', TaskRowAction[], TaskRowAction[]][] = [
    ['pending', 'ai', ['force-start'], ['force-start', 'skip']],
    ['approved', 'ai', ['force-start'], ['force-start', 'skip']],
    ['blocked', 'ai', ['skip', 'force-start'], []],
    ['in_progress', 'ai', ['cancel'], ['cancel', 'complete']],
    ['awaiting_user', 'ai', ['skip', 'complete'], ['complete']],
    ['completed', 'ai', ['uncomplete'], ['uncomplete']],
    ['failed', 'ai', ['skip'], ['skip']],
    ['skipped', 'ai', ['complete'], ['complete']],
    ['pending', 'user', ['complete'], ['skip']],
    ['approved', 'user', ['complete'], ['skip']],
    ['blocked', 'user', ['skip', 'complete'], []],
    ['in_progress', 'user', ['cancel', 'complete'], ['cancel']],
    ['awaiting_user', 'user', ['skip', 'complete'], ['complete']],
    ['completed', 'user', ['complete', 'uncomplete'], ['uncomplete']],
    ['failed', 'user', ['skip', 'complete'], ['skip']],
    ['skipped', 'user', ['complete'], ['complete']],
  ];

  it.each(table)('a %s %s task offers %j, as a subtask %j', (status, type, asTask, asSubtask) => {
    expect(taskRowActions({ status, type })).toEqual(asTask);
    expect(taskRowActions({ status, type }, 'subtask')).toEqual(asSubtask);
    expect(taskRowView(subject({ status, type })).actions).toEqual(asTask);
    expect(taskRowView(subject({ status, type }), { parent: { order: 1 } }).actions).toEqual(asSubtask);
  });

  it.each(STATUSES)('the mark toggle on a %s task', (status) => {
    expect(markAction({ status })).toBe(status === 'completed' ? 'uncomplete' : 'complete');
  });

  it.each(STATUSES)('ops can be flipped on a %s AI task only before it starts, never on a manual one', (status) => {
    expect(opsEditable({ status, type: 'ai' })).toBe(['pending', 'approved', 'blocked'].includes(status));
    expect(opsEditable({ status, type: 'user' })).toBe(false);
  });

  it.each([
    ['complete', 'complete'],
    ['skip', null],
    ['uncomplete', 'uncomplete'],
    ['cancel', null],
    ['force-start', null],
    ['retry', null],
  ])('%s asks for the mark %s', (action, mark) => {
    expect(markRequestFor(action)).toBe(mark);
  });
});

describe('the row view, every status against every annotation', () => {
  const isolated = { branch: 'b', worktree: 'w', repos: ['.'] };
  const annotations: [string, Partial<TaskRowSubject>, (view: ReturnType<typeof taskRowView>, status: string) => void][] = [
    ['nothing', {}, (v) => {
      expect(v).toMatchObject({ conflict: null, repairing: null, repaired: null, mergeGate: null, opsChangedFiles: false, forcedPastGate: null, approvals: null, autonomous: false });
    }],
    ['a conflict in a named repo', { isolation: { ...isolated, state: 'conflict', conflictRepo: 'api', conflictFiles: ['a', 'b', 'c', 'd', 'e', 'f'] } }, (v) => {
      expect(v.conflict).toEqual({ repo: 'api', files: 'a, b, c, d, e, +1 more' });
    }],
    ['a conflict at the root repo', { isolation: { ...isolated, state: 'conflict', conflictRepo: '.' } }, (v) => {
      expect(v.conflict).toEqual({ repo: null, files: null });
      expect(v.repos).toEqual([]);
    }],
    ['work in a repo group', { isolation: { ...isolated, state: 'active', repos: ['.', 'api', 'web'] } }, (v) => {
      expect(v.repos).toEqual(['api', 'web']);
    }],
    ['a repair with its attempt', { isolation: { ...isolated, state: 'repairing', conflictFiles: ['a'], repair: { attempt: 2, limit: 3 } } }, (v) => {
      expect(v.repairing).toEqual({ files: 'a', attempt: { attempt: 2, limit: 3 } });
      expect(v.conflict).toBeNull();
    }],
    ['a repair before the stream has its attempt', { isolation: { ...isolated, state: 'repairing' } }, (v) => {
      expect(v.repairing).toEqual({ files: null, attempt: null });
    }],
    ['repaired files, landed', { isolation: { ...isolated, state: 'integrated', repairedFiles: ['a'] } }, (v) => {
      expect(v.repaired).toEqual({ files: 'a', landed: true });
    }],
    ['repaired files, still repairing', { isolation: { ...isolated, state: 'repairing', repairedFiles: ['a'] } }, (v) => {
      expect(v.repaired).toEqual({ files: 'a', landed: false });
    }],
    ['no isolation at all', { isolation: { state: 'none' } }, (v) => {
      expect(v).toMatchObject({ conflict: null, repairing: null, repaired: null, repos: [] });
    }],
    ['a merge gate', { mergeGate: ['t1', 'ghost'] }, (v) => {
      expect(v.mergeGate).toEqual(['#1', 'ghost']);
    }],
    ['an empty merge gate', { mergeGate: [] }, (v) => {
      expect(v.mergeGate).toBeNull();
    }],
    ['a forced start', { forcedPastGate: ['Fix'] }, (v) => {
      expect(v.forcedPastGate).toEqual(['Fix']);
    }],
    ['changed files', { awaitingReason: 'files-changed', ops: true }, (v, status) => {
      expect(v.opsChangedFiles).toBe(status === 'awaiting_user');
      expect(v.awaiting).toBe(status === 'awaiting_user' ? 'Changed tracked files' : null);
    }],
    ['approvals', { awaitingApproval: 3 }, (v) => {
      expect(v.approvals).toBe('Waiting for approval (3)');
    }],
    ['dependencies', { dependencies: ['t1', 'ghost'] }, (v) => {
      expect(v.dependencies).toEqual(['#1', 'ghost']);
    }],
    ['an autonomous mode', { taskMode: 'yolo' }, (v) => {
      expect(v.autonomous).toBe(true);
    }],
  ];

  const cases = STATUSES.flatMap((status) => annotations.map(([name, over, check]) => [status, name, over, check] as const));

  it.each(cases)('%s with %s', (status, _name, over, check) => {
    const view = taskRowView(subject({ status, ...over }), { tasks, modes: [{ id: 'yolo', autonomous: true }] });
    expect(view.status).toBe(taskStatusKind({ status }));
    check(view, status);
  });

  it('names the row by kind', () => {
    expect(taskRowView(subject()).kind).toBe('ai');
    expect(taskRowView(subject({ ops: true })).kind).toBe('ops');
    expect(taskRowView(subject({ type: 'user', ops: true })).kind).toBe('user');
  });

  it('labels a subtask by its dotted order', () => {
    expect(taskRowView(subject({ order: 1 }), { parent: { order: 2 } }).orderLabel).toBe('2.1');
    expect(taskRowView(subject()).orderLabel).toBe('2');
  });

  it('offers a subtask\'s actions to a subtask shown without its parent', () => {
    expect(taskRowView(subject({ status: 'in_progress' }), { placement: 'subtask' })).toMatchObject({ orderLabel: '2', actions: ['cancel', 'complete'] });
  });

  it('never marks a manual task autonomous, or one whose mode is untagged', () => {
    const modes = [{ id: 'yolo', autonomous: true }, { id: 'ask' }];
    expect(taskRowView(subject({ type: 'user', taskMode: 'yolo' }), { modes }).autonomous).toBe(false);
    expect(taskRowView(subject({ taskMode: 'ask' }), { modes }).autonomous).toBe(false);
    expect(taskRowView(subject({ taskMode: 'yolo' })).autonomous).toBe(false);
  });

  it('labels a dependency against the plan tree, so a sibling subtask reads dotted', () => {
    const tree = [
      { id: 't1', order: 1, title: 'Setup' },
      { id: 't2', order: 2, title: 'Build', subtasks: [{ id: 's1', order: 1, title: 'Sibling' }, { id: 's2', order: 2, title: 'Other' }] },
      { id: 't3', order: 3, title: 'Test' },
    ];
    expect(taskRowView(subject({ id: 's2', order: 2, dependencies: ['s1'] }), { parent: { order: 2 }, tasks: tree }).dependencies).toEqual(['#2.1']);
    expect(taskRowView(subject({ dependencies: ['t3'] }), { tasks: tree }).dependencies).toEqual(['#3']);
    expect(taskRowView(subject({ id: 's2', order: 2, dependencies: ['t1'] }), { parent: { order: 2 }, tasks: tree }).dependencies).toEqual(['#1']);
  });

  it('shows a dependency by its id when there is no plan tree to label it against', () => {
    expect(taskRowView(subject({ dependencies: ['t1'] })).dependencies).toEqual(['t1']);
    expect(taskRowView(subject({ dependencies: ['t1'] }), { tasks: [] }).dependencies).toEqual(['t1']);
  });

  it('shows a task a failure blocks as blocked by the failed task, through its dependencies and in a subtask (ADR-0034)', () => {
    const tree = [
      { id: 't1', order: 1, title: 'Setup', status: 'failed', dependencies: [] },
      { id: 't2', order: 2, title: 'Build', status: 'pending', dependencies: ['t1'], subtasks: [
        { id: 's1', order: 1, title: 'Sibling', status: 'failed', dependencies: [] },
        { id: 's2', order: 2, title: 'Other', status: 'approved', dependencies: ['s1'] },
      ] },
      { id: 't3', order: 3, title: 'Test', status: 'pending', dependencies: ['t2'] },
      { id: 't4', order: 4, title: 'Docs', status: 'pending', dependencies: [] },
    ];

    expect(taskRowView(subject({ id: 't3', order: 3, dependencies: ['t2'] }), { tasks: tree })).toMatchObject({ status: 'blocked', blockedBy: ['#1'] });
    expect(taskRowView(subject({ id: 's2', order: 2, status: 'approved', dependencies: ['s1'] }), { parent: { order: 2 }, tasks: tree })).toMatchObject({ status: 'blocked', blockedBy: ['#2.1'] });
    expect(taskRowView(subject({ id: 't4', order: 4 }), { tasks: tree })).toMatchObject({ status: 'todo', blockedBy: null });
    expect(taskRowView(subject({ id: 't3', order: 3, dependencies: ['t2'] }))).toMatchObject({ status: 'todo', blockedBy: null });
    expect(blockedByLabel(['#1', '#2.1'])).toBe('Blocked by #1, #2.1');
  });

  it('offers Skip on a task a failure blocks, though its own status is not blocked', () => {
    const tree = [
      { id: 't1', order: 1, title: 'Setup', status: 'failed', dependencies: [] },
      { id: 't2', order: 2, title: 'Build', status: 'pending', dependencies: ['t1'] },
    ];

    expect(taskRowView(subject({ id: 't2', order: 2, dependencies: ['t1'] }), { tasks: tree }).actions).toEqual(['skip', 'force-start']);
  });

  it('shows a skipped task as skipped, with its reason, and releases what depends on it', () => {
    const tree = [
      { id: 't1', order: 1, title: 'Setup', status: 'skipped', dependencies: [] },
      { id: 't2', order: 2, title: 'Build', status: 'pending', dependencies: ['t1'] },
    ];

    expect(taskRowView(subject({ id: 't1', order: 1, status: 'skipped', skipReason: 'no GPU here' }), { tasks: tree })).toMatchObject({ status: 'skipped', skipReason: 'no GPU here', running: false });
    expect(taskRowView(subject({ id: 't1', order: 1, status: 'skipped' })).skipReason).toBeNull();
    expect(skippedLabel('no GPU here')).toBe('Skipped: no GPU here');
    expect(skippedLabel(null)).toBe('Skipped');
    expect(taskRowView(subject({ id: 't2', order: 2, dependencies: ['t1'] }), { tasks: tree })).toMatchObject({ status: 'todo', blockedBy: null });
  });

  it('marks a quiet task as still running', () => {
    expect(taskRowView(subject({ status: 'in_progress', idleSince: 'x' }))).toMatchObject({ status: 'quiet', running: true });
  });
});

describe('texts', () => {
  const plan = [
    { id: 'a', order: 1, title: 'Fix', subtasks: [{ id: 'a1', order: 1, title: 'Nested' }] },
    { id: 'b', order: 2, title: 'Deploy' },
  ];

  it('names tasks by order and title, subtasks dotted, and a missing one by id', () => {
    expect(titledRefs(['a', 'a1', 'ghost'], plan)).toEqual(['#1 Fix', '#1.1 Nested', 'ghost']);
  });

  it.each([
    [[], null],
    [[{ order: 2, title: 'Build' }], '1 task depends on it and will lose that dependency: #2 Build.'],
    [[{ order: 2, title: 'Build' }, { order: 3, title: 'Test' }], '2 tasks depend on it and will lose that dependency: #2 Build, #3 Test.'],
  ])('says what a removal does to %j', (dependents, notice) => {
    expect(dependentsNotice(dependents)).toBe(notice);
  });

  it('asks before a start past the merge gate, from the asking surface\'s subject', () => {
    expect(pastGateConfirmation(['#1 Fix', 'ghost'])).toBe(
      'This task waits for Merge all: the work of #1 Fix, ghost is not merged into your branch yet, so it would act without it. Starting it now is kept on the task.',
    );
    expect(pastGateConfirmation(['#1 Fix'], 'It')).toMatch(/^It waits for Merge all: /);
  });

  it.each([
    ['Docs', undefined, { title: 'Docs', description: 'Docs', prompt: 'Docs', type: 'ai' }],
    ['  Docs ', '  ', { title: 'Docs', description: 'Docs', prompt: 'Docs', type: 'ai' }],
    ['Docs', 'write them\n', { title: 'Docs', description: 'Docs', prompt: 'write them\n', type: 'ai' }],
    ['   ', 'anything', null],
  ])('a hand-added %j with prompt %j starts as %j', (title, prompt, fields) => {
    expect(newTaskFields(title, prompt)).toEqual(fields);
  });
});
