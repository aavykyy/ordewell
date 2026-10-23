import { handoffPreviewLines, type HandoffDigest } from '@ordewell/core';

/**
 * A handoff as the headless surfaces print it under a task (ADR-0047): the
 * summary, its findings' title lines and its artifacts. `status` and `run`
 * share this block, so what one says of a task the other says too. The detail
 * and the report stay in the attempt's log, which `task_output` reads.
 */
export function taskHandoffLines(handoff: HandoffDigest, indent: string): string[] {
  const preview = handoffPreviewLines(handoff);
  const [first = '', ...body] = preview;
  if (!handoff.summary.trim() || handoff.commit) return [`${indent}↳ Handoff`, ...preview.map((line) => `${indent}${line}`)];
  return [`${indent}↳ Handoff: ${first}`, ...body.map((line) => `${indent}${line}`)];
}
