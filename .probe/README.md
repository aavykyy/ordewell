# Review probes (compaction check, round 2)

These are read-only review harnesses bundled from the real sources with esbuild; they are not product tests.

Build once (the CLI refuses `--outfile`, so use `--outdir`):

```sh
node_modules/.bin/esbuild .probe/condense90.ts --bundle --platform=node --format=cjs --outdir=.probe/out
node_modules/.bin/esbuild .probe/retry-hold.ts ... --outdir=.probe/out
node_modules/.bin/esbuild .probe/tui-race.ts ... --outdir=.probe/out --alias:@ordewell/core=./packages/core/src/index.ts --alias:@ordewell/core/plan-utils=./packages/core/src/plan-utils.ts
node_modules/.bin/esbuild .probe/tui-reconcile.ts ... (same aliases)
node_modules/.bin/esbuild .probe/tui-joined.ts ... (same aliases)
node_modules/.bin/esbuild .probe/gemini-head.ts ... --outdir=.probe/out
node_modules/.bin/esbuild .probe/meter-empty.ts ... --outdir=.probe/out
node_modules/.bin/esbuild .probe/turn-stream.ts ... --outdir=.probe/out
node .probe/out/<name>.js
```

Observed (2026-10-25/26, sealed, no network):

- `condense90.js`: after a committed landed summary, a call was sent at 192,118 chars of a 200,000-token window (96.06%), ceiling 180,000, prompt limit 198,000: `{calls:1, overCeiling:true, overPromptLimit:false}`.
- `retry-hold.js`: measured model, first send held `condensed:message`; `retry()` then held `not_tried:message` with `callsAfterRetry:0`, though `retryable:true`.
- `gemini-head.js`: real `GeminiService.startConversation` (fresh, no prior history) sends `contents` roles `["user","user"]`; the rule added to the new Gemini fake rejects it: `turn 1 has the role of turn 0`.
- `tui-race.js`: after a held `planner_turn_ended` then `turnJoined`, the real reducer is `joined {open:'t1'}` and stays busy; Escape only sends `cancelPlanning`.
- `tui-reconcile.js`: a joined turn reconciled with no live turn drains the queue correctly (effects preserved).
- `meter-empty.js`: unknown window with an unset model prints `... states 's window`.
- `turn-stream.js`: `mute()` emits a synthetic `ended/stopped` for a running compaction and drops the later real end.
- `tui-joined.js`: a normal joined turn stays `joined` through an in-turn compaction start/end (`after compaction: joined {open:'t1'}`) and settles to `idle {open:null}` on `planner_turn_ended`.
