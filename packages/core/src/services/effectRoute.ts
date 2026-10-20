/**
 * Where an effect the planner's shell does not run goes instead (ADR-0035):
 * an exact one the planner performs itself through `run_script`, which the
 * user consents to; one that needs judgment is an ops task; a change to the
 * repository's files is a change task.
 */
export const EFFECT_ROUTE = 'call run_script with the exact commands for an effect you can state, and the user consents to what it runs; one that needs judgment is an ops task in the plan, and a change to repository files is a change task, which the runner executing the plan makes.';

/** What a command the user did not approve leaves the planner to do (ADR-0026, ADR-0035). */
export const NOT_APPROVED_HINT = 'Continue without it. If it would change something outside the repository, call run_script with the exact commands, or add an ops task to the plan if it needs judgment; if it only reads, ask the user to approve it or add it to the planner allowlist.';
