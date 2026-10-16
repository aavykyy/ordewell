import { Hono, type Context, type Env } from 'hono';
import {
  AlreadyExecutingError,
  flattenTasks,
  NoPlanError,
  surfacePlan,
  surfacePlanState,
  TaskControlError,
  type CommandOutcome,
  type ConversationCompactResponse,
  type ConversationForkResponse,
  type ConversationRewindResponse,
  type ExecuteResponse,
  type ExecutionCommand,
  type ForceSendResponse,
  type GeneratePlanResponse,
  type IsolationDiffResponse,
  type IsolationMergeResponse,
  type MergeGateResponse,
  type OkResponse,
  type PlanResponse,
  type PrdResponse,
  type RemoveMessageResponse,
  type ResolveConflictResponse,
  type RewindTargetsResponse,
  type StopResponse,
  type TaskMessageResponse,
  type CancelPlanningResponse,
  type CancelResumeResponse,
} from '@ordewell/core';
import { OrchestratorPool } from '../pool/orchestratorPool';
import { failure, refuse } from './errors';

const NO_CHECKPOINT = 'The task is not waiting at a checkpoint: it was answered already, withdrawn, or has no runner left to hear it.';

/** One execution button's command, run as the user (ADR-0029): a refusal becomes the 400 the surface already shows. */
async function runUserCommand(session: ReturnType<OrchestratorPool['session']>, command: ExecutionCommand): Promise<Extract<CommandOutcome, { ok: true }>> {
  const outcome = await session.execute(command, { kind: 'user' });
  if (!outcome.ok) throw new TaskControlError(outcome.message);
  return outcome;
}

