import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CheckpointPanel from '../CheckpointPanel';

const props = {
  taskTitle: 'Add rate limiting',
  pausedAt: Date.now(),
  onApprove: () => {},
  onReject: () => {},
};

function summary(): HTMLElement {
  return document.querySelector('.checkpoint-summary') as HTMLElement;
}

describe('reading a full checkpoint summary', () => {
  it('shows only the first line until the reader expands it, then the whole text', () => {
    const text = 'Shipped the endpoint\nand left the tests for later';
    render(<CheckpointPanel {...props} summary={text} />);

    expect(summary().textContent).toBe('Shipped the endpoint');

    fireEvent.click(screen.getByText('Show full'));
    expect(summary().textContent).toBe(text);

    fireEvent.click(screen.getByText('Show less'));
    expect(summary().textContent).toBe('Shipped the endpoint');
  });

  it('offers no expand control when there is nothing hidden', () => {
    render(<CheckpointPanel {...props} summary="ready for review" />);
    expect(document.querySelector('.checkpoint-summary-toggle')).toBeNull();
  });

  it('lets the reader see the tail of a single overlong line', () => {
    const long = 'x'.repeat(200);
    render(<CheckpointPanel {...props} summary={long} />);

    expect(summary().textContent!.length).toBe(120);
    expect(summary().textContent!.endsWith('…')).toBe(true);

    fireEvent.click(screen.getByText('Show full'));
    expect(summary().textContent).toBe(long);
  });
});
