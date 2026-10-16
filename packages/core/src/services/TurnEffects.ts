import type { ExecutionCommand } from './ExecutionCommands';
import type { ExecutionActor, SupervisorLevel } from '../models/Execution';
import type { StartAdmission } from './TaskOrchestrator';

/** What settling a turn's effects calls on the Session. */
export interface TurnEffectsHost {
  /**
   * The command seam: each deferred start is checked there again, against the
   * plan as edited and the admission it was queued under, and said if it does
   * not run.
   */
  replay(command: ExecutionCommand, actor: ExecutionActor, admission: StartAdmission): Promise<void>;
  supervisorLevel(): SupervisorLevel;
  notice(level: 'warn' | 'error', message: string): void;
}

const NO_EDIT = 'waited for an edit that did not land';

interface DeferredStart {
  command: ExecutionCommand;
  actor: ExecutionActor;
  intent: string;
  /** Held from the moment it was queued, so a Stop meanwhile counts it and withdraws it (ADR-0029). */
  admission: StartAdmission;
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
  defer(command: ExecutionCommand, actor: ExecutionActor, intent: string, admission: StartAdmission): void {
    if (!this.settled) {
      this.deferred.push({ command, actor, intent, admission });
      return;
    }
    admission.release();
    this.notDone(intent, NO_EDIT);
  }

  /** The turn's planner tasks were adopted: a task edit, or a whole plan committed. */
  landed(how: 'edit' | 'commit'): void {
    if (how === 'edit') this.editLanded = true;
    else this.submitted = true;
  }

  get planSubmitted(): boolean { return this.submitted; }

  /** Starts are still owed: the turn is open, or its deferred starts are still being run. */
  get outstanding(): boolean { return !this.settled || this.deferred.length > 0; }

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
    if (!this.editLanded) {
      this.drop(NO_EDIT);
      return;
    }
    void (async () => {
      // Taken one at a time, so an abandon while one runs drops the rest.
      for (let next = this.deferred.shift(); next; next = this.deferred.shift()) {
        const { command, actor, admission } = next;
        const now: ExecutionActor = actor.kind === 'supervisor' ? { kind: 'supervisor', level: this.host.supervisorLevel() } : actor;
        await this.host.replay(command, now, admission)
          .catch((err: unknown) => this.host.notice('error', `Could not run what the planner queued: ${err instanceof Error ? err.message : String(err)}`))
          .finally(() => admission.release());
      }
    })();
  }

  /**
   * The plan the turn served is gone: what it deferred must not run on the
   * next one, edit landed or not — a fork shares its task ids. A start
   * already at the seam goes on; those after it are dropped.
   */
  abandon(): void {
    if (this.settled) {
      this.drop('its plan was closed first');
      return;
    }
    this.editLanded = false;
    this.settle();
  }

  private drop(why: string): void {
    const dropped = this.deferred;
    this.deferred = [];
    for (const { intent, admission } of dropped) {
      admission.release();
      this.notDone(intent, why);
    }
  }

  private notDone(intent: string, why: string): void {
    this.host.notice('warn', `Not done: ${intent} ${why}.`);
  }
}
