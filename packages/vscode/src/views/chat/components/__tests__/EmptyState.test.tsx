import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { RUN_SETTINGS_DEFAULTS } from '@ordewell/core';
import EmptyState from '../EmptyState';

const withAutorun = (autorun: boolean) => ({ autonomous: false, run: { ...RUN_SETTINGS_DEFAULTS, autorun } });

describe('EmptyState — plan approval', () => {
  it('says nothing runs until approval before the host has sent run settings', () => {
    const { container } = render(<EmptyState />);
    expect(container.textContent).toContain('Nothing runs until you approve the plan.');
  });

  it('says it while autorun is off', () => {
    const { container } = render(<EmptyState runSettings={withAutorun(false)} />);
    expect(container.textContent).toContain('Nothing runs until you approve the plan.');
  });

  it('warns instead of promising approval while autorun is on', () => {
    const { container } = render(<EmptyState runSettings={withAutorun(true)} />);
    expect(container.textContent).not.toContain('Nothing runs until');
    expect(container.querySelector('p.warn')?.textContent).toContain('Autorun is on');
  });
});
