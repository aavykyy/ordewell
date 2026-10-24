import { describe, it, expect, vi } from 'vitest';
import { createTask, type DiscoveredModel, type RunnerId, type Task } from '../../models/Task';
import { PlanChangeCheck, planChangeErrorText, requestScope, type CheckedChange, type PassedChange, type PlanChangeScope } from '../PlanChangeCheck';
import { parsePlanJson } from '../PlanValidator';
import type { TaskOp } from '../TaskOps';
import type { SkillInfo } from '../SkillsService';
import type { SkillLookup } from '../taskSkills';

const model = (modelId: string): DiscoveredModel => ({ modelId, modelLabel: modelId, variants: [] });

/** A session's live state, which a test moves between a change's submit and its landing. */
function fakeSession(tasks: Task[] = []) {
  const live = {
    tasks,
    enabled: ['claude-code'] as RunnerId[],
    allowlist: {} as Record<string, string[]>,
    held: [] as TaskOp[],
    skills: undefined as SkillLookup | undefined,
    guard: undefined as PlanChangeScope['guard'],
  };
  const scope: PlanChangeScope = {
    tasks: () => live.tasks,
    runners: (kind) => (kind === 'plan' ? [...live.enabled] : [...new Set([...live.tasks.map((t) => t.assignedRunner), ...live.enabled])]),
    catalog: () => ({ modelsByRunner: { 'claude-code': [model('sonnet'), model('opus')], codex: [model('gpt-5')] }, perRunnerAllowlist: live.allowlist }),
    skills: () => live.skills ?? { findSkill: () => undefined, searchedDirs: () => [] },
    held: () => live.held,
    guard: (before, after) => live.guard?.(before, after),
  };
  return { live, check: new PlanChangeCheck(scope) };
}

const raw = (id: string, over: Record<string, unknown> = {}) => ({
  id, order: 1, title: `Task ${id}`, description: 'd', prompt: 'p', sliceType: 'AFK', autonomy: 'AFK', assignedRunner: 'claude-code', ...over,
});

function passed(checked: CheckedChange): PassedChange {
  if (!checked.ok) throw new Error(`refused: ${checked.errors.map(planChangeErrorText).join('; ')}`);
  return checked;
}

describe('a whole plan, as submitted and as it lands', () => {
  it('lands with the adjustments it was shown at submit, the stray model replaced as the submit said', async () => {
    const { live, check } = fakeSession();
    live.allowlist = { 'claude-code': ['sonnet'] };

    const submitted = passed(await check.check({ kind: 'plan', tasks: [raw('a', { assignedModel: { modelId: 'opus' } })] }, 'submit'));
    const landed = passed(await check.check({ kind: 'plan', tasks: submitted.tasks }, 'land'));

    expect(submitted.tasks[0].assignedModel?.modelId).toBe('opus');
    expect(submitted.adjustments).toEqual([expect.objectContaining({ taskId: 'a', field: 'assignedModel', from: 'opus', to: 'sonnet' })]);
    expect(landed.adjustments).toEqual(submitted.adjustments);
    expect(landed.tasks[0].assignedModel?.modelId).toBe('sonnet');
  });

  it('is refused as it lands for a runner switched off since it was accepted, naming the runners enabled now', async () => {
    const { live, check } = fakeSession();
    live.enabled = ['claude-code', 'codex'];
    const submitted = passed(await check.check({ kind: 'plan', tasks: [raw('a', { assignedRunner: 'codex' })] }, 'submit'));

    live.enabled = ['claude-code'];
    const landed = await check.check({ kind: 'plan', tasks: submitted.tasks }, 'land');

    expect(landed).toEqual({
      ok: false,
      runners: ['claude-code'],
      errors: [{ taskId: 'a', field: 'assignedRunner', message: 'Task "Task a" has invalid assignedRunner "codex". Expected one of: claude-code' }],
    });
  });

  it('is held to the same rules by the envelope\'s parse as by submit_plan: the same tasks pass, the same first error refuses', async () => {
    const { live, check } = fakeSession();
    live.enabled = ['claude-code', 'codex'];
    const good = [raw('a'), raw('b', { order: 2, assignedRunner: 'codex', dependencies: ['a'] })];
    const bad = [raw('a', { assignedRunner: 'opencode' })];
    const { runners, runnerModes, autonomousDefault } = check.intake();

    const viaTool = passed(await check.check({ kind: 'plan', tasks: good }, 'submit'));
    const viaEnvelope = parsePlanJson(JSON.stringify({ tasks: good }), runners, runnerModes, autonomousDefault);
    expect(viaEnvelope).toEqual(viaTool.tasks);

    const refused = await check.check({ kind: 'plan', tasks: bad }, 'submit');
    expect(() => parsePlanJson(JSON.stringify({ tasks: bad }), runners, runnerModes, autonomousDefault))
      .toThrow(refused.ok ? 'not refused' : refused.errors[0].message);
  });

  it('refuses a planner skill at either end, by task and field, and only warns of one not found', async () => {
    const { live, check } = fakeSession();
    const grilling = { name: 'grilling', path: '/g/grilling/SKILL.md', appliesTo: 'planner' } as SkillInfo;
    live.skills = { findSkill: (name) => (name === 'grilling' ? grilling : undefined), searchedDirs: () => [] };

    const refused = await check.check({ kind: 'plan', tasks: [raw('a', { skills: ['grilling'] })] }, 'submit');
    const warned = passed(await check.check({ kind: 'plan', tasks: [raw('a', { skills: ['later'] })] }, 'submit'));

    expect(refused).toMatchObject({ ok: false, errors: [{ taskId: 'a', field: 'skills', message: expect.stringContaining('"grilling" is a planner skill') }] });
    expect(warned.warnings).toEqual([expect.stringContaining('skill "later" not found')]);
  });
});

