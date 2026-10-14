import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import GetStarted from '../GetStarted';
import { orNames } from '../../runnerNames';

describe('GetStarted', () => {
  it('names the runners the host reports, not a list of its own', () => {
    const { container } = render(
      <GetStarted runnerNames={['Claude Code', 'Acme Agent']} onConfigure={vi.fn()} />,
    );
    expect(container.textContent).toContain('Claude Code or Acme Agent');
    expect(container.textContent).not.toContain('OpenCode');
  });

  it('still asks for a coding agent before the host has reported any', () => {
    const { container } = render(<GetStarted runnerNames={[]} onConfigure={vi.fn()} />);
    expect(container.textContent).toContain('Install a coding agent');
  });
});

describe('orNames', () => {
  it('reads as prose', () => {
    expect(orNames([], 'a coding agent')).toBe('a coding agent');
    expect(orNames(['A'])).toBe('A');
    expect(orNames(['A', 'B'])).toBe('A or B');
    expect(orNames(['A', 'B', 'C'])).toBe('A, B or C');
  });
});
