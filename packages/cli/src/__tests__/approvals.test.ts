import { describe, it, expect, vi } from 'vitest';
import { describeApproval, describeApprovalDecision, handleApprovalEvent, createApprovalHandler, type ApprovalDeps } from '../approvals';

const SHELL_EVENT = {
  type: 'approval_request',
  id: 'ap-1',
  kind: 'shell_command',
  subject: 'npm test',
  scope: 'npm test',
  detail: 'Planner research wants to run: npm test',
};

const PATH_EVENT = {
  type: 'approval_request',
  id: 'ap-2',
  kind: 'external_path',
  subject: '/tmp/dump/a.log',
  scope: '/tmp/dump/*',
};

function deps(overrides: Partial<ApprovalDeps> = {}): ApprovalDeps {
  return {
    respond: vi.fn().mockResolvedValue(undefined),
    ask: vi.fn().mockResolvedValue('y'),
    write: vi.fn(),
    ...overrides,
  };
}

describe('describeApproval', () => {
  it('asks to start work without promising a wider grant (ADR-0029)', () => {
    const text = describeApproval({ type: 'approval_request', id: 'ap-3', kind: 'task_start', subject: 'Run the plan', scope: 'Run the plan' });
    expect(text).toContain('The planner wants to start work:\n    Run the plan');
    expect(text).not.toMatch(/also allows/i);
  });

  it('prints a script task\'s body whole, since the consent is to what runs (ADR-0035)', () => {
    const text = describeApproval({ type: 'approval_request', id: 'ap-4', kind: 'task_start', subject: 'Run script task #2 "Push"', scope: 'Run script task #2 "Push"', body: 'git push origin main\n\nTime limit: 10 minutes.' });
    expect(text).toContain('The planner wants to start work:\n    Run script task #2 "Push"\n      git push origin main\n\n      Time limit: 10 minutes.');
  });

  it('leads with what will run, not with the internal scope', () => {
    const text = describeApproval(SHELL_EVENT);
    expect(text).toContain('npm test');
    expect(text).toMatch(/run/i);
  });

  it('names the workspace escape for a path request', () => {
    const text = describeApproval(PATH_EVENT);
    expect(text).toContain('/tmp/dump/a.log');
    expect(text).toMatch(/outside the workspace/i);
  });

  it('says what a yes actually grants, since the grant is wider than the request', () => {
    expect(describeApproval(PATH_EVENT)).toContain('/tmp/dump/*');
  });

  it('describes a URL fetch', () => {
    const text = describeApproval({ ...PATH_EVENT, kind: 'url_fetch', subject: 'https://docs.rs/tokio', scope: 'https://docs.rs/*' });
    expect(text).toContain('https://docs.rs/tokio');
    expect(text).toMatch(/fetch/i);
  });

  it('describes a web search', () => {
    const text = describeApproval({ ...PATH_EVENT, kind: 'web_search', subject: 'tokio changelog', scope: 'web_search:duckduckgo' });
    expect(text).toContain('tokio changelog');
    expect(text).toMatch(/search the web/i);
  });

  it('describes a project MCP server it would start, by exactly what would run', () => {
    const text = describeApproval({ ...PATH_EVENT, kind: 'mcp_server', subject: 'probe: ./serve.sh --marker', scope: 'mcp-server:probe@0123456789ab' });
    expect(text).toContain('probe: ./serve.sh --marker');
    expect(text).toMatch(/start an MCP server the repository declares/i);
  });

  it('surfaces detail, since an auto-tier command touching an outside path otherwise reads identically to a plain read', () => {
    expect(describeApproval(SHELL_EVENT)).toContain('Planner research wants to run: npm test');
  });

  it('omits the detail line entirely when the event carries none', () => {
    expect(describeApproval(PATH_EVENT)).not.toMatch(/\n\s*undefined/);
  });
});

