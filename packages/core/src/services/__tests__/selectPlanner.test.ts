import { describe, it, expect } from 'vitest';
import { selectPlanner, type PlannerSelectionChange, type PlannerSelectionResult, type PlannerSelectionState } from '../selectPlanner';
import type { PlannerModelCandidate, PlannerModelChoice } from '../PlannerModelMemory';

const claudeCatalog: PlannerModelCandidate[] = [
  { id: 'haiku', variants: [{ id: 'low' }] },
  { id: 'sonnet', variants: [{ id: 'low' }, { id: 'high' }] },
  { id: 'opus', variants: [] },
];

const memoryOf = (entries: Record<string, PlannerModelChoice>) => ({
  getPlannerModel: (provider: string) => entries[provider],
});

const onCodex: PlannerSelectionState = { provider: 'codex', model: 'gpt-5-codex', effort: 'medium' };

interface Row {
  name: string;
  current: PlannerSelectionState;
  change: PlannerSelectionChange;
  memory?: Record<string, PlannerModelChoice>;
  catalog: PlannerModelCandidate[];
  expected: PlannerSelectionResult;
}

const rows: Row[] = [
  {
    name: 'switching provider recalls the remembered model and effort',
    current: onCodex,
    change: { provider: 'claude-code' },
    memory: { 'claude-code': { model: 'sonnet', effort: 'high' } },
    catalog: claudeCatalog,
    expected: {
      next: { provider: 'claude-code', model: 'sonnet', effort: 'high' },
      recall: { model: 'sonnet', effort: 'high', source: 'remembered' },
    },
  },
  {
    name: 'switching to a provider with nothing remembered lands on the head of its catalog',
    current: onCodex,
    change: { provider: 'claude-code' },
    catalog: claudeCatalog,
    expected: {
      next: { provider: 'claude-code', model: 'haiku', effort: '' },
      recall: { model: 'haiku', effort: '', source: 'catalog-default' },
    },
  },
  {
    name: 'a remembered model no longer in the catalog falls to the catalog default',
    current: onCodex,
    change: { provider: 'claude-code' },
    memory: { 'claude-code': { model: 'claude-3-retired', effort: 'high' } },
    catalog: claudeCatalog,
    expected: {
      next: { provider: 'claude-code', model: 'haiku', effort: '' },
      recall: { model: 'haiku', effort: '', source: 'catalog-default' },
    },
  },
  {
    name: 'a remembered effort the model no longer offers is dropped on recall',
    current: onCodex,
    change: { provider: 'claude-code' },
    memory: { 'claude-code': { model: 'opus', effort: 'max' } },
    catalog: claudeCatalog,
    expected: {
      next: { provider: 'claude-code', model: 'opus', effort: '' },
      recall: { model: 'opus', effort: '', source: 'remembered' },
    },
  },
  {
    name: 'switching to a provider whose catalog is empty leaves the model unset',
    current: onCodex,
    change: { provider: 'claude-code' },
    memory: { 'claude-code': { model: 'sonnet' } },
    catalog: [],
    expected: {
      next: { provider: 'claude-code', model: '', effort: '' },
      recall: { model: '', effort: '', source: 'none' },
    },
  },
  {
    name: 'a blank model sent with a switch is the legacy clear, filled by recall',
    current: onCodex,
    change: { provider: 'claude-code', model: '  ', effort: 'medium' },
    memory: { 'claude-code': { model: 'sonnet', effort: 'low' } },
    catalog: claudeCatalog,
    expected: {
      next: { provider: 'claude-code', model: 'sonnet', effort: 'low' },
      recall: { model: 'sonnet', effort: 'low', source: 'remembered' },
    },
  },
  {
    name: 'an explicit model with a switch wins over memory and is remembered',
    current: onCodex,
    change: { provider: 'claude-code', model: 'opus', effort: '' },
    memory: { 'claude-code': { model: 'sonnet', effort: 'high' } },
    catalog: claudeCatalog,
    expected: {
      next: { provider: 'claude-code', model: 'opus', effort: '' },
      remember: { provider: 'claude-code', model: 'opus', effort: '' },
    },
  },
  {
    name: 'an explicit model with a switch never inherits the old backend\'s effort',
    current: { provider: 'codex', model: 'gpt-5-codex', effort: 'low' },
    change: { provider: 'claude-code', model: 'haiku' },
    catalog: claudeCatalog,
    expected: {
      next: { provider: 'claude-code', model: 'haiku', effort: '' },
      remember: { provider: 'claude-code', model: 'haiku', effort: '' },
    },
  },
  {
    name: 'reselecting the provider in use changes nothing',
    current: { provider: 'claude-code', model: 'opus', effort: '' },
    change: { provider: 'claude-code' },
    memory: { 'claude-code': { model: 'sonnet', effort: 'high' } },
    catalog: claudeCatalog,
    expected: { next: { provider: 'claude-code', model: 'opus', effort: '' } },
  },
  {
    name: 'a new model keeps the current effort when it offers that level',
    current: { provider: 'claude-code', model: 'haiku', effort: 'low' },
    change: { model: 'sonnet' },
    catalog: claudeCatalog,
    expected: {
      next: { provider: 'claude-code', model: 'sonnet', effort: 'low' },
      remember: { provider: 'claude-code', model: 'sonnet', effort: 'low' },
    },
  },
  {
    name: 'a new model drops the current effort when it does not offer it',
    current: { provider: 'claude-code', model: 'sonnet', effort: 'high' },
    change: { model: 'haiku' },
    catalog: claudeCatalog,
    expected: {
      next: { provider: 'claude-code', model: 'haiku', effort: '' },
      remember: { provider: 'claude-code', model: 'haiku', effort: '' },
    },
  },
  {
    name: 'a model the catalog does not list is taken as chosen, effort kept',
    current: { provider: 'claude-code', model: 'sonnet', effort: 'high' },
    change: { model: 'claude-sonnet-4-5-20250929' },
    catalog: claudeCatalog,
    expected: {
      next: { provider: 'claude-code', model: 'claude-sonnet-4-5-20250929', effort: 'high' },
      remember: { provider: 'claude-code', model: 'claude-sonnet-4-5-20250929', effort: 'high' },
    },
  },
  {
    name: 'an explicit effort the model does not offer is dropped',
    current: { provider: 'claude-code', model: 'haiku', effort: '' },
    change: { effort: 'max' },
    catalog: claudeCatalog,
    expected: {
      next: { provider: 'claude-code', model: 'haiku', effort: '' },
      remember: { provider: 'claude-code', model: 'haiku', effort: '' },
    },
  },
  {
    name: 'an explicit effort the model offers is taken and remembered',
    current: { provider: 'claude-code', model: 'sonnet', effort: '' },
    change: { effort: 'high' },
    catalog: claudeCatalog,
    expected: {
      next: { provider: 'claude-code', model: 'sonnet', effort: 'high' },
      remember: { provider: 'claude-code', model: 'sonnet', effort: 'high' },
    },
  },
  {
    name: 'an effort is trusted while the catalog is cold',
    current: { provider: 'claude-code', model: 'sonnet', effort: '' },
    change: { effort: 'high' },
    catalog: [],
    expected: {
      next: { provider: 'claude-code', model: 'sonnet', effort: 'high' },
      remember: { provider: 'claude-code', model: 'sonnet', effort: 'high' },
    },
  },
  {
    name: 'clearing the model clears its effort and forgets the pick',
    current: { provider: 'claude-code', model: 'sonnet', effort: 'high' },
    change: { model: '' },
    catalog: claudeCatalog,
    expected: {
      next: { provider: 'claude-code', model: '', effort: '' },
      remember: { provider: 'claude-code', model: '', effort: '' },
    },
  },
  {
    name: 'a vendor model id is trimmed and kept with no effort to judge',
    current: { provider: 'openrouter', model: 'openai/gpt-5', effort: '' },
    change: { model: ' z-ai/glm-4.6 ' },
    catalog: [{ id: 'openai/gpt-5' }, { id: 'z-ai/glm-4.6' }],
    expected: {
      next: { provider: 'openrouter', model: 'z-ai/glm-4.6', effort: '' },
      remember: { provider: 'openrouter', model: 'z-ai/glm-4.6', effort: '' },
    },
  },
  {
    name: 'an empty change keeps everything',
    current: onCodex,
    change: {},
    catalog: [],
    expected: { next: onCodex },
  },
];

describe('selectPlanner', () => {
  it.each(rows)('$name', ({ current, change, memory, catalog, expected }) => {
    expect(selectPlanner(current, change, memoryOf(memory ?? {}), catalog)).toEqual(expected);
  });
});
