import { describe, it, expect } from 'vitest';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import type { AgentAdapter, PlannerStartOptions } from '../harness/AgentAdapter';
import type { ConversationRequest } from '../AiService';
import { fakeConfig, fakeFileSystem } from '../../testing';
import { fakeMcpServer } from './harnessTestKit';

/**
 * Ordewell's plan tools, through the lifetime of one planner conversation
 * (ADR-0025): the attach check is not a fact about the spawn, it is a fact
 * about the turn. A process can outlive its link to the server — a revoked
 * token, a rebuilt MCP client, an idle eviction — and the next turn must not be
 * sent to tools it can no longer call.
 */

interface FakePlanner {
  disposed: boolean;
  exited: boolean;
  sent: string[];
  starts: PlannerStartOptions[];
  token: string | null;
}

/** The token a runner was handed, out of the configuration the adapter started with. */
function bearer(record: FakePlanner): string | null {
  const [scheme, token] = (record.starts[0]?.mcp?.headers.Authorization ?? '').split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

/**
 * A service whose planner adapters keep their process and hand back the same
 * native session id when restarted. `attached` decides what each reports, so a
 * test can take the server's link away without killing the process.
 */
function planners(attached: (record: FakePlanner) => boolean | 'connected' | 'pending' | 'failed') {
  const mcp = fakeMcpServer();
  const records: FakePlanner[] = [];
  const svc = new CliAgentAiService(fakeConfig({ aiProvider: 'claude-code' }), {
    workspaceRoot: () => '/repo',
    mcpServer: mcp,
    createAdapter: () => {
      const record: FakePlanner = { disposed: false, exited: false, sent: [], starts: [], token: null };
      records.push(record);
      const adapter: AgentAdapter = {
        agentId: 'claude-code',
        get exited() { return record.exited; },
        start: async (opts) => {
          if (opts.kind !== 'planner') throw new Error('a planner test starts planners only');
          record.starts.push(opts);
          record.token = bearer(record);
        },
        send: async (message, onEvent) => {
          record.sent.push(message);
          const state = attached(record);
          if (state !== 'connected' && state !== true) {
            // OpenCode's own words when its tool list no longer holds Ordewell's.
            onEvent({ type: 'error', message: 'No tool named "ordewell_edit_plan" is currently available. Please use a tool from the available tool list.' });
            onEvent({ type: 'turn_end' });
            return;
          }
          onEvent({ type: 'assistant_text', runId: `r-${records.length}`, text: `reply ${records.length}` });
          onEvent({ type: 'turn_end' });
        },
        nativeSessionId: () => 'ses-1',
        dispose: () => { record.disposed = true; },
        mcpAttached: async () => attached(record),
      };
      return adapter;
    },
  });
  return { svc, records, mcp };
}

function request(): ConversationRequest {
  return {
    goal: 'Add a cache layer',
    runners: ['claude-code'],
    modelsByRunner: { 'claude-code': [{ modelId: 'sonnet', modelLabel: 'Sonnet', variants: [] }] },
    fs: fakeFileSystem(),
    onProgress: () => {},
    plannerTools: { sessionId: 's1', handler: {} },
  };
}

describe('a planner conversation keeps Ordewell\'s plan tools for its whole life', () => {
  it('respawns once with a fresh token instead of sending the turn without its tools', async () => {
    const { svc, records, mcp } = planners((record) => (record.token !== null && mcp.heldTokens().includes(record.token) ? 'connected' : 'failed'));
    await svc.startConversation(request());
    const firstToken = records[0].token!;
    expect(records[0].sent).toHaveLength(1);

    // The process stays up; only the credential it was spawned with goes away.
    mcp.revoke(firstToken);

    const turn = await svc.continueConversation('where were we?', () => {});

    expect(turn.text).toBe('reply 2');
    expect(records).toHaveLength(2);
    expect(records[1].sent).toEqual(['where were we?']);
    expect(records[0].disposed).toBe(true);
    expect(records[1].starts[0].resumeSessionId).toBe('ses-1');
    expect(mcp.heldTokens()).toEqual([records[1].token]);
  });

  it('re-attaches a planner restarted on its own session after the process ended', async () => {
    const { svc, records, mcp } = planners((record) => (record.token !== null && mcp.heldTokens().includes(record.token) ? 'connected' : 'failed'));
    await svc.startConversation(request());
    const firstToken = records[0].token!;
    // The process ended while nobody was talking to it: the next turn restarts
    // it from the session it named, on a credential of its own.
    records[0].exited = true;

    const turn = await svc.continueConversation('and then?', () => {});

    expect(turn.text).toBe('reply 2');
    expect(records).toHaveLength(2);
    expect(records[0].disposed).toBe(true);
    expect(records[1].starts[0].resumeSessionId).toBe('ses-1');
    expect(records[1].token).not.toBe(firstToken);
    expect(mcp.heldTokens()).toEqual([records[1].token]);
    expect(records[1].sent).toEqual(['and then?']);
  });

  it('treats a runner that cannot answer the attach check as lost, rather than planning blind', async () => {
    let unreadable = false;
    const { svc, records, mcp } = planners((record) => {
      if (unreadable && record === records[0]) throw new Error('the status request failed');
      return record.token !== null && mcp.heldTokens().includes(record.token) ? 'connected' : 'failed';
    });
    await svc.startConversation(request());
    unreadable = true;

    const turn = await svc.continueConversation('try again', () => {});

    expect(turn.text).toBe('reply 2');
    expect(records).toHaveLength(2);
    expect(records[1].sent).toEqual(['try again']);
  });

  it('fails the turn, sending nothing, when the planner cannot be given its tools again', async () => {
    let broken = false;
    const { svc, records, mcp } = planners((record) => (broken ? 'failed' : record.token !== null && mcp.heldTokens().includes(record.token) ? 'connected' : 'failed'));
    await svc.startConversation(request());
    mcp.revoke(records[0].token!);
    broken = true;

    await expect(svc.continueConversation('edit the plan', () => {})).rejects.toThrow(
      /^Could not start the claude-code planner with Ordewell's tools\./,
    );

    expect(records.slice(1).every((record) => record.sent.length === 0)).toBe(true);
    expect(svc.hasActiveConversation()).toBe(true);

    // A server that comes back is reachable on the next message: the failure
    // was the turn's, not the conversation's.
    broken = false;
    const turn = await svc.continueConversation('edit the plan', () => {});
    expect(turn.text).toBe(`reply ${records.length}`);
    expect(records.at(-1)!.sent).toEqual(['edit the plan']);
    expect(records.at(-1)!.starts[0].resumeSessionId).toBe('ses-1');
  });
});
