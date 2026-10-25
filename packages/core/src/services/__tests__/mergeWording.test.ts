import { describe, it, expect } from 'vitest';
import { checkoutRule, handoffBaseLine, handoffBranchName, isRepoGroup, mergeTarget, repoBaseLine, repoResultLines } from '../mergeWording';

const t = (order: number) => ({ taskId: `t${order}`, order, title: `Task ${order}` });

const named = (path: string, baseBranch: string | undefined, baseRef: string, startedDetached = baseBranch === undefined) => ({
  path, integrationBranch: 'ordewell/r1/integration', baseRef,
  ...(baseBranch ? { baseBranch } : {}),
  ...(startedDetached ? { startedDetached: true as const } : {}),
  landed: [t(1)],
});

describe('handoffBranchName', () => {
  it('names one branch once for a group, and each when they differ', () => {
    expect(handoffBranchName({ repos: [
      { integrationBranch: 'ordewell/r1/integration' }, { integrationBranch: 'ordewell/r1/integration' },
    ] })).toBe('ordewell/r1/integration');
    expect(handoffBranchName({ repos: [
      { integrationBranch: 'ordewell/r1/integration' }, { integrationBranch: 'ordewell/r2/integration' },
    ] })).toBe('ordewell/r1/integration, ordewell/r2/integration');
  });
});

describe('where the run forked from', () => {
  it('names the branch and the commit for a lone repo, and a detached HEAD as that', () => {
    expect(repoBaseLine(named('.', 'main', 'abcdef1234567890'), 12)).toBe('main @ abcdef123456');
    expect(repoBaseLine(named('.', undefined, 'abcdef1234567890'), 8)).toBe('detached at abcdef12');
  });

  it('does not call a record that never noted its branch detached', () => {
    expect(repoBaseLine(named('.', undefined, 'abcdef1234567890', false), 8)).toBe('base abcdef12');
  });

  it('heads each repo of a group, and leaves a lone repo unheaded', () => {
    expect(handoffBaseLine({ repos: [named('.', 'main', 'abcdef1234567890')] }, 12)).toBe('main @ abcdef123456');
    expect(handoffBaseLine({ repos: [named('api', 'main', 'aaaa1111'), named('web', undefined, 'bbbb2222')] }, 12))
      .toBe('api: main @ aaaa1111, web: detached at bbbb2222');
  });
});

describe('a repo group in a handoff', () => {
  it('is any handoff but a lone repo at the workspace root', () => {
    expect(isRepoGroup({ repos: [named('.', 'main', 'aaa')] })).toBe(false);
    expect(isRepoGroup({ repos: [named('api', 'main', 'aaa')] })).toBe(true);
  });

  it('says per repo what landed, or that there is nothing to merge', () => {
    const handoff = { repos: [
      { path: 'api', landed: [t(1), t(2), t(3)] },
      { path: 'web', landed: [t(3)] },
      { path: 'infra', landed: [] },
    ] };
    expect(repoResultLines(handoff)).toEqual(['api: 3 tasks landed', 'web: 1 task landed', 'infra: nothing to merge']);
  });
});

describe('where Merge all lands, for a confirmation', () => {
  const withBranch = (path: string, baseBranch: string | undefined, landed = [t(1)]) => ({ path, baseBranch, landed });

  it('names the branch for a lone repo, and the branch that must be checked out', () => {
    const handoff = { repos: [withBranch('.', 'main')] };

    expect(mergeTarget(handoff)).toBe('main');
    expect(checkoutRule(handoff)).toBe(' Nothing is merged unless main is checked out.');
  });

  it('keeps saying the branch you have checked out for a run that started detached', () => {
    const handoff = { repos: [withBranch('.', undefined)] };

    expect(mergeTarget(handoff)).toBe('the branch you have checked out');
    expect(checkoutRule(handoff)).toBe('');
  });

  it('names one branch once for a group, leaving out a repo with nothing to merge', () => {
    const handoff = { repos: [withBranch('api', 'main'), withBranch('web', 'main'), withBranch('infra', 'main', [])] };

    expect(mergeTarget(handoff)).toBe('main in each of api, web');
  });

  it('names each repo with its own branch when they differ, and a detached one as checked out', () => {
    const handoff = { repos: [withBranch('api', 'main'), withBranch('web', 'develop'), withBranch('docs', undefined)] };

    expect(mergeTarget(handoff)).toBe('each of api (main), web (develop), docs (as checked out)');
    expect(checkoutRule(handoff)).toBe(' Nothing is merged unless each repository is on the branch it started on.');
  });
});
