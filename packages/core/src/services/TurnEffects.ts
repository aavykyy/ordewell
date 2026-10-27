/**
 * What one planner turn leaves for its end: whether the planner committed a
 * whole plan in it, which autorun starts once the turn lands (ADR-0030). Made
 * per turn, so nothing of one turn carries into the next. A change a planner
 * tool makes commits as the call answers (ADR-0022 P2), so a start the turn
 * asks for after it runs on the plan as changed, and none waits for the turn.
 */
export class TurnEffects {
  private submitted = false;

  /** The turn's planner tasks were adopted: a task edit, or a whole plan committed. */
  landed(how: 'edit' | 'commit'): void {
    if (how === 'commit') this.submitted = true;
  }

  get planSubmitted(): boolean { return this.submitted; }
}
