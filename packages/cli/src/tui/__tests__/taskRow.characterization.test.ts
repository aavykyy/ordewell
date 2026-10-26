import { describe, it, expect, beforeAll, vi } from 'vitest';
import { initialState, reduce, type Step } from '../reducer';
import { planLayout } from '../layout';
import { style } from '../ansi';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import type { ModeView, TaskView, TuiState } from '../state';

beforeAll(() => { style.enabled = false; });

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Fix the parser', type: 'ai', status: 'pending', dependencies: [], assignedRunner: 'claude-code', ...over,
});
const deploy = (over: Partial<TaskView> = {}): TaskView =>
  task({ id: 'o2', order: 2, title: 'Redeploy on dev', ops: true, dependencies: ['t1'], ...over });

const state = (tasks: TaskView[], over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', rows: 60, cols: 220, focus: 'chat', tasks, ...over });
// The plan pane alone, wide enough that nothing it says is wrapped or cut.
const frame = (tasks: TaskView[], over: Partial<TuiState> = {}): string => planLayout(state(tasks, over), 60, 200).lines.join('\n');
const press = (s: TuiState, char: string): Step => reduce(s, { type: 'key', key: { name: 'char', char } });

const isolated = { branch: 'ordewell/t1', worktree: '/wt/t1', repos: ['.'] };

describe('a plan row, pinned before its rules move to core', () => {
  it.each([
    ['completed', '✓', ' AI'],
    ['failed', '✗', ' AI'],
    ['blocked', '!', ' AI'],
    ['awaiting_user', '?', ' AI'],
    ['pending', '·', ' AI'],
    ['approved', '·', ' AI'],
    ['in_progress', '⠋', 'RUN'],
  ])('%s draws %s', (status, icon, kind) => {
    expect(frame([task({ status })])).toContain(`  ${icon}  1 ${kind} Fix the parser`);
  });

  it('draws a quiet running task with ~', () => {
    expect(frame([task({ status: 'in_progress', idleSince: '2026-01-01T00:00:00Z' })])).toContain('  ~  1 RUN Fix the parser');
  });

  it('leaves a quiet task to its ~ glyph rather than spelling it out', () => {
    const out = frame([task({ status: 'in_progress', idleSince: '2026-01-01T00:00:00Z' })]);
    expect(out).not.toContain('quiet');
    expect(out).toMatch(/^\s+claude-code · default model$/m);
  });

  it('leaves a running task to its spinner, naming the runner first', () => {
    const out = frame([task({ status: 'in_progress' })]);
    expect(out).not.toContain('working');
    expect(out).toMatch(/^\s+claude-code · default model$/m);
  });

  it.each(['completed', 'failed'] as const)('says no activity word on a %s row', (status) => {
    const out = frame([task({ status })]);
    expect(out).not.toContain('working');
    expect(out).not.toContain('quiet');
    expect(out).toMatch(/^\s+claude-code · default model$/m);
  });

  it('keeps the word that opens an approval and the one that names an awaiting task', () => {
    expect(frame([task({ status: 'in_progress', awaitingApproval: 1 })]))
      .toMatch(/^\s+waiting for approval: enter opens it · claude-code · default model$/m);
    expect(frame([task({ status: 'awaiting_user', awaitingReason: 'input' })]))
      .toMatch(/^\s+waiting for your input · claude-code · default model$/m);
  });

  it('names a manual and an ops task by kind', () => {
    expect(frame([task({ type: 'user' })])).toContain('  ·  1 MAN Fix the parser');
    expect(frame([deploy()])).toContain('  ·  2 OPS Redeploy on dev');
  });

  it.each([
    ['input', 'waiting for your input'],
    ['checkpoint', 'checkpoint'],
    ['conflict', 'merge conflict'],
    ['files-changed', 'changed tracked files'],
  ] as const)('an awaiting task waiting on %s reads "%s"', (awaitingReason, label) => {
    expect(frame([task({ status: 'awaiting_user', awaitingReason })])).toContain(`    ${label} · claude-code`);
  });

  it('counts approvals beyond one, and puts them ahead of the status', () => {
    expect(frame([task({ status: 'in_progress', awaitingApproval: 1 })])).toContain('waiting for approval: enter opens it · claude-code');
    expect(frame([task({ status: 'in_progress', awaitingApproval: 3 })])).toContain('waiting for approval (3): enter opens it · claude-code');
  });

  it('marks a conflict, naming the repo and files but not a lone root repo', () => {
    const conflict = (conflictRepo: string) => task({ status: 'awaiting_user', isolation: { ...isolated, state: 'conflict', conflictRepo, conflictFiles: ['a.ts', 'b.ts'] } });
    expect(frame([conflict('api')])).toContain('⚠ merge conflict in api (a.ts, b.ts): its work is kept on its own branch');
    expect(frame([conflict('.')])).toContain('⚠ merge conflict (a.ts, b.ts): its work is kept on its own branch');
  });

  it('marks a repair in flight, with its attempt once the stream has one', () => {
    const repairing = (repair?: { attempt: number; limit: number }) =>
      task({ status: 'in_progress', isolation: { ...isolated, state: 'repairing', conflictFiles: ['a.ts'], repair } });
    expect(frame([repairing({ attempt: 1, limit: 3 })])).toContain('↻ repairing conflict in a.ts (attempt 1/3)');
    expect(frame([repairing()])).toMatch(/↻ repairing conflict in a\.ts\s*$/m);
  });

  it('says a task landed after a repair only once it is integrated', () => {
    const repaired = (state: 'integrated' | 'active') => task({ status: 'completed', isolation: { ...isolated, state, repairedFiles: ['a.ts'] } });
    expect(frame([repaired('integrated')])).toContain('↻ landed after repairing conflict in a.ts');
    expect(frame([repaired('active')])).not.toContain('landed after repairing');
  });

  it('names what a merge gate waits on, by order, and an unknown id as is', () => {
    expect(frame([task({ status: 'completed' }), deploy({ mergeGate: ['t1', 'ghost'] })]))
      .toContain('⏸ waits for Merge all: #1, ghost not merged into your branch yet');
  });

  it('says a task added after the plan was approved waits for the user, and how to approve it (ADR-0035)', () => {
    expect(frame([task({ waitsForApproval: true })])).toContain('⏸ waits for your approval · f approves it · /run approves all');
    expect(frame([task({ waitsForApproval: true, status: 'in_progress' })])).not.toContain('waits for your approval');
  });

  it('wraps a row\'s status line in a narrow pane rather than cutting it off, under its glyph', () => {
    const narrow = planLayout(state([task({ waitsForApproval: true })]), 60, 40).lines;
    const at = narrow.findIndex((line) => line.includes('⏸'));
    expect(narrow.slice(at, at + 2)).toEqual([
      '    ⏸ waits for your approval · f',
      '       approves it · /run approves all',
    ]);
  });

  it('draws a task a failure blocks as blocked by the failed task, through its dependencies (ADR-0034)', () => {
    const out = frame([
      task({ status: 'failed' }),
      task({ id: 't2', order: 2, title: 'Wire the parser', dependencies: ['t1'] }),
      task({ id: 't3', order: 3, title: 'Test the parser', status: 'approved', dependencies: ['t2'] }),
    ]);
    expect(out).toContain('  !  2  AI Wire the parser');
    expect(out).toContain('  !  3  AI Test the parser');
    expect(out.match(/⊘ blocked by #1: runs once it is retried and passes/g)).toHaveLength(2);
  });

  it('draws a skipped task apart from a done one, with why, and lets what depends on it go ahead', () => {
    const out = frame([
      task({ status: 'skipped', skipReason: 'the host has no GPU' }),
      task({ id: 't2', order: 2, title: 'Wire the parser', dependencies: ['t1'] }),
    ]);
    expect(out).toContain('  »  1  AI Fix the parser');
    expect(out).toContain('» skipped: the host has no GPU: nothing of it landed; m done lands its kept work');
    expect(out).toContain('  ·  2  AI Wire the parser');
    expect(out).not.toContain('blocked by');
  });

  it('warns about an ops task that changed tracked files', () => {
    expect(frame([deploy({ status: 'awaiting_user', awaitingReason: 'files-changed' })]))
      .toContain('⚠ an ops task changed tracked files: check them, then m done or /retry');
  });

  it('shows the expanded detail: status, ops, forced start, autonomy and dependencies', () => {
    const modes: Record<string, ModeView[]> = { 'claude-code': [{ id: 'yolo', label: 'Yolo', autonomous: true }] };
    const out = frame(
      [task({ status: 'completed' }), deploy({ status: 'awaiting_user', taskMode: 'yolo', forcedPastGate: ['Fix the parser'], dependencies: ['t1', 'ghost'] })],
      { expandedTaskId: 'o2', modesByRunner: modes },
    );
    expect(out).toContain('    Awaiting');
    expect(out).toContain('Runs in your checkout, not a worktree, once the work it depends on is merged. O makes it a change task.');
    expect(out).toContain('Started before the work of Fix the parser was merged into your branch.');
    expect(out).toContain('Runs without permission prompts (Full). Change the level with /settings.');
    expect(out).toMatch(/Depends on\n.*#1, ghost/);
  });
});

describe('task texts and actions, pinned before their rules move to core', () => {
  it.each([
    [[] as TaskView[], 'This cannot be undone.'],
    [[deploy()], '1 task depends on it and will lose that dependency: #2 Redeploy on dev.'],
    [[deploy(), task({ id: 'x3', order: 3, title: 'Tag it', dependencies: ['t1'] })], '2 tasks depend on it and will lose that dependency: #2 Redeploy on dev, #3 Tag it.'],
  ])('confirms a removal, naming the dependents', (others, message) => {
    const asked = press(state([task(), ...others], { focus: 'plan' }), 'd').state;
    expect(asked.overlay).toMatchObject({ kind: 'confirm', title: 'Remove #1 Fix the parser?', message });
  });

  it('confirms a force start past the merge gate, naming the unmerged work', () => {
    const asked = press(state([task({ status: 'completed' }), deploy({ mergeGate: ['t1', 'ghost'] })], { focus: 'plan', selectedTask: 1 }), 'f').state;
    expect(asked.overlay).toMatchObject({
      kind: 'confirm',
      title: 'Force start #2 Redeploy on dev?',
      message: 'It waits for Merge all: the work of #1 Fix the parser, ghost is not merged into your branch yet, so it would act without it. Starting it now is kept on the task.',
    });
  });

  it('asks the same from /force-start', () => {
    const s = state([task({ status: 'completed' }), deploy({ mergeGate: ['t1'] })], { focus: 'chat' });
    const asked = reduce({ ...s, editor: { ...s.editor, text: '/force-start 2', cursor: 14 } }, { type: 'key', key: { name: 'enter' } }).state;
    expect(asked.overlay).toMatchObject({ kind: 'confirm', title: 'Force start #2 Redeploy on dev?' });
  });

  it.each([
    ['completed', 'uncomplete'],
    ['pending', 'complete'],
    ['awaiting_user', 'complete'],
    ['failed', 'complete'],
  ])('m on a %s task asks to %s it, and sends nothing yet', (status, direction) => {
    const asked = press(state([task({ status })], { focus: 'plan' }), 'm');
    expect(asked.effects).toEqual([]);
    expect(asked.state.overlay).toMatchObject({ kind: 'confirm', action: { kind: 'mark-override', direction, seen: status } });
  });

  it('adds a task with its title as description and prompt', async () => {
    const addTask = vi.fn().mockResolvedValue({ ok: true });
    const deps: EffectDeps = {
      api: { addTask } as unknown as OrdewellApi,
      workspace: '/ws', port: 3742, dispatch: () => {}, newSessionId: () => 's2', setEnvVar: () => {}, saveAutonomy: () => ({ overridden: false }), hasBin: () => true,
      login: async () => ({ ok: true }),
      exit: vi.fn(),
      reviveDaemon: vi.fn(), setMouseCapture: vi.fn(), writeTerminal: vi.fn(),
    };
    // Only the request is pinned; the plan refresh after it has no daemon to reach.
    await runEffect({ type: 'addTask', sessionId: 's1', title: 'Docs' }, deps).catch(() => undefined);
    expect(addTask).toHaveBeenCalledWith('s1', { title: 'Docs', description: 'Docs', prompt: 'Docs', type: 'ai' });
  });
});
