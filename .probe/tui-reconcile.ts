import { initialState, reduce, type Action } from '../packages/cli/src/tui/reducer';

const fold = (state: ReturnType<typeof initialState>, action: Action) => reduce(state, action).state;
const typed = (state: ReturnType<typeof initialState>, text: string) => ({ ...state, editor: { ...state.editor, text, cursor: text.length } });
let s = initialState({ sessionId: 's2', rows: 30, cols: 100 });
s = fold(s, { type: 'sessionLoaded', sessionId: 's2', goal: 'g' });
s = fold(s, { type: 'planUpdated', plan: { tasks: [] }, sessionId: 's2' });
s = fold(s, { type: 'turnJoined', turnId: 't1', sessionId: 's2' });
s = reduce(typed(s, 'queued while joined'), { type: 'key', key: { name: 'enter' } }).state;
console.log('queued:', s.queuedPrompts, 'planner:', s.planner);
const result = reduce(s, {
  type: 'turnReconciled',
  plan: { tasks: [] },
  chat: { type: 'chatRestored', history: [], sessionId: 's2' },
  sessionId: 's2',
});
console.log('after reconcile:', JSON.stringify({ planner: result.state.planner, queued: result.state.queuedPrompts, gate: result.state.turnGate, effects: result.effects }));
