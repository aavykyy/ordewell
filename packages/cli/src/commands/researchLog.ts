import { toolHeadline, type ResearchStep, type ResearchStepOutcome } from '@ordewell/core';
import type { WsEvent } from '../apiClient';

/**
 * Renders the planner's research stream as terminal lines. Pure, so the
 * headless log — the only audit trail a piped or CI run leaves behind — is
 * testable without a daemon or a socket.
 */

const OUTCOME_MARK: Record<ResearchStepOutcome, string> = {
  success: '✓',
  failure: '✗',
  refused: '⊘',
  denied: '⊘',
  not_executed: '–',
};

const RESULT_CHARS = 160;
const VERBOSE_RESULT_CHARS = 600;
const THINKING_CHARS = 300;

export interface StepLineOptions {
  /** `--verbose`: include the planner's raw reasoning and longer result previews. */
  verbose?: boolean;
}

// The TUI's command-row head, so a piped log and the chat pane name a call alike.
function summarize(tool: string, args: string, toolLabel?: string): string {
  const { name, keyArg } = toolHeadline(tool, args, toolLabel);
  return `${name}(${keyArg})`;
}

function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** The line a stream event should print, or null when it prints nothing. */
export function formatStepLine(event: WsEvent, options: StepLineOptions = {}): string | null {
  if (event.type === 'research_step') {
    const summary = summarize(event.tool, event.args || '{}', event.toolLabel);
    return event.subagentId ? `  ↳ ${summary}` : summary;
  }

  if (event.type === 'research_step_done') {
    const step = event.step as ResearchStep | undefined;
    if (!step) return null;
    const mark = OUTCOME_MARK[step.outcome] ?? '✓';
    const summary = summarize(step.tool, step.args, step.toolLabel);
    const result = oneLine(step.result ?? '', options.verbose ? VERBOSE_RESULT_CHARS : RESULT_CHARS);
    const indent = event.subagentId ? '  ↳ ' : '';
    return result ? `${indent}${mark} ${summary} → ${result}` : `${indent}${mark} ${summary}`;
  }

  // Said once per session, such as that the planner's shell has no OS sandbox
  // here (ADR-0011 B5): in a piped run this log is the only place it is seen.
  if (event.type === 'notice') return `! ${oneLine(event.message, Infinity)}`;

  return null;
}

/** Whether the line replaces the transient status line or scrolls away above it. */
export function isTransient(event: WsEvent): boolean {
  return event.type === 'research_step';
}

export interface LogLine {
  text: string;
  transient: boolean;
}

export interface StepLog {
  /** The lines this event settles, in order. */
  push(event: WsEvent): LogLine[];
  /** Whatever is still held, for when the stream ends. */
  flush(): LogLine[];
}

/**
 * The planning stream as log lines. Thinking arrives in fragments — a token at
 * a time from the API backends — so a run of it from one thinker is held and
 * printed as one line once something else prints or the stream ends.
 */
export function createStepLog(options: StepLineOptions = {}): StepLog {
  let held: { thinker: string; text: string } | null = null;

  const flush = (): LogLine[] => {
    const text = held ? oneLine(held.text, THINKING_CHARS) : '';
    held = null;
    return text ? [{ text: `  · ${text}`, transient: false }] : [];
  };

  return {
    push(event) {
      if (event.type === 'planner_thinking_delta') {
        // Reasoning is off by default: it is the noisiest part of the stream
        // and would bury the tool log it is interleaved with.
        if (!options.verbose) return [];
        const thinker = `${event.turnId}|${event.segmentId}|${event.subagentId}`;
        const done = held && held.thinker !== thinker ? flush() : [];
        held = { thinker, text: (held?.text ?? '') + event.text };
        return done;
      }
      // Lifecycle events that print nothing (liveness, usage) must not split
      // a run of thinking into several lines.
      const line = formatStepLine(event, options);
      return line === null ? [] : [...flush(), { text: line, transient: isTransient(event) }];
    },
    flush,
  };
}
