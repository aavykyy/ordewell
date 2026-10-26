import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTask } from '@ordewell/core';
import { inboundFor } from '../inbound';
import { render } from '../render';
import { stripAnsi } from '../ansi';
import type { Action } from '../reducer';
import type { WsEvent } from '../../apiClient';
import { draftPlan, liveDaemon, toolContext, type LiveDaemon, type Tui } from './liveDaemon';

/**
 * A TUI that loses its socket and loads the session again, or attaches to a
 * session already going, shows what the session holds now: the planner's
 * held edit and the approvals still waiting. Against the real daemon.
 */

const proposed = (tui: Tui): string[] => tui.state().run.heldEdit?.tasks.filter((t) => t.mark === 'added').map((t) => t.task.title) ?? [];

describe('a TUI that loads a session again after its socket dropped', () => {
  let daemon: LiveDaemon;

  beforeEach(async () => { daemon = await liveDaemon(); });
  afterEach(async () => { await daemon.close(); });

  it('drops a held edit cleared after the reload, as it dropped one cleared before', async () => {
    daemon.save(draftPlan(), 's');
    const tui = daemon.tui();
    await tui.run({ type: 'loadSession', sessionId: 's' });
    const other = daemon.client();

    // Held and landed while the first socket is up: the TUI sees it come and go.
    const first = other.sendConversationMessage('s', 'add a cache');
    await vi.waitFor(() => expect(daemon.turns).toHaveLength(1));
    await daemon.turns[0].tools.editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' } }] }, toolContext);
    await vi.waitFor(() => expect(proposed(tui)).toEqual(['Add a cache']));
    daemon.turns[0].finish('Added a cache.');
    await first;
    await vi.waitFor(() => expect(tui.state().run.heldEdit).toBeUndefined());

    daemon.dropSockets();
    await vi.waitFor(() => expect(tui.actions.some((a) => a.type === 'followLost')).toBe(true));
    await tui.run({ type: 'loadSession', sessionId: 's' });

    // A second turn holds an edit and is stopped: nothing lands, and the preview goes.
    const second = other.sendConversationMessage('s', 'add a ghost').catch(() => undefined);
    await vi.waitFor(() => expect(daemon.turns).toHaveLength(2));
    await daemon.turns[1].tools.editPlan!({ ops: [{ op: 'add', task: { title: 'Ghost proposed task', prompt: 'boo' } }] }, toolContext);
    await vi.waitFor(() => expect(proposed(tui)).toEqual(['Ghost proposed task']));
    await other.cancelPlanning('s');
    await second;

    expect(daemon.pool.session('s').runSnapshot().heldEdit).toBeUndefined();
    await vi.waitFor(() => expect(tui.state().run.heldEdit).toBeUndefined(), { timeout: 2000 });
  });
});

describe('a TUI that loads a session again after its socket dropped, then sees an edit land', () => {
  let daemon: LiveDaemon;

  beforeEach(async () => { daemon = await liveDaemon(); });
  afterEach(async () => { await daemon.close(); });

  it('drops the preview of an edit that lands after the reload', async () => {
    daemon.save(draftPlan(), 's');
    const tui = daemon.tui();
    await tui.run({ type: 'loadSession', sessionId: 's' });
    const other = daemon.client();
    for (const [n, title] of [[0, 'Add a cache'], [1, 'Add a metric']] as const) {
      if (n === 1) {
        daemon.dropSockets();
        await vi.waitFor(() => expect(tui.actions.some((a) => a.type === 'followLost')).toBe(true));
        await tui.run({ type: 'loadSession', sessionId: 's' });
      }
      const reply = other.sendConversationMessage('s', title);
      await vi.waitFor(() => expect(daemon.turns).toHaveLength(n + 1));
      await daemon.turns[n].tools.editPlan!({ ops: [{ op: 'add', task: { title, prompt: title } }] }, toolContext);
      await vi.waitFor(() => expect(proposed(tui)).toEqual([title]));
      daemon.turns[n].finish('Done.');
      await reply;
      await vi.waitFor(() => expect(tui.state().run.heldEdit).toBeUndefined());
    }

    expect(tui.state().tasks.map((t) => t.title)).toEqual(expect.arrayContaining(['Add a cache', 'Add a metric']));
  });
});

describe('two sockets on one session during a handover', () => {
  const held = { turnId: 'turn-1', tasks: [] };
  const view = { tasks: [], runMerge: null, handoff: null, mergeResult: null };

  it('does not bring back a preview the newer socket\'s snapshot already shows as cleared', () => {
    const actions: Action[] = [];
    const inbound = inboundFor({}, (action) => actions.push(action), 's1');
    const old = inbound.execution();
    const fresh = inbound.execution();

    old({ type: 'plan_edit_held', held, stream: 'd1', seq: 4 } as WsEvent);
    // The new socket greets with the run as of broadcast 6 — the edit held at 5 and cleared at 6.
    fresh({ type: 'run_snapshot', sessionId: 's1', view, approvals: [], stream: 'd1', seq: 6 } as WsEvent);
    old({ type: 'plan_edit_held', held, stream: 'd1', seq: 5 } as WsEvent);
    old({ type: 'plan_edit_held', held: null, stream: 'd1', seq: 6 } as WsEvent);

    expect(actions.filter((a) => a.type === 'heldEdit').length).toBe(1);
    expect(actions.at(-1)).toMatchObject({ type: 'runSnapshot' });
  });

  it('passes over a snapshot older than a broadcast another socket already delivered', () => {
    const actions: Action[] = [];
    const inbound = inboundFor({}, (action) => actions.push(action), 's1');
    inbound.execution()({ type: 'plan_edit_held', held: null, stream: 'd1', seq: 9 } as WsEvent);

    inbound.planning()({ type: 'run_snapshot', sessionId: 's1', view: { ...view, heldEdit: held }, stream: 'd1', seq: 8 } as WsEvent);

    expect(actions.map((a) => a.type)).toEqual(['heldEdit']);
  });

  it('shows each broadcast once whichever socket delivers it, and two that read the same twice', () => {
    const actions: Action[] = [];
    const inbound = inboundFor({}, (action) => actions.push(action), 's1');
    const a = inbound.execution();
    const b = inbound.execution();
    const clear = (seq: number) => ({ type: 'plan_edit_held', held: null, stream: 'd1', seq }) as WsEvent;

    a(clear(1)); b(clear(1)); b(clear(2)); a(clear(2));

    expect(actions.filter((x) => x.type === 'heldEdit')).toHaveLength(2);
  });

  it('starts counting again for a restarted daemon', () => {
    const actions: Action[] = [];
    const receive = inboundFor({}, (action) => actions.push(action), 's1').execution();

    receive({ type: 'plan_edit_held', held: null, stream: 'd1', seq: 7 } as WsEvent);
    receive({ type: 'plan_edit_held', held, stream: 'd2', seq: 1 } as WsEvent);

    expect(actions.map((a) => a.type)).toEqual(['heldEdit', 'heldEdit']);
  });
});

