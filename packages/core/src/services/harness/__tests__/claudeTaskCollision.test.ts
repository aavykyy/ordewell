import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../ClaudeCodeAdapter';
import { fakeSpawn } from '../../__tests__/harnessTestKit';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('Claude task repository MCP collisions', () => {
  it('refuses to spawn when .mcp.json declares ordewell and names the file', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'claude-collision-'));
    dirs.push(cwd);
    writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { ordewell: { command: 'foreign' } } }));
    const spawned = fakeSpawn([]);
    const adapter = new ClaudeCodeAdapter({ spawn: spawned.spawn, fetch, resolvePath: async () => '/usr/bin', exists: () => true, workspaceEnv: async () => ({}) });
    await expect(adapter.start({ kind: 'task', cwd, mode: 'acceptEdits', flags: { permissionMode: 'acceptEdits', modeSettings: {} } }))
      .rejects.toThrow(/\.mcp\.json.*rename or remove.*ordewell/i);
    expect(spawned.processes).toHaveLength(0);
  });

  it.each(['settings.json', 'settings.local.json'])('starts despite an mcpServers entry in .claude/%s, which Claude does not read', async (file) => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'claude-collision-'));
    dirs.push(cwd);
    mkdirSync(path.join(cwd, '.claude'));
    writeFileSync(path.join(cwd, '.claude', file), JSON.stringify({ mcpServers: { ordewell: {} } }));
    const spawned = fakeSpawn([]);
    const adapter = new ClaudeCodeAdapter({ spawn: spawned.spawn, fetch, resolvePath: async () => '/usr/bin', exists: () => true, workspaceEnv: async () => ({}) });
    await adapter.start({ kind: 'task', cwd, mode: 'acceptEdits', flags: { permissionMode: 'acceptEdits', modeSettings: {} } });
    expect(spawned.processes).toHaveLength(1);
    adapter.dispose();
  });

  it.each([
    ['another server', JSON.stringify({ mcpServers: { other: { command: 'foreign' } } })],
    ['no file', undefined],
    ['invalid JSON', '{'],
  ])('starts with %s', async (_label, content) => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'claude-collision-'));
    dirs.push(cwd);
    if (content !== undefined) writeFileSync(path.join(cwd, '.mcp.json'), content);
    const spawned = fakeSpawn([]);
    const adapter = new ClaudeCodeAdapter({ spawn: spawned.spawn, fetch, resolvePath: async () => '/usr/bin', exists: () => true, workspaceEnv: async () => ({}) });
    await adapter.start({ kind: 'task', cwd, mode: 'acceptEdits', flags: { permissionMode: 'acceptEdits', modeSettings: {} } });
    expect(spawned.processes).toHaveLength(1);
    adapter.dispose();
  });
});
