import type { CommandOutcome, ExecutionCommand } from './ExecutionCommands';
import type { ExecutionActor, SupervisorLevel } from '../models/Execution';

/** What settling a turn's effects calls on the Session. */
export interface TurnEffectsHost {
  /** The command seam: each deferred start is checked there again, against the plan as edited. */
  execute(command: ExecutionCommand, actor: ExecutionActor): Promise<CommandOutcome>;
  supervisorLevel(): SupervisorLevel;
  notice(level: 'warn' | 'error', message: string): void;
}

interface DeferredStart {
  command: ExecutionCommand;
  actor: ExecutionActor;
  intent: string;
}

/**
 * What one planner turn leaves for its end (ADR-0029): the starts it deferred
 * behind its own held task edit, whether that edit landed, and whether the
 * planner submitted a whole plan, which autorun starts (ADR-0030). Made per
 * turn and settled once however the turn ends — landed, stopped, failed or
 * discarded — so a deferred start always either runs or is reported as not
 * done, and nothing of one turn carries into the next.
 */
export class TurnEffects {
  private deferred: DeferredStart[] = [];
  private editLanded = false;
  private submitted = false;
  private settled = false;

  constructor(private readonly host: TurnEffectsHost) {}

  /** A start that waits for this turn's held edit. Asked for once the turn settled, it can never run as edited. */
  defer(command: ExecutionCommand, actor: ExecutionActor, intent: string): void {
    if (this.settled) this.notDone(intent);
    else this.deferred.push({ command, actor, intent });
  }

  /** The turn's planner tasks were adopted: a task edit, or a whole plan committed. */
  landed(how: 'edit' | 'commit'): void {
    if (how === 'edit') this.editLanded = true;
    else this.submitted = true;
  }

  get planSubmitted(): boolean { return this.submitted; }

  /**
   * The turn ended. Its deferred starts go through the seam again — the
   * supervisor's at the level it has by now — when its edit landed. An edit
   * that never landed (the turn stopped, failed, or the edit was refused as
   * it landed) takes its starts with it: run on the unedited plan, they would
   * not be what was asked.
   */
  settle(): void {
    if (this.settled) return;
    this.settled = true;
    const due = this.deferred;
    this.deferred = [];
    if (!this.editLanded) {
      for (const { intent } of due) this.notDone(intent);
      return;
    }
    void (async () => {
      for (const { command, actor } of due) {
        const now: ExecutionActor = actor.kind === 'supervisor' ? { kind: 'supervisor', level: this.host.supervisorLevel() } : actor;
        await this.host.execute(command, now).catch((err: unknown) => this.host.notice('error', `Could not run what the planner queued: ${err instanceof Error ? err.message : String(err)}`));
      }
    })();
  }

  /** The plan the turn served is gone: what it deferred must not run on the next one, edit landed or not. */
  abandon(): void {
    this.editLanded = false;
    this.settle();
  }

  private notDone(intent: string): void {
    this.host.notice('warn', `Not done: ${intent} waited for an edit that did not land.`);
  }
}
