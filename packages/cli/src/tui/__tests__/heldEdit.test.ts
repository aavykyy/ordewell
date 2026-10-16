import { describe, it, expect } from 'vitest';
import type { HeldEdit, SessionMessage } from '@ordewell/core';
import { inboundFor } from '../inbound';
import type { WsEvent } from '../../apiClient';
import { initialState, reduce, type Action } from '../reducer';
import { render } from '../render';
import { stripAnsi } from '../ansi';
import { planScrollExtent } from '../layout';
import type { TuiState } from '../state';

/**
 * The edit a planner turn holds lands when its reply ends (ADR-0029). The plan
 * pane shows it meanwhile, apart from the plan's own rows: nothing in it can be
 * selected, run or edited, and it is gone when the edit lands or is dropped.
 */

const task = (id: string, order: number, title: string): HeldEdit['tasks'][number]['task'] =>
  ({ id, order, title, type: 'ai', status: 'pending', description: '', dependencies: [], assignedRunner: 'claude-code', assignedModel: null, taskMode: 'build', prompt: null, subtasks: [],
    userSteps: undefined, autonomy: undefined, sliceType: undefined, userStoriesCovered: undefined });

const held: HeldEdit = {
  turnId: 'turn-1',
  tasks: [
    { label: '1', task: task('t1', 1, 'Write the parser') },
    { label: '2', mark: 'changed', task: task('t2', 2, 'Wire the parser into the CLI') },
    { label: '3', mark: 'removed', task: task('t3', 3, 'Delete the old lexer') },
    { label: '4', mark: 'added', task: task('t4', 4, 'Add a cache for parsed files') },
  ],
};

const planned = (cols = 100): TuiState => {
  const plan = { tasks: [task('t1', 1, 'Write the parser'), task('t2', 2, 'Wire the CLI'), task('t3', 3, 'Delete the old lexer')] };
  return reduce(initialState({ sessionId: 's1', rows: 30, cols }), { type: 'planUpdated', plan, sessionId: 's1' }).state;
}

/** A session's broadcast arriving the way the daemon sends it, folded into the state. */
function arriving(state: TuiState) {
  let current = state;
  const inbound = inboundFor({}, (action: Action) => { current = reduce(current, action).state; }, 's1');
  const receive = inbound.execution();
  return { state: () => current, send: (message: SessionMessage) => receive(message as WsEvent) };
}

const screen = (state: TuiState): string => render(state).map(stripAnsi).join('\n');

describe('the plan pane while the planner turn holds an edit', () => {
  it('lists the proposed tasks apart from the plan, marked, and says they land when the reply ends', () => {
    const session = arriving(planned());

    session.send({ type: 'plan_edit_held', held });

    const text = screen(session.state());
    expect(text).toContain('Proposed — lands when this reply ends');
    expect(text).toMatch(/~ +2 +Wire the parser into the CLI/);
    expect(text).toMatch(/- +3 +Delete the old lexer/);
    expect(text).toMatch(/\+ +4 +Add a cache for parsed files/);
    // Unchanged tasks are not repeated, and the proposal makes no promise to run.
    expect(text).not.toMatch(/^.*Proposed[\s\S]*Write the parser/m);
    expect(text).not.toMatch(/will run|runs next/i);
  });

  it('adds nothing to select: the plan keeps its own rows', () => {
    const session = arriving(planned());
    const before = planScrollExtent(session.state()).rowSpans.length;

    session.send({ type: 'plan_edit_held', held });

    expect(planScrollExtent(session.state()).rowSpans).toHaveLength(before);
  });

  it('is gone when the edit lands or is dropped', () => {
    const session = arriving(planned());
    session.send({ type: 'plan_edit_held', held });

    session.send({ type: 'plan_edit_held', held: null });

    expect(screen(session.state())).not.toContain('Proposed');
    expect(session.state().run.heldEdit).toBeUndefined();
  });

  it('fits the pane at every width, a long title cut to it', () => {
    for (const cols of [80, 100, 160]) {
      const session = arriving(planned(cols));
      const long = { ...held, tasks: held.tasks.map((t) => ({ ...t, task: { ...t.task, title: `${t.task.title} ${'and then some more '.repeat(8)}` } })) };
      session.send({ type: 'plan_edit_held', held: long });

      const lines = render(session.state());

      expect(lines.map((l) => stripAnsi(l).length).filter((n) => n > cols), `at ${cols} columns`).toEqual([]);
      expect(lines.map(stripAnsi).join('\n')).toContain('Proposed');
    }
  });
});
