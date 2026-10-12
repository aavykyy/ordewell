import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlannerModelMemory, type PlannerModelStore } from '@ordewell/core';
import { __resetConfig, __setConfig, configUpdates } from '../test/vscode.mock';
import { VsCodeConfig } from '../adapters/VsCodeConfig';
import { PlannerSelection } from '../PlannerSelection';

function setup() {
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
    modelResolver: { modelsForRunners: async () => ({}), pickerOptions: async () => [] } as never,
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