describe('handleApprovalEvent', () => {
  it('ignores events that are not approval requests', async () => {
    const d = deps();
    await handleApprovalEvent('s1', { type: 'research_step', tool: 'grep' }, d);

    expect(d.ask).not.toHaveBeenCalled();
    expect(d.respond).not.toHaveBeenCalled();
  });

  it('grants when the user answers yes', async () => {
    const d = deps({ ask: vi.fn().mockResolvedValue('y') });
    await handleApprovalEvent('s1', SHELL_EVENT, d);

    expect(d.respond).toHaveBeenCalledWith('s1', 'ap-1', true);
  });

  it('accepts a full "yes" as well as the initial', async () => {
    const d = deps({ ask: vi.fn().mockResolvedValue('YES') });
    await handleApprovalEvent('s1', SHELL_EVENT, d);

    expect(d.respond).toHaveBeenCalledWith('s1', 'ap-1', true);
  });

  it('denies on anything else, so a stray keypress cannot approve', async () => {
    const d = deps({ ask: vi.fn().mockResolvedValue('maybe') });
    await handleApprovalEvent('s1', SHELL_EVENT, d);

    expect(d.respond).toHaveBeenCalledWith('s1', 'ap-1', false);
  });

  it('denies on an empty answer — the default must never be consent', async () => {
    const d = deps({ ask: vi.fn().mockResolvedValue('') });
    await handleApprovalEvent('s1', SHELL_EVENT, d);

    expect(d.respond).toHaveBeenCalledWith('s1', 'ap-1', false);
  });

  it('grants without asking when the operator passed --yes', async () => {
    const d = deps({ autoApprove: true });
    await handleApprovalEvent('s1', SHELL_EVENT, d);

    expect(d.ask).not.toHaveBeenCalled();
    expect(d.respond).toHaveBeenCalledWith('s1', 'ap-1', true);
    expect(vi.mocked(d.write).mock.calls.join('')).toContain('npm test');
  });

  it('denies without asking when there is no interactive terminal', async () => {
    const d = deps({ interactive: false });
    await handleApprovalEvent('s1', SHELL_EVENT, d);

    expect(d.ask).not.toHaveBeenCalled();
    expect(d.respond).toHaveBeenCalledWith('s1', 'ap-1', false);
    expect(vi.mocked(d.write).mock.calls.join('')).toMatch(/ORDEWELL_APPROVAL_ALLOW|--yes/);
  });

  it('refuses a start it cannot ask about, and says how the user starts it themselves', async () => {
    const d = deps({ interactive: false });
    await handleApprovalEvent('s1', { type: 'approval_request', id: 'ap-3', kind: 'task_start', subject: 'Run the plan', scope: 'Run the plan' }, d);

    expect(d.ask).not.toHaveBeenCalled();
    expect(d.respond).toHaveBeenCalledWith('s1', 'ap-3', false);
    expect(vi.mocked(d.write).mock.calls.join('')).toContain('  Not started: there is no terminal here to ask you. Start it yourself with `ordewell run`, or Execute plan in the TUI or VS Code.\n');
  });

  it('does not fail the planning run when the answer cannot be delivered', async () => {
    const d = deps({ respond: vi.fn().mockRejectedValue(new Error('connection reset')) });

    await expect(handleApprovalEvent('s1', SHELL_EVENT, d)).resolves.toBeUndefined();
  });

  it('answers each request once, even when the same id arrives twice', async () => {
    const d = deps();
    const handle = createApprovalHandler('s1', d);

    await handle(SHELL_EVENT);
    await handle(SHELL_EVENT);

    expect(d.respond).toHaveBeenCalledTimes(1);
  });

  it('keeps that memory per run, so a second planning run still prompts', async () => {
    const d = deps();
    await createApprovalHandler('s1', d)(SHELL_EVENT);
    await createApprovalHandler('s2', d)(SHELL_EVENT);

    expect(d.respond).toHaveBeenCalledTimes(2);
  });

  it('prints a silent decision instead of dropping it — it never had a round-trip prompt to answer', async () => {
    const d = deps();
    await handleApprovalEvent('s1', { type: 'approval_decided', kind: 'shell_command', subject: 'npm test', scope: 'npm test', granted: true, source: 'pre-approved' }, d);

    expect(d.ask).not.toHaveBeenCalled();
    expect(d.respond).not.toHaveBeenCalled();
    expect(vi.mocked(d.write).mock.calls.join('')).toContain('npm test');
  });
});

describe('describeApprovalDecision', () => {
  it('labels a pre-approved grant', () => {
    const text = describeApprovalDecision({ type: 'approval_decided', subject: 'npm test', granted: true, source: 'pre-approved' });
    expect(text).toMatch(/auto-approved/i);
    expect(text).toContain('pre-approved');
    expect(text).toContain('npm test');
  });

  it('names the web-read guard behind a refusal', () => {
    expect(describeApprovalDecision({ type: 'approval_decided', subject: 'http://10.0.0.1/', granted: false, source: 'guard' })).toContain('blocked address');
    expect(describeApprovalDecision({ type: 'approval_decided', subject: '(withheld)', granted: false, source: 'secret' })).toContain('secret check');
    expect(describeApprovalDecision({ type: 'approval_decided', subject: 'tokio', granted: false, source: 'budget' })).toContain('web-read budget');
    expect(describeApprovalDecision({ type: 'approval_decided', subject: 'https://intra.example/', granted: false, source: 'excluded' })).toContain('excluded');
  });

  it('says an approved project server is not usable on the runner\'s version', () => {
    expect(describeApprovalDecision({ type: 'approval_decided', subject: 'probe: ./serve.sh', granted: false, source: 'unsupported' }))
      .toBe('Auto-denied (not usable on this runner version): probe: ./serve.sh');
  });

  it('labels a remembered grant', () => {
    const text = describeApprovalDecision({ type: 'approval_decided', subject: '/tmp/dump/b.log', granted: true, source: 'remembered' });
    expect(text).toContain('remembered');
  });

  it('labels a mode-floor denial', () => {
    const text = describeApprovalDecision({ type: 'approval_decided', subject: 'npm test', granted: false, source: 'mode' });
    expect(text).toMatch(/auto-denied/i);
    expect(text).toContain('policy');
  });
});
