import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, expect, it } from 'vitest';
import { TaskStartConfig } from '../taskStartConfig';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), 'start-config-'));
  dirs.push(dir);
  return dir;
}

const at = (cwd: string, epoch = 1) => ({ epoch, root: cwd, cwd, worktree: false });

it('takes what a checkout holds at its first launch as the baseline, and holds what differs at the next', async () => {
  const cwd = checkout();
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{}');
  const guard = new TaskStartConfig();
  expect(await guard.check(null, 't1', at(cwd))).toEqual([]);
  expect(await guard.check(null, 't2', at(cwd))).toEqual([]);

  writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{"env":{}}');
  writeFileSync(join(cwd, '.mcp.json'), '{}');
  writeFileSync(join(cwd, 'notes.md'), 'not configuration');
  expect(await guard.check(null, 't3', at(cwd))).toEqual(['.claude/settings.local.json', '.mcp.json']);
  // The baseline does not move, so the hold stands until the configuration goes.
  expect(await guard.check(null, 't3', at(cwd))).toEqual(['.claude/settings.local.json', '.mcp.json']);
  rmSync(join(cwd, '.mcp.json'));
  writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{}');
  expect(await guard.check(null, 't3', at(cwd))).toEqual([]);
});

it('takes a new baseline for a new run, and drops them with the plan', async () => {
  const cwd = checkout();
  const guard = new TaskStartConfig();
  await guard.check(null, 't1', at(cwd));
  writeFileSync(join(cwd, '.mcp.json'), '{}');
  expect(await guard.check(null, 't2', at(cwd))).toEqual(['.mcp.json']);
  expect(await guard.check(null, 't2', at(cwd, 2))).toEqual([]);
  guard.clear();
  rmSync(join(cwd, '.mcp.json'));
  await guard.check(null, 't1', at(cwd, 2));
  writeFileSync(join(cwd, '.mcp.json'), '{}');
  expect(await guard.check(null, 't2', at(cwd, 2))).toEqual(['.mcp.json']);
  guard.clear();
  expect(await guard.check(null, 't2', at(cwd, 2))).toEqual([]);
});

it('has nothing to compare for a directory that is not there', async () => {
  const guard = new TaskStartConfig();
  expect(await guard.check(null, 't1', at('/nonexistent/ordewell-start-config'))).toEqual([]);
  expect(await guard.check(null, 't2', at('/nonexistent/ordewell-start-config'))).toEqual([]);
});
