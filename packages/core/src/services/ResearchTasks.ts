import type { LegacyPlanState, Task, TaskReportTo } from '../models/Task';
import type { ExecutionActor } from '../models/Execution';
import type { GlobalRunSettings } from './SettingsService';

export type ResearchWait = { kind: 'research-parallel' | 'research-message'; limit: number };

export interface ResearchSchedule {
  wait(task: Readonly<Task>): ResearchWait | undefined;
  started(task: Readonly<Task>): void;
}

/** Research's spending boundary belongs to the message, never to a run or a report turn (ADR-0037 R4). */
export class ResearchTasks implements ResearchSchedule {
  constructor(private readonly host: {
    plan(): LegacyPlanState | null;
    settings(): Pick<GlobalRunSettings, 'researchMaxParallel' | 'researchMaxPerMessage'>;
    active(): number;
    owe(taskId: string, to: TaskReportTo): void;
  }) {}

  userMessage(): void {
    const plan = this.host.plan();
    if (plan) plan.researchBudget = { tasks: 0, reports: 0 };
  }

  get left(): number {
    return Math.max(0, this.host.settings().researchMaxPerMessage - (this.host.plan()?.researchBudget?.tasks ?? 0));
  }

  mayReport(): boolean {
    return (this.host.plan()?.researchBudget?.reports ?? 0) < this.host.settings().researchMaxPerMessage;
  }

  reportTurn(): void {
    const budget = this.budget();
    if (budget) budget.reports++;
  }

  wait(task: Readonly<Task>): ResearchWait | undefined {
    if (!task.research) return;
    const { researchMaxParallel, researchMaxPerMessage } = this.host.settings();
    if (this.left === 0) return { kind: 'research-message', limit: researchMaxPerMessage };
    if (this.host.active() >= researchMaxParallel) return { kind: 'research-parallel', limit: researchMaxParallel };
  }

  started(task: Readonly<Task>): void {
    if (!task.research) return;
    const budget = this.budget();
    if (budget) budget.tasks++;
    if (!task.reportTo) this.host.owe(task.id, task.researchOrigin ?? researchReportTo(task.addedBy === 'supervisor'
      ? { kind: 'supervisor', level: this.host.plan()?.runSettings?.supervisorLevel ?? 'off' } : { kind: 'planner-turn' }));
  }

  private budget(): LegacyPlanState['researchBudget'] {
    const plan = this.host.plan();
    return plan ? (plan.researchBudget ??= { tasks: 0, reports: 0 }) : undefined;
  }
}

/** The same authority record as run_script, without inventing consent to a script (ADR-0037 R3). */
export function researchReportTo(actor: ExecutionActor): TaskReportTo {
  return actor.kind === 'supervisor'
    ? { research: true, actor: 'supervisor', level: actor.level }
    : { research: true, actor: 'planner-turn' };
}
