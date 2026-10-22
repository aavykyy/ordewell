import { describe, it, expect } from 'vitest';
import { validatePlanTasks, parsePlanJson } from '../PlanValidator';
import { applyTaskOps, type TaskOp } from '../TaskOps';
import { validateTaskEdit } from '../TaskEditValidator';
import { PLANNER_TOOLS, type PlannerToolHandler } from '../mcp/tools';
import { createTask, keepExecutionState, waitsForApproval, type Task } from '../../models/Task';
import { rewrittenScripts, scriptBodyOf, DEFAULT_SCRIPT_TIMEOUT_MS } from '../../models/ScriptTask';

/**
 * A script task as a plan holds it (ADR-0035): `type: 'script'`, exactly one
 * body, top-level, and nothing a runner would read. Every route a task arrives
 * by holds it to that: a submitted plan, the plan envelope, an edit.
 */

const runners = ['claude-code'];
const push = [['git', 'push', 'origin', 'main']];
const scriptSpec = (over: Record<string, unknown> = {}) => ({ id: 's1', order: 1, title: 'Push the branch', description: 'push', type: 'script', sliceType: 'AFK', dependencies: [], ...over });
const aiSpec = (over: Record<string, unknown> = {}) => ({ id: 't1', order: 1, title: 'Build it', description: 'build', type: 'ai', prompt: 'build it', sliceType: 'AFK', autonomy: 'AFK', dependencies: [], ...over });

function refusal(spec: Record<string, unknown>): string[] {
  const result = validatePlanTasks({ tasks: [spec] }, runners);
  if (result.ok) throw new Error('expected a refusal');
  return result.errors.map((e) => e.message);
}

describe('a submitted plan with a script task', () => {
  it('accepts a commands body, run with no runner, model, mode or prompt', () => {
    const result = validatePlanTasks({ tasks: [scriptSpec({ commands: push })] }, runners);

    expect(result.ok).toBe(true);
    const [task] = result.ok ? result.tasks : [];
    expect(task).toMatchObject({ type: 'script', commands: push });
    expect(task.prompt).toBeUndefined();
    expect(task.assignedModel).toBeUndefined();
    expect(task.taskMode).toBeUndefined();
    expect(task.ops).toBeUndefined();
    expect(scriptBodyOf(task)).toEqual({ commands: push, timeoutMs: DEFAULT_SCRIPT_TIMEOUT_MS });
  });

  it('accepts a script body with a time limit of its own', () => {
    const result = validatePlanTasks({ tasks: [scriptSpec({ script: 'az webapp config appsettings set --name app --settings A=1', timeoutMs: 120_000 })] }, runners);

    expect(result.ok && scriptBodyOf(result.tasks[0])).toEqual({ script: 'az webapp config appsettings set --name app --settings A=1', timeoutMs: 120_000 });
  });

  it('accepts one in the plan envelope, beside the tasks it depends on', () => {
    const tasks = parsePlanJson(JSON.stringify({ tasks: [aiSpec(), scriptSpec({ order: 2, commands: push, dependencies: ['t1'] })] }), runners);

    expect(tasks.map((t) => t.type)).toEqual(['ai', 'script']);
    expect(tasks[1].dependencies).toEqual(['t1']);
  });

  it('refuses both bodies, and neither', () => {
    expect(refusal(scriptSpec({ commands: push, script: 'git push' }))).toContain('Task "Push the branch" has both "commands" and "script": a script task runs exactly one of them');
    expect(refusal(scriptSpec())).toContain('Task "Push the branch" is a script task with neither "commands" nor "script": give it the argument vectors to run, or the script');
  });

  it('refuses an empty argument vector, a program named by nothing, and commands that are not argument vectors', () => {
    expect(refusal(scriptSpec({ commands: [['git', 'fetch'], []] }))).toContain('Task "Push the branch" has command 2 as an empty argument vector: name the program it runs');
    expect(refusal(scriptSpec({ commands: [['', 'push']] }))).toContain('Task "Push the branch" has command 1 naming no program: its first word is the program it runs');
    expect(refusal(scriptSpec({ commands: [] }))[0]).toMatch(/^Task "Push the branch" has "commands" that is not a list of argument vectors/);
    expect(refusal(scriptSpec({ commands: 'git push origin main' }))[0]).toMatch(/^Task "Push the branch" has "commands" that is not a list of argument vectors/);
    expect(refusal(scriptSpec({ commands: [['git', 3]] }))[0]).toMatch(/^Task "Push the branch" has command 1 that is not an argument vector/);
  });

  it('refuses an empty script and a time limit out of range', () => {
    expect(refusal(scriptSpec({ script: '  ' }))).toContain('Task "Push the branch" has an empty "script": write the script it runs');
    expect(refusal(scriptSpec({ commands: push, timeoutMs: 0 }))[0]).toMatch(/has "timeoutMs" 0: the time limit is a whole number of milliseconds/);
    expect(refusal(scriptSpec({ commands: push, timeoutMs: 1.5 }))[0]).toMatch(/has "timeoutMs" 1.5/);
  });

  it('refuses runner, model and prompt fields on a script task, naming each', () => {
    expect(refusal(scriptSpec({ commands: push, prompt: 'push it', assignedRunner: 'claude-code', assignedModel: { modelId: 'sonnet' } }))).toContain(
      'Task "Push the branch" is a script task, which runs its "commands" or "script" with no model: leave out "assignedRunner", "assignedModel", "prompt"',
    );
    expect(refusal(scriptSpec({ commands: push, skills: ['deploy'] }))[0]).toMatch(/leave out "skills"/);
    expect(refusal(scriptSpec({ commands: push, readOnly: true }))[0]).toMatch(/leave out "readOnly"/);
    expect(refusal(scriptSpec({ commands: push, ops: true }))[0]).toMatch(/leave out "ops"/);
  });

  it('refuses subtasks under a script task, and a script task as a subtask', () => {
    expect(refusal(scriptSpec({ commands: push, subtasks: [aiSpec({ id: 'c1' })] }))[0]).toMatch(/leave out "subtasks"/);
    expect(refusal(aiSpec({ subtasks: [scriptSpec({ commands: push })] }))).toContain(
      'subtask "Push the branch" of "Build it" is a script task: only a top-level task can be one, as only a top-level task can be an ops task',
    );
  });

  it('refuses a body on a task that is not a script task', () => {
    expect(refusal(aiSpec({ commands: push }))).toContain('Task "Build it" has "commands", which only a script task has: set "type": "script", or leave it out');
  });

  it('is accepted by submit_plan\'s schema', async () => {
    const submitPlan = PLANNER_TOOLS.find((t) => t.name === 'submit_plan')!;
    let submitted: unknown;
    const handler: PlannerToolHandler = { submitPlan: async (args) => { submitted = args; return { text: 'ok' }; } };

    const reply = await submitPlan.call(handler, { tasks: [scriptSpec({ commands: push, timeoutMs: 60_000 })] }, { signal: new AbortController().signal });

    expect(reply.isError).toBeFalsy();
    expect(submitted).toMatchObject({ tasks: [{ type: 'script', commands: push, timeoutMs: 60_000 }] });
  });
});

