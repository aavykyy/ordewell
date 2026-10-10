import { describe, it, expect, vi } from 'vitest';
import { HttpWebFetcher, type HttpWebFetcherOptions } from '../HttpWebFetcher';
import { WebReadPolicy, type WebReadPolicyOptions } from '../webReadPolicy';
import { ApprovalPolicy } from '../ApprovalPolicy';
import { WebResponseCache } from '../WebResponseCache';
import type { IApproval } from '../../interfaces/IApproval';

const PUBLIC_IP = '93.184.215.14';

const RESULTS = `
  <html><body>
    <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fhono.dev%2Fdocs%2Frouting&amp;rut=abc" class='result-link'>Hono Routing</a>
  </body></html>`;

function response(body: string, init: { status?: number; contentType?: string; headers?: Record<string, string> } = {}) {
  const h: Record<string, string> = { 'content-type': init.contentType ?? 'text/html', ...(init.headers ?? {}) };
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: { get: (name: string) => h[name.toLowerCase()] ?? null },
    text: async () => body,
    body: null,
  } as unknown as Response;
}

function makeFetcher(
  { approval, policy, ...opts }: Omit<HttpWebFetcherOptions, 'policy'> & { approval: IApproval; policy?: Partial<WebReadPolicyOptions> },
) {
  const resolveHost = opts.resolveHost ?? (async () => [PUBLIC_IP]);
  return new HttpWebFetcher({ policy: new WebReadPolicy({ approval, env: () => ({}), resolveHost, ...policy }), ...opts, resolveHost });
}

const allow: IApproval = { request: async () => true };

