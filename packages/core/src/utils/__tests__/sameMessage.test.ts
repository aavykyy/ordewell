import { describe, it, expect } from 'vitest';
import { sameMessage } from '../sameMessage';

describe('sameMessage', () => {
  it('ignores surrounding whitespace and a final period', () => {
    expect(sameMessage("You've hit your limit", "  You've hit your limit.\n")).toBe(true);
  });

  it('tells a message that only contains the other from it', () => {
    expect(sameMessage('I stopped: out of budget', 'out of budget')).toBe(false);
  });

  it('never matches an empty message', () => {
    expect(sameMessage('', ' . ')).toBe(false);
  });
});