describe('edit_plan and a script task', () => {
  const plan = (): Task[] => [
    createTask({ id: 'a', order: 1, title: 'Build', prompt: 'build', assignedRunner: 'claude-code' }),
    createTask({ id: 's', order: 2, title: 'Push', type: 'script', commands: push, dependencies: ['a'] }),
  ];
  const apply = (ops: TaskOp[], tasks = plan()) => applyTaskOps(tasks, ops, runners);
  const find = (tasks: readonly Task[], title: string) => tasks.find((t) => t.title === title)!;

  it('adds one as a script task: the type is never coerced to an AI task', () => {
    const result = apply([{ op: 'add', task: { title: 'Tag it', type: 'script', commands: [['git', 'tag', 'v1']], sliceType: 'AFK', dependencies: ['#2'] } }]);

    expect(result.errors).toEqual([]);
    const added = find(result.tasks, 'Tag it');
    expect(added).toMatchObject({ type: 'script', commands: [['git', 'tag', 'v1']], dependencies: ['s'] });
    expect(added.prompt).toBeUndefined();
  });

  it('turns an AI task that has not started into a script task with its body, clearing what a runner would read', () => {
    const result = apply([{ op: 'update', taskId: '#1', changes: { type: 'script', commands: [['npm', 'run', 'build']] } }]);

    expect(result.errors).toEqual([]);
    const task = find(result.tasks, 'Build');
    expect(task).toMatchObject({ type: 'script', commands: [['npm', 'run', 'build']] });
    expect(task.prompt).toBeUndefined();
    expect(task.taskMode).toBeUndefined();
    expect(result.summary[0]).toContain('cleared');
  });

  it('refuses a flip to a script task without a body, and one after the task started', () => {
    expect(apply([{ op: 'update', taskId: '#1', changes: { type: 'script' } }]).errors).toEqual([
      'op 1 (update): "Build" cannot become a script task without a body: include "commands" or "script" in this edit',
    ]);
    const failed = plan().map((t) => (t.id === 'a' ? { ...t, status: 'failed' as const } : t));
    expect(apply([{ op: 'update', taskId: '#1', changes: { type: 'script', commands: push } }], failed).errors).toEqual([
      'op 1 (update): "Build" has started, so whether it is a script task is fixed: add a new task instead',
    ]);
  });

  it('refuses a prompt, a runner or a read-only flag on a script task', () => {
    expect(apply([{ op: 'update', taskId: '#2', changes: { prompt: 'push it' } }]).errors).toEqual([
      'op 1 (update): "Push" is a script task, which runs its "commands" or "script" with no model: leave out "prompt"',
    ]);
    expect(apply([{ op: 'update', taskId: '#2', changes: { assignedRunner: 'claude-code' } }]).errors[0]).toMatch(/leave out "assignedRunner"/);
    expect(apply([{ op: 'update', taskId: '#2', changes: { readOnly: true } }]).errors[0]).toMatch(/leave out "readOnly"/);
  });

  it('replaces the body: a script written over commands drops them, and a null drops a limit', () => {
    const withLimit = plan().map((t) => (t.id === 's' ? { ...t, timeoutMs: 5000 } : t));
    const result = apply([{ op: 'update', taskId: '#2', changes: { script: 'git push origin main --tags', timeoutMs: null } as unknown as Partial<Task> }], withLimit);

    expect(result.errors).toEqual([]);
    expect(scriptBodyOf(find(result.tasks, 'Push'))).toEqual({ script: 'git push origin main --tags', timeoutMs: DEFAULT_SCRIPT_TIMEOUT_MS });
  });

  it('refuses a body on a task that is not a script task', () => {
    expect(apply([{ op: 'update', taskId: '#1', changes: { commands: push } }]).errors).toEqual([
      'op 1 (update): "Build" is not a script task, so it has no "commands": set "type": "script" with it, or leave it out',
    ]);
  });

  it('merges script tasks into a script task, whose body the merge states', () => {
    const two = [...plan(), createTask({ id: 't', order: 3, title: 'Tag', type: 'script', commands: [['git', 'tag', 'v1']] })];

    expect(apply([{ op: 'merge', taskIds: ['#2', '#3'], merged: { title: 'Push and tag' } }], two).errors[0]).toMatch(/is a script task with neither "commands" nor "script"/);
    const merged = apply([{ op: 'merge', taskIds: ['#2', '#3'], merged: { title: 'Push and tag', commands: [...push, ['git', 'tag', 'v1']] } }], two);
    expect(merged.errors).toEqual([]);
    expect(find(merged.tasks, 'Push and tag')).toMatchObject({ type: 'script', commands: [...push, ['git', 'tag', 'v1']] });
  });

  it('splits a script task into script tasks, each with its own body', () => {
    const result = apply([{ op: 'split', taskId: '#2', parts: [{ title: 'Fetch', commands: [['git', 'fetch']] }, { title: 'Push it', commands: push }] }]);

    expect(result.errors).toEqual([]);
    expect(result.tasks.filter((t) => t.type === 'script').map((t) => t.title)).toEqual(['Fetch', 'Push it']);
  });

  it('holds a user\'s direct edit to the same rules', () => {
    expect(validateTaskEdit('direct', plan(), 's', { prompt: 'push it' })).toMatchObject({ ok: false, error: expect.stringMatching(/leave out "prompt"/) });
    expect(validateTaskEdit('direct', plan(), 's', { commands: [['git', 'push', '--tags']] })).toEqual({ ok: true });
  });
});

