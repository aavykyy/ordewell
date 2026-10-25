import { TurnStream } from '../packages/core/src/services/replyStream';
const events: unknown[] = [];
const stream = new TurnStream('t1', (p) => events.push(p));
stream.sink()({ type: 'compaction', compaction: { phase: 'started', id: 'c1', origin: 'ordewell', trigger: 'auto', at: '2026-10-25T00:00:00Z' } });
stream.mute();
stream.sink()({ type: 'compaction', compaction: { phase: 'ended', id: 'c1', origin: 'ordewell', trigger: 'auto', outcome: 'condensed', at: '2026-10-25T00:00:01Z' } });
console.log(JSON.stringify(events.map((e) => (e as { compaction: { phase: string; outcome?: string } }).compaction), null, 2));
