import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import { EMPTY_TASK_LOG, EMPTY_TASK_LOG_FOLLOW, taskLogHeaderView, type AttemptUsage, type DisplayBlock, type RunnerCommand, type StructuredTurnEnd, type TaskLogFollow, type TaskLogHeaderTask, type TaskUsageSummary, type UsageTotals } from '@ordewell/core';
import { replayTaskLog } from '@ordewell/core/plan-utils';
import TaskLogApp from '../TaskLogApp';
import type { HostToTaskLog, TaskLogStatus } from '../../../shared/taskLogProtocol';

const api = (globalThis as unknown as { __vscodeApi: { postMessage: ReturnType<typeof vi.fn> } }).__vscodeApi;

function send(msg: HostToTaskLog): void {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: msg })); });
}

/**
 * The header fields the app used to take raw (`working`, `planStatus`, …) are
 * turned into a real log and read through core's one header view, so these
 * tests draw what the TUI draws rather than a hand-copied header.
 */
type StatusOverrides = Partial<TaskLogStatus> & {
  planStatus?: string;
  working?: boolean;
  awaitingReason?: TaskLogHeaderTask['awaitingReason'];
  skipReason?: string;
  resumeAt?: string;
  awaitingApproval?: number;
  continuable?: boolean;
  lastTurnEnd?: StructuredTurnEnd;
  usage?: Pick<TaskUsageSummary, 'totals' | 'contextFill'>;
  usageTotal?: Pick<TaskUsageSummary, 'totals' | 'contextFill'>;
  commands?: readonly RunnerCommand[];
};

function attemptOf(n: number, usage: Pick<TaskUsageSummary, 'totals' | 'contextFill'>): AttemptUsage {
  return {
    attempt: n, runner: 'claude-code', startedAt: '', wallTimeMs: 0, totals: usage.totals, byModel: [],
    ...(usage.contextFill
      ? { lastPromptTokens: usage.contextFill.usedTokens, ...(usage.contextFill.windowTokens ? { contextWindow: usage.contextFill.windowTokens } : {}) }
      : {}),
  };
}

/** What a second attempt adds to reach a stated task total, for the past-attempt case below. */
function remainder(total: UsageTotals, own: UsageTotals): UsageTotals {
  const left: UsageTotals = { ...total };
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const) {
    const value = (total[key] ?? 0) - (own[key] ?? 0);
    if (value > 0) left[key] = value; else delete left[key];
  }
  const cost = Object.entries(total.reportedCost ?? {}).flatMap(([currency, amount]) => {
    const value = amount - (own.reportedCost?.[currency] ?? 0);
    return value > 0 ? [[currency, value] as const] : [];
  });
  if (cost.length > 0) left.reportedCost = Object.fromEntries(cost); else delete left.reportedCost;
  return left;
}

function status(over: StatusOverrides = {}): TaskLogStatus {
  const {
    planStatus = 'in_progress', working = false, awaitingReason, skipReason, resumeAt,
    awaitingApproval = 0, continuable = false, lastTurnEnd, usage, usageTotal, commands,
    attempt = 1, attempts = [1], ...rest
  } = over;
  const ledger = usageTotal && usage
    ? [attemptOf(1, usage), attemptOf(2, { totals: remainder(usageTotal.totals, usage.totals), ...(usageTotal.contextFill ? { contextFill: usageTotal.contextFill } : {}) })]
    : usage ? [attemptOf(1, usage)] : [];
  const view = {
    ...EMPTY_TASK_LOG,
    working,
    ...(lastTurnEnd ? { lastTurnEnd } : {}),
    ...(commands?.length ? { blocks: [{ type: 'runner_loaded' as const, id: 'r', commands: [...commands], mcpServers: [] }] } : {}),
  };
  const follow: TaskLogFollow = { ...EMPTY_TASK_LOG_FOLLOW, view, attempts, attempt };
  return {
    taskId: 't1', order: 2, title: 'Parse JSON', runner: 'claude-code',
    header: taskLogHeaderView({
      status: planStatus,
      ...(awaitingReason ? { awaitingReason } : {}),
      ...(skipReason !== undefined ? { skipReason } : {}),
      resumeAt: resumeAt ?? null,
      continuable,
      attemptUsage: ledger,
    }, follow, awaitingApproval, attempt),
    queued: [], attempts, attempt,
    ...rest,
  };
}

