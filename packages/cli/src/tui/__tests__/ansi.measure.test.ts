import { describe, it, expect, vi } from 'vitest';

// The composer wraps up to 8KB on every keystroke, and a pasted single-line
// blob reaches that cap as one word. Asking string-width about each character
// of an all-ASCII word costs far more than laying it out, so the wrap must not.
vi.mock('string-width', async (importOriginal) => {
  const actual = await importOriginal<typeof import('string-width')>();
  return { default: vi.fn(actual.default) };
});

import stringWidth from 'string-width';
import { wrapLines } from '../ansi';

describe('wrapping a long ASCII run', () => {
  it('does not measure the word one character at a time', () => {
    const measure = vi.mocked(stringWidth);
    measure.mockClear();

    wrapLines('x'.repeat(4_096), 40);

    expect(measure.mock.calls.length).toBeLessThan(500);
  });
});
