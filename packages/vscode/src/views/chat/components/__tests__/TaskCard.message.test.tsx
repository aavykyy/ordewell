import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import TaskCard from '../TaskCard';
import type { Task } from '@ordewell/core';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', order: 1, title: 'Test task', description: 'A task', type: 'ai', status: 'in_progress',
    dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build',
    ...overrides,
  };
}

function renderCard(task: Task, handlers: { onSendMessage?: (id: string, text: string) => void; onSendMessageNow?: (id: string, text: string) => void } = {}) {
  return render(
    <TaskCard
      task={task}
      models={[]}
      isExecuting
      expanded
      onExpandedChange={() => {}}
      onSendMessage={handlers.onSendMessage}
      onSendMessageNow={handlers.onSendMessageNow}
    />,
  );
}

const box = () => document.querySelector('.task-message-box');
const input = () => document.querySelector('.task-message-input') as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });

describe('messaging a running or waiting task from its card', () => {
  it.each(['in_progress', 'awaiting_user'] as const)('offers a message box on a %s task', (status) => {
    renderCard(makeTask({ status, awaitingReason: status === 'awaiting_user' ? 'input' : undefined }), { onSendMessage: vi.fn(), onSendMessageNow: vi.fn() });
    expect(box()).not.toBeNull();
  });

  it('hides the box on a task that is neither running nor waiting', () => {
    renderCard(makeTask({ status: 'pending' }), { onSendMessage: vi.fn(), onSendMessageNow: vi.fn() });
    expect(box()).toBeNull();
  });

  it('hides the box on a manual task, which has no runner turn', () => {
    renderCard(makeTask({ type: 'user', status: 'in_progress' }), { onSendMessage: vi.fn(), onSendMessageNow: vi.fn() });
    expect(box()).toBeNull();
  });

  it('sends a plain message through the task-log path on Send', () => {
    const onSendMessage = vi.fn();
    const onSendMessageNow = vi.fn();
    renderCard(makeTask(), { onSendMessage, onSendMessageNow });

    type('use Postgres');
    fireEvent.click(document.querySelector('.task-message-send')!);

    expect(onSendMessage).toHaveBeenCalledWith('t1', 'use Postgres');
    expect(onSendMessageNow).not.toHaveBeenCalled();
    expect(input().value).toBe('');
  });

  it('sends now on Send now and on Ctrl+Enter', () => {
    const onSendMessage = vi.fn();
    const onSendMessageNow = vi.fn();
    renderCard(makeTask(), { onSendMessage, onSendMessageNow });

    type('stop now');
    fireEvent.click(document.querySelector('.task-message-send-now')!);
    type('and this too');
    fireEvent.keyDown(input(), { key: 'Enter', ctrlKey: true });

    expect(onSendMessageNow.mock.calls).toEqual([['t1', 'stop now'], ['t1', 'and this too']]);
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it('sends a plain message on Enter', () => {
    const onSendMessage = vi.fn();
    const onSendMessageNow = vi.fn();
    renderCard(makeTask(), { onSendMessage, onSendMessageNow });

    type('a note');
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onSendMessage).toHaveBeenCalledWith('t1', 'a note');
    expect(onSendMessageNow).not.toHaveBeenCalled();
  });

  it('disables both sends with nothing typed', () => {
    renderCard(makeTask(), { onSendMessage: vi.fn(), onSendMessageNow: vi.fn() });
    expect(document.querySelector('.task-message-send')).toBeDisabled();
    expect(document.querySelector('.task-message-send-now')).toBeDisabled();
  });
});
