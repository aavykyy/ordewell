import { describe, it, expect, beforeAll } from 'vitest';
import { initialState, reduce, type Action, type Step } from '../reducer';
import { render } from '../render';
import { style } from '../ansi';
import { runHint } from '../layout';
import type { RunMergeView, HandoffView, TaskView, TuiState } from '../state';

beforeAll(() => { style.enabled = false; });

const key = (name: string, char?: string) => ({ type: 'key' as const, key: { name, char } });
const press = (state: TuiState, name: string, char?: string): Step => reduce(state, key(name, char));
const apply = (state: TuiState, action: Action): Step => reduce(state, action);
const frame = (state: TuiState): string => render(state).join('\n');

const handoff: HandoffView = {
  repos: [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: 'abcdef1234567890', landed: [{ taskId: 't1', order: 1, title: 'Bump the version' }] }],
  landed: [{ taskId: 't1', order: 1, title: 'Bump the version' }],
};
const runMerge: RunMergeView = { waitingAtGate: true, paused: true, handoff };
/** The run's merge view as the wire carries it: repos and landed flat, not nested under the handoff. */
const wireMerge = (m: RunMergeView) => ({ waitingAtGate: m.waitingAtGate, paused: m.paused, repos: m.handoff.repos, landed: m.handoff.landed });

const change = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Bump the version', type: 'ai', status: 'completed', dependencies: [], ...over,
});
const deploy = (over: Partial<TaskView> = {}): TaskView => ({
  id: 'o2', order: 2, title: 'Redeploy on dev', type: 'ai', status: 'pending', dependencies: ['t1'], ops: true, ...over,
});

const plan = (tasks: TaskView[], over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', rows: 40, cols: 100, focus: 'plan', tasks, ...over });

describe('ops tasks and merge gates in the TUI (ADR-0020)', () => {
  it('marks an ops task, and a task waiting at its merge gate', () => {
    const out = frame(plan([change(), deploy({ mergeGate: ['t1'] })]));

    expect(out).toContain('OPS Redeploy on dev');
    expect(out).toContain('⏸ waits for Merge all: #1');
  });

  it('takes the gate from a status update, and says the run is paused for Merge all', () => {
    const state = plan([change(), deploy()], { status: 'executing' });

    const next = apply(state, { type: 'statusUpdate', sessionId: 's1', runMerge: wireMerge(runMerge), tasks: [{ id: 'o2', status: 'pending', verdict: null, idleSince: null, mergeGate: ['t1'] }] }).state;

    expect(next.runMerge).toEqual(runMerge);
    expect(next.tasks[1].mergeGate).toEqual(['t1']);
    expect(next.status).toBe('executing');
    expect(runHint(next)).toBe('paused for Merge all: /handoff merge');

    const cleared = apply(next, { type: 'statusUpdate', sessionId: 's1', tasks: [{ id: 'o2', status: 'in_progress', verdict: null, idleSince: null }] }).state;
    expect(cleared.runMerge).toBeNull();
    expect(cleared.tasks[1].mergeGate).toBeUndefined();
  });

  it('flips a task between change and ops with O', () => {
    const state = plan([change({ status: 'pending' })]);

    expect(press(state, 'char', 'O').effects).toEqual([{
      type: 'updateTask', sessionId: 's1', taskId: 't1', changes: { ops: true },
      message: 'Task #1 is an ops task: it runs in your checkout once the work it depends on is merged.',
    }]);
    expect(press(plan([deploy()]), 'char', 'O').effects).toMatchObject([{ changes: { ops: false } }]);
  });

  it('refuses O on a manual task', () => {
    const step = press(plan([change({ type: 'user' })]), 'char', 'O');
    expect(step.effects).toEqual([]);
  });

  it('asks before a force start passes a merge gate, naming what is not merged', () => {
    const state = plan([change(), deploy({ mergeGate: ['t1'] })], { selectedTask: 1 });

    const asked = press(state, 'char', 'f');

    expect(asked.effects).toEqual([]);
    expect(asked.state.overlay).toMatchObject({ kind: 'confirm', action: { kind: 'force-start-gated', taskId: 'o2' } });
    expect(asked.state.overlay?.kind === 'confirm' && asked.state.overlay.message).toContain('#1 Bump the version is not merged');
    expect(press(asked.state, 'enter').effects).toMatchObject([{ type: 'taskAction', taskId: 'o2', action: 'force-start' }]);
  });

  it('offers Merge all mid-run from the gate, and keeps the run when it merges', () => {
    const state = plan([change(), deploy({ mergeGate: ['t1'] })], { status: 'executing', runMerge, focus: 'chat' });

    const typed = reduce({ ...state, editor: { ...state.editor, text: '/handoff merge', cursor: 14 } }, key('enter'));

    expect(typed.state.overlay).toMatchObject({ kind: 'confirm', title: 'Merge what has landed into your branch?' });
    expect(typed.state.overlay?.kind === 'confirm' && typed.state.overlay.message).toContain('The run goes on');
    expect(press(typed.state, 'enter').effects).toEqual([{ type: 'isolationMerge', sessionId: 's1', branch: 'ordewell/r1/integration' }]);
  });

  it('offers /handoff merge during a run without a gate, using the same confirmation', () => {
    const state = plan([change(), change({ id: 't2', order: 2, status: 'in_progress' })], {
      status: 'executing', runMerge: { ...runMerge, waitingAtGate: false, paused: false }, focus: 'chat',
    });
    const command = (s: TuiState) => reduce({ ...s, editor: { ...s.editor, text: '/handoff merge', cursor: 14 } }, key('enter'));

    const asked = command(state);
    const gated = command({ ...state, runMerge });

    expect(asked.effects).toEqual([]);
    expect(asked.state.overlay).toEqual(gated.state.overlay);
    expect(press(asked.state, 'enter').effects).toEqual([{ type: 'isolationMerge', sessionId: 's1', branch: 'ordewell/r1/integration' }]);
  });

  it('shows the unmerged landing count quietly and clears it without task status changes', () => {
    const state = plan([change(), change({ id: 't2', order: 2, status: 'in_progress' })], { status: 'executing' });
    const next = apply(state, { type: 'statusUpdate', tasks: [], runMerge: wireMerge({ ...runMerge, waitingAtGate: false, paused: false }) }).state;

    expect(frame(next)).toContain('1 landed task not merged');
    expect(frame(next)).not.toContain('paused for Merge all');
    expect(frame(next)).not.toContain('waits for Merge all');
    expect(next.overlay).toBeNull();

    const cleared = apply(next, { type: 'statusUpdate', tasks: [] }).state;
    expect(frame(cleared)).not.toContain('landed task');
  });

  it('does not offer a cached handoff mid-run after all landed work was merged', () => {
    const state = plan([change({ status: 'in_progress' })], { status: 'executing', handoff, focus: 'chat' });
    const asked = reduce({ ...state, editor: { ...state.editor, text: '/handoff merge', cursor: 14 } }, key('enter'));

    expect(asked.state.overlay).toBeNull();
    expect(asked.effects).toEqual([]);
    expect(frame(asked.state)).toContain('No isolated run to hand off');
  });
});
