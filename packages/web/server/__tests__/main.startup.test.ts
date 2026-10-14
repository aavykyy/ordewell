import { spawn } from 'child_process';
import { createServer } from 'http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('daemon startup', () => {
  it('preserves the listening daemon token when another daemon cannot bind its port', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ordewell-daemon-start-'));
    const incumbent = createServer((_req, res) => res.end('incumbent'));
    await new Promise<void>((resolve) => incumbent.listen(0, '127.0.0.1', resolve));
    const address = incumbent.address();
    if (!address || typeof address === 'string') throw new Error('No listening port');
    const dataDir = join(home, '.ordewell');
    mkdirSync(dataDir);
    const tokenFile = join(dataDir, `server-${address.port}.token`);
    writeFileSync(tokenFile, 'incumbent-token');
    const child = spawn(process.execPath, [resolve(__dirname, '../../dist/server/main.js'), '--port', String(address.port)], {
      env: { HOME: home, USERPROFILE: home, PATH: '', AI_PROVIDER: 'codex', ORDEWELL_ENABLED_RUNNERS: 'codex' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      expect(exit).not.toBe(0);
      expect(stderr).toContain('EADDRINUSE');
      expect(readFileSync(tokenFile, 'utf8')).toBe('incumbent-token');
      expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe('incumbent');
    } finally {
      child.kill();
      await new Promise<void>((resolve) => incumbent.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });
});
