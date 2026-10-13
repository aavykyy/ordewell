import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlannerModelMemory, type PlannerModelStore } from '@ordewell/core';
import { __resetConfig, __setConfig, configUpdates } from '../test/vscode.mock';
import { VsCodeConfig } from '../adapters/VsCodeConfig';
import { PlannerSelection } from '../PlannerSelection';

function setup(runnerModels: Record<string, { modelId: string; variants: { id: string }[] }[]> = {}) {
  const stored: Record<string, { model: string; effort?: string }> = {};
  const store: PlannerModelStore = {
    getPlannerModel: (p) => stored[p],
    setPlannerModel: (p, e) => { if (e) stored[p] = e; else delete stored[p]; },
  };
  const memory = new PlannerModelMemory(store);
  const sendModelConfig = vi.fn();
  const setPlannerBackends = vi.fn();
  const selection = new PlannerSelection({
    config: new VsCodeConfig(),
    modelResolver: { modelsForRunners: async (runners: string[]) => Object.fromEntries(runners.map((r) => [r, runnerModels[r] ?? []])), pickerOptions: async () => [] } as never,
    plannerModelMemory: memory,
    runnerInstallation: { plannerUsability: async () => ({ usable: true }) } as never,
    chatProvider: { setPlannerBackends } as never,
    sendModelConfig,
    log: () => {},
  });
  return { selection, memory, sendModelConfig, setPlannerBackends };
}

describe('PlannerSelection.applyChoice', () => {
  beforeEach(() => {
    __resetConfig();
    __setConfig({ aiProvider: 'openrouter', orchestratorModel: 'z-ai/glm-4.6', plannerThinkingEffort: '' });
  });

  it('writes provider, model and effort, remembers the pick, and tells the webview once', async () => {
    const { selection, memory, sendModelConfig, setPlannerBackends } = setup();

    await selection.applyChoice('claude-code', 'claude-opus-5-5', 'high');

    expect(configUpdates).toEqual([
      { key: 'aiProvider', value: 'claude-code' },
      { key: 'orchestratorModel', value: 'claude-opus-5-5' },
      { key: 'plannerThinkingEffort', value: 'high' },
    ]);
    expect(memory.recall('claude-code', [{ id: 'claude-opus-5-5', variants: [{ id: 'high' }] }])).toEqual({
      model: 'claude-opus-5-5', effort: 'high', source: 'remembered',
    });
    expect(sendModelConfig).toHaveBeenCalledOnce();
    expect(setPlannerBackends).toHaveBeenCalledOnce();
    expect(setPlannerBackends.mock.calls[0].slice(1)).toEqual(['claude-code', 'claude-code', 'high']);
  });
});

describe('PlannerSelection.setModel', () => {
  beforeEach(() => {
    __resetConfig();
    __setConfig({ aiProvider: 'claude-code', orchestratorModel: 'claude-a', plannerThinkingEffort: 'high' });
  });

  it('drops an effort the model was not picked with when the pick names none', async () => {
    const { selection, memory } = setup();

    await selection.setModel('claude-b');

    expect(configUpdates).toEqual([
      { key: 'orchestratorModel', value: 'claude-b' },
      { key: 'plannerThinkingEffort', value: '' },
    ]);
    expect(memory.getPlannerModel('claude-code')).toEqual({ model: 'claude-b' });
  });
});

describe('PlannerSelection.apply', () => {
  beforeEach(() => {
    __resetConfig();
    __setConfig({ aiProvider: 'claude-code', orchestratorModel: 'claude-a', plannerThinkingEffort: '' });
  });

  it('restores what the new backend remembers', async () => {
    const { selection, memory } = setup({ codex: [{ modelId: 'gpt-5-codex', variants: [{ id: 'high' }] }] });
    memory.remember('codex', 'gpt-5-codex', 'high');

    await selection.apply('codex');

    expect(configUpdates).toEqual([
      { key: 'aiProvider', value: 'codex' },
      { key: 'orchestratorModel', value: 'gpt-5-codex' },
      { key: 'plannerThinkingEffort', value: 'high' },
    ]);
  });

  it('keeps the model of the planner already in use rather than re-recalling it', async () => {
    const { selection, memory } = setup({ 'claude-code': [{ modelId: 'claude-b', variants: [] }] });
    memory.remember('claude-code', 'claude-b');

    await selection.apply('claude-code');

    expect(configUpdates).toEqual([]);
  });
});
