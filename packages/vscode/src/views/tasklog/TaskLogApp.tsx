import React, { useState, useEffect, useMemo } from 'react';
import { ConversationBlocks } from '../chat/components/ChatMessage';
import { useFollowOutput } from '../chat/followOutput';
import { contextMeterTitle, hasHiddenDetail, usageText } from '@ordewell/core/plan-utils';
import { applyConversationPatch, EMPTY_PATCHED_VIEW, patchedBlocks, type PatchedView } from '../../shared/conversationPatch';
import type { HostToTaskLog, TaskLogStatus, TaskLogToHost } from '../../shared/taskLogProtocol';
import { taskCommand, useRunnerCommands } from '../chat/components/RunnerCommands';
import { taskLogState } from './taskLogState';
import PendingMessages, { QUEUE_TITLE, SendKeyHint, isSendNowKey, type PendingMessage } from '../chat/components/PendingMessages';

declare function acquireVsCodeApi(): { postMessage(message: TaskLogToHost): void };

const vscode = acquireVsCodeApi();

function noop(): void {}

const STOP_ARM_MS = 2_000;

/**
 * One structured task's log (ADR-0018, V1), in its own editor tab. It draws
 * the same display blocks as the planner chat through the same components and
 * stylesheet, and adds what only a task has: a live-state header, a message
 * box that also stops the turn, the pending messages, and an attempt switcher. The host
 * reduces the log and patches blocks in; nothing here knows the event format.
 */
