import { describe, it, expect, vi } from 'vitest';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { blockedAddressReason, guardedLookup, resolveAll, vetEgress } from '../egressGuard';

const dnsLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: dnsLookup }));

describe('blockedAddressReason', () => {
  it.each([
    ['0.1.2.3', '0.0.0.0/8'],
    ['10.255.255.255', '10.0.0.0/8'],
    ['100.64.0.1', '100.64.0.0/10 CGNAT'],
    ['100.127.255.254', '100.64.0.0/10 CGNAT, top'],
    ['127.0.0.1', 'loopback'],
    ['169.254.169.254', 'link-local / metadata'],
    ['172.31.255.255', '172.16.0.0/12, top'],
    ['192.168.0.1', '192.168.0.0/16'],
    ['198.18.0.1', '198.18.0.0/15 benchmarking'],
    ['198.19.255.255', '198.18.0.0/15, top'],
    ['224.0.0.1', '224.0.0.0/4 multicast'],
    ['239.255.255.250', '224.0.0.0/4, top'],
    ['240.0.0.1', '240.0.0.0/4 reserved'],
    ['255.255.255.255', 'limited broadcast'],
    ['::', '::/128 unspecified'],
    ['::1', 'IPv6 loopback'],
    ['fc00::1', 'fc00::/7 unique local'],
    ['fdff:ffff::1', 'fc00::/7, fd half'],
    ['fe80::1', 'fe80::/10 link-local'],
    ['febf::1', 'fe80::/10, top'],
    ['fe80::1%eth0', 'scoped link-local'],
    ['fec0::1', 'fec0::/10 site-local'],
    ['ff02::1', 'ff00::/8 multicast'],
    ['::ffff:a9fe:a9fe', 'mapped metadata, hex'],
    ['::ffff:127.0.0.1', 'mapped loopback, dotted'],
    ['::FFFF:7F00:1', 'mapped loopback, upper case'],
    ['0:0:0:0:0:ffff:10.0.0.1', 'mapped private, uncompressed'],
    ['64:ff9b::7f00:1', 'NAT64 loopback'],
    ['64:ff9b::192.168.1.1', 'NAT64 private, dotted'],
  ])('blocks %s (%s)', (ip) => {
    expect(blockedAddressReason(ip)).toBeTypeOf('string');
  });

  it.each([
    ['93.184.215.14'],
    ['1.1.1.1'],
    ['100.63.255.255'],
    ['100.128.0.0'],
    ['172.15.255.255'],
    ['172.32.0.0'],
    ['198.17.255.255'],
    ['198.20.0.0'],
    ['223.255.255.255'],
    ['2606:4700:4700::1111'],
    ['::ffff:5db8:d70e'],
    ['64:ff9b::808:808'],
    ['fbff::1'],
    ['fe00::1'],
  ])('allows public %s', (ip) => {
    expect(blockedAddressReason(ip)).toBeUndefined();
  });

  it.each([[''], ['not-an-ip'], [null], ['1.2.3']])('fails closed on %j', (ip) => {
    expect(blockedAddressReason(ip)).toBeTypeOf('string');
  });
});

describe('vetEgress', () => {
  const resolvesTo = (...addrs: string[]) => async () => addrs;

  it('returns every vetted address for a public name', async () => {
    expect(await vetEgress('docs.rs', '', resolvesTo('93.184.215.14', '2606:4700::1'))).toEqual({
      ok: true,
      addresses: ['93.184.215.14', '2606:4700::1'],
    });
  });

  // A split answer is how DNS rebinding is staged: the connection may land on
  // either address, so one private answer taints the whole name.
  it('blocks a name if any one DNS answer is private', async () => {
    const result = await vetEgress('rebind.example', '443', resolvesTo('93.184.215.14', '10.0.0.5'));
    expect(result.ok).toBe(false);
  });

  it('blocks a name that resolves to nothing or fails to resolve', async () => {
    expect((await vetEgress('empty.example', '', resolvesTo())).ok).toBe(false);
    expect((await vetEgress('gone.example', '', async () => { throw new Error('ENOTFOUND'); })).ok).toBe(false);
  });

  it('vets a bracketed IPv6 literal by range without resolving it', async () => {
    const resolve = async (): Promise<string[]> => { throw new Error('should not resolve a literal'); };
    expect((await vetEgress('[::ffff:a9fe:a9fe]', '', resolve)).ok).toBe(false);
    expect(await vetEgress('[2606:4700:4700::1111]', '', resolve)).toEqual({ ok: true, addresses: ['2606:4700:4700::1111'] });
  });

  it('blocks ports other than 80 and 443', async () => {
    expect((await vetEgress('docs.rs', '6379', resolvesTo('93.184.215.14'))).ok).toBe(false);
  });
});

describe('resolveAll', () => {
  // A single-answer lookup only ever vetted the first record, so a name with
  // a public A record and a private AAAA record passed.
  it('asks DNS for every answer and lets vetEgress refuse a split name', async () => {
    dnsLookup.mockResolvedValueOnce([
      { address: '93.184.215.14', family: 4 },
      { address: 'fd12::1', family: 6 },
    ]);

    const result = await vetEgress('split.example', '');

    expect(dnsLookup).toHaveBeenCalledWith('split.example', expect.objectContaining({ all: true }));
    expect(result.ok).toBe(false);
  });

  it('returns every address', async () => {
    dnsLookup.mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }, { address: '2606:4700::1', family: 6 }]);
    expect(await resolveAll('one.one.one.one')).toEqual(['1.1.1.1', '2606:4700::1']);
  });
});

describe('guardedLookup', () => {
  function call(lookup: LookupFunction, options: Parameters<LookupFunction>[1]) {
    return new Promise<{ err: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number }>((resolve) => {
      lookup('docs.example', options, (err, address, family) => resolve({ err, address, family }));
    });
  }

  it('answers in the all-addresses shape net uses for happy eyeballs', async () => {
    const lookup = guardedLookup(async () => ['93.184.215.14', '2606:4700::1']);
    expect(await call(lookup, { all: true })).toEqual({
      err: null,
      address: [{ address: '93.184.215.14', family: 4 }, { address: '2606:4700::1', family: 6 }],
      family: undefined,
    });
  });

  it('answers in the single-address shape, honouring a requested family', async () => {
    const lookup = guardedLookup(async () => ['93.184.215.14', '2606:4700::1']);
    expect(await call(lookup, {})).toMatchObject({ err: null, address: '93.184.215.14', family: 4 });
    expect(await call(lookup, { family: 6 })).toMatchObject({ err: null, address: '2606:4700::1', family: 6 });
  });

  it('refuses the connection when any answer is private', async () => {
    const lookup = guardedLookup(async () => ['93.184.215.14', '::ffff:7f00:1']);
    const { err } = await call(lookup, { all: true });
    expect(err?.message).toMatch(/blocked host.*loopback/);
  });
});
