import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';

/**
 * The SSRF guard for anything that leaves the machine on the planner's behalf.
 * An unguarded `http://169.254.169.254/` would hand a prompt-injected planner
 * the cloud metadata credentials, so every outbound host is vetted here: IP
 * literals by range, names by every address DNS answers with.
 */

export type ResolveAll = (host: string) => Promise<string[]>;

export type EgressCheck =
  | { ok: true; addresses: string[] }
  | { ok: false; reason: string };

export const resolveAll: ResolveAll = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

const ALLOWED_PORTS = new Set(['', '80', '443']);
const LOCAL_NAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);

type Cidr4 = [base: number, bits: number, label: string];

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

const BLOCKED_V4: Cidr4[] = (
  [
    ['0.0.0.0', 8, '"this network"'],
    ['10.0.0.0', 8, 'private'],
    ['100.64.0.0', 10, 'shared (CGNAT)'],
    ['127.0.0.0', 8, 'loopback'],
    ['169.254.0.0', 16, 'link-local'],
    ['172.16.0.0', 12, 'private'],
    ['192.168.0.0', 16, 'private'],
    ['198.18.0.0', 15, 'benchmarking'],
    ['224.0.0.0', 4, 'multicast'],
    // Includes the 255.255.255.255 limited broadcast.
    ['240.0.0.0', 4, 'reserved'],
  ] as const
).map(([base, bits, label]) => [ipv4ToInt(base), bits, label]);

function blockedV4Reason(ip: string): string | undefined {
  const n = ipv4ToInt(ip);
  for (const [base, bits, label] of BLOCKED_V4) {
    const size = 2 ** (32 - bits);
    if (n >= base && n < base + size) return `${label} address ${ip}`;
  }
  return undefined;
}

/** Expand a valid IPv6 address to its 16 bytes, including a dotted IPv4 tail. */
function ipv6Bytes(ip: string): number[] {
  let text = ip;
  const tail: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    tail.push(...dotted[1].split('.').map(Number));
    text = text.slice(0, -dotted[1].length) + '0:0';
  }
  const [head, rest] = text.includes('::') ? text.split('::') : [text, undefined];
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const groups = rest === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  const bytes = groups.flatMap((g) => { const v = parseInt(g, 16); return [v >> 8, v & 0xff]; });
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

function inPrefix(bytes: number[], prefix: number[], bits: number): boolean {
  for (let i = 0; i < bits; i += 8) {
    const mask = (0xff << (8 - Math.min(8, bits - i))) & 0xff;
    if ((bytes[i / 8] & mask) !== ((prefix[i / 8] ?? 0) & mask)) return false;
  }
  return true;
}

const BLOCKED_V6: [prefix: number[], bits: number, label: string][] = [
  [[], 127, 'unspecified/loopback'],
  [[0xfc], 7, 'unique-local'],
  [[0xfe, 0x80], 10, 'link-local'],
  [[0xfe, 0xc0], 10, 'site-local'],
  [[0xff], 8, 'multicast'],
];

const MAPPED_V4 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];
const NAT64_V4 = [0, 0x64, 0xff, 0x9b];

function blockedV6Reason(ip: string): string | undefined {
  const bytes = ipv6Bytes(ip);
  const v4 = bytes.slice(12).join('.');
  // ::ffff:0:0/96 (mapped) and 64:ff9b::/96 (NAT64) carry an IPv4 address the
  // stack will actually connect to, so they are judged by that address.
  if (inPrefix(bytes, MAPPED_V4, 96) || inPrefix(bytes, NAT64_V4, 96)) return blockedV4Reason(v4);
  for (const [prefix, bits, label] of BLOCKED_V6) {
    if (inPrefix(bytes, prefix, bits)) return `${label} address ${ip}`;
  }
  return undefined;
}

/**
 * Why `ip` must not be contacted, or `undefined` if it is public. Anything
 * that is not a well-formed IP fails closed — `dns.lookup('')` resolves with
 * `address: null` rather than rejecting.
 */
export function blockedAddressReason(ip: unknown): string | undefined {
  if (typeof ip !== 'string') return 'unparseable address';
  // Resolvers can return scoped link-local addresses (`fe80::1%eth0`).
  const bare = ip.replace(/%.*$/, '');
  switch (isIP(bare)) {
    case 4: return blockedV4Reason(bare);
    case 6: return blockedV6Reason(bare.toLowerCase());
    default: return 'unparseable address';
  }
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function vetHostUnresolved(host: string): EgressCheck | undefined {
  const bare = stripBrackets(host);
  if (isIP(bare)) {
    const reason = blockedAddressReason(bare);
    return reason ? { ok: false, reason } : { ok: true, addresses: [bare] };
  }
  if (LOCAL_NAMES.has(bare.toLowerCase())) return { ok: false, reason: `local host name ${bare}` };
  return undefined;
}

async function vetHost(host: string, resolve: ResolveAll): Promise<EgressCheck> {
  const settled = vetHostUnresolved(host);
  if (settled) return settled;

  const bare = stripBrackets(host);
  let addresses: string[];
  try {
    addresses = await resolve(bare);
  } catch {
    return { ok: false, reason: `${bare} did not resolve` };
  }
  if (addresses.length === 0) return { ok: false, reason: `${bare} did not resolve` };
  for (const address of addresses) {
    const reason = blockedAddressReason(address);
    if (reason) return { ok: false, reason: `${bare} resolves to a ${reason}` };
  }
  return { ok: true, addresses };
}

/**
 * Vet a URL's `hostname` and `port` (as `URL` reports them). Returns the
 * addresses that may be contacted, or why none may. Names are resolved and
 * refused if any answer is private: a split answer is a rebinding setup, and
 * the connection could land on either.
 */
export async function vetEgress(host: string, port: string, resolve: ResolveAll = resolveAll): Promise<EgressCheck> {
  return vetEgressUnresolved(host, port) ?? vetHost(host, resolve);
}

/**
 * The part of {@link vetEgress} that needs no DNS: the port, an IP literal and
 * a local name. `undefined` means the host is a name still to be resolved. A
 * lookup is itself a request that leaves the machine, so a caller that may yet
 * refuse for another reason checks this first and resolves last.
 */
export function vetEgressUnresolved(host: string, port: string): EgressCheck | undefined {
  if (!ALLOWED_PORTS.has(port)) return { ok: false, reason: `port ${port} is not 80 or 443` };
  return vetHostUnresolved(host);
}

/**
 * A `lookup` for `net`/`http`/`https` that vets at connect time. Checking a
 * name and then letting the socket resolve it again is a TOCTOU gap a
 * rebinding DNS server walks through; this makes the connection use only
 * addresses that were vetted in the same lookup.
 */
export function guardedLookup(resolve: ResolveAll = resolveAll): LookupFunction {
  return (hostname, options, callback) => {
    void vetHost(hostname, resolve).then((check) => {
      if (!check.ok) {
        callback(Object.assign(new Error(`blocked host: ${check.reason}`), { code: 'EBLOCKEDHOST' }), []);
        return;
      }
      const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;
      const addresses = check.addresses
        .map((address) => ({ address, family: isIP(address) }))
        .filter((a) => !family || a.family === family);
      if (addresses.length === 0) {
        callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), []);
      } else if (options.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }
    });
  };
}