describe('the planner\'s approval requests on a TUI that was not listening', () => {
  let daemon: LiveDaemon;

  beforeEach(async () => { daemon = await liveDaemon(); });
  afterEach(async () => { await daemon.close(); });

  const cards = (tui: Tui) => tui.state().conversation.blocks.flatMap((b) => (b.type === 'approval' ? [[b.kind, b.status]] : []));
  const asking = (tui: Tui): string | null => {
    const overlay = tui.state().overlay;
    return overlay?.kind === 'approval' ? overlay.request.id : null;
  };
  const starts = () => (daemon.pool.session('s').planState?.conversationHistory ?? [])
    .filter((e) => e.kind === 'execution' && e.execution?.command === 'run_task' && e.execution.outcome === 'done');

  /** A plan the user executed, and a task added since that they have not approved. */
  const approvedPlan = () => {
    const plan = draftPlan();
    return {
      ...plan, approved: true, approvedTasks: ['t1', 't2'],
      tasks: [...plan.tasks, createTask({ id: 't3', order: 3, title: 'Add a cache', prompt: 'add a cache', assignedRunner: 'claude-code' })],
    };
  };

  /** A Guarded planner turn, started on another surface, that asks to start the added task and waits for the answer. */
  async function askedToStart() {
    const other = daemon.client();
    await other.adoptSession('s', daemon.workspace);
    void other.sendConversationMessage('s', 'start the cache task').catch(() => undefined);
    await vi.waitFor(() => expect(daemon.turns).toHaveLength(1));
    const answered = daemon.turns[0].tools.runTask!({ task: 't3' }, toolContext);
    await vi.waitFor(() => expect(daemon.pool.session('s').outstandingApprovals()).toHaveLength(1));
    return { id: daemon.pool.session('s').outstandingApprovals()[0].id, answered };
  }

  it('shows a request already waiting to a TUI that loads the session, and asks it', async () => {
    daemon.save(approvedPlan(), 's');
    const { id } = await askedToStart();

    const tui = daemon.tui();
    await tui.run({ type: 'loadSession', sessionId: 's' });

    expect(cards(tui)).toEqual([['task_start', 'pending']]);
    expect(asking(tui)).toBe(id);
  });

  it('takes a request answered on another TUI off this one, which cannot answer it again', async () => {
    daemon.save(approvedPlan(), 's');
    const a = daemon.tui();
    const b = daemon.tui();
    await a.run({ type: 'loadSession', sessionId: 's' });
    await b.run({ type: 'loadSession', sessionId: 's' });
    const { id, answered } = await askedToStart();
    await vi.waitFor(() => expect([asking(a), asking(b)]).toEqual([id, id]));

    await a.act({ type: 'key', key: { name: 'enter' } });
    await answered;

    await vi.waitFor(() => expect(asking(b)).toBeNull());
    expect(cards(b)).toEqual([['task_start', 'granted']]);
    await b.run({ type: 'respondApproval', sessionId: 's', approvalId: id, granted: false });
    expect(starts()).toHaveLength(1);
  });

  it('drops a request answered while this TUI was reconnecting, card and question both', async () => {
    daemon.save(approvedPlan(), 's');
    const a = daemon.tui();
    const b = daemon.tui();
    await b.run({ type: 'loadSession', sessionId: 's' });
    const { id, answered } = await askedToStart();
    await vi.waitFor(() => expect(asking(b)).toBe(id));

    daemon.dropSockets();
    await vi.waitFor(() => expect(b.actions.some((action) => action.type === 'followLost')).toBe(true));
    await a.run({ type: 'respondApproval', sessionId: 's', approvalId: id, granted: true });
    await answered;
    await b.run({ type: 'loadSession', sessionId: 's' });

    expect(asking(b)).toBeNull();
    expect(cards(b)).toEqual([]);
    expect(starts()).toHaveLength(1);
  });
});

describe('the welcome through the real daemon and client', () => {
  let daemon: LiveDaemon;

  beforeEach(async () => { daemon = await liveDaemon(); });
  afterEach(async () => { await daemon.close(); });

  it('carries the workspace preview from the daemon into the welcome, saying plainly there is no repository', async () => {
    const tui = daemon.tui();

    await tui.run({ type: 'refresh' });

    expect(tui.state().isolationPreview).toMatchObject({ status: 'no-repo', repos: [] });
    expect(stripAnsi(render(tui.state()).join('\n'))).toContain('No Git repository detected. Tasks run in the workspace without isolated worktrees.');
  });
});
