import type { ResearchLogEntry, ResearchProgress, ResearchStep, SubagentLogEntry } from '../models/Task';

/** One subagent's activity: its log entry plus the steps it ran. */
interface SubagentRun {
  entry: SubagentLogEntry;
  steps: ResearchStep[];
}

/**
 * The research subagents one piece of planner work started, one run per
 * subagent, held by that work until it lands. A planner turn writes them in the
 * mutation that lands it; a turn that never lands — failed, stopped before it
 * said anything, abandoned with its plan — takes them with it, whatever its
 * subagents report afterwards.
 */
export class SubagentRuns {
  /** In the order each subagent was first seen. */
  private readonly runs = new Map<string, SubagentRun>();

  /** Take in one progress event of the work; anything not a subagent's is ignored. */
  observe(progress: ResearchProgress): void {
    switch (progress.type) {
      case 'tool_result':
        // Child steps carry their subagent on the step itself; the initiating
        // spawn step does not, so it stays a plain parent step.
        if (progress.step?.subagentId) this.run(progress.step.subagentId).steps.push(progress.step);
        return;
      case 'subagent_started':
        if (progress.subagentId) {
          const { entry } = this.run(progress.subagentId);
          entry.brief = progress.brief ?? entry.brief;
          if (progress.model) entry.model = progress.model;
        }
        return;
      case 'subagent_finished':
        if (progress.subagentId) {
          const { entry } = this.run(progress.subagentId);
          entry.outcome = progress.outcome ?? 'failed';
          entry.digest = progress.digest ?? '';
          if (progress.usage) entry.usage = progress.usage;
        }
        return;
      default:
        return;
    }
  }

  /**
   * `log` with the runs folded in as one contiguous group per subagent — its
   * entry then its steps — so a replay nests each step under its own subagent
   * however the live stream interleaved. A harness planner already logs its
   * child steps in the turn's own research; they are pulled out of that
   * position and regrouped rather than duplicated.
   */
  foldInto(log: readonly ResearchLogEntry[]): ResearchLogEntry[] {
    if (this.runs.size === 0) return [...log];
    const runs = [...this.runs.values()];
    const childStepIds = new Set(runs.flatMap((r) => r.steps.map((s) => s.id)));
    return [
      ...log.filter((e) => !childStepIds.has(e.id)),
      ...runs.flatMap((r): ResearchLogEntry[] => [r.entry, ...r.steps]),
    ];
  }

  /** Created on first sighting, so a step arriving before (or without) its started event still gets a home. */
  private run(subagentId: string): SubagentRun {
    let run = this.runs.get(subagentId);
    if (!run) {
      run = {
        entry: { id: `sa-${subagentId}`, type: 'subagent', subagentId, brief: '', outcome: 'failed', digest: '', timestamp: new Date().toISOString() },
        steps: [],
      };
      this.runs.set(subagentId, run);
    }
    return run;
  }
}
