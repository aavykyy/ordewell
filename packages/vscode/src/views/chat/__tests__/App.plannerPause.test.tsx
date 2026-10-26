import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { LegacyPlanState } from '@ordewell/core';
import App from '../App';
import { api, hostBridge, post } from './hostBridge';

/**
 * A planner paused on its context (ADR-0002) waits for the user: a quiet bar
 * above the composer says so and offers Retry compaction, or Stop to drop
 * the paused turn. The draft and the conversation are left as they are.
 */

const pause = {
  model: 'vendor/model', at: '2026-10-25T10:00:00Z', inputs: ['turn-1'],
  reason: "vendor/model refused the planner's call as too long for its window. The planner is paused: Retry compaction tries to condense its context and continue the turn, or stop it to drop the turn.",
};
const plan = (over: Partial<LegacyPlanState> = {}): LegacyPlanState => ({ tasks: [], generatedAt: '', lastUpdated: '', status: 'draft', runners: [], ...over });
const showPlan = (p: LegacyPlanState) => post({ type: 'planUpdated', plan: p });
const textarea = () => document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
const bar = () => document.querySelector('.planner-pause');

describe('a planner paused on its context', () => {
  beforeEach(() => {
    render(<App />);
    api.postMessage.mockClear();
  });

  it('shows a quiet status above the composer, with Retry compaction and Stop', () => {
    showPlan(plan({ plannerContextPause: pause }));

    expect(bar()!.getAttribute('role')).toBe('status');
    expect(bar()!.textContent).toContain("Planner paused: its context does not fit vendor/model's window");
    fireEvent.click(screen.getByRole('button', { name: 'Retry compaction' }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendSystemCommand', command: 'retryPlannerCompaction' });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'stopResearch' });
  });

  it('is hidden while a planner turn runs, as the retry is, and gone once the plan no longer carries it', () => {
    const host = hostBridge();
    showPlan(plan({ plannerContextPause: pause }));
    host.session({ type: 'planner_turn_started', turnId: 'retry-1' });
    expect(bar()).toBeNull();

    host.session({ type: 'planner_turn_ended', turnId: 'retry-1', outcome: 'message' });
    showPlan(plan());
    expect(bar()).toBeNull();
  });

  it('leaves the draft where it was as the pause comes and goes', () => {
    fireEvent.change(textarea(), { target: { value: 'half a thought' } });
    showPlan(plan({ plannerContextPause: pause }));
    showPlan(plan());

    expect(textarea().value).toBe('half a thought');
  });
});