describe('shared web-response cache', () => {
  it('serves a repeated GET from the cache without a second request', async () => {
    const cache = new WebResponseCache();
    const fetchImpl = vi.fn().mockResolvedValue(response('<p>page</p>'));
    const fetcher = makeFetcher({ approval: allow, fetchImpl, cache });

    const first = await fetcher.fetch('https://docs.example.com/a');
    const second = await fetcher.fetch('https://docs.example.com/a');

    expect(first.output).toContain('page');
    expect(second.output).toContain('page');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('serves a repeated search from the cache without a second request', async () => {
    const cache = new WebResponseCache();
    const fetchImpl = vi.fn().mockResolvedValue(response(RESULTS));
    const fetcher = makeFetcher({ approval: allow, fetchImpl, cache });

    const first = await fetcher.search('hono');
    const second = await fetcher.search('hono');

    expect(first.output).toContain('Hono Routing');
    expect(second.output).toContain('Hono Routing');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('still refuses a cached page once an exclusion added later covers it', async () => {
    let entries: string[] = [];
    const cache = new WebResponseCache();
    const fetchImpl = vi.fn().mockResolvedValue(response('<p>internal</p>'));
    const approval = new ApprovalPolicy({ mode: 'allow', preApproved: () => entries, ask: async () => true });
    const fetcher = makeFetcher({ approval, fetchImpl, cache });

    const first = await fetcher.fetch('https://internal.example.com/secret');
    expect(first.success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    entries = ['!https://internal.example.com/*'];
    const second = await fetcher.fetch('https://internal.example.com/secret');

    expect(second.success).toBe(false);
    expect(second.output).toMatch(/excluded/);
    // Refused before the cache was consulted: no network either way.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('counts a cached hit against the budget like a live read', async () => {
    const cache = new WebResponseCache();
    const fetchImpl = vi.fn().mockResolvedValue(response('<p>page</p>'));
    const fetcher = makeFetcher({ approval: allow, fetchImpl, cache, policy: { budget: () => 1 } });

    const first = await fetcher.fetch('https://docs.example.com/a');
    expect(first.success).toBe(true);

    const second = await fetcher.fetch('https://docs.example.com/a');
    expect(second.success).toBe(false);
    expect(second.output).toMatch(/budget/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not cache a response marked no-store', async () => {
    const cache = new WebResponseCache();
    const fetchImpl = vi.fn().mockResolvedValue(response('<p>page</p>', { headers: { 'cache-control': 'no-store' } }));
    const fetcher = makeFetcher({ approval: allow, fetchImpl, cache });

    await fetcher.fetch('https://docs.example.com/a');
    await fetcher.fetch('https://docs.example.com/a');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // The cache cannot revalidate, so a response that must be revalidated is
  // one it cannot reuse.
  it('does not cache a response marked no-cache', async () => {
    const cache = new WebResponseCache();
    const fetchImpl = vi.fn().mockResolvedValue(response('<p>page</p>', { headers: { 'cache-control': 'public, no-cache' } }));
    const fetcher = makeFetcher({ approval: allow, fetchImpl, cache });

    await fetcher.fetch('https://docs.example.com/a');
    await fetcher.fetch('https://docs.example.com/a');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps a response only for its max-age when that is shorter than the TTL', async () => {
    let now = 0;
    const cache = new WebResponseCache({ ttlMs: 300_000, now: () => now });
    const fetchImpl = vi.fn().mockResolvedValue(response('<p>page</p>', { headers: { 'cache-control': 'public, max-age=10' } }));
    const fetcher = makeFetcher({ approval: allow, fetchImpl, cache });

    await fetcher.fetch('https://docs.example.com/a');
    now = 9_000;
    await fetcher.fetch('https://docs.example.com/a');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now = 10_001;
    await fetcher.fetch('https://docs.example.com/a');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not cache a response with max-age=0', async () => {
    const cache = new WebResponseCache();
    const fetchImpl = vi.fn().mockResolvedValue(response('<p>page</p>', { headers: { 'cache-control': 'max-age=0' } }));
    const fetcher = makeFetcher({ approval: allow, fetchImpl, cache });

    await fetcher.fetch('https://docs.example.com/a');
    await fetcher.fetch('https://docs.example.com/a');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not cache a response that was byte-capped', async () => {
    const cache = new WebResponseCache();
    const huge = 'x'.repeat(2_500_000);
    const fetchImpl = vi.fn().mockImplementation(() => ({
      ok: true, status: 200, headers: { get: () => 'text/plain' }, body: (async function* () { yield Buffer.from(huge); })(),
    } as unknown as Response));
    const fetcher = makeFetcher({ approval: allow, fetchImpl, cache, maxChars: 100 });

    await fetcher.fetch('https://docs.example.com/big');
    await fetcher.fetch('https://docs.example.com/big');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // The key is the URL asked for. Caching what another origin answered under
  // it would hand that body to every session that later asks for the first
  // URL, without the second origin ever being decided for them.
  it('does not cache a body that came from another origin', async () => {
    const cache = new WebResponseCache();
    const fetchImpl = vi.fn().mockImplementation((url: string) => (url === 'https://docs.example.com/moved'
      ? response('', { status: 302, headers: { location: 'https://elsewhere.example.net/page' } })
      : response('<p>elsewhere</p>')));
    const fetcher = makeFetcher({ approval: allow, fetchImpl, cache });

    await fetcher.fetch('https://docs.example.com/moved');
    await fetcher.fetch('https://docs.example.com/moved');

    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('caches a body reached through a same-origin redirect', async () => {
    const cache = new WebResponseCache();
    const fetchImpl = vi.fn().mockImplementation((url: string) => (url === 'https://docs.example.com/moved'
      ? response('', { status: 301, headers: { location: '/page' } })
      : response('<p>page</p>')));
    const fetcher = makeFetcher({ approval: allow, fetchImpl, cache });

    await fetcher.fetch('https://docs.example.com/moved');
    await fetcher.fetch('https://docs.example.com/moved');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('expires an entry after the TTL and fetches again', async () => {
    let now = 0;
    const cache = new WebResponseCache({ ttlMs: 1_000, now: () => now });
    const fetchImpl = vi.fn().mockResolvedValue(response('<p>page</p>'));
    const fetcher = makeFetcher({ approval: allow, fetchImpl, cache });

    await fetcher.fetch('https://docs.example.com/a');
    now = 1_001;
    await fetcher.fetch('https://docs.example.com/a');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

// A count alone lets 100 entries of a 2 MB page each sit in every process.
describe('WebResponseCache bounds', () => {
  const page = (bytes: number) => ({ body: 'x'.repeat(bytes), isHtml: false });

  it('evicts the least recently used entries once the total bytes pass the cap', () => {
    const cache = new WebResponseCache({ maxBytes: 100 });
    cache.setFetch('https://a.example/', page(40));
    cache.setFetch('https://b.example/', page(40));
    cache.getFetch('https://a.example/');
    cache.setFetch('https://c.example/', page(40));

    expect(cache.getFetch('https://b.example/')).toBeUndefined();
    expect(cache.getFetch('https://a.example/')).toBeDefined();
    expect(cache.getFetch('https://c.example/')).toBeDefined();
  });

  it('does not store an entry larger than the whole cap', () => {
    const cache = new WebResponseCache({ maxBytes: 100 });
    cache.setFetch('https://a.example/', page(40));
    cache.setFetch('https://huge.example/', page(101));

    expect(cache.getFetch('https://huge.example/')).toBeUndefined();
    expect(cache.getFetch('https://a.example/')).toBeDefined();
  });

  it('counts a search result by its text', () => {
    const cache = new WebResponseCache({ maxBytes: 100 });
    const hit = { title: 't'.repeat(30), url: 'https://u.example/', snippet: 's'.repeat(30) };
    cache.setSearch('ddg\u0000a', [hit]);
    cache.setSearch('ddg\u0000b', [hit]);

    expect(cache.getSearch('ddg\u0000a')).toBeUndefined();
    expect(cache.getSearch('ddg\u0000b')).toEqual([hit]);
  });
});
