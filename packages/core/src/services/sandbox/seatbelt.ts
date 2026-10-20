import {
  assertProfilePaths,
  execProbe,
  probeByRunning,
  SandboxUnsupportedError,
  type ProbeExec,
  type SandboxBackend,
  type SandboxInvocation,
  type SandboxLaunch,
  type SandboxProbe,
  type SandboxProfile,
} from './SandboxBackend';

/** Absolute, so a `sandbox-exec` earlier on PATH can never stand in for the real one. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/**
 * Closed by default, not "allow default, deny writes". With everything else
 * allowed, a command that cannot write a file can still ask a system service
 * to write one: `defaults write` goes through cfprefsd and changes the user's
 * preferences, `open` and Apple events reach LaunchServices and other apps,
 * and each of those writes as the user, outside any profile. Denying by
 * default leaves only the services named here, which read on the command's
 * behalf. Modelled on Chromium's and Codex's Seatbelt policies.
 *
 * Reads are open (ADR-0011 B2): `file-read*`, process listings and sysctls.
 * `ps` and `top` still cannot start, because the kernel will not run a setuid
 * program in a sandbox.
 */
const BASE_PROFILE = `(version 1)
(deny default)
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow process-info*)
(allow file-read* file-test-existence file-map-executable)
(allow sysctl-read)
(allow user-preference-read)
(allow ipc-posix-sem)
(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs.") (ipc-posix-name "apple.shm.notification_center"))
(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))
(allow mach-lookup
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.cfprefsd.agent")
  (global-name "com.apple.cfprefsd.daemon")
  (local-name "com.apple.cfprefsd.agent")
  (global-name "com.apple.diagnosticd")
  (global-name "com.apple.logd")
  (global-name "com.apple.logd.events")
  (global-name "com.apple.secinitd")
  (global-name "com.apple.sysmond")
  (global-name "com.apple.system.DirectoryService.libinfo_v1")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.opendirectoryd.membership"))
(allow network-outbound (literal "/private/var/run/syslog"))
; No ioctl on /dev/tty: TIOCSTI there would type into the user's terminal.
(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (subpath "/dev/fd"))
(allow file-write-data file-ioctl (literal "/dev/dtracehelper"))
; macOS's /bin/sh is bash 3.2, which writes a here-document to /tmp whatever
; TMPDIR says, after checking that /tmp itself is writable. Only its own
; file names are allowed there.
(allow file-write* (literal "/private/tmp") (regex #"^/private/tmp/sh-thd-[0-9]+$"))`;

/**
 * What an approved command's network needs beyond the sockets themselves:
 * name resolution, TLS trust, and the keychain, where `gh` and git's
 * credential helper keep the user's tokens. The keychain service also takes
 * writes; that is part of what approving a networked command trusts it with.
 */
const NETWORK_PROFILE = `(allow network-outbound network-inbound network-bind system-socket)
(allow mach-lookup
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.networkd")
  (global-name "com.apple.ocspd")
  (global-name "com.apple.trustd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.TrustEvaluationAgent")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.SystemConfiguration.configd"))`;

/**
 * macOS's Seatbelt, through `sandbox-exec -p <profile>` (ADR-0011 B4). The
 * profile text is fixed: every path goes in as a `-D NAME=value` parameter and
 * is referred to as `(param "NAME")`, so no path is ever parsed as profile
 * syntax.
 */
export class SeatbeltBackend implements SandboxBackend {
  readonly name = 'Seatbelt';

  constructor(private readonly exec: ProbeExec = execProbe) {}

  probe(profile: SandboxProfile): Promise<SandboxProbe> {
    return probeByRunning(this, profile, this.exec);
  }

  wrap(invocation: SandboxInvocation, profile: SandboxProfile): SandboxLaunch {
    // Seatbelt filters what a process may touch; it has no mount namespace to
    // give it a /tmp of its own, nor a resource limit to hold it to.
    if (profile.read !== 'host') throw new SandboxUnsupportedError(this.name, 'a read list');
    if (profile.privateTmp) throw new SandboxUnsupportedError(this.name, 'a private /tmp');
    if (profile.limits) throw new SandboxUnsupportedError(this.name, 'resource limits');
    assertProfilePaths(this.name, profile);

    const params: string[] = [];
    const filters = (prefix: string, paths: readonly string[]): string => paths.map((p, i) => {
      params.push('-D', `${prefix}_${i}=${p}`);
      return `(subpath (param "${prefix}_${i}"))`;
    }).join(' ');

    const rules = [BASE_PROFILE];
    if (profile.network) rules.push(NETWORK_PROFILE);
    // The last matching rule wins, so a writable directory inside a masked one stays writable, as under bubblewrap.
    if (profile.masked?.length) rules.push(`(deny file-read* file-write* ${filters('MASKED', profile.masked)})`);
    if (profile.write.length) rules.push(`(allow file-write* ${filters('WRITABLE', profile.write)})`);

    return {
      file: SANDBOX_EXEC,
      args: ['-p', rules.join('\n'), ...params, invocation.shell, ...invocation.shellArgs],
      env: { ...invocation.env, ...profile.env },
    };
  }
}
