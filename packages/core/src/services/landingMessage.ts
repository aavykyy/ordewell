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

/** The line that says a commit was planned by Ordewell, in git's trailer form (`git interpret-trailers --parse` reads it). */
export const PLANNED_WITH_TRAILER = 'Planned-with: Ordewell';

const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*:\s+\S/;

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0].trim();
}

/**
 * The whole message of a commit Ordewell writes for a task: the stated
 * subject, or the task title when none was stated, then the stated body
 * after a blank line. A repair merge carries no body: the body describes the
 * task's work, which the landing merge after it carries. With `plannedWith`
 * the {@link PLANNED_WITH_TRAILER} closes it; the caller reads the user's
 * setting as it writes (ADR-0030). The one place a landing's message text is
 * decided.
 */
export function landingMessage(kind: LandingCommit, from: LandingSubject, plannedWith = false): string {
  const subject = firstLine(from.commit?.subject ?? '') || firstLine(from.title);
  const head = kind === 'work' ? subject
    : kind === 'merge' ? `Merge: ${subject}`
    : `Merge: ${subject} (resolve conflicts with integration)`;
  const body = kind === 'repair-merge' ? '' : from.commit?.body?.trim() ?? '';
  const text = body ? `${head}\n\n${body}` : head;
  return plannedWith ? withTrailer(text, body) : text;
}

/**
 * git reads trailers from the last paragraph only, so a body that already ends
 * in a trailer block takes ours on the next line of it; any other message gets
 * a paragraph of its own.
 */
function withTrailer(text: string, body: string): string {
  const lines = text.split(/\r?\n/);
  if (lines.includes(PLANNED_WITH_TRAILER)) return text;
  const lastParagraph = body ? body.split(/\r?\n\s*\n/).pop()!.split(/\r?\n/) : [];
  const endsInTrailers = lastParagraph.length > 0 && lastParagraph.every((line) => TRAILER_LINE.test(line));
  return `${text}${endsInTrailers ? '\n' : '\n\n'}${PLANNED_WITH_TRAILER}`;
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
