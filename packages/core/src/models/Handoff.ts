import { flattenTasks, type Task } from './Task';
import { checkOf } from './Loop';
import { resolveTaskRef, taskRefOf, titledTaskRefOf } from '../services/TaskRefs';

/*
 * A task's handoff (ADR-0047): what it tells the tasks that read it, as its
 * `task_complete` call stated it. A short summary, atomic findings Ordewell
 * numbers, typed artifacts, and a long report kept in the attempt's log and
 * never pushed. A handoff is neither the verdict nor evidence of passing.
 */

/** Advice to the reader of how much a finding matters; it never reaches the verdict. */
export type FindingSeverity = 'blocker' | 'major' | 'minor' | 'info';

/**
 * A typed reference a reader can check rather than trust. A `task` names the
 * task by id once the call is accepted, and `finding` one of its findings.
 */
export type HandoffEvidence =
  | { kind: 'file'; path: string; line?: number }
  | { kind: 'commit'; sha: string; repo?: string }
  | { kind: 'task'; task: string; finding?: string }
  | { kind: 'url'; url: string };

/** What a task produced, by the same four kinds as evidence. */
export type HandoffArtifact = HandoffEvidence;

export interface HandoffFinding {
  /** `F1` … `Fn`, assigned by Ordewell in the order the author gave them. */
  id: string;
  severity: FindingSeverity;
  title: string;
  detail?: string;
  evidence?: HandoffEvidence[];
}

/** What the plan keeps on a task: enough for a surface or a dependent's prompt without reading a log. */
export interface HandoffDigest {
  summary: string;
  /** The first {@link DIGEST_FINDINGS} findings; the rest are in the attempt's log. */
  findings: HandoffFinding[];
  findingCount: number;
  artifacts?: HandoffArtifact[];
}

/** The whole handoff, as the attempt's log keeps it. */
export interface StoredHandoff extends HandoffDigest {
  report?: string;
}

/** A handoff as its author sends it, before Ordewell numbers the findings. */
export interface Handoff {
  summary: string;
  findings?: Omit<HandoffFinding, 'id'>[];
  artifacts?: HandoffArtifact[];
  report?: string;
}

/** The most a report keeps: whole findings fit, and a runaway one does not bloat the files that hold it. */
export const REPORT_MAX_CHARS = 20_000;

/**
 * What a `task_complete` call may hand over. A call past one is refused, not
 * cut: an author who is told learns, one cut silently does not.
 */
export const HANDOFF_LIMITS = {
  summary: 1_500,
  findings: 50,
  title: 200,
  detail: 2_000,
  evidence: 10,
  artifacts: 20,
  report: REPORT_MAX_CHARS,
} as const;

/** Findings the plan's digest keeps of a handoff. */
export const DIGEST_FINDINGS = 25;

/** The handoff a call stated, its findings numbered in the author's order; undefined when it stated nothing. */
export function storedHandoff(handoff: Handoff): StoredHandoff | undefined {
  const summary = handoff.summary.trim();
  const findings = (handoff.findings ?? []).map((f, i): HandoffFinding => ({ id: `F${i + 1}`, ...f }));
  const artifacts = handoff.artifacts ?? [];
  const report = handoff.report?.trim();
  if (!summary && findings.length === 0 && artifacts.length === 0 && !report) return undefined;
  return {
    summary,
    findings,
    findingCount: findings.length,
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(report ? { report } : {}),
  };
}

/** What the plan keeps of a handoff: no report, and at most {@link DIGEST_FINDINGS} findings. */
export function handoffDigest(handoff: StoredHandoff): HandoffDigest {
  return {
    summary: handoff.summary,
    findings: handoff.findings.slice(0, DIGEST_FINDINGS),
    findingCount: handoff.findingCount,
    ...(handoff.artifacts ? { artifacts: handoff.artifacts } : {}),
  };
}

/** How a task is named in a handoff's text: the plan's reference for its id, or the id where the plan has none. */
export type HandoffTaskName = (taskId: string) => string | undefined;

/** A handoff with the tasks it cites named by their references in `plan`, as a reader names them. */
export function namedHandoff<H extends HandoffDigest>(plan: readonly Task[], handoff: H): H {
  const named = (refs: readonly HandoffEvidence[]) => refs.map((r) => (r.kind === 'task' ? { ...r, task: taskRefOf(plan, r.task) ?? r.task } : r));
  return {
    ...handoff,
    findings: handoff.findings.map((f) => (f.evidence ? { ...f, evidence: named(f.evidence) } : f)),
    ...(handoff.artifacts ? { artifacts: named(handoff.artifacts) } : {}),
  };
}

function referenceText(ref: HandoffEvidence, taskName: HandoffTaskName): string {
  switch (ref.kind) {
    case 'file': return ref.line !== undefined ? `${ref.path}:${ref.line}` : ref.path;
    case 'commit': return `commit ${ref.sha}${ref.repo ? ` in ${ref.repo}` : ''}`;
    case 'task': return `task ${taskName(ref.task) ?? ref.task}${ref.finding ? ` ${ref.finding}` : ''}`;
    case 'url': return ref.url;
  }
}

