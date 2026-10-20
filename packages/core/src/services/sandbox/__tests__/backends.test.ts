import { describe, it, expect } from 'vitest';
import { SeatbeltBackend, SANDBOX_EXEC } from '../seatbelt';
import { BubblewrapBackend, findBubblewrap } from '../bubblewrap';
import { SandboxUnsupportedError, type SandboxInvocation, type SandboxProfile, type ProbeExec } from '../SandboxBackend';

const SH: SandboxInvocation = { shell: '/bin/sh', shellArgs: ['-c'], env: { PATH: '/usr/bin:/bin', HOME: '/home/me' } };
const SCRATCH = '/tmp/ordewell-planner-abc';

function profile(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
  return { write: [SCRATCH], read: 'host', network: false, env: { TMPDIR: SCRATCH }, ...overrides };
}

/** A path built to break out of any quoting a backend might have done by hand. */
const HOSTILE = '/tmp/a"b) (allow file-write* (subpath "/"))\n(allow network*)';

describe('SeatbeltBackend.wrap', () => {
  const seatbelt = new SeatbeltBackend();

  function profileText(args: string[]): string {
    expect(args[0]).toBe('-p');
    return args[1];
  }

  it('launches sandbox-exec by its absolute path, with the shell and its arguments last', () => {
    const launch = seatbelt.wrap(SH, profile());
    expect(launch.file).toBe(SANDBOX_EXEC);
    expect(launch.args.slice(-2)).toEqual(['/bin/sh', '-c']);
  });

  it('denies by default and allows writes only under the parameters it passes', () => {
    const launch = seatbelt.wrap(SH, profile());
    const text = profileText(launch.args);
    expect(text).toMatch(/^\(version 1\)\n\(deny default\)/);
    expect(text).toContain('(allow file-write* (subpath (param "WRITABLE_0")))');
    expect(launch.args).toContain(`WRITABLE_0=${SCRATCH}`);
    expect(launch.args[launch.args.indexOf(`WRITABLE_0=${SCRATCH}`) - 1]).toBe('-D');
    // Nothing but the scratch directory, the device files and the shell's own here-document names.
    const writes = text.split('\n').filter((line) => line.includes('file-write'));
    expect(writes.join('\n')).not.toMatch(/subpath "\/(Users|home|private\/var)/);
  });

  it('allows no network without it, and the network with it', () => {
    const off = profileText(seatbelt.wrap(SH, profile()).args);
    const on = profileText(seatbelt.wrap(SH, profile({ network: true })).args);
    expect(off).not.toMatch(/\(allow network-outbound\b(?! \(literal "\/private\/var\/run\/syslog"\))/);
    expect(off).not.toContain('com.apple.SecurityServer');
    expect(on).toContain('(allow network-outbound network-inbound network-bind system-socket)');
    expect(on).toContain('com.apple.SecurityServer');
  });

  it('never puts a path into the profile text, so none can become syntax', () => {
    const plain = seatbelt.wrap(SH, profile());
    const hostile = seatbelt.wrap(SH, profile({ write: [HOSTILE], masked: [HOSTILE] }));
    expect(profileText(hostile.args)).not.toContain('a"b');
    expect(profileText(hostile.args)).toBe(profileText(seatbelt.wrap(SH, profile({ write: ['/x'], masked: ['/y'] })).args));
    expect(hostile.args).toContain(`WRITABLE_0=${HOSTILE}`);
    expect(hostile.args).toContain(`MASKED_0=${HOSTILE}`);
    expect(profileText(plain.args)).not.toContain('MASKED');
  });

  it('keeps a writable directory inside a masked one writable, as bubblewrap does', () => {
    const text = profileText(seatbelt.wrap(SH, profile({ masked: ['/run/user/501'] })).args);
    expect(text.indexOf('(deny file-read* file-write* (subpath (param "MASKED_0")))'))
      .toBeLessThan(text.indexOf('(allow file-write* (subpath (param "WRITABLE_0")))'));
  });

  it('sets the profile environment over the one the shell had', () => {
    const { env } = seatbelt.wrap(SH, profile({ env: { TMPDIR: SCRATCH, HOME: '/elsewhere' } }));
    expect(env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/elsewhere', TMPDIR: SCRATCH });
  });

  it.each<[string, Partial<SandboxProfile>]>([
    ['a read list', { read: ['/usr'] }],
    ['a private /tmp', { privateTmp: true }],
    ['resource limits', { limits: { processes: 64 } }],
    ['a relative path', { write: ['scratch'] }],
    ['an option-shaped path', { write: ['--help'] }],
  ])('refuses %s rather than enforce less than it was asked', (_what, overrides) => {
    expect(() => seatbelt.wrap(SH, profile(overrides))).toThrow(SandboxUnsupportedError);
  });
});

describe('BubblewrapBackend.wrap', () => {
  const bwrap = (isDirectory: (p: string) => boolean = () => true) => new BubblewrapBackend('/usr/bin/bwrap', { isDirectory });

  it('builds the planner command line ADR-0011 names, without the network', () => {
    expect(bwrap().wrap(SH, profile())).toEqual({
      file: '/usr/bin/bwrap',
      args: [
        '--new-session', '--die-with-parent', '--unshare-pid', '--unshare-ipc', '--unshare-net',
        '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
        '--bind', SCRATCH, SCRATCH,
        '--', '/bin/sh', '-c',
      ],
      env: { PATH: '/usr/bin:/bin', HOME: '/home/me', TMPDIR: SCRATCH },
    });
  });

  it('keeps the network for an approved command', () => {
    const { args } = bwrap().wrap(SH, profile({ network: true }));
    expect(args).not.toContain('--unshare-net');
    expect(args).toContain('--unshare-pid');
  });

  it('masks a directory with an empty one and a socket file with /dev/null, before the writable binds', () => {
    const { args } = bwrap((p) => p !== '/run/docker.sock').wrap(SH, profile({ masked: ['/run/user/1000', '/run/docker.sock'] }));
    const joined = args.join(' ');
    expect(joined).toContain('--tmpfs /run/user/1000');
    expect(joined).toContain('--ro-bind /dev/null /run/docker.sock');
    expect(joined.indexOf('--tmpfs /run/user/1000')).toBeLessThan(joined.indexOf(`--bind ${SCRATCH}`));
  });

  it('can say all a sealed run needs: a read list, a private /tmp, no network', () => {
    const { args } = bwrap().wrap(SH, profile({
      read: ['/usr/lib', '/usr', '/tmp/ws'],
      write: ['/tmp/ws/worktree', SCRATCH],
      privateTmp: true,
    }));
    expect(args).not.toContain('/');
    const joined = args.join(' ');
    // The private /tmp first, so a workspace and a scratch under /tmp are mounted on it, parents before children.
    expect(joined).toContain('--tmpfs /tmp --ro-bind /usr /usr --ro-bind /usr/lib /usr/lib --ro-bind /tmp/ws /tmp/ws');
    expect(joined).toContain(`--bind ${SCRATCH} ${SCRATCH} --bind /tmp/ws/worktree /tmp/ws/worktree`);
  });

  it('passes a hostile path as one argument, never split or read as an option', () => {
    const { args } = bwrap().wrap(SH, profile({ write: [HOSTILE] }));
    expect(args[args.indexOf('--bind') + 1]).toBe(HOSTILE);
    expect(args[args.indexOf('--bind') + 2]).toBe(HOSTILE);
  });

  it.each<[string, Partial<SandboxProfile>]>([
    ['resource limits', { limits: { memoryBytes: 1 << 30 } }],
    ['a relative path', { masked: ['run/user'] }],
  ])('refuses %s rather than enforce less than it was asked', (_what, overrides) => {
    expect(() => bwrap().wrap(SH, profile(overrides))).toThrow(SandboxUnsupportedError);
  });
});

describe('probing a backend', () => {
  function recording(result: { code: number | null; output: string }): { exec: ProbeExec; calls: Array<{ file: string; args: string[] }> } {
    const calls: Array<{ file: string; args: string[] }> = [];
    return { calls, exec: async (file, args) => { calls.push({ file, args }); return result; } };
  }

  it('runs `true` in the wrapped shell, exactly as a command would run', async () => {
    const { exec, calls } = recording({ code: 0, output: '' });
    expect(await new BubblewrapBackend('/usr/bin/bwrap', { exec }).probe(profile({ write: [] }))).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('/usr/bin/bwrap');
    expect(calls[0].args.slice(-4)).toEqual(['--', '/bin/sh', '-c', 'true']);
    expect(calls[0].args).toContain('--unshare-net');
  });

  it('reports what the launcher said when it cannot start', async () => {
    const { exec } = recording({ code: 1, output: 'bwrap: setting up uid map: Permission denied' });
    expect(await new BubblewrapBackend('/usr/bin/bwrap', { exec }).probe(profile())).toEqual({ ok: false, detail: 'bwrap: setting up uid map: Permission denied' });
  });

  it('fails a profile the backend cannot enforce without running anything', async () => {
    const { exec, calls } = recording({ code: 0, output: '' });
    const probe = await new SeatbeltBackend(exec).probe(profile({ privateTmp: true }));
    expect(probe.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('findBubblewrap', () => {
  it('prefers the distribution install over whatever PATH finds first', () => {
    const present = new Set(['/home/me/bin/bwrap', '/usr/bin/bwrap']);
    expect(findBubblewrap({ PATH: '/home/me/bin:/usr/bin' }, (f) => present.has(f))).toBe('/usr/bin/bwrap');
  });

  it('falls back to an absolute PATH entry, and never a relative one', () => {
    expect(findBubblewrap({ PATH: 'node_modules/.bin:/opt/tools/bin' }, (f) => f === '/opt/tools/bin/bwrap' || f === 'node_modules/.bin/bwrap')).toBe('/opt/tools/bin/bwrap');
    expect(findBubblewrap({ PATH: 'node_modules/.bin' }, (f) => f === 'node_modules/.bin/bwrap')).toBeNull();
  });

  it('answers null when it is not installed', () => {
    expect(findBubblewrap({ PATH: '/usr/bin' }, () => false)).toBeNull();
  });
});
