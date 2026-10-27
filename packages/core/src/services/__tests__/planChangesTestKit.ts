import { vi } from 'vitest';
import type { Task } from '../../models/Task';
import { PlanChangeCheck, type CheckedChange, type CheckPhase, type PassedChange, type PlannerChange, type PlanChangeScope } from '../PlanChangeCheck';
import type { PlannerConversationHost } from '../PlannerConversation';
import { checkOpSkills, checkPlanSkills, type SkillLookup } from '../taskSkills';

/** A change that passed, carrying what a test sets of it. */
export function passed(over: Partial<PassedChange> = {}): PassedChange {
  return { ok: true, tasks: [], adjustments: [], warnings: [], summary: [], handles: new Map(), ...over };
}

/** A change refused for `messages`. */
export function refused(...messages: string[]): CheckedChange {
  return { ok: false, errors: messages.map((message) => ({ message })), runners: [] };
}

/**
 * A conversation host's plan-change check whose rules a test can set:
 * `rules` answers every change, the real check's rules over `scope` (`real`)
 * until a test mocks it. The skills are looked up first, as the real check
 * looks them up, so a test can hold that wait with `useSkills`.
 */
export function fakePlanChanges(scope: Omit<PlanChangeScope, 'skills'>) {
  let lookup: SkillLookup = { findSkill: () => undefined, searchedDirs: () => [] };
  const real = new PlanChangeCheck(scope);
  const rules = vi.fn((change: PlannerChange, phase: CheckPhase): CheckedChange => real.checkNow(change, phase));
  const planChanges: PlannerConversationHost['planChanges'] = {
    async check(change, phase, then) {
      const skills = change.kind === 'ops' ? await checkOpSkills(change.ops, lookup) : await checkPlanSkills(change.tasks as readonly Task[], lookup);
      const checked: CheckedChange = skills.errors.length > 0
        ? { ok: false, errors: skills.errors.map((e) => ({ ...e, field: 'skills' })), runners: [] }
        : rules(change, phase);
      if (!checked.ok) return checked;
      const withWarnings = { ...checked, warnings: [...checked.warnings, ...skills.warnings] };
      then?.(withWarnings);
      return withWarnings;
    },
  };
  return { planChanges, rules, real: (change: PlannerChange, phase: CheckPhase) => real.checkNow(change, phase), useSkills: (next: SkillLookup) => { lookup = next; } };
}