describe('an edit, as it is made and as it lands', () => {
  const plan = () => [createTask({ id: 't1', order: 1, title: 'Build', prompt: 'p', assignedRunner: 'claude-code', assignedModel: { modelId: 'sonnet', modelLabel: 'sonnet' } })];

  it('joins the held ops at submit and leaves the plan as the whole batch landing does', async () => {
    const { live, check } = fakeSession(plan());
    const rename: TaskOp = { op: 'update', taskId: '#1', changes: { title: 'Build it' } };
    const add: TaskOp = { op: 'add', task: { title: 'Ship', prompt: 'ship', dependencies: ['#1'] } };
    live.held = [rename];

    const submitted = passed(await check.check({ kind: 'ops', ops: [add] }, 'submit'));
    const landed = passed(await check.check({ kind: 'ops', ops: [rename, add] }, 'land'));

    expect(landed.tasks).toEqual(submitted.tasks);
    expect(landed.adjustments).toEqual(submitted.adjustments);
    expect(landed.tasks.map((t) => t.title)).toEqual(['Build it', 'Ship']);
  });

  it('names the op a refusal is about as data, an op the turn already held as an earlier one', async () => {
    const { live, check } = fakeSession(plan());
    live.held = [{ op: 'remove', taskId: '#9' }];

    const refused = await check.check({ kind: 'ops', ops: [{ op: 'update', taskId: '#1', changes: { title: 'x' } }] }, 'submit');

    expect(refused).toMatchObject({ ok: false, errors: [{ op: { number: 1, kind: 'remove', earlier: true } }] });
    expect(refused.ok ? [] : refused.errors.map(planChangeErrorText)).toEqual([expect.stringMatching(/^earlier op 1 \(remove\): /)]);
  });

  it('pins a planner skill an op attaches to that op', async () => {
    const { live, check } = fakeSession(plan());
    const grilling = { name: 'grilling', path: '/g/grilling/SKILL.md', appliesTo: 'planner' } as SkillInfo;
    live.skills = { findSkill: (name) => (name === 'grilling' ? grilling : undefined), searchedDirs: () => [] };

    const refused = await check.check({ kind: 'ops', ops: [{ op: 'add', task: { title: 'A' } }, { op: 'update', taskId: '#1', changes: { skills: ['grilling'] } }] }, 'submit');

    expect(refused).toMatchObject({ ok: false, errors: [{ field: 'skills', op: { number: 2, kind: 'update' } }] });
    expect(refused.ok ? '' : planChangeErrorText(refused.errors[0])).toMatch(/^op 2 \(update\): "grilling" is a planner skill/);
  });

  it('refuses what the guard refuses, after the applier passed it', async () => {
    const { live, check } = fakeSession(plan());
    live.guard = () => 'the supervisor has changed this task too often';

    expect(await check.check({ kind: 'ops', ops: [{ op: 'update', taskId: '#1', changes: { title: 'x' } }] }, 'land'))
      .toMatchObject({ ok: false, errors: [{ message: 'the supervisor has changed this task too often' }] });
  });

  it('reads the plan after its one wait, the skill lookup, and hands only what passed to `then`', async () => {
    const { live, check } = fakeSession(plan());
    const asked = vi.fn();
    let release = () => {};
    const tdd = { name: 'tdd', path: '/g/tdd/SKILL.md', appliesTo: 'task', source: 'global' } as SkillInfo;
    live.skills = {
      findSkill: (name) => (name === 'tdd' ? tdd : undefined),
      searchedDirs: () => [],
      uncommitted: () => new Promise((resolve) => {
        asked();
        release = () => resolve(new Map());
      }),
    };
    const then = vi.fn();

    const pending = check.check({ kind: 'ops', ops: [{ op: 'update', taskId: '#1', changes: { skills: ['tdd'] } }] }, 'land', then);
    await vi.waitFor(() => expect(asked).toHaveBeenCalled());
    live.tasks = [{ ...live.tasks[0], title: 'Renamed meanwhile' }];
    release();
    const checked = passed(await pending);
    await check.check({ kind: 'ops', ops: [{ op: 'remove', taskId: '#9' }] }, 'land', then);

    expect(checked.tasks.map((t) => [t.title, t.skills])).toEqual([['Renamed meanwhile', ['tdd']]]);
    expect(then).toHaveBeenCalledTimes(1);
    expect(then).toHaveBeenCalledWith(checked);
  });
});

describe('a one-shot plan, checked against its request', () => {
  it('replaces a stray model as it lands, as a session\'s plan lands', async () => {
    const check = new PlanChangeCheck(requestScope({ runners: ['claude-code'], modelsByRunner: { 'claude-code': [model('sonnet'), model('opus')] }, perRunnerAllowlist: { 'claude-code': ['sonnet'] } }));
    const submitted = passed(await check.check({ kind: 'plan', tasks: [raw('a', { assignedModel: { modelId: 'opus' } })] }, 'submit'));

    const landed = passed(await check.check({ kind: 'plan', tasks: submitted.tasks }, 'land'));

    expect(landed.tasks[0].assignedModel?.modelId).toBe('sonnet');
    expect(landed.adjustments).toEqual(submitted.adjustments);
  });
});