export default function TaskLogApp() {
  const [view, setView] = useState<PatchedView>(EMPTY_PATCHED_VIEW);
  const [status, setStatus] = useState<TaskLogStatus | null>(null);
  const [detailAll, setDetailAll] = useState(false);
  const usageLine = status?.usage ? usageText(status.usage) : null;
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [stopArmed, setStopArmed] = useState(false);

  const blocks = useMemo(() => patchedBlocks(view), [view]);
  const followRef = useFollowOutput<HTMLDivElement>(blocks);
  const state = status ? taskLogState(status) : null;
  const hasDetail = useMemo(() => hasHiddenDetail(blocks), [blocks]);
  const commands = status?.commands ?? [];
  const completion = useRunnerCommands(text, setText, commands);
  const canSend = text.trim().length > 0;

  useEffect(() => {
    const handler = (event: MessageEvent<HostToTaskLog>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'init':
          setView(applyConversationPatch(EMPTY_PATCHED_VIEW, {
            type: 'conversationPatch',
            order: msg.blocks.map((b) => b.id),
            changed: msg.blocks,
          }));
          setStatus(msg.status);
          setError('');
          break;
        case 'patch':
          setView((prev) => applyConversationPatch(prev, {
            type: 'conversationPatch',
            order: msg.order,
            changed: msg.changed,
          }));
          break;
        case 'status':
          setStatus(msg.status);
          break;
        case 'showError':
          setError(msg.error);
          break;
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, []);

  // A finished task has no turn to message: its box continues it instead, and
  // one paused on a usage limit is resumed by it.
  const continues = status?.continuable === true;
  const resumes = status?.resumable === true;

  const send = (): void => {
    const value = text.trim();
    if (!value) return;
    try {
      const command = taskCommand(value, commands);
      if (command && !continues) {
        vscode.postMessage({ type: 'invokeTaskCommand', ...command });
        setText('');
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    vscode.postMessage(continues ? { type: 'continueTask', text: value } : { type: 'sendTaskMessage', text: value });
    setText('');
  };

  const working = status?.working === true && state?.kind !== 'done' && state?.kind !== 'failed';
  // Force send (ADR-0023, F1) needs a turn to interrupt; a finished task's box continues it instead.
  const canSendNow = working && canSend && !continues && !(commands.length > 0 && text.trim().startsWith('/'));

  const sendNow = (): void => {
    const value = text.trim();
    if (!value) return;
    vscode.postMessage({ type: 'sendTaskMessageNow', text: value });
    setText('');
  };

  const pending = useMemo((): PendingMessage[] => (status?.queued ?? []).map((m) => ({
    key: m.id,
    text: m.text,
    state: m.forced ? 'sending' : m.handedOver ? 'waiting' : 'queued',
    onSendNow: m.forced ? undefined : () => vscode.postMessage({ type: 'sendQueuedTaskMessageNow', id: m.id }),
    onRemove: m.forced || m.handedOver ? undefined : () => vscode.postMessage({ type: 'removeQueuedTaskMessage', id: m.id }),
  })), [status?.queued]);

  // The pairing is what keeps a stray tap from interrupting a turn, so an arm
  // lapses on its own, and never outlives the turn it was aimed at.
  useEffect(() => {
    if (!stopArmed) return;
    if (!working) {
      setStopArmed(false);
      return;
    }
    const timer = setTimeout(() => setStopArmed(false), STOP_ARM_MS);
    return () => clearTimeout(timer);
  }, [stopArmed, working]);

  const onComposerKeyDown = (e: React.KeyboardEvent): void => {
    if (e.nativeEvent.isComposing || completion.keyDown(e)) return;
    if (e.key === 'Escape' && working) {
      e.preventDefault();
      if (stopArmed) {
        setStopArmed(false);
        vscode.postMessage({ type: 'interruptTask' });
      } else {
        setStopArmed(true);
      }
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (isSendNowKey(e) && canSendNow) sendNow();
    else send();
  };

  // One button, as in the planner's composer: Stop only while a turn is live
  // and nothing is typed, so typing a message always turns it back into Send.
  const stops = working && !canSend;
  const sendLabel = resumes ? 'Resume' : continues ? 'Continue' : 'Send';

  return (
    <div className="task-log-container">
      {status && (
        <div className="task-log-header">
          <span className="task-log-title">Task {status.order} · {status.title}</span>
          {status.runner && <span className="task-log-runner">{status.runner}</span>}
          {state && <span className={`task-log-state ${state.kind}`}>{state.label}</span>}
          {status.resumes && <span className="task-log-runner">{status.resumes}</span>}
          {resumes && (
            <button type="button" className="task-log-detail" onClick={() => vscode.postMessage({ type: 'resumeNow' })}
              title="The limit has reset: resume it in its saved session now">
              Resume now
            </button>
          )}
          {status.resumes && (
            <button type="button" className="task-log-detail" onClick={() => vscode.postMessage({ type: 'cancelResume' })}
              title="Keep it from resuming on its own: resume or retry it yourself once the limit resets">
              Don't resume
            </button>
          )}
          <span className="task-log-spacer" />
          {hasDetail && (
            <button type="button" className="task-log-detail" aria-pressed={detailAll}
              onClick={() => setDetailAll((v) => !v)} title="Show or hide the full thinking, command and subagent detail">
              {detailAll ? 'Collapse all' : 'Expand all'}
            </button>
          )}
          {status.attempts.length > 1 && (
            <label className="task-log-attempt">
              Attempt
              <select value={status.attempt} onChange={(e) => vscode.postMessage({ type: 'selectAttempt', attempt: Number(e.target.value) })}>
                {status.attempts.map((attempt) => <option key={attempt} value={attempt}>{attempt}</option>)}
              </select>
            </label>
          )}
        </div>
      )}

      {error && (
        <div className="task-log-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')}>Dismiss</button>
        </div>
      )}

      {/* Keyed by attempt so a switched-to attempt opens at its newest output. */}
      <div className="task-log-body" key={status?.attempt} ref={followRef}>
        {blocks.length === 0
          ? <div className="task-log-empty">{working ? 'Working…' : 'No output yet.'}</div>
          : <ConversationBlocks blocks={blocks} detailAll={detailAll} onShowPlan={noop}
              onAnswerApproval={(id, decision) => vscode.postMessage({ type: 'answerApproval', id, decision })} />}
      </div>

      {usageLine && (
        <div className="usage-line" role="status">
          <span title={status?.usage?.contextFill && contextMeterTitle(status.usage.contextFill)}>{usageLine}</span>
        </div>
      )}

      {stopArmed && <div className="stop-hint" role="status">Press Esc again to stop</div>}

      <PendingMessages messages={pending} />

      <div className="task-log-composer">
        {completion.palette}
        <textarea className="task-log-input" value={text} rows={2}
          placeholder={`${resumes ? 'The limit has reset? A message to resume it with…' : continues ? 'Continue the task in its saved session…' : 'Message the task…'} (Enter to send, Shift+Enter for a new line)`}
          onChange={(e) => completion.change(e.target.value)} onKeyDown={onComposerKeyDown} />
        <button type="button" className={`send-btn${stops ? ' processing' : ''}`}
          disabled={!stops && !canSend}
          title={stops ? 'Interrupt (Esc Esc)' : canSendNow ? QUEUE_TITLE : `${sendLabel} (Enter)`} aria-label={stops ? 'Interrupt' : sendLabel}
          onClick={stops ? () => vscode.postMessage({ type: 'interruptTask' }) : send}>
          {stops ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
              <rect x="0" y="0" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 8L14 2L8 14L6.5 9.5L2 8Z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          )}
        </button>
        {canSendNow && <SendKeyHint />}
      </div>
    </div>
  );
}