const message = (id: string, text: string): DisplayBlock => ({ type: 'message', id, role: 'agent', text, streaming: false });

function init(overrides: StatusOverrides = {}, blocks: DisplayBlock[] = [message('b1', 'hello from the agent')]): void {
  send({ type: 'init', status: status(overrides), blocks });
}

describe('the task log tab (ADR-0018, V1)', () => {
  beforeEach(() => {
    cleanup();
    api.postMessage.mockClear();
  });

  it('names a subtask by its dotted reference in the header', () => {
    render(<TaskLogApp />);
    init({ orderLabel: '2.1' });

    expect(document.querySelector('.task-log-title')?.textContent).toBe('Task 2.1 · Parse JSON');
  });

  it('draws a handoff from the attempt log and expands its full report with the shared detail switch', () => {
    const report = Array.from({ length: 12 }, (_, i) => `Report line ${i + 1}`).join('\n');
    const view = replayTaskLog([{ type: 'handoff', handoff: {
      summary: 'Check the token boundary.', findingCount: 2,
      findings: [
        { id: 'F1', severity: 'blocker', title: 'Token escapes', detail: 'A sibling can read it.', evidence: [
          { kind: 'file', path: 'src/token.ts', line: 42 },
          { kind: 'commit', sha: 'abc123', repo: 'core', resolved: true },
          { kind: 'task', task: '#3', finding: 'F2' },
          { kind: 'url', url: 'https://example.com/evidence' },
        ] },
        { id: 'F2', severity: 'info', title: 'Checked the fallback' },
      ], artifacts: [{ kind: 'file', path: 'docs/result.md' }], report,
    } }]);
    render(<TaskLogApp />);
    init({ planStatus: 'completed' }, [...view.blocks]);
    expect(screen.getByText('Handoff · 2 findings · Blocker')).toBeTruthy();
    expect(screen.getByText('Check the token boundary.')).toBeTruthy();
    expect(screen.getByText('F1 · Blocker · Token escapes')).toBeTruthy();
    expect(screen.getByText('A sibling can read it.')).toBeTruthy();
    expect(screen.getByText(/src\/token.ts:42 \(unresolved\)/)).toBeTruthy();
    expect(screen.getByText(/commit abc123 in core/)).toBeTruthy();
    expect(screen.getByText(/commit abc123 in core/)).not.toHaveTextContent('commit abc123 in core (unresolved)');
    expect(screen.getByText(/task #3 F2/)).toBeTruthy();
    expect(screen.getByText(/https:\/\/example.com\/evidence/)).toBeTruthy();
    expect(screen.getByText('docs/result.md (unresolved)')).toBeTruthy();
    expect(document.querySelector('.task-handoff-report')).toHaveTextContent('Report line 8');
    expect(document.querySelector('.task-handoff-report')).not.toHaveTextContent('Report line 9');
    expect(screen.getByText('+4 lines of the report')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(document.querySelector('.task-handoff-report')?.textContent).toBe(report);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(document.querySelector('.task-handoff-report')).not.toHaveTextContent('Report line 9');
    expect(screen.getByText('Done')).toBeTruthy();
  });

  it.each(['script', 'user'])('draws a %s handoff with no findings and no detail toggle for a short report', (kind) => {
    render(<TaskLogApp />);
    const view = replayTaskLog([{ type: 'handoff', handoff: {
      summary: `${kind} finished`, findings: [], findingCount: 0, report: 'Short report',
    } }]);
    init({ planStatus: 'completed' }, [...view.blocks]);
    expect(screen.getByText('Handoff · no findings')).toBeTruthy();
    expect(screen.getByText(`${kind} finished`)).toBeTruthy();
    expect(screen.getByText('Short report')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Expand all' })).toBeNull();
  });

  it('replaces a live handoff through a patch and drops it when switching attempts', () => {
    render(<TaskLogApp />);
    init();
    const block: DisplayBlock = { type: 'handoff', id: 'handoff', handoff: {
      summary: '<script>author text</script>', findings: [], findingCount: 3,
    } };
    send({ type: 'patch', order: [block.id], changed: [block] });
    expect(screen.getByText('<script>author text</script>')).toBeTruthy();
    expect(document.querySelector('.task-handoff script')).toBeNull();
    expect(screen.getByText("+3 more findings, in the attempt's log")).toBeTruthy();
    send({ type: 'patch', order: [block.id], changed: [{ ...block, handoff: { summary: 'Restated', findings: [], findingCount: 0 } }] });
    expect(document.querySelectorAll('.task-handoff')).toHaveLength(1);
    expect(screen.queryByText('<script>author text</script>')).toBeNull();
    init({ attempt: 2, attempts: [1, 2] }, []);
    expect(screen.queryByText('Restated')).toBeNull();
  });

  it('offers no interrupt or send-now on a settled task with a stale open turn', () => {
    render(<TaskLogApp />);
    init({ planStatus: 'completed', working: true });
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.queryByLabelText('Interrupt')).toBeNull();
    const input = screen.getByPlaceholderText(/Message the task/);
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(api.postMessage).not.toHaveBeenCalledWith({ type: 'interruptTask' });
    fireEvent.change(input, { target: { value: 'another detail' } });
    expect(screen.getByLabelText('Send').getAttribute('title')).toBe('Send (Enter)');
  });

  it('pins the task\'s whole spend below the log and follows it as usage arrives', () => {
    render(<TaskLogApp />);
    init();
    expect(screen.queryByRole('status')).toBeNull();

    send({ type: 'status', status: status({ usage: { totals: { inputTokens: 12400, outputTokens: 3100, cachedInputTokens: 2000, reportedCost: { USD: 0.42 } }, contextFill: { usedTokens: 36_000, windowTokens: 200_000 } } }) });
    expect(screen.getByRole('status')).toHaveTextContent(/^ctx 36k \(18%\) · \$0\.42$/);
    expect(screen.getByText(/ctx 36k/)).toHaveAttribute('title', '36,000 of 200,000 tokens');

    send({ type: 'status', status: status({ usage: { totals: { inputTokens: 13000, outputTokens: 3200 }, contextFill: { usedTokens: 13_000 } } }) });
    expect(screen.getByRole('status')).toHaveTextContent(/^ctx 13k$/);

    send({ type: 'status', status: status({ usage: { totals: { inputTokens: 13000, outputTokens: 3200 } } }) });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('draws an earlier attempt\'s own spend above the task total', () => {
    render(<TaskLogApp />);
    init({
      attempt: 1, attempts: [1, 2],
      usage: { totals: { inputTokens: 1000, reportedCost: { USD: 0.5 } }, contextFill: { usedTokens: 10_000, windowTokens: 200_000 } },
      usageTotal: { totals: { inputTokens: 1500, reportedCost: { USD: 1.5 } }, contextFill: { usedTokens: 50_000, windowTokens: 200_000 } },
    });

    const lines = [...document.querySelectorAll('.usage-line')].map((el) => el.textContent);
    expect(lines).toEqual(['attempt 1: ctx 10k (5%) · $0.50', 'task total: ctx 50k (25%) · $1.50']);
  });

  it('completes only the runner commands and sends a command with arguments', () => {
    render(<TaskLogApp />);
    init({ working: true, commands: [{ name: 'compact', description: 'Compact native context', argumentHint: '[focus]', kind: 'builtin' }] });
    const input = screen.getByPlaceholderText(/Message the task/);
    fireEvent.change(input, { target: { value: '/' } });
    expect(screen.getByRole('listbox')).toHaveTextContent('/compact');
    expect(screen.getByRole('listbox')).toHaveTextContent('Compact native context');
    expect(screen.getByRole('listbox')).toHaveTextContent('[focus]');
    expect(screen.queryByText('/approve')).toBeNull();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input).toHaveValue('/compact ');
    fireEvent.change(input, { target: { value: '/compact keep API details' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'invokeTaskCommand', name: 'compact', args: 'keep API details' });
  });

  it('draws command results, automatic compaction and collapsed runner configuration', () => {
    render(<TaskLogApp />);
    const view = replayTaskLog([
      { type: 'runner_loaded', commands: [{ name: 'review', kind: 'skill', description: 'Review code' }], mcpServers: [{ name: 'docs', status: 'connected' }] },
      { type: 'command', name: 'compact', args: 'keep APIs' },
      { type: 'command_output', text: 'Native context summary' },
      { type: 'compaction', trigger: 'auto', preTokens: 12000, postTokens: 3000 },
      { type: 'turn_end', reason: 'completed' },
    ]);
    init({}, [...view.blocks]);
    expect(screen.getByText('/compact keep APIs')).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
    expect(screen.getByText('Native context summary')).toBeTruthy();
    expect(screen.getByText('Context compacted by the runner on its own · 12k → 3k tokens')).toBeTruthy();
    expect(screen.getByText(/Runner loaded 1 skill/)).toBeTruthy();
    expect(screen.queryByText('docs (connected)')).toBeNull();
    fireEvent.click(screen.getByText('Expand all'));
    expect(screen.getByText('docs (connected)')).toBeTruthy();
    expect(screen.getByText('/review')).toBeTruthy();
  });

  it('offers no palette when no commands are reported and sends slash text as typed', () => {
    render(<TaskLogApp />);
    init({ commands: [], working: true });
    const input = screen.getByPlaceholderText(/Message the task/);
    fireEvent.change(input, { target: { value: '/' } });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.change(input, { target: { value: '/custom details' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendTaskMessageNow', text: '/custom details' });
  });

  it('refuses Ordewell commands in a task and lets Escape close completion before interrupting', () => {
    render(<TaskLogApp />);
    init({ working: true, commands: [{ name: 'compact', kind: 'builtin', description: 'Native compaction' }] });
    const input = screen.getByPlaceholderText(/Message the task/);
    fireEvent.change(input, { target: { value: '/' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByText('Press Esc again to stop')).toBeNull();
    fireEvent.change(input, { target: { value: '/run' } });
    fireEvent.click(screen.getByLabelText('Send'));
    expect(screen.getByRole('alert')).toHaveTextContent('The runner does not offer that command');
    expect(api.postMessage).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue('/run');
  });

  it('asks the host for the log when it mounts', () => {
    render(<TaskLogApp />);
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('draws the saved blocks through the chat components', () => {
    render(<TaskLogApp />);
    init();

    expect(screen.getByText('Task 2 · Parse JSON')).toBeTruthy();
    expect(screen.getByText('hello from the agent')).toBeTruthy();
  });

  it('applies a live patch to the blocks it was sent', () => {
    render(<TaskLogApp />);
    init({}, [message('b1', 'first')]);
    send({ type: 'patch', order: ['b1', 'b2'], changed: [message('b2', 'second')] });

    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.getByText('second')).toBeTruthy();
  });

  it('shows the live state and sends a message on Send', () => {
    render(<TaskLogApp />);
    init({ working: true, awaitingReason: 'input' });
    expect(screen.getByText('Working')).toBeTruthy();

    const input = screen.getByPlaceholderText(/Message the task/);
    act(() => { fireEvent.change(input, { target: { value: 'use Postgres' } }); });
    act(() => { fireEvent.click(screen.getByLabelText('Send')); });

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendTaskMessage', text: 'use Postgres' });
  });

  it('says what a waiting task waits on, and why a skipped one was skipped', () => {
    render(<TaskLogApp />);
    init({ planStatus: 'awaiting_user', awaitingReason: 'files-changed' });
    expect(screen.getByText('Changed tracked files', { selector: '.task-log-state' })).toBeTruthy();

    send({ type: 'status', status: status({ planStatus: 'skipped', skipReason: 'no GPU on this host' }) });
    expect(screen.getByText('Skipped: no GPU on this host', { selector: '.task-log-state' })).toBeTruthy();
  });

  it('shows an undelivered message from the task log with an empty queue', () => {
    render(<TaskLogApp />);
    const view = replayTaskLog([
      { type: 'message_queued', messageId: 'm1', text: 'use Postgres' },
      { type: 'message_undelivered', messageId: 'm1', text: 'use Postgres' },
    ]);
    init({ queued: [...view.queued] }, [...view.blocks]);
    expect(screen.getByText('use Postgres · not delivered')).toBeTruthy();
    expect(screen.queryByTitle('Remove this message')).toBeNull();
  });

  it('shows the completion reminder as Ordewell\'s, not the user\'s', () => {
    render(<TaskLogApp />);
    const view = replayTaskLog([{ type: 'turn_start', message: 'Call task_complete.', from: 'ordewell' }]);
    init({}, [...view.blocks]);
    expect(screen.getByText('Ordewell: Call task_complete.')).toBeTruthy();
  });

  it('stacks pending messages above the composer, with no heading, and takes one back', () => {
    render(<TaskLogApp />);
    init({ queued: [{ id: 'q1', text: 'then add tests' }] });

    expect(screen.getByRole('list', { name: 'Pending messages' }).nextElementSibling?.classList.contains('task-log-composer')).toBe(true);
    expect(screen.getByText('then add tests')).toBeTruthy();
    expect(screen.queryByText(/^Queued/)).toBeNull();
    act(() => { fireEvent.click(screen.getByLabelText('Remove pending message: then add tests')); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'removeQueuedTaskMessage', id: 'q1' });
  });

  describe('Send now (ADR-0023, F1)', () => {
    it('is a key, not a second button: a hint and the Send tooltip name it while a turn is live and something is typed', () => {
      render(<TaskLogApp />);
      init({ working: true });
      expect(document.querySelector('.send-key-hint')).toBeNull();

      const input = screen.getByPlaceholderText(/Message the task/);
      act(() => { fireEvent.change(input, { target: { value: 'stop, use Postgres' } }); });

      expect(document.querySelectorAll('.task-log-composer button')).toHaveLength(1);
      expect(document.querySelector('.send-key-hint')?.textContent).toBe('Enter queue · Ctrl+Enter send now');
      expect(screen.getByLabelText('Send').getAttribute('title')).toBe('Queue (Enter) · Send now (Ctrl+Enter)');

      act(() => { fireEvent.keyDown(input, { key: 'Enter', metaKey: true }); });
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendTaskMessageNow', text: 'stop, use Postgres' });
      expect((input as HTMLTextAreaElement).value).toBe('');
    });

    it('force sends on Ctrl+Enter while a turn is live, and plain sends when none is', () => {
      render(<TaskLogApp />);
      init({ working: true });
      const input = screen.getByPlaceholderText(/Message the task/);
      act(() => { fireEvent.change(input, { target: { value: 'now' } }); });
      act(() => { fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true }); });
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendTaskMessageNow', text: 'now' });

      send({ type: 'status', status: status({ working: false }) });
      act(() => { fireEvent.change(input, { target: { value: 'later' } }); });
      act(() => { fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true }); });
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendTaskMessage', text: 'later' });
      act(() => { fireEvent.change(input, { target: { value: 'later still' } }); });
      expect(document.querySelector('.send-key-hint')).toBeNull();
    });

    it('is not offered on a finished task, whose box continues it', () => {
      render(<TaskLogApp />);
      init({ working: true, planStatus: 'completed', continuable: true });
      act(() => { fireEvent.change(screen.getByPlaceholderText(/Continue the task/), { target: { value: 'more' } }); });
      expect(document.querySelector('.send-key-hint')).toBeNull();
      expect(screen.getByLabelText('Continue').getAttribute('title')).toBe('Continue (Enter)');
    });

    it('is on each pending message the runner already has too, and each says where it stands', () => {
      render(<TaskLogApp />);
      init({ working: true, queued: [{ id: 'q0', text: 'stop now', forced: true }, { id: 'q1', text: 'then add tests' }, { id: 'q2', text: 'handed', handedOver: true }] });

      const states = [...document.querySelectorAll('.pending-message-state')].map((el) => el.textContent);
      expect(states).toEqual(['sending now…', 'queued', 'waiting for the current step']);
      expect(screen.queryByLabelText('Send now: stop now')).toBeNull();
      act(() => { fireEvent.click(screen.getByLabelText('Send now: then add tests')); });
      act(() => { fireEvent.click(screen.getByLabelText('Send now: handed')); });
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendQueuedTaskMessageNow', id: 'q1' });
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendQueuedTaskMessageNow', id: 'q2' });
    });

    it('offers × only on a message still in Ordewell\'s queue', () => {
      render(<TaskLogApp />);
      init({ working: true, queued: [{ id: 'q0', text: 'stop now', forced: true }, { id: 'q1', text: 'then add tests' }, { id: 'q2', text: 'handed', handedOver: true }] });

      expect([...document.querySelectorAll('.pending-message-remove')].map((el) => el.getAttribute('aria-label')))
        .toEqual(['Remove pending message: then add tests']);
    });

    it('sends a pending message now on Ctrl+Enter while focus is on it', () => {
      render(<TaskLogApp />);
      init({ working: true, queued: [{ id: 'q2', text: 'handed', handedOver: true }] });

      act(() => { fireEvent.keyDown(screen.getByLabelText('Send now: handed'), { key: 'Enter', ctrlKey: true }); });
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendQueuedTaskMessageNow', id: 'q2' });
    });
  });

  it('is one button: disabled when idle and empty, Stop while a turn is live and empty, Send once typed', () => {
    render(<TaskLogApp />);
    init({ working: false });
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(true);

    send({ type: 'status', status: status({ working: true }) });
    act(() => { fireEvent.click(screen.getByLabelText('Interrupt')); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'interruptTask' });

    act(() => { fireEvent.change(screen.getByPlaceholderText(/Message the task/), { target: { value: 'wait, use Postgres' } }); });
    expect(screen.queryByLabelText('Interrupt')).toBeNull();
    act(() => { fireEvent.click(screen.getByLabelText('Send')); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendTaskMessage', text: 'wait, use Postgres' });
  });

  it('sends on Enter and keeps Shift+Enter for a new line', () => {
    render(<TaskLogApp />);
    init({ working: true });
    const input = screen.getByPlaceholderText(/Message the task/);
    act(() => { fireEvent.change(input, { target: { value: 'hello' } }); });

    act(() => { fireEvent.keyDown(input, { key: 'Enter', shiftKey: true }); });
    expect(api.postMessage).not.toHaveBeenCalledWith({ type: 'sendTaskMessage', text: 'hello' });

    act(() => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendTaskMessage', text: 'hello' });
  });

  describe('Esc Esc to interrupt', () => {
    const esc = (input: HTMLElement): void => { act(() => { fireEvent.keyDown(input, { key: 'Escape' }); }); };

    it('arms on the first Esc with a hint and interrupts on the second', () => {
      render(<TaskLogApp />);
      init({ working: true });
      const input = screen.getByPlaceholderText(/Message the task/);

      esc(input);
      expect(screen.getByText('Press Esc again to stop')).toBeTruthy();
      expect(api.postMessage).not.toHaveBeenCalledWith({ type: 'interruptTask' });

      esc(input);
      expect(screen.queryByText('Press Esc again to stop')).toBeNull();
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'interruptTask' });
    });

    it('lets the arm lapse after a pause', () => {
      vi.useFakeTimers();
      try {
        render(<TaskLogApp />);
        init({ working: true });
        esc(screen.getByPlaceholderText(/Message the task/));
        act(() => { vi.advanceTimersByTime(2_100); });
        expect(screen.queryByText('Press Esc again to stop')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does nothing when no turn is live', () => {
      render(<TaskLogApp />);
      init({ working: false });
      const input = screen.getByPlaceholderText(/Message the task/);
      esc(input);
      esc(input);
      expect(screen.queryByText('Press Esc again to stop')).toBeNull();
      expect(api.postMessage).not.toHaveBeenCalledWith({ type: 'interruptTask' });
    });
  });

  it('follows a live patch into view', () => {
    const { container } = render(<TaskLogApp />);
    init({ working: true }, [message('b1', 'first')]);
    const body = container.querySelector('.task-log-body') as HTMLElement;
    let top = 0;
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });

    send({ type: 'patch', order: ['b1', 'b2'], changed: [message('b2', 'second')] });
    expect(top).toBe(600);
  });

  it('switches to an earlier attempt', () => {
    render(<TaskLogApp />);
    init({ attempts: [1, 2], attempt: 2 });

    act(() => { fireEvent.change(screen.getByLabelText('Attempt'), { target: { value: '1' } }); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'selectAttempt', attempt: 1 });
  });

  it('shows a control refusal the host reported', () => {
    render(<TaskLogApp />);
    init();
    send({ type: 'showError', error: 'Task is not running.' });

    expect(screen.getByText('Task is not running.')).toBeTruthy();
  });

  it('turns the message box into Continue for a finished task that can be continued (ADR-0018, K1)', () => {
    render(<TaskLogApp />);
    init({ planStatus: 'completed', continuable: true });

    const input = screen.getByPlaceholderText(/Continue the task/);
    act(() => { fireEvent.change(input, { target: { value: 'also handle arrays' } }); });
    act(() => { fireEvent.click(screen.getByLabelText('Continue')); });

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'continueTask', text: 'also handle arrays' });
    expect(screen.queryByLabelText('Send')).toBeNull();
  });

  describe('a runner\'s tool request (ADR-0018, A1)', () => {
    const request = (overrides: Partial<Extract<DisplayBlock, { type: 'approval' }>> = {}): DisplayBlock => ({
      type: 'approval', id: 'b2', approvalId: 'ap-1', kind: 'runner_tool', subject: 'Bash(npm test)', scope: 'Bash', status: 'pending', allowForTask: true,
      ...overrides,
    });

    it('offers Allow, Allow for this task and Deny, each sent with its whole decision', () => {
      render(<TaskLogApp />);
      init({ working: true, awaitingApproval: 1 }, [request()]);
      expect(screen.getByText('Waiting for approval', { selector: '.task-log-state' })).toBeTruthy();

      fireEvent.click(screen.getByText('Allow'));
      fireEvent.click(screen.getByText('Allow for this task'));
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'answerApproval', id: 'ap-1', decision: { decision: 'allow' } });
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'answerApproval', id: 'ap-1', decision: { decision: 'allowForTask' } });
    });

    it('denies with the note typed on the card', () => {
      render(<TaskLogApp />);
      init({}, [request()]);
      fireEvent.change(screen.getByPlaceholderText(/Note to the agent/), { target: { value: '  write it under notes/ ' } });
      fireEvent.click(screen.getByText('Deny'));
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'answerApproval', id: 'ap-1', decision: { decision: 'deny', note: 'write it under notes/' } });
    });

    it('leaves out Allow for this task when the runner offered no grant', () => {
      render(<TaskLogApp />);
      init({}, [request({ allowForTask: false })]);
      expect(screen.queryByText('Allow for this task')).toBeNull();
      expect(screen.getByText('Allow')).toBeTruthy();
    });

    it('settles into how it was answered, with no buttons left', () => {
      render(<TaskLogApp />);
      init({}, [
        request({ status: 'granted', decidedBy: 'asked', forTask: true }),
        request({ id: 'b3', approvalId: 'ap-2', status: 'denied', decidedBy: 'asked', note: 'use notes/' }),
        request({ id: 'b4', approvalId: 'ap-3', status: 'withdrawn' }),
      ]);
      expect(screen.getByText('Approved for this task')).toBeTruthy();
      expect(screen.getByText('Note to the agent: use notes/')).toBeTruthy();
      expect(screen.getByText('Withdrawn')).toBeTruthy();
      expect(screen.queryByText('Allow')).toBeNull();
    });
  });
});