describe('consent is to a body (ADR-0035)', () => {
  const before = [createTask({ id: 's', order: 1, title: 'Push', type: 'script', commands: push })];

  it('names a script task whose body or limit an edit changed, and no other', () => {
    expect(rewrittenScripts(before, [{ ...before[0], title: 'Push main' }])).toEqual([]);
    expect(rewrittenScripts(before, [{ ...before[0], commands: [['git', 'push', '--force']] }])).toEqual(['s']);
    expect(rewrittenScripts(before, [{ ...before[0], timeoutMs: 1000 }])).toEqual(['s']);
    expect(rewrittenScripts(before, [...before, createTask({ id: 'n', type: 'script', commands: push })])).toEqual([]);
  });

  it('counts a script task outside the approval record as waiting for the user\'s approval', () => {
    expect(waitsForApproval({ id: 's', type: 'script', status: 'pending' }, { approved: true, approvedTasks: [] })).toBe(true);
    expect(waitsForApproval({ id: 's', type: 'script', status: 'pending' }, { approved: true, approvedTasks: ['s'] })).toBe(false);
  });

  it('keeps a failed task a planner restates as another type as it was', () => {
    const failed = [{ ...before[0], status: 'failed' as const }];
    const [kept] = keepExecutionState(failed, [createTask({ id: 's', order: 1, title: 'Push', prompt: 'push it' })]);
    expect(kept).toMatchObject({ type: 'script', commands: push, status: 'failed' });
  });
});