export function plansRoute(pool: OrchestratorPool) {
  const router = new Hono();

  router.post('/:sessionId/generate', async (c) => {
    try {
      const { goal, runners, workspace, model, allowInit } = await c.req.json();
      if (!goal) return c.json({ error: 'goal is required' }, 400);
      const ws = workspace || c.req.query('workspace') || process.cwd();
      const queryRunners = c.req.query('runners');
      // No runners in the request means "whatever is enabled", not claude-code:
      // a hard-coded default here contradicts the /runners toggle state and
      // fails planning for anyone who disabled claude-code. Left undefined for
      // the session to read after its planner gate, since before the installed
      // agents are detected the enabled default is not known yet.
      const runnerList: string[] | undefined = Array.isArray(runners) ? runners : (runners ? [runners] : (queryRunners ? queryRunners.split(',').map(s => s.trim()).filter(Boolean) : undefined));
      const plan = await pool.generatePlan(c.req.param('sessionId'), goal, runnerList, ws, model, { allowInit });
      const { models, modelsByRunner } = await pool.getProviderModels();
      const notes = (pool.session(c.req.param('sessionId')).planState?.conversationHistory ?? [])
        .filter((e) => e.kind === 'system')
        .map((e) => e.content);
      return c.json({ plan: surfacePlanState(plan), models, modelsByRunner, ...(notes.length > 0 ? { notes } : {}) } satisfies GeneratePlanResponse);
    } catch (err) {
      return failure(c, err, 'generate', { message: 'Plan generation failed' });
    }
  });

  router.post('/:sessionId/execute', async (c) => {
    try {
      const session = pool.session(c.req.param('sessionId'));
      // The daemon contract keeps `no_plan` and `already_executing` distinct
      // from a plain refusal; the seam refuses either way, so the codes it
      // cannot carry are kept here.
      if (!session.planState || session.planTasks.length === 0) throw new NoPlanError('execute');
      if (session.isExecuting) throw new AlreadyExecutingError();
      await runUserCommand(session, { command: 'run_plan' });
      return c.json({ status: 'running' } satisfies ExecuteResponse);
    } catch (err) {
      return failure(c, err, 'execute');
    }
  });

  router.post('/:sessionId/stop', async (c) => {
    try {
      if (pool.hasSession(c.req.param('sessionId'))) {
        const session = pool.session(c.req.param('sessionId'));
        const outcome = await session.execute({ command: 'stop_run' }, { kind: 'user' });
        // A stop with nothing running is a no-op, not a refusal: the surface already said stopped.
        // That holds only while nothing can still start, or "stopped" would be untrue (ADR-0029).
        if (!outcome.ok && (session.isExecuting || session.startsPending)) throw new TaskControlError(outcome.message);
      }
      return c.json({ status: 'stopped' } satisfies StopResponse);
    } catch (err) {
      return failure(c, err, 'stop');
    }
  });

  // Distinct from the stop route above, which halts *execution* (running
  // tasks). This aborts a planning turn in flight — a harmless no-op, not a
  // 404, when the session simply isn't planning right now.
  router.post('/:sessionId/planning/stop', (c) => {
    const cancelled = pool.cancelPlanning(c.req.param('sessionId'));
    return c.json({ cancelled } satisfies CancelPlanningResponse);
  });

  router.post('/:sessionId/tasks/:taskId/complete', async (c) => {
    try {
      await pool.session(c.req.param('sessionId')).markTaskComplete(c.req.param('taskId'));
      return c.json({ ok: true } satisfies OkResponse);
    } catch (err) {
      return failure(c, err, 'mark complete', { fallback: 404, message: 'Not found' });
    }
  });

  router.post('/:sessionId/tasks/:taskId/uncomplete', async (c) => {
    try {
      await pool.session(c.req.param('sessionId')).markTaskIncomplete(c.req.param('taskId'));
      return c.json({ ok: true } satisfies OkResponse);
    } catch (err) {
      return failure(c, err, 'mark incomplete', { fallback: 404, message: 'Not found' });
    }
  });

  // A task paused on a usage limit then waits for a manual retry; `cancelled`
  // is false when no resume was scheduled for it.
  router.post('/:sessionId/tasks/:taskId/resume/cancel', (c) => {
    try {
      const cancelled = pool.session(c.req.param('sessionId')).cancelScheduledResume(c.req.param('taskId'));
      return c.json({ cancelled } satisfies CancelResumeResponse);
    } catch (err) {
      return failure(c, err, 'cancel resume', { fallback: 404, message: 'Not found' });
    }
  });

  // The user says the limit has reset early: the task, and every other one
  // waiting on its runner's reset, resumes in its saved session now.
  router.post('/:sessionId/tasks/:taskId/resume/now', async (c) => {
    try {
      await pool.session(c.req.param('sessionId')).resumeNow(c.req.param('taskId'));
      return c.json({ ok: true } satisfies OkResponse);
    } catch (err) {
      return failure(c, err, 'resume now', { fallback: 404, message: 'Not found' });
    }
  });

  // Orchestrator controls — these spawn or kill runner processes, so they are
  // deliberately separate from the generic `PUT tasks/:taskId` status patch.
  // Each is an execution button, so it goes through the command seam as the
  // user (ADR-0029). Force start passes a merge gate, which the seam has no
  // command for, so it stays on the Session method.
  for (const [segment, command] of [
    ['run', (id: string): ExecutionCommand => ({ command: 'run_task', task: id })],
    ['retry', (id: string): ExecutionCommand => ({ command: 'retry_task', task: id, from: 'fresh' })],
    ['cancel', (id: string): ExecutionCommand => ({ command: 'stop_task', task: id })],
  ] as const) {
    router.post(`/:sessionId/tasks/:taskId/${segment}`, async (c) => {
      try {
        await runUserCommand(pool.session(c.req.param('sessionId')), command(c.req.param('taskId')));
        return c.json({ ok: true } satisfies OkResponse);
      } catch (err) {
        return failure(c, err, segment);
      }
    });
  }

  // Skip ends the task without landing its work (never a mark complete); the user's reason is optional.
  router.post('/:sessionId/tasks/:taskId/skip', async (c) => {
    try {
      const body: unknown = await c.req.json().catch(() => ({}));
      const reason = typeof body === 'object' && body !== null && 'reason' in body && typeof body.reason === 'string' ? body.reason : undefined;
      await runUserCommand(pool.session(c.req.param('sessionId')), { command: 'skip_task', task: c.req.param('taskId'), ...(reason ? { reason } : {}) });
      return c.json({ ok: true } satisfies OkResponse);
    } catch (err) {
      return failure(c, err, 'skip');
    }
  });

  router.post('/:sessionId/tasks/:taskId/force-start', async (c) => {
    try {
      await pool.session(c.req.param('sessionId')).forceStartTask(c.req.param('taskId'));
      return c.json({ ok: true } satisfies OkResponse);
    } catch (err) {
      return failure(c, err, 'force-start');
    }
  });

  // Talking to a task (ADR-0018, M1). A task not running is refused with
  // the reason. Force send
  // (ADR-0023, F1) is the same request: it interrupts the running turn and
  // delivers this message next, ahead of anything queued.
  const messageHandler = (send: (session: ReturnType<typeof pool.session>, taskId: string, text: string) => string | Promise<string>) => async (c: Context<Env, '/:sessionId/tasks/:taskId/messages'>) => {
    try {
      const body: unknown = await c.req.json().catch(() => ({}));
      const text = typeof body === 'object' && body !== null && 'text' in body ? body.text : undefined;
      if (typeof text !== 'string' || !text.trim()) return c.json({ error: 'text is required' }, 400);
      const id = await send(pool.session(c.req.param('sessionId')), c.req.param('taskId'), text);
      return c.json({ id } satisfies TaskMessageResponse);
    } catch (err) {
      return failure(c, err, 'task edit');
    }
  };

  // A plain message reaches the task through the command seam as the user (ADR-0029),
  // so it lands in the timeline; force send has no command and stays on the Session.
  router.post('/:sessionId/tasks/:taskId/messages', messageHandler(async (session, taskId, text) =>
    (await runUserCommand(session, { command: 'message_task', task: taskId, text })).id ?? ''));
  router.post('/:sessionId/tasks/:taskId/messages/now', messageHandler((session, taskId, text) => session.forceSendTaskMessage(taskId, text)));

  // The task runner's own slash command (#66): carried to the runner, never
  // one of Ordewell's. A task that cannot take one is refused with the reason.
  router.post('/:sessionId/tasks/:taskId/commands', async (c) => {
    try {
      const body: unknown = await c.req.json().catch(() => ({}));
      const fields = typeof body === 'object' && body !== null ? body as { name?: unknown; args?: unknown } : {};
      if (typeof fields.name !== 'string' || !fields.name.trim()) return c.json({ error: 'name is required' }, 400);
      const args = typeof fields.args === 'string' ? fields.args : '';
      const id = pool.session(c.req.param('sessionId')).invokeTaskCommand(c.req.param('taskId'), fields.name.trim(), args);
      return c.json({ id } satisfies TaskMessageResponse);
    } catch (err) {
      return failure(c, err, 'task edit');
    }
  });

  // Force send a message not yet delivered, queued or already handed over;
  // `sent` is false once it was delivered.
  router.post('/:sessionId/tasks/:taskId/messages/:messageId/now', (c) => {
    try {
      const sent = pool.session(c.req.param('sessionId')).forceSendQueuedTaskMessage(c.req.param('taskId'), c.req.param('messageId'));
      return c.json({ sent } satisfies ForceSendResponse);
    } catch (err) {
      return failure(c, err, 'task edit');
    }
  });

  // Continue a finished structured task in its saved session (ADR-0018, K1),
  // through the command seam as the user (ADR-0029). A task that cannot be
  // continued is refused with the reason.
  router.post('/:sessionId/tasks/:taskId/continue', async (c) => {
    try {
      const body: unknown = await c.req.json().catch(() => ({}));
      const text = typeof body === 'object' && body !== null && 'text' in body ? body.text : undefined;
      if (typeof text !== 'string' || !text.trim()) return c.json({ error: 'text is required' }, 400);
      await runUserCommand(pool.session(c.req.param('sessionId')), { command: 'retry_task', task: c.req.param('taskId'), from: 'session', message: text });
      return c.json({ ok: true } satisfies OkResponse);
    } catch (err) {
      return failure(c, err, 'task edit');
    }
  });

  router.delete('/:sessionId/tasks/:taskId/messages/:messageId', (c) => {
    try {
      const removed = pool.session(c.req.param('sessionId')).removeQueuedTaskMessage(c.req.param('taskId'), c.req.param('messageId'));
      return c.json({ removed } satisfies RemoveMessageResponse);
    } catch (err) {
      return failure(c, err, 'task edit');
    }
  });

  router.post('/:sessionId/tasks/:taskId/interrupt', async (c) => {
    try {
      await pool.session(c.req.param('sessionId')).interruptTask(c.req.param('taskId'));
      return c.json({ ok: true } satisfies OkResponse);
    } catch (err) {
      return failure(c, err, 'task edit');
    }
  });

  // Answer the checkpoint a task waits at: approve lets it go on, reject sends
  // it the reason. Nothing waiting — settled elsewhere, withdrawn, or no runner
  // left to hear it — is a 409, so a surface says so instead of claiming success.
  router.post('/:sessionId/tasks/:taskId/checkpoint/approve', (c) => {
    try {
      const session = pool.session(c.req.param('sessionId'));
      const taskId = c.req.param('taskId');
      if (!session.awaitsCheckpoint(taskId)) return refuse(c, 409, NO_CHECKPOINT, 'checkpoint_not_waiting');
      session.approveCheckpoint(taskId);
      return c.json({ ok: true } satisfies OkResponse);
    } catch (err) {
      return failure(c, err, 'task edit');
    }
  });

  router.post('/:sessionId/tasks/:taskId/checkpoint/reject', async (c) => {
    try {
      const body: unknown = await c.req.json().catch(() => ({}));
      const reason = typeof body === 'object' && body !== null && 'reason' in body && typeof body.reason === 'string' ? body.reason.trim() : '';
      const session = pool.session(c.req.param('sessionId'));
      const taskId = c.req.param('taskId');
      if (!session.awaitsCheckpoint(taskId)) return refuse(c, 409, NO_CHECKPOINT, 'checkpoint_not_waiting');
      session.rejectCheckpoint(taskId, reason || undefined);
      return c.json({ ok: true } satisfies OkResponse);
    } catch (err) {
      return failure(c, err, 'task edit');
    }
  });

  // What a task waits on at its merge gate (ADR-0020), for a surface that asks
  // before a force start passes it. Empty when nothing gates the task.
  router.get('/:sessionId/tasks/:taskId/merge-gate', (c) => {
    try {
      const session = pool.session(c.req.param('sessionId'));
      const tasks = flattenTasks(session.planState?.tasks ?? []);
      const mergeGate = session.mergeGate(c.req.param('taskId')).map((id) => {
        const dep = tasks.find((t) => t.id === id);
        return { id, order: dep?.order ?? 0, title: dep?.title ?? id };
      });
      return c.json({ mergeGate } satisfies MergeGateResponse);
    } catch (err) {
      return failure(c, err, 'task edit');
    }
  });

  // Isolated-run handoff (ADR-0013). A merge that conflicts or fails is an
  // outcome the surface reports, not a malformed request, so it answers 200.
  router.get('/:sessionId/isolation/diff', async (c) => {
    try {
      return c.json({ diff: await pool.session(c.req.param('sessionId')).reviewRunDiff() } satisfies IsolationDiffResponse);
    } catch (err) {
      return failure(c, err, 'task edit');
    }
  });

  router.post('/:sessionId/isolation/merge', async (c) => {
    try {
      return c.json(await pool.session(c.req.param('sessionId')).mergeRun() satisfies IsolationMergeResponse);
    } catch (err) {
      return failure(c, err, 'task edit');
    }
  });

  for (const [segment, run] of [
    ['discard', (s: ReturnType<typeof pool.session>) => s.discardRun()],
    ['cleanup', (s: ReturnType<typeof pool.session>) => s.cleanupRun()],
    ['stash-and-continue', (s: ReturnType<typeof pool.session>) => s.continueWithStash()],
    ['run-without', (s: ReturnType<typeof pool.session>) => s.continueWithoutIsolation()],
  ] as const) {
    router.post(`/:sessionId/isolation/${segment}`, async (c) => {
      try {
        await run(pool.session(c.req.param('sessionId')));
        return c.json({ ok: true } satisfies OkResponse);
      } catch (err) {
        return failure(c, err, 'task edit');
      }
    });
  }

  router.post('/:sessionId/tasks/:taskId/resolve-conflict', async (c) => {
    try {
      const plan = await pool.session(c.req.param('sessionId')).resolveConflictAsTask(c.req.param('taskId'));
      return c.json({ plan: plan && surfacePlan(plan) } satisfies ResolveConflictResponse);
    } catch (err) {
      return failure(c, err, 'task edit');
    }
  });

  router.put('/:sessionId/tasks/:taskId', async (c) => {
    try {
      const { assignedRunner, dependencies, ...rest } = await c.req.json();
      const session = pool.session(c.req.param('sessionId'));
      const taskId = c.req.param('taskId');

      // Two fields are not field writes. A runner change carries the task's
      // model, effort and mode with it, and a dependency list has to be
      // validated against the whole graph — each has one owner on the session.
      // The runner goes first: its retarget derives a model, and an explicit
      // model in the same patch must win over that derived one.
      const hasRunner = typeof assignedRunner === 'string';
      const hasDeps = Array.isArray(dependencies);

      let result = null;
      if (hasRunner) result = await session.setTaskRunner(taskId, assignedRunner);
      if (hasDeps) {
        try {
          result = await session.setTaskDependencies(taskId, dependencies.map(String));
        } catch (err) {
          // A rejected dependency edit is the client's mistake, not a fault.
          return failure(c, err, 'task dependencies', { fallback: 400 });
        }
      }
      // An empty patch still reaches updateTask — that is how a caller asks
      // whether the task exists at all.
      if (Object.keys(rest).length > 0 || (!hasRunner && !hasDeps)) result = await session.updateTask(taskId, rest);

      if (!result) return refuse(c, 404, 'Task not found', 'task_not_found');
      return c.json({ ok: true } satisfies OkResponse);
    } catch (err) {
      return failure(c, err, 'task edit');
    }
  });

  router.delete('/:sessionId/tasks/:taskId', async (c) => {
    try {
      const result = await pool.session(c.req.param('sessionId')).removeTask(c.req.param('taskId'));
      if (!result) return refuse(c, 404, 'Task not found', 'task_not_found');
      return c.json({ ok: true } satisfies OkResponse);
    } catch (err) {
      return failure(c, err, 'task edit');
    }
  });

  router.post('/:sessionId/tasks', async (c) => {
    try {
      const body = await c.req.json();
      const result = await pool.session(c.req.param('sessionId')).addTask(body);
      if (!result) return refuse(c, 404, 'Session not found', 'session_not_found');
      return c.json({ ok: true } satisfies OkResponse);
    } catch (err) {
      return failure(c, err, 'task edit');
    }
  });

  router.post('/:sessionId/review/approve', async (c) => {
    try {
      const plan = await pool.session(c.req.param('sessionId')).approveReview();
      return c.json({ plan: surfacePlan(plan) } satisfies PlanResponse);
    } catch (err) {
      return failure(c, err, 'review approve');
    }
  });

  router.post('/:sessionId/tasks/merge', async (c) => {
    try {
      const { taskIds } = await c.req.json();
      if (!taskIds || !Array.isArray(taskIds) || taskIds.length < 2) {
        return c.json({ error: 'taskIds array with at least two ids is required' }, 400);
      }
      const plan = await pool.session(c.req.param('sessionId')).requestMerge(taskIds);
      return c.json({ plan: surfacePlan(plan) } satisfies PlanResponse);
    } catch (err) {
      return failure(c, err, 'merge', { fallback: 400 });
    }
  });

  router.post('/:sessionId/tasks/:taskId/split', async (c) => {
    try {
      const plan = await pool.session(c.req.param('sessionId')).requestSplit(c.req.param('taskId'));
      return c.json({ plan: surfacePlan(plan) } satisfies PlanResponse);
    } catch (err) {
      return failure(c, err, 'split', { fallback: 400 });
    }
  });

  // Conversational planning (ADR-0002): start the planner dialogue. The
  // response's plan carries conversationHistory; when tasks are non-empty the
  // planner committed the plan.
  router.post('/:sessionId/converse/start', async (c) => {
    try {
      const { goal, runners, workspace, model, allowInit } = await c.req.json();
      if (!goal) return c.json({ error: 'goal is required' }, 400);
      const ws = workspace || c.req.query('workspace') || process.cwd();
      // As in generate: none requested is read by the session, after its gate.
      const runnerList: string[] | undefined = Array.isArray(runners) ? runners : (runners ? [runners] : undefined);
      const plan = await pool.startPlanning(c.req.param('sessionId'), goal, runnerList, ws, model, { allowInit });
      return c.json({ plan: surfacePlan(plan) } satisfies PlanResponse);
    } catch (err) {
      return failure(c, err, 'converse start', { message: 'Planning failed' });
    }
  });

  // One branch for every user reply — clarifying answers, outline confirm.
  // The planner decides what happens next.
  router.post('/:sessionId/converse/message', async (c) => {
    try {
      const { message } = await c.req.json();
      if (!message) return c.json({ error: 'message is required' }, 400);
      const plan = await pool.continuePlanning(c.req.param('sessionId'), message);
      return c.json({ plan: surfacePlan(plan) } satisfies PlanResponse);
    } catch (err) {
      return failure(c, err, 'conversation message');
    }
  });

  // Send now (ADR-0023): stops the planner turn in flight — never the run's
  // tasks — and answers this message in the turn that replaces it, ahead of
  // anything waiting. With no turn in flight it is the plain send above.
  router.post('/:sessionId/converse/message/now', async (c) => {
    try {
      const { message } = await c.req.json();
      if (!message) return c.json({ error: 'message is required' }, 400);
      const plan = await pool.session(c.req.param('sessionId')).forceSendPrompt(message);
      return c.json({ plan: surfacePlan(plan) } satisfies PlanResponse);
    } catch (err) {
      return failure(c, err, 'conversation message');
    }
  });

  // Fork and rewind act on the conversation, never on the plan: the task list
  // rides along as-is (ADR-0002, update of 2026-09-25). A rewind is a fork from
  // just before a user message; the original session is left as it was.
  router.post('/:sessionId/conversation/fork', (c) => {
    try {
      const fork = pool.forkConversation(c.req.param('sessionId'));
      return c.json({ ...fork, plan: surfacePlan(fork.plan) } satisfies ConversationForkResponse);
    } catch (err) {
      return failure(c, err, 'conversation edit');
    }
  });

  router.get('/:sessionId/conversation/rewind-targets', (c) => {
    try {
      return c.json({ targets: pool.session(c.req.param('sessionId')).rewindTargets() } satisfies RewindTargetsResponse);
    } catch (err) {
      return failure(c, err, 'conversation edit');
    }
  });

  router.post('/:sessionId/conversation/rewind', async (c) => {
    try {
      const { index } = await c.req.json();
      if (!Number.isInteger(index) || index < 0) return c.json({ error: 'index must be a non-negative integer' }, 400);
      const rewound = pool.rewindConversation(c.req.param('sessionId'), index);
      return c.json({ ...rewound, plan: surfacePlan(rewound.plan) } satisfies ConversationRewindResponse);
    } catch (err) {
      return failure(c, err, 'conversation edit');
    }
  });

  // The summary is one planner call, so this can take as long as a reply and
  // fail like one — a failure leaves the conversation exactly as it was.
  router.post('/:sessionId/conversation/compact', async (c) => {
    try {
      const compacted = await pool.compactConversation(c.req.param('sessionId'));
      return c.json({ ...compacted, plan: surfacePlan(compacted.plan) } satisfies ConversationCompactResponse);
    } catch (err) {
      return failure(c, err, 'conversation edit');
    }
  });

  router.get('/:sessionId/prd', (c) => {
    const plan = pool.getPlan(c.req.param('sessionId'));
    if (!plan?.prdMarkdown) return refuse(c, 404, 'No PRD found');
    return c.json({ prdMarkdown: plan.prdMarkdown } satisfies PrdResponse);
  });

  return router;
}