/** One finding as text: its id, severity and title, then its detail and evidence under it. */
export function findingLines(f: HandoffFinding, taskName: HandoffTaskName = () => undefined): string[] {
  return [
    `- ${f.id} [${f.severity}] ${f.title}`,
    ...(f.detail ? f.detail.split('\n').map((l) => `  ${l}`) : []),
    ...(f.evidence?.length ? [`  Evidence: ${f.evidence.map((e) => referenceText(e, taskName)).join('; ')}`] : []),
  ];
}

/** A handoff's artifacts as one line, or none when it lists none. */
export function artifactLines(handoff: HandoffDigest, taskName: HandoffTaskName = () => undefined): string[] {
  return handoff.artifacts?.length ? [`Artifacts: ${handoff.artifacts.map((a) => referenceText(a, taskName)).join('; ')}`] : [];
}

/**
 * A handoff as text, for a reader with no structure to render it from: the
 * summary, every finding it holds with its id, severity, detail and evidence,
 * how many the digest left out, the artifacts, and the report when it has one.
 */
export function handoffLines(handoff: HandoffDigest | StoredHandoff, taskName: HandoffTaskName = () => undefined): string[] {
  const lines = [handoff.summary];
  if (handoff.findings.length > 0) lines.push('', 'Findings:', ...handoff.findings.flatMap((f) => findingLines(f, taskName)));
  const more = handoff.findingCount - handoff.findings.length;
  if (more > 0) lines.push(`+${more} more finding${more === 1 ? '' : 's'}, in the attempt's log`);
  const artifacts = artifactLines(handoff, taskName);
  if (artifacts.length > 0) lines.push('', ...artifacts);
  if ('report' in handoff && handoff.report) lines.push('', 'Report:', handoff.report);
  return lines;
}

/**
 * The tasks whose handoffs `taskId` may cite and read (ADR-0047): itself, its
 * transitive dependencies, and its loop's other end — a check its body tasks,
 * a body task its check (ADR-0045). The plan's own graph scopes the reach.
 */
export function readableTaskIds(plan: readonly Task[], taskId: string): Set<string> {
  const tasks = flattenTasks(plan);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const readable = new Set<string>([taskId]);
  const pending = [...(byId.get(taskId)?.dependencies ?? [])];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (readable.has(id)) continue;
    readable.add(id);
    pending.push(...(byId.get(id)?.dependencies ?? []));
  }
  for (const id of byId.get(taskId)?.loop?.body ?? []) readable.add(id);
  const check = checkOf(tasks, taskId);
  if (check) readable.add(check.id);
  return readable;
}

export type HandoffCheck<H> = { ok: true; handoff: H } | { ok: false; refusal: string };

const RESEND = 'Fix or drop each reference named, then call task_complete again; nothing was recorded.';

/**
 * Check the references a handoff makes, at the call (ADR-0047): a `task`
 * must be one the producer may read and a finding of it one that exists, and
 * a `url` must be http or https, so no surface renders a `javascript:` link.
 * A `file` or `commit` is a claim about a tree Ordewell may not see, so it is
 * taken as given. An accepted handoff names each task by its id, which a
 * later edit of the plan does not renumber.
 */
export function checkHandoff<H extends Handoff>(handoff: H, producerId: string, plan: readonly Task[]): HandoffCheck<H> {
  const readable = readableTaskIds(plan, producerId);
  const refusals: string[] = [];
  const check = (ref: HandoffEvidence, field: string): HandoffEvidence => {
    if (ref.kind === 'url') {
      if (!isWebUrl(ref.url)) refusals.push(`${field}.url: ${JSON.stringify(ref.url)} is refused: only an http or https URL is accepted.`);
      return ref;
    }
    if (ref.kind !== 'task') return ref;
    const target = resolveTaskRef(plan, ref.task);
    if (!target) {
      refusals.push(`${field}.task: ${JSON.stringify(ref.task)} names no task in the plan: give its "#order", its id or its title.`);
      return ref;
    }
    const named = titledTaskRefOf(plan, target.id) ?? target.id;
    if (!readable.has(target.id)) {
      refusals.push(`${field}.task: ${JSON.stringify(ref.task)} is ${named}, which this task may not read: only itself, a task it depends on, or its loop's other end.`);
      return ref;
    }
    if (ref.finding !== undefined) {
      const count = target.handoff?.findingCount ?? 0;
      if (Number(ref.finding.slice(1)) > count) {
        refusals.push(`${field}.finding: ${JSON.stringify(ref.finding)} is not a finding of ${named}: ${count > 0 ? `its latest handoff has F1 to F${count}` : 'its latest handoff has none'}.`);
      }
    }
    return { ...ref, task: target.id };
  };
  const findings = handoff.findings?.map((f, i) => (f.evidence ? { ...f, evidence: f.evidence.map((e, j) => check(e, `findings[${i}].evidence[${j}]`)) } : f));
  const artifacts = handoff.artifacts?.map((a, i) => check(a, `artifacts[${i}]`));
  if (refusals.length > 0) return { ok: false, refusal: [...refusals, RESEND].join('\n') };
  return { ok: true, handoff: { ...handoff, ...(findings ? { findings } : {}), ...(artifacts ? { artifacts } : {}) } };
}

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
