import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLANNER_TURN_ENDED } from '../plannerTools';
import type { SkillInfo } from '../SkillsService';
import { makeSession, type SessionOverrides } from './sessionTestKit';
import { ctx, heldPlanner, NOW, plan, settled, task, until } from './supervisorTestKit';

/**
 * An edit_plan call checks its ops against the live catalog and the skills
 * they attach, and both can wait. The planner turn that made the call may end
 * meanwhile, by Stop, by a newer reply or by its plan being replaced; the
 * call is then refused and changes nothing, since it commits only in the turn
 * it was made in (ADR-0022 P2).
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
  // A turn whose plan is replaced rejects as discarded; the tests read the call it made, not the reply.
  void session.continueConversation('add a skill').catch(() => {});
  await until(() => planner.calls.length === 1);
  return { session, planner };
}

/** A promise the test settles by hand. */
function gate<T>() {
  let open!: (value: T) => void;
  const opened = new Promise<T>((resolve) => { open = resolve; });
  return { opened, open };
}

const unchanged = (session: Awaited<ReturnType<typeof openTurn>>['session']) => session.planTasks.map((t) => [t.id, t.title, t.skills ?? []]);

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

    it('commits nothing once the turn was stopped', async () => {
      const held = heldSkills();
      const { session, planner } = await openTurn({ skillsService: held.skills });

      const call = planner.tools().editPlan!(attachSkill, ctx);
      await until(() => held.asked.mock.calls.length > 0);
      session.abortPlannerTurn();
      await settled();
      held.release();

      expect(await call).toMatchObject({ isError: true, text: expect.stringContaining(PLANNER_TURN_ENDED) });
      expect(session.planTasks.map((t) => t.skills ?? [])).toEqual([[], []]);
    });

    it('commits nothing, rather than in the turn opened since', async () => {
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
      expect(session.planTasks.map((t) => t.skills ?? [])).toEqual([[], []]);
    });

    it('commits nothing on the plan that replaced the one it was made for', async () => {
      const held = heldSkills();
      const { session, planner } = await openTurn({ skillsService: held.skills });

      const call = planner.tools().editPlan!(attachSkill, ctx);
      await until(() => held.asked.mock.calls.length > 0);
      session.loadPlan(plan([task('t1', 1), task('t2', 2)], { status: 'draft' }), 'build it again', process.cwd());
      await settled();
      held.release();

      expect(await call).toMatchObject({ isError: true, text: expect.stringContaining(PLANNER_TURN_ENDED) });
      expect(unchanged(session)).toEqual([['t1', 'Task t1', []], ['t2', 'Task t2', []]]);
    });

    it('commits no plan submitted in a turn stopped while its skills were checked', async () => {
      const held = heldSkills();
      const { session, planner } = await openTurn({ skillsService: held.skills });
      const tasks = [{ id: 'n1', title: 'New', description: 'd', type: 'ai', prompt: 'p', dependencies: [], sliceType: 'AFK', autonomy: 'AFK', assignedRunner: 'claude-code', skills: ['tdd'] }];

      const call = planner.tools().submitPlan!({ tasks } as never, ctx);
      await until(() => held.asked.mock.calls.length > 0);
      session.abortPlannerTurn();
      await settled();
      held.release();

      expect(await call).toMatchObject({ isError: true, text: expect.stringContaining(PLANNER_TURN_ENDED) });
      expect(unchanged(session)).toEqual([['t1', 'Task t1', []], ['t2', 'Task t2', []]]);
    });
  });

  describe('during the catalog discovery', () => {
    it('commits nothing, rather than in the turn opened since', async () => {
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
      expect(session.planTasks.map((t) => t.skills ?? [])).toEqual([[], []]);
    });
  });
});
