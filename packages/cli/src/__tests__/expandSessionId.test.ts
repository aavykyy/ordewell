import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, it, expect } from 'vitest';
import { expandSessionId } from '../utils/session';

function workspaceWith(ids: string[]): string {
  const ws = mkdtempSync(join(tmpdir(), 'ow-expand-'));
  const dir = join(ws, '.ordewell', 'sessions');
  mkdirSync(dir, { recursive: true });
  ids.forEach((id, i) => writeFileSync(join(dir, `s${i}.json`), JSON.stringify({ meta: { id } })));
  return ws;
}

describe('expandSessionId', () => {
  const ws = workspaceWith(['session-9a407a988bb0706e009055b784ac2257', 'session-bf85a92352de3fd498691291cdb952a7']);
  afterAll(() => rmSync(ws, { recursive: true, force: true }));

  it('expands the short id `ordewell status` prints', () => {
    expect(expandSessionId('84ac2257', ws)).toBe('session-9a407a988bb0706e009055b784ac2257');
  });

  it('expands a leading piece of the hash too', () => {
    expect(expandSessionId('bf85a923', ws)).toBe('session-bf85a92352de3fd498691291cdb952a7');
  });

  it('leaves full, unknown and ambiguous ids to the daemon', () => {
    expect(expandSessionId('session-anything', ws)).toBe('session-anything');
    expect(expandSessionId('zzzz', ws)).toBe('zzzz');
    expect(expandSessionId('7', ws)).toBe('7');
    expect(expandSessionId('84ac2257', join(ws, 'missing'))).toBe('84ac2257');
  });
});
