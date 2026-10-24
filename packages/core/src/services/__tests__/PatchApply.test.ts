import { describe, expect, it, vi } from 'vitest';
import { applyReply, applySavedPatch, type ApplyPatchSite } from '../PatchCapture';
import type { GitInvoker } from '../gitExec';
import { createTask, type Task } from '../../models/Task';
import type { HandoffPatch, StoredHandoff } from '../../models/Handoff';
import type { TaskLogEvent } from '../../models/TaskLog';

/**
 * What `apply_patch` refuses before git runs, and how it answers (ADR-0050).
 * That a patch merges, at its base, past it, and into conflicts, is the e2e's
 * to show with real git (`PatchApply.e2e.test.ts`); here git is a seam that
 * fails the test if it is reached.
 */

const patchArtifact = (attempt: number, bytes: number, extra: Partial<HandoffPatch> = {}): HandoffPatch => ({
  kind: 'patch', path: `.ordewell/sessions/s/tasks/explore/${attempt}.patch`, attempt, base: 'a'.repeat(40), files: 2, added: 5, removed: 1, binary: 0, bytes, ...extra,
});

const handoff = (...artifacts: HandoffPatch[]): StoredHandoff => ({ summary: 'Tried it.', findings: [], findingCount: 0, artifacts });

const task = (id: string, order: number, extra: Partial<Task> = {}) => createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...extra });

const plan = [
  task('explore', 1),
  task('build', 2, { dependencies: ['explore'] }),
  task('aside', 3),
];

const gitNeverRuns: GitInvoker = {
  exec: vi.fn(async () => { throw new Error('git must not run'); }),
  resolvePath: async () => '',
};

const files: Record<string, Buffer> = { 'explore/1': Buffer.from('one'), 'explore/2': Buffer.from('twotwo') };
const handoffs: Record<string, StoredHandoff> = {
  'explore/1': handoff(patchArtifact(1, 3)),
  'explore/2': handoff(patchArtifact(2, 6, { flags: [{ kind: 'dropped', count: 1, paths: ['big.bin (3 MiB)'] }] })),
};

function site(extra: Partial<ApplyPatchSite> = {}): ApplyPatchSite {
  return {
    callerId: 'build',
    plan,
    log: {
      attempts: (id) => (id === 'explore' ? [1, 2] : id === 'aside' ? [1] : []),
      events: (id, attempt): TaskLogEvent[] => (handoffs[`${id}/${attempt}`] ? [{ type: 'handoff', handoff: handoffs[`${id}/${attempt}`] } as TaskLogEvent] : []),
      patch: (id, attempt) => files[`${id}/${attempt}`],
    },
    worktrees: ['/work/build'],
    readOnly: false,
    git: gitNeverRuns,
    ...extra,
  };
}

const refusal = async (args: Parameters<typeof applySavedPatch>[0], extra: Partial<ApplyPatchSite> = {}) => {
  const reply = await applySavedPatch(args, site(extra));
  expect(reply.isError, reply.text).toBe(true);
  expect(gitNeverRuns.exec).not.toHaveBeenCalled();
  return reply.text;
};

describe('applySavedPatch refuses', () => {
  it('a call from a read-only task, which lands nothing', async () => {
    expect(await refusal({ task: '#1' }, { readOnly: true })).toContain('read-only task lands nothing');
  });

  it('a task with no worktree of its own, and one across several repositories', async () => {
    expect(await refusal({ task: '#1' }, { worktrees: [] })).toContain('no worktree of its own');
    expect(await refusal({ task: '#1' }, { worktrees: ['/work/a', '/work/b'] })).toContain('several repositories');
  });

  it('a patch from a task outside the set read_task reads, naming that set', async () => {
    const text = await refusal({ task: '#3' });

    expect(text).toContain('#3 Task aside is not a task this one may read');
    expect(text).toContain('#1 Task explore');
    expect(text).toContain('#2 Task build');
  });

  it('a task the plan does not have, and an attempt a task did not save', async () => {
    expect(await refusal({ task: 'nowhere' })).toContain('names no task in the plan');
    expect(await refusal({ task: '#1', attempt: 3 })).toContain('its saved attempts are 1 and 2');
  });

  it('a task whose attempt saved no patch, naming the attempts that did', async () => {
    const saved = { ...handoffs };
    handoffs['explore/2'] = { summary: 'Only talked.', findings: [], findingCount: 0 };
    try {
      expect(await refusal({ task: '#1' })).toContain('#1 Task explore saved no patch in attempt 2; its attempts that did are 1');
    } finally {
      Object.assign(handoffs, saved);
    }
  });

  it('a patch whose file is gone from the task logs', async () => {
    expect(await refusal({ task: '#1', attempt: 1 }, { log: { ...site().log, patch: () => undefined } })).toContain('no longer in this session\'s task logs');
  });

  it('a patch cut short, or changed since it was saved, by its size', async () => {
    const text = await refusal({ task: '#1', attempt: 1 }, { log: { ...site().log, patch: () => Buffer.from('on') } });

    expect(text).toContain('2 B where its artifact says 3 B');
    expect(text).toContain('cut short');
  });
});

describe('applyReply', () => {
  const saved = patchArtifact(2, 6, { flags: [{ kind: 'dropped', count: 1, paths: ['big.bin (3 MiB)'] }] });
  const at = { head: 'b'.repeat(40), files: 2 };

  it('says a clean apply at the base staged its changes, and names what the patch left out', () => {
    const { text, isError } = applyReply({ kind: 'applied', sameBase: true, ...at }, '#1 Task explore', saved);

    expect(isError).toBeUndefined();
    expect(text).toContain("Applied #1 Task explore's patch (2 files, +5 -1) cleanly");
    expect(text).toContain('staged');
    expect(text).toContain('at the commit the patch was taken against');
    expect(text).toContain('Not as its author\'s worktree had it:');
    expect(text).toContain('big.bin (3 MiB)');
  });

  it('says a merge past the base was tested elsewhere, so the task runs its checks', () => {
    const { text } = applyReply({ kind: 'applied', sameBase: false, ...at }, '#1 Task explore', saved);

    expect(text).toContain('Your worktree is at commit bbbbbbbbbbbb, not aaaaaaaaaaaa');
    expect(text).toContain('run your checks here');
  });

  it('names each conflicted path, tells a binary one from one with markers, and is not an error: the rest is applied', () => {
    const { text, isError } = applyReply({
      kind: 'conflicted', sameBase: false, ...at, conflicts: [{ path: 'assets.bin', binary: true }, { path: 'src/greet.ts', binary: false }],
    }, '#1 Task explore', saved);

    expect(isError).toBeUndefined();
    expect(text).toContain('with 2 conflicted paths. The rest of it is in your worktree, staged.');
    expect(text).toContain('- assets.bin: binary, so the file holds no markers: `git checkout --ours -- assets.bin` keeps your version, `--theirs` takes the patch\'s');
    expect(text).toContain('- src/greet.ts: the file holds conflict markers');
  });

  it('names the patch file in a refusal, for a task that would rather apply part of it by hand', () => {
    const { text, isError } = applyReply({ kind: 'refused', reason: 'git applied none of it: error: gone.txt: patch does not apply.' }, '#1 Task explore', saved);

    expect(isError).toBe(true);
    expect(text).toBe(`Nothing applied: git applied none of it: error: gone.txt: patch does not apply. The patch is the file ${saved.path}, if you would rather apply part of it by hand.`);
  });
});
