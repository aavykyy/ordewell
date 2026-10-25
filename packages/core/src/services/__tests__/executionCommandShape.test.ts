import { describe, expect, it } from 'vitest';
import { parseExecutionCommand } from '../executionCommandShape';

describe('parseExecutionCommand', () => {
  it('keeps a valid command and drops what the seam does not read', () => {
    expect(parseExecutionCommand({ command: 'retry_task', task: 't1', from: 'session', message: 'go on', extra: 1 }))
      .toEqual({ ok: true, command: { command: 'retry_task', task: 't1', from: 'session', message: 'go on' } });
  });

  it('keeps an override\'s yes and the status it was asked about, and refuses a yes that is not a flag', () => {
    expect(parseExecutionCommand({ command: 'mark_complete', task: 't1', confirmed: true, seen: 'failed' }))
      .toEqual({ ok: true, command: { command: 'mark_complete', task: 't1', confirmed: true, seen: 'failed' } });
    expect(parseExecutionCommand({ command: 'mark_not_done', task: 't1', confirmed: 'yes' }).ok).toBe(false);
  });

  it('takes a command with no fields', () => {
    expect(parseExecutionCommand({ command: 'merge_all', task: 'ignored' })).toEqual({ ok: true, command: { command: 'merge_all' } });
  });

  it('treats a null optional field as absent', () => {
    expect(parseExecutionCommand({ command: 'skip_task', task: 't1', reason: null })).toEqual({ ok: true, command: { command: 'skip_task', task: 't1' } });
  });

  it.each([
    ['not an object', 'stop_run'],
    ['an array', []],
    ['null', null],
    ['no command', {}],
    ['an inherited name', { command: 'toString' }],
    ['an unknown command', { command: 'format_disk' }],
    ['a missing task', { command: 'stop_task' }],
    ['a task that is not text', { command: 'stop_task', task: 7 }],
    ['a start from neither kind', { command: 'retry_task', task: 't1', from: 'later' }],
    ['a blank message', { command: 'message_task', task: 't1', text: ' ' }],
    ['a force that is not a flag', { command: 'message_task', task: 't1', text: 'hi', force: 'yes' }],
    ['a checkpoint answer of neither kind', { command: 'answer_checkpoint', task: 't1', answer: 'maybe' }],
    ['a script with a command line that is not text', { command: 'run_script', title: 'Lint', commands: [[1]] }],
    ['a script with no title', { command: 'run_script', script: 'ls' }],
  ])('refuses %s', (_label, body) => {
    const parsed = parseExecutionCommand(body);

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.message).not.toBe('');
  });

  it('takes an approval answer as free text, for the seam to refuse an allow with its reason', () => {
    expect(parseExecutionCommand({ command: 'answer_approval', task: 't1', answer: 'allow' }).ok).toBe(true);
  });
});
