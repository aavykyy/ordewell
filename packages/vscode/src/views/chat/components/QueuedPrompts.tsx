import React from 'react';
import type { PromptHold } from '@ordewell/core/plan-utils';

interface QueuedPromptsProps {
  prompts: PromptHold;
  onUnsend: () => void;
  /** Send one held prompt now, by position: it stops the turn and goes ahead of the rest. */
  onSendNow: (index: number) => void;
}

/**
 * Prompts held for the next planner turn, drawn after the conversation they
 * join once sent. Only the newest carries the ×: unsend always takes the
 * newest, as Esc does, so the button never promises to take back another.
 */
export default function QueuedPrompts({ prompts, onUnsend, onSendNow }: QueuedPromptsProps) {
  if (prompts.length === 0) return null;
  const newest = prompts.length - 1;
  return (
    <div className="conversation-queued" aria-label="Queued prompts">
      {prompts.map((text, i) => (
        <div key={i} className="queued-prompt">
          <div className="queued-prompt-bubble">{text}</div>
          <div className="queued-prompt-meta">
            <button
              type="button"
              className="queued-prompt-now"
              title="Stop the planner turn and send this now, ahead of the rest"
              aria-label={`Send now: ${text}`}
              onClick={() => onSendNow(i)}
            >
              Send now
            </button>
            <span>{i === newest ? 'queued · esc to unsend' : 'queued'}</span>
            {i === newest && (
              <button
                type="button"
                className="queued-prompt-unsend"
                title="Unsend (Esc)"
                aria-label={`Unsend queued prompt: ${text}`}
                onClick={onUnsend}
              >
                ×
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
