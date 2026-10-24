import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLANNER_TURN_ENDED } from '../plannerTools';
import type { SkillInfo } from '../SkillsService';
import { makeSession, type SessionOverrides } from './sessionTestKit';
import { ctx, heldPlanner, NOW, plan, settled, task, until } from './supervisorTestKit';

/**
 * An edit_plan call checks its ops against the live catalog and the skills
 * they attach, and both can wait. The planner turn that made the call may end
 * meanwhile, by Stop or by a newer reply; its ops then reach no turn.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const tdd: SkillInfo = {
  name: 'tdd', description: 'tdd', metadata: { name: 'tdd', description: 'tdd' }, content: '', path: '/g/tdd/SKILL.md', source: 'global', appliesTo: 'task', modelInvocable: false, userInvocable: true,
};

const attachSkill = { ops: [{ op: 'update' as const, taskId: 't1', changes: { skills: ['tdd'] } }] };

/** A plan not yet run, with the user's turn open and the planner's reply in the test's hands. */
async function openTurn(overrides: SessionOverrides = {}) {
  const planner = heldPlanner();
  const session = makeSession({ aiService: planner.aiService, ...overrides });
  session.loadPlan(plan([task('t1', 1), task('t2', 2)], { status: 'draft' }), 'build it', process.cwd());
  void session.continueConversation('add a skill');
  await until(() => planner.calls.length === 1);
  return { session, planner };
}

/** A promise the test settles by hand. */
function gate<T>() {
  let open!: (value: T) => void;
  const opened = new Promise<T>((resolve) => { open = resolve; });
  return { opened, open };
}

describe('an edit whose planner turn ends while its ops are checked', () => {
  describe('during the skill check', () => {
    function heldSkills() {
      const checking = gate<Map<string, string>>();
      const asked = vi.fn();
      const skills = {
        findSkill: (name: string) => (name === 'tdd' ? tdd : undefined),
        listSkills: () => [tdd],
        searchedDirs: () => [],
        forRoot() { return skills; },
        uncommitted: () => { asked(); return checking.opened; },
      };
      return { skills, asked, release: () => checking.open(new Map()) };
    }

    it('hands its ops to no turn once the turn was stopped', async () => {
      const held = heldSkills();
      const { session, planner } = await openTurn({ skillsService: held.skills });

      const call = planner.tools().editPlan!(attachSkill, ctx);
      await until(() => held.asked.mock.calls.length > 0);
      session.abortPlannerTurn();
      await settled();
      held.release();

      expect(await call).toMatchObject({ isError: true, text: expect.stringContaining(PLANNER_TURN_ENDED) });
      expect(session.runSnapshot().heldEdit).toBeUndefined();
    });

    it('hands its ops to no turn, rather than to the one opened since', async () => {
      const held = heldSkills();
      const { session, planner } = await openTurn({ skillsService: held.skills });

      const call = planner.tools().editPlan!(attachSkill, ctx);
      await until(() => held.asked.mock.calls.length > 0);
      session.abortPlannerTurn();
      await settled();
      void session.continueConversation('and another');
      await until(() => planner.calls.length === 2);
      held.release();

      expect(await call).toMatchObject({ isError: true, text: expect.stringContaining(PLANNER_TURN_ENDED) });
      expect(session.runSnapshot().heldEdit).toBeUndefined();
    });
  });

  describe('during the catalog discovery', () => {
    it('hands its ops to no turn, rather than to the one opened since', async () => {
      let discovering: Promise<unknown> | null = null;
      const modelsForRunners = vi.fn(async () => {
        await discovering;
        return {};
      });
      const { session, planner } = await openTurn({ modelResolver: { modelsForRunners } });
      const discovery = gate<void>();
      discovering = discovery.opened;
      modelsForRunners.mockClear();

      const call = planner.tools().editPlan!({ ops: [{ op: 'update', taskId: 't1', changes: { title: 'Renamed' } }] }, ctx);
      await until(() => modelsForRunners.mock.calls.length > 0);
      session.abortPlannerTurn();
      await settled();
      void session.continueConversation('and another');
      await until(() => planner.calls.length === 2);
      discovery.open();

      expect(await call).toMatchObject({ isError: true, text: expect.stringContaining(PLANNER_TURN_ENDED) });
      expect(session.runSnapshot().heldEdit).toBeUndefined();
    });
  });
});
