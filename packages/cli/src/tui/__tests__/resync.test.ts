import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
