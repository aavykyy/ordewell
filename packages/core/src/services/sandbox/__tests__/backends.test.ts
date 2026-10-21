import { describe, it, expect } from 'vitest';
import { SeatbeltBackend, SANDBOX_EXEC } from '../seatbelt';
import { BubblewrapBackend, findBubblewrap } from '../bubblewrap';
import { SandboxUnsupportedError, type SandboxInvocation, type SandboxLimits, type SandboxProfile, type ProbeExec } from '../SandboxBackend';

const SH: SandboxInvocation = { shell: '/bin/sh', shellArgs: ['-c'], env: { PATH: '/usr/bin:/bin', HOME: '/home/me' } };
const SCRATCH = '/tmp/ordewell-planner-abc';

function profile(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
  return { write: [SCRATCH], read: 'host', network: false, env: { TMPDIR: SCRATCH }, ...overrides };
}

const LIMITS: SandboxLimits = { processes: 64, memoryBytes: 2 * 1024 ** 3, wallTimeMs: 30_000 };

/** A sealed run's profile, as ADR-0036 S1 shapes it. */
function sealed(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
  return profile({
    read: ['/usr', '/bin', '/work/repo'],
    privateTmp: true,
    env: { TMPDIR: SCRATCH, HOME: SCRATCH },
    inheritEnv: ['PATH'],
    limits: LIMITS,
    ...overrides,
  });
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
    expect(text).toContain('(allow file-read* file-test-existence file-map-executable file-write* (subpath (param "WRITABLE_0")))');
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

  it('keeps the keychain out of reach of a native shell that has the network (ADR-0036 N2.2)', () => {
    const text = profileText(seatbelt.wrap(SH, profile({ network: true, keychain: false })).args);
    expect(text).toContain('(allow network-outbound network-inbound network-bind system-socket)');
    expect(text).toContain('com.apple.trustd');
    expect(text).not.toContain('com.apple.SecurityServer');
  });

  it('keeps a native shell that has the network off this machine\'s own services, since a local API acts outside the sandbox (ADR-0036 N2)', () => {
    const text = profileText(seatbelt.wrap(SH, profile({ network: true, localNetwork: false })).args);
    const network = text.indexOf('(allow network-outbound network-inbound network-bind system-socket)');
    const deny = text.indexOf('(deny network-outbound (remote ip "localhost:*") (remote unix-socket))');
    expect(network).toBeGreaterThan(-1);
    expect(deny).toBeGreaterThan(network);
    // Name resolution goes through mDNSResponder's socket, and logging through syslog's.
    expect(text.indexOf('(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")) (literal "/private/var/run/syslog"))')).toBeGreaterThan(deny);
    expect(profileText(seatbelt.wrap(SH, profile({ network: true })).args)).not.toContain('(deny network-outbound');
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
      .toBeLessThan(text.indexOf('file-write* (subpath (param "WRITABLE_0")))'));
  });

  it('sets the profile environment over the one the shell had', () => {
    const { env } = seatbelt.wrap(SH, profile({ env: { TMPDIR: SCRATCH, HOME: '/elsewhere' } }));
    expect(env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/elsewhere', TMPDIR: SCRATCH });
  });

  it.each<[string, Partial<SandboxProfile>]>([
    ['a throwaway overlay', { read: ['/work/repo'], throwaway: ['/work/repo'] }],
    ['a relative path', { write: ['scratch'] }],
    ['an option-shaped path', { write: ['--help'] }],
    ['a limit that is not a whole number', { limits: { ...LIMITS, processes: 1.5 } }],
  ])('refuses %s rather than enforce less than it was asked', (_what, overrides) => {
    expect(() => seatbelt.wrap(SH, profile(overrides))).toThrow(SandboxUnsupportedError);
  });

  describe('a sealed profile (ADR-0036 S1)', () => {
    it('reads only what it lists, the directories above it by name, and none of the user preferences or other processes', () => {
      const launch = seatbelt.wrap(SH, sealed({ masked: ['/usr/local/var'] }));
      const text = profileText(launch.args.slice(launch.args.indexOf(SANDBOX_EXEC) + 1));
      expect(text).not.toContain('(allow file-read* file-test-existence file-map-executable)\n');
      expect(text).not.toContain('user-preference-read');
      expect(text).not.toContain('com.apple.cfprefsd');
      expect(text).toContain('(allow process-info* (target same-sandbox))');
      expect(text).toContain('(allow file-read* file-test-existence file-map-executable (subpath (param "READ_0")) (subpath (param "READ_1")) (subpath (param "READ_2")))');
      expect(launch.args).toEqual(expect.arrayContaining(['READ_0=/usr', 'READ_1=/bin', 'READ_2=/work/repo']));
      // Stat, never read: the workspace's and the scratch directory's parents.
      expect(launch.args).toEqual(expect.arrayContaining(['ABOVE_0=/work', 'ABOVE_1=/tmp']));
      expect(text).toMatch(/\(allow file-read-metadata \(literal \(param "ABOVE_0"\)\)/);
      expect(text.indexOf('(deny file-read* file-write* (subpath (param "MASKED_0")))')).toBeGreaterThan(text.indexOf('READ_2'));
    });

    it('keeps a hostile path out of the profile text in the read list too', () => {
      const launch = seatbelt.wrap(SH, sealed({ read: [HOSTILE] }));
      expect(launch.args.find((arg) => arg.startsWith('(version 1)'))).not.toContain('a"b');
      expect(launch.args).toContain(`READ_0=${HOSTILE}`);
    });

    it('hides the host /tmp from a profile that reads the host, but for the shell\'s here-documents', () => {
      const text = profileText(seatbelt.wrap(SH, profile({ privateTmp: true })).args);
      const deny = text.indexOf('(deny file-read* file-write* (subpath "/private/tmp") (subpath "/private/var/tmp"))');
      expect(deny).toBeGreaterThan(text.indexOf('(allow file-read* file-test-existence file-map-executable)'));
      expect(text.indexOf('(allow file-read* file-write* (regex #"^/private/tmp/sh-thd-[0-9]+$"))')).toBeGreaterThan(deny);
    });

    it('starts behind a bash prelude that sets the limits and owns the process group, and asks the caller to keep the time', () => {
      const launch = seatbelt.wrap(SH, sealed());
      expect(launch.file).toBe('/bin/bash');
      expect(launch.args[0]).toBe('-c');
      const prelude = launch.args[1];
      expect(prelude).toContain('ulimit -u $((n + 64))');
      expect(prelude).toContain(`ulimit -v $((v + ${2 * 1024 * 1024}))`);
      expect(prelude).toContain('set -m');
      expect(prelude).toContain('kill -KILL -$pid');
      // `$0`, then the launcher and the shell, with the command left to come last.
      expect(launch.args.slice(2, 4)).toEqual(['ordewell-sealed', SANDBOX_EXEC]);
      expect(launch.args.slice(-2)).toEqual(['/bin/sh', '-c']);
      expect(launch.wallTimeMs).toBe(30_000);
    });

    it('keeps only the environment the profile names, then sets its own', () => {
      const { env } = seatbelt.wrap({ ...SH, env: { PATH: '/usr/bin', AWS_SECRET_ACCESS_KEY: 'x', HOME: '/home/me' } }, sealed());
      expect(env).toEqual({ PATH: '/usr/bin', TMPDIR: SCRATCH, HOME: SCRATCH });
    });
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

  it('refuses a network without this machine\'s own services, which needs a network namespace of its own', () => {
    expect(() => bwrap().wrap(SH, profile({ network: true, localNetwork: false }))).toThrow(SandboxUnsupportedError);
    expect(() => bwrap().wrap(SH, profile({ network: false, localNetwork: false }))).not.toThrow();
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
    ['a limit that is not a whole number', { limits: { ...LIMITS, memoryBytes: -1 } }],
    ['a relative path', { masked: ['run/user'] }],
    ['a relative throwaway directory', { throwaway: ['repo'] }],
  ])('refuses %s rather than enforce less than it was asked', (_what, overrides) => {
    expect(() => bwrap().wrap(SH, profile(overrides))).toThrow(SandboxUnsupportedError);
  });

  describe('a sealed profile (ADR-0036 S1)', () => {
    it('lays a throwaway overlay over the workspace in place of a read-only bind', () => {
      const { args } = bwrap().wrap(SH, sealed({ throwaway: ['/work/repo'] }));
      const joined = args.join(' ');
      expect(joined).toContain('--overlay-src /work/repo --tmp-overlay /work/repo');
      expect(joined).not.toContain('--ro-bind /work/repo');
      expect(joined).toContain('--ro-bind /usr /usr --ro-bind /bin /bin');
      expect(joined).toContain('--unshare-net');
      expect(joined).toContain('--tmpfs /tmp');
    });

    it('starts behind a prelude that sets the limits and then becomes bubblewrap, so its kill and its parent\'s death reach the sandbox', () => {
      const launch = bwrap().wrap(SH, sealed());
      expect(launch.file).toBe('/bin/sh');
      const prelude = launch.args[1];
      // dash calls the process limit -p, bash -u.
      const processes = '$(($(set -- /proc/[0-9]*; echo $#) + 64))';
      expect(prelude).toContain(`ulimit -u ${processes} 2>/dev/null || ulimit -p ${processes}`);
      expect(prelude).toContain(`ulimit -v ${2 * 1024 * 1024}`);
      expect(prelude).toMatch(/exec "\$@"$/);
      expect(launch.args.slice(2, 4)).toEqual(['ordewell-sealed', '/usr/bin/bwrap']);
      expect(launch.args).toContain('--die-with-parent');
      expect(launch.wallTimeMs).toBe(30_000);
    });

    it('keeps only the environment the profile names, then sets its own', () => {
      const { env } = bwrap().wrap({ ...SH, env: { PATH: '/usr/bin', GITHUB_TOKEN: 'x', HOME: '/home/me' } }, sealed());
      expect(env).toEqual({ PATH: '/usr/bin', TMPDIR: SCRATCH, HOME: SCRATCH });
    });
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
    const probe = await new SeatbeltBackend(exec).probe(profile({ read: ['/work/repo'], throwaway: ['/work/repo'] }));
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