describe('a message the runner reads mid-turn (ADR-0023)', () => {
  beforeEach(() => {
    cleanup();
    api.postMessage.mockClear();
  });

  const before = [
    { type: 'turn_start', message: 'Do the task' },
    { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"sleep 20"}' },
    { type: 'message_queued', messageId: 'm1', text: 'use Postgres' },
    { type: 'message_queued', messageId: 'm2', text: 'then add tests' },
    { type: 'message_handed_over', messageId: 'm1' },
  ] as const;

  it('marks a message the runner already has, with no way to take it back but a way to send it now', () => {
    render(<TaskLogApp />);
    const view = replayTaskLog([...before]);
    init({ working: true, queued: [...view.queued] }, [...view.blocks]);

    expect(screen.getByText('waiting for the current step')).toBeTruthy();
    expect(screen.getByLabelText('Send now: use Postgres')).toBeTruthy();
    const removes = screen.getAllByTitle('Remove this message');
    expect(removes).toHaveLength(1);
    act(() => { fireEvent.click(removes[0]); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'removeQueuedTaskMessage', id: 'm2' });
  });

  it('draws the message in the log where the runner read it, and takes it off the queue', () => {
    render(<TaskLogApp />);
    const view = replayTaskLog([
      ...before,
      { type: 'tool_result', id: 'c1', output: '', success: true },
      { type: 'message_delivered', messageId: 'm1', text: 'use Postgres' },
      { type: 'text', text: 'Switching to Postgres.' },
    ]);
    init({ working: true, queued: [...view.queued] }, [...view.blocks]);

    expect(screen.queryByText('handed over')).toBeNull();
    const prompt = screen.getByText('Do the task');
    const read = screen.getByText('use Postgres');
    const reply = screen.getByText('Switching to Postgres.');
    expect(prompt.compareDocumentPosition(read) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(read.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('then add tests')).toBeTruthy();
  });
});
