import type { HandoffCommit } from '../models/Handoff';

/**
 * The commits Ordewell itself writes for a task (ADR-0013): its leftover
 * `work`, the `merge` that lands it, and the `repair-merge` that brings the
 * integration tip into its branch when a landing conflicted (ADR-0015). A
 * commit the runner made is never rewritten, so it is not one of these.
 */
export type LandingCommit = 'work' | 'merge' | 'repair-merge';

/** What a landing message is written from: the task's title, and the commit its done handoff stated, if any. */
export interface LandingSubject {
  title: string;
  commit?: HandoffCommit;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0].trim();
}

/**
 * The whole message of a commit Ordewell writes for a task: the stated
 * subject, or the task title when none was stated, then the stated body
 * after a blank line. A repair merge carries no body: the body describes the
 * task's work, which the landing merge after it carries. The one place a
 * landing's message text is decided.
 */
export function landingMessage(kind: LandingCommit, from: LandingSubject): string {
  const subject = firstLine(from.commit?.subject ?? '') || firstLine(from.title);
  const head = kind === 'work' ? subject
    : kind === 'merge' ? `Merge: ${subject}`
    : `Merge: ${subject} (resolve conflicts with integration)`;
  const body = kind === 'repair-merge' ? '' : from.commit?.body?.trim() ?? '';
  return body ? `${head}\n\n${body}` : head;
}

/**
 * A message as `git commit`/`git merge` arguments: one `-m` per paragraph,
 * which git joins with a blank line, so a multi-line message never needs a
 * shell or a temporary file.
 */
export function messageArgs(message: string): string[] {
  return message.split(/\r?\n\s*\n/).map((p) => p.trim()).filter(Boolean).flatMap((p) => ['-m', p]);
}

/**
 * {@link messageArgs} as a POSIX shell would read them, for a command a
 * runner is asked to type: each paragraph single-quoted, its own quotes closed
 * around an escaped one.
 */
export function quotedMessageArgs(message: string): string {
  const args = messageArgs(message);
  return args.map((arg, i) => (i % 2 === 0 ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(' ');
}
