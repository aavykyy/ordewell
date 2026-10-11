import { describe, it, expect } from 'vitest';
import { taskReadPage } from '../taskReadPage';
import { OUTPUT_TAIL_MAX_CHARS } from '../TaskQuery';

describe('task read pages', () => {
  it('pages a patch or file list at line boundaries and resumes without skipping text', () => {
    const patch = '[repo api] src/file.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const first = taskReadPage(patch, { lines: 2 });
    const second = taskReadPage(patch, { lines: 2, since: first.nextOffset });
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
    expect(first.output.replace(/\n\[truncated.*$/, '') + second.output).toBe(patch);
    expect(second.nextOffset).toBe(patch.length);
  });

  it('caps long lines with a recoverable character offset and handles offsets past the end', () => {
    const text = 'x'.repeat(OUTPUT_TAIL_MAX_CHARS + 3);
    const first = taskReadPage(text, {});
    expect(first.nextOffset).toBe(OUTPUT_TAIL_MAX_CHARS);
    expect(taskReadPage(text, { since: first.nextOffset })).toEqual({ output: 'xxx', nextOffset: text.length, hasMore: false });
    expect(taskReadPage(text, { since: text.length + 1 })).toEqual({ output: '', nextOffset: text.length, hasMore: false });
  });
});
