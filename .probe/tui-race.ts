import { initialState, reduce, type Action } from '../packages/cli/src/tui/reducer';
import { plannerInFlight } from '../packages/cli/src/tui/state';

const fold = (state: ReturnType<typeof initialState>, action: Action) => reduce(state, action).state;
let s = initialState({ sessionId: 's2', rows: 30, cols: 100 });
s = fold(s, { type: 'sessionLoaded', sessionId: 's2', goal: 'g' });
s = fold(s, { type: 'planUpdated', plan: { tasks: [] }, sessionId: 's2' });
console.log('after planUpdated:', s.planner, s.turnGate);
s = fold(s, { type: 'sessionMessage', sessionId: 's2', message: { type: 'planner_turn_ended', turnId: 't1', outcome: 'message' } });
console.log('after held turn end:', s.planner, s.turnGate);
s = fold(s, { type: 'turnJoined', turnId: 't1', sessionId: 's2' });
console.log('after turnJoined:', s.planner, s.turnGate, 'busy=', plannerInFlight(s));
const stopped = fold(s, { type: 'key', key: { name: 'escape' } });
console.log('after escape1:', stopped.stopArmed, stopped.planner, stopped.turnGate);
const stopped2 = fold(stopped, { type: 'key', key: { name: 'escape' } });
console.log('after escape2:', stopped2.stopRequested, stopped2.planner, stopped2.turnGate, 'effects=', JSON.stringify(reduce(stopped, { type: 'key', key: { name: 'escape' } }).effects));
