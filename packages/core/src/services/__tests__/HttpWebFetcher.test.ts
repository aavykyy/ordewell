import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { HttpWebFetcher, pinnedTransport, type HttpWebFetcherOptions } from '../HttpWebFetcher';
import { WebReadPolicy } from '../webReadPolicy';
import { ApprovalPolicy, effectiveApprovalMode } from '../ApprovalPolicy';
import { DuckDuckGoSearchProvider } from '../DuckDuckGoSearchProvider';
import type { ApprovalRequest, IApproval } from '../../interfaces/IApproval';
import { fakeSecret } from './fakeSecret';

const lite = (name: string) => readFileSync(join(__dirname, 'fixtures', 'duckduckgo', name), 'utf8');

const allow: IApproval = { request: async () => true };
const deny: IApproval = { request: async () => false };

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

// Real DNS is slow and flaky in CI. We inject `resolveHost` so the default
// blocklist never hits the network; IP literals and `localhost` are caught
// before any lookup, so SSRF cases still exercise the real guard.
const PUBLIC_IP = '93.184.215.14';

function makeFetcher({ approval, ...opts }: Omit<HttpWebFetcherOptions, 'policy'> & { approval: IApproval }) {
  const resolveHost = opts.resolveHost ?? (async () => [PUBLIC_IP]);
  return new HttpWebFetcher({ policy: new WebReadPolicy({ approval, env: () => ({}), resolveHost }), ...opts, resolveHost });
}

async function allowed(fetcher: HttpWebFetcher, url: string): Promise<boolean> {
  return (await fetcher.decide({ kind: 'fetch', url })).allowed;
}

describe('HttpWebFetcher.decide', () => {
  it('asks per origin, so a second page on the same host does not re-prompt', async () => {
    const request = vi.fn().mockResolvedValue(true);
    const fetcher = makeFetcher({ approval: { request } });

    await fetcher.decide({ kind: 'fetch', url: 'https://docs.rs/tokio/latest/tokio/' });

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'url_fetch',
      subject: 'https://docs.rs/tokio/latest/tokio/',
      scope: 'https://docs.rs/*',
    }));
  });

  it('refuses a non-HTTP scheme without consulting the user', async () => {
    const request = vi.fn();
    const fetcher = makeFetcher({ approval: { request } });

    expect(await allowed(fetcher, 'file:///etc/passwd')).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a malformed URL rather than throwing mid-turn', async () => {
    const fetcher = makeFetcher({ approval: allow });
    expect(await allowed(fetcher, 'not a url')).toBe(false);
  });
});

describe('HttpWebFetcher.fetch', () => {
  it('hands the policy\'s reason back when the fetch is refused', async () => {
    const fetchImpl = vi.fn();
    const fetcher = makeFetcher({ approval: deny, fetchImpl });

    const result = await fetcher.fetch('https://docs.rs/tokio');

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/^Fetch not approved: https:\/\/docs\.rs\/\*/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns readable text with the markup stripped', async () => {
    const html = '<html><head><style>a{}</style></head><body><h1>Tokio</h1><p>An async runtime.</p></body></html>';
    const fetcher = makeFetcher({ approval: allow, fetchImpl: async () => response(html) });

    const result = await fetcher.fetch('https://docs.rs/tokio');

    expect(result.success).toBe(true);
    expect(result.output).toContain('Tokio');
    expect(result.output).toContain('An async runtime.');
    expect(result.output).not.toContain('<h1>');
    expect(result.output).not.toContain('a{}');
  });

  it('leaves non-HTML content alone', async () => {
    const json = '{"name":"tokio"}';
    const fetcher = makeFetcher({ approval: allow, fetchImpl: async () => response(json, { contentType: 'application/json' }) });

    const result = await fetcher.fetch('https://registry.example/tokio');

    expect(result.output).toBe(json);
  });

  it('reports an HTTP error as a failed tool result rather than throwing', async () => {
    const fetcher = makeFetcher({ approval: allow, fetchImpl: async () => response('nope', { status: 404 }) });

    const result = await fetcher.fetch('https://docs.rs/missing');

    expect(result.success).toBe(false);
    expect(result.output).toContain('404');
  });

  it('reports a network failure as a failed tool result', async () => {
    const fetcher = makeFetcher({ approval: allow, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });

    const result = await fetcher.fetch('https://docs.rs/tokio');

    expect(result.success).toBe(false);
    expect(result.output).toContain('host not reachable');
  });

  it('caps a huge page and says it did', async () => {
    const fetcher = makeFetcher({
      approval: allow,
      maxChars: 50,
      fetchImpl: async () => response(`<p>${'x'.repeat(500)}</p>`),
    });

    const result = await fetcher.fetch('https://docs.rs/tokio');

    expect(result.truncated).toBe(true);
    expect(result.output).toContain('truncated');
  });
});

describe('HttpWebFetcher.search', () => {
  const RESULTS = lite('lite-results-typescript.html');

  it('returns numbered titles with the real URLs, not DuckDuckGo redirects', async () => {
    const fetcher = makeFetcher({ approval: allow, fetchImpl: async () => response(RESULTS) });

    const result = await fetcher.search('typescript');

    expect(result.success).toBe(true);
    expect(result.output).toContain('1. TypeScript: JavaScript With Syntax For Types.\n   https://www.typescriptlang.org/\n');
    expect(result.output).toContain('https://github.com/microsoft/TypeScript');
    expect(result.output).not.toContain('duckduckgo.com/l/');
  });

  it('tells the planner what to do when the search returns nothing usable', async () => {
    const fetcher = makeFetcher({ approval: allow, fetchImpl: async () => response('<html><body>nothing</body></html>') });

    const result = await fetcher.search('zzz');

    expect(result.success).toBe(false);
    expect(result.output).toContain('No results');
  });

  it('reports a network failure without failing the turn', async () => {
    const fetcher = makeFetcher({ approval: allow, fetchImpl: async () => { throw new Error('offline'); } });

    const result = await fetcher.search('hono');

    expect(result.success).toBe(false);
    expect(result.output).toContain('offline');
  });

  it('asks the web-read policy about the query, scoped to the search provider', async () => {
    const request = vi.fn().mockResolvedValue(true);
    const fetcher = makeFetcher({ approval: { request }, fetchImpl: async () => response(RESULTS) });

    await fetcher.search('hono');

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatchObject({ kind: 'web_search', subject: 'hono', scope: 'web_search:duckduckgo' });
  });

  it('hands the policy\'s reason back when the search is refused', async () => {
    const fetcher = makeFetcher({ approval: allow, fetchImpl: vi.fn() });

    const result = await fetcher.search(fakeSecret('github'));

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/secret/);
    expect(result.output).not.toContain('ghp_');
  });

  it('does not search when approval is refused', async () => {
    const fetchImpl = vi.fn();
    const fetcher = makeFetcher({ approval: deny, fetchImpl });

    const result = await fetcher.search('hono');

    expect(result.success).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('HttpWebFetcher.search back-off', () => {
  it('starts a cooldown on a 429 and sends no request for the next search', async () => {
    const provider = new DuckDuckGoSearchProvider(() => 1_000);
    const fetchImpl = vi.fn().mockResolvedValue(response('too many requests', { status: 429 }));
    const fetcher = makeFetcher({ approval: allow, fetchImpl, searchProvider: provider });

    const first = await fetcher.search('hono');
    expect(first.success).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const second = await fetcher.search('serde');
    expect(second.success).toBe(false);
    expect(second.output).toMatch(/temporarily unavailable/i);
    expect(second.output).toMatch(/fetch/i);
    // No request went out for the second search.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('starts a cooldown on a challenge page rather than reporting a parse miss', async () => {
    const provider = new DuckDuckGoSearchProvider(() => 1_000);
    const fetchImpl = vi.fn().mockResolvedValue(response(lite('lite-challenge-202.html'), { status: 202 }));
    const fetcher = makeFetcher({ approval: allow, fetchImpl, searchProvider: provider });

    const result = await fetcher.search('hono');

    expect(result.success).toBe(false);
    expect(provider.coolingDown()).toBe(true);
    expect(result.output).toMatch(/temporarily unavailable/i);
  });

  it('answers a cooling-down search before the policy, so nobody is asked and no budget is spent', async () => {
    const provider = new DuckDuckGoSearchProvider(() => 1_000);
    const decide = vi.fn().mockResolvedValue({ allowed: true });
    const fetchImpl = vi.fn().mockResolvedValue(response('', { status: 429 }));
    const fetcher = new HttpWebFetcher({ policy: { decide }, fetchImpl, searchProvider: provider });
    await fetcher.search('hono');
    expect(decide).toHaveBeenCalledTimes(1);

    const result = await fetcher.search('serde');

    expect(result.output).toMatch(/temporarily unavailable/i);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('resets the cooldown after a successful search', async () => {
    let now = 1_000;
    const provider = new DuckDuckGoSearchProvider(() => now);
    const results = `<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fhono.dev%2Fdocs%2Frouting" class='result-link'>Hono Routing</a>`;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response('nope', { status: 429 }))
      .mockResolvedValue(response(results));
    const fetcher = makeFetcher({ approval: allow, fetchImpl, searchProvider: provider });

    await fetcher.search('hono');
    expect(provider.coolingDown()).toBe(true);

    now += 60_000;
    expect(provider.coolingDown()).toBe(false);
    const result = await fetcher.search('serde');

    expect(result.success).toBe(true);
    expect(provider.coolingDown()).toBe(false);
  });
});

// fetch is the one capability that leaves the machine, so an unguarded
// http://169.254.169.254/ would hand a prompt-injected planner the cloud
// metadata credentials. The blocklist runs before approval is even asked.
describe('HttpWebFetcher SSRF guard', () => {
  it.each([
    ['http://127.0.0.1/', 'loopback IPv4'],
    ['http://localhost/', 'localhost'],
    ['http://0.0.0.0/', '0.0.0.0'],
    ['http://[::1]/', 'loopback IPv6'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://192.168.1.1/', 'RFC1918 192.168'],
    ['http://10.0.0.1/', 'RFC1918 10'],
    ['http://172.16.0.1/', 'RFC1918 172.16/12'],
    // WHATWG URL re-serializes these in hex ([::ffff:a9fe:a9fe]), so a guard
    // that only string-matches the dotted form lets them through.
    ['http://[::ffff:169.254.169.254]/', 'IPv4-mapped metadata'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped loopback'],
    ['http://[::ffff:7f00:1]/', 'IPv4-mapped loopback, hex'],
    ['http://[64:ff9b::a9fe:a9fe]/', 'NAT64 metadata'],
  ])('refuses %s without consulting the approval channel', async (url) => {
    const request = vi.fn().mockResolvedValue(true);
    const fetchImpl = vi.fn();
    const fetcher = makeFetcher({ approval: { request }, fetchImpl });

    expect(await allowed(fetcher, url)).toBe(false);
    expect(request).not.toHaveBeenCalled();
    // A direct fetch must also fail rather than reach the network.
    const result = await fetcher.fetch(url);
    expect(result.success).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a non-HTTP(S) port', async () => {
    const request = vi.fn();
    const fetcher = makeFetcher({ approval: { request } });
    expect(await allowed(fetcher, 'https://internal.example:6379/')).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('HttpWebFetcher redirect handling', () => {
  // A 302 to a private IP would bypass the policy's origin check — the classic
  // SSRF-via-redirect — so a hop to another origin is decided like a new fetch.
  it('refuses a redirect to a blocked host even when the origin was approved', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url === 'https://api.example.com/x') {
        return response('', { status: 302, headers: { location: 'https://169.254.169.254/' } });
      }
      return response('ok');
    });
    const fetcher = makeFetcher({ approval: allow, fetchImpl });

    const result = await fetcher.fetch('https://api.example.com/x');

    expect(result.success).toBe(false);
    expect(result.output).toContain('link-local address 169.254.169.254');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // WHATWG URL serializes this as [::ffff:a9fe:a9fe]; a dotted-form string
  // match on the hop's hostname would have followed it to the metadata service.
  it('refuses a redirect to an IPv4-mapped IPv6 metadata address', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url === 'https://api.example.com/x') {
        return response('', { status: 302, headers: { location: 'https://[::ffff:169.254.169.254]/latest/meta-data/' } });
      }
      return response('credentials');
    });
    const fetcher = makeFetcher({ approval: allow, fetchImpl });

    const result = await fetcher.fetch('https://api.example.com/x');

    expect(result.success).toBe(false);
    expect(result.output).toContain('link-local address 169.254.169.254');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to a name with one private DNS answer among public ones', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url === 'https://api.example.com/x') {
        return response('', { status: 302, headers: { location: 'https://split.example/' } });
      }
      return response('internal');
    });
    const resolveHost = async (host: string) => (host === 'split.example' ? [PUBLIC_IP, '10.1.2.3'] : [PUBLIC_IP]);
    const fetcher = makeFetcher({ approval: allow, fetchImpl, resolveHost });

    const result = await fetcher.fetch('https://api.example.com/x');

    expect(result.success).toBe(false);
    expect(result.output).toContain('private address 10.1.2.3');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('follows a same-origin redirect to a public host', async () => {
    let first = true;
    const fetchImpl = vi.fn().mockImplementation(() => {
      if (first) { first = false; return response('', { status: 301, headers: { location: 'https://docs.rs/tokio/' } }); }
      return response('<p>page</p>');
    });
    const fetcher = makeFetcher({ approval: allow, fetchImpl });

    const result = await fetcher.fetch('https://docs.rs/tokio');

    expect(result.success).toBe(true);
    expect(result.output).toContain('page');
  });

  it('gives up after too many redirects', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => response('', { status: 302, headers: { location: 'https://docs.rs/loop' } }));
    const fetcher = makeFetcher({ approval: allow, fetchImpl });

    const result = await fetcher.fetch('https://docs.rs/tokio');

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/redirect/i);
  });

  // the policy rejects non-HTTP schemes up front, but a redirect hop only ever
  // re-checked the host blocklist — a 302 to `file:///etc/passwd` skipped the
  // scheme check entirely and would have been followed.
  it('refuses a redirect to a non-HTTP scheme', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url === 'https://api.example.com/x') {
        return response('', { status: 302, headers: { location: 'file:///etc/passwd' } });
      }
      return response('ok');
    });
    const fetcher = makeFetcher({ approval: allow, fetchImpl });

    const result = await fetcher.fetch('https://api.example.com/x');

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/scheme/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// The policy decided the first URL only; a hop to another origin is a new read
// and gets the same decision, or a redirect would launder an origin past it.
describe('HttpWebFetcher cross-origin redirects', () => {
  function redirecting(location: string) {
    return vi.fn().mockImplementation((url: string) => (url === 'https://docs.example.com/moved'
      ? response('', { status: 302, headers: { location } })
      : response('<p>elsewhere</p>')));
  }

  it('asks about the new origin in Guarded, and stops when it is declined', async () => {
    const request = vi.fn(async (req: ApprovalRequest) => req.scope === 'https://docs.example.com/*');
    const fetchImpl = redirecting('https://collect.example.net/page');
    const fetcher = makeFetcher({ approval: { request }, fetchImpl });

    const result = await fetcher.fetch('https://docs.example.com/moved');

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/redirect/i);
    expect(result.output).toContain('Fetch not approved: https://collect.example.net/*');
    expect(request.mock.calls.map(([req]) => req.scope)).toEqual(['https://docs.example.com/*', 'https://collect.example.net/*']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops at an excluded origin in Full', async () => {
    const approval = new ApprovalPolicy({
      mode: (kind) => effectiveApprovalMode('auto', true, kind),
      preApproved: ['!https://collect.example.net/*'],
      ask: async () => true,
    });
    const fetchImpl = redirecting('https://collect.example.net/page');
    const fetcher = makeFetcher({ approval, fetchImpl });

    const result = await fetcher.fetch('https://docs.example.com/moved');

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/excluded/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a downgrade from https to http, even on the same host', async () => {
    const request = vi.fn(async () => true);
    const fetchImpl = redirecting('http://docs.example.com/plain');
    const fetcher = makeFetcher({ approval: { request }, fetchImpl });

    const result = await fetcher.fetch('https://docs.example.com/moved');

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/https to plain http/);
    expect(request).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('counts a cross-origin hop against the budget', async () => {
    const fetchImpl = redirecting('https://elsewhere.example.net/page');
    const fetcher = new HttpWebFetcher({
      policy: new WebReadPolicy({ approval: allow, env: () => ({}), resolveHost: async () => [PUBLIC_IP], budget: () => 1 }),
      fetchImpl,
      resolveHost: async () => [PUBLIC_IP],
    });

    const result = await fetcher.fetch('https://docs.example.com/moved');

    expect(result.output).toMatch(/budget/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('lets a research subagent follow only to an origin already standing', async () => {
    const approval = new ApprovalPolicy({
      mode: (kind) => effectiveApprovalMode('auto', false, kind),
      preApproved: ['https://docs.example.com/*'],
      ask: async () => true,
    });
    const fetchImpl = redirecting('https://collect.example.net/page');
    const subagent = makeFetcher({ approval, fetchImpl }).forSubagent();

    const result = await subagent.fetch('https://docs.example.com/moved');

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/research agents/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('follows a hop to an origin the policy allows', async () => {
    const fetchImpl = redirecting('https://elsewhere.example.net/page');
    const fetcher = makeFetcher({ approval: allow, fetchImpl });

    const result = await fetcher.fetch('https://docs.example.com/moved');

    expect(result.output).toContain('elsewhere');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('HttpWebFetcher connection pinning', () => {
  // The policy vets the name, then the transport resolves it again to connect.
  // A rebinding DNS server answers public for the first lookup and private for
  // the second, so the connect-time lookup must be vetted too.
  it('refuses a host that rebinds to a private address between check and connect', async () => {
    const resolveHost = vi.fn()
      .mockResolvedValueOnce([PUBLIC_IP])
      .mockResolvedValue(['169.254.169.254']);
    const fetcher = makeFetcher({ approval: allow, resolveHost, timeoutMs: 2_000 });

    const result = await fetcher.fetch('http://rebind.example/latest/meta-data/');

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/blocked/i);
    expect(result.output).toContain('link-local');
    expect(resolveHost).toHaveBeenCalledTimes(2);
  });
});

// A name is resolved only after the approval (a lookup is itself a request),
// so these are refused after the person said yes, never before.
describe('HttpWebFetcher multi-answer DNS', () => {
  it('refuses a name when any one of its DNS answers is private', async () => {
    const fetchImpl = vi.fn();
    const fetcher = makeFetcher({ approval: allow, fetchImpl, resolveHost: async () => [PUBLIC_IP, '2606:4700::1', 'fd00::5'] });

    expect(await allowed(fetcher, 'https://split.example/')).toBe(false);
    expect((await fetcher.fetch('https://split.example/')).output).toMatch(/unique-local/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('HttpWebFetcher isBlockedHost null-address guard', () => {
  // dns.lookup('') resolves rather than rejecting, with address: null (Node
  // treats an empty hostname as loopback-ish but doesn't throw) — isPrivateIp
  // must fail closed on that instead of every regex quietly missing `null`.
  it('blocks a host that resolves to a null address', async () => {
    const fetcher = makeFetcher({ approval: allow, resolveHost: async () => [null as unknown as string] });

    expect(await allowed(fetcher, 'https://weird-host.example/')).toBe(false);
  });
});

describe('HttpWebFetcher body byte cap', () => {
  it('caps an oversized stream and reports truncation rather than OOMing', async () => {
    // A streaming body larger than the byte ceiling must stop reading and mark
    // the result truncated, mirroring the exec-buffer cap the ADR fixed for
    // search — not buffer the whole thing and crash the planner.
    const huge = 'x'.repeat(2_500_000);
    const stream = (async function* () { yield Buffer.from(huge); })();
    const fetchImpl = vi.fn().mockImplementation(() => ({
      ok: true, status: 200,
      headers: { get: () => 'text/plain' },
      body: stream,
    } as unknown as Response));
    const fetcher = makeFetcher({ approval: allow, fetchImpl, maxChars: 100 });

    const result = await fetcher.fetch('https://docs.rs/tokio');

    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThan(2000);
  });
});

// 64 MB of zeros, compressed to a few tens of kilobytes.
const BOMB = gzipSync(Buffer.alloc(64 * 1024 * 1024));

// The guard refuses loopback by design, so the transport is exercised here with
// a stand-in lookup that sends every name to a local server; the vetting
// lookup itself is covered by the connection-pinning test above.
describe('pinnedTransport', () => {
  let server: Server;
  let port: number;
  const seen: { method?: string; url?: string; headers: IncomingHttpHeaders }[] = [];
  const lookedUp: string[] = [];
  const toLocalServer: LookupFunction = (hostname, options, callback) => {
    lookedUp.push(hostname);
    if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  };
  const init = () => ({
    signal: new AbortController().signal,
    headers: { 'user-agent': 'ua-under-test', accept: 'text/html' },
    redirect: 'manual' as const,
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      if (req.url === '/gzip' || req.url === '/br') {
        const text = `compressed page (${req.url.slice(1)})`;
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': req.url === '/gzip' ? 'gzip' : 'br' });
        res.end(req.url === '/gzip' ? gzipSync(text) : brotliCompressSync(text));
        return;
      }
      if (req.url === '/drip') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        const drip = setInterval(() => res.write('.'), 20);
        res.on('close', () => clearInterval(drip));
        return;
      }
      if (req.url === '/bomb') {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
        res.end(BOMB);
        return;
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://elsewhere.example/' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello from the pinned socket');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));

  it('connects through the given lookup and sends a plain GET with only the given headers', async () => {
    const res = await pinnedTransport(toLocalServer)(`http://user:secret@docs.example:${port}/page?q=1`, init());

    expect(res.ok).toBe(true);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    expect(await res.text()).toBe('hello from the pinned socket');
    expect(lookedUp).toContain('docs.example');
    const req = seen[seen.length - 1];
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/page?q=1');
    expect(req.headers['user-agent']).toBe('ua-under-test');
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers.cookie).toBeUndefined();
  });

  // The platform fetch advertised and decoded compression transparently, and
  // some hosts (the search endpoint among them) challenge clients that don't.
  it.each([['gzip'], ['br']])('advertises compression and decodes a %s body', async (encoding) => {
    const res = await pinnedTransport(toLocalServer)(`http://docs.example:${port}/${encoding}`, init());

    expect(await res.text()).toBe(`compressed page (${encoding})`);
    expect(seen[seen.length - 1].headers['accept-encoding']).toContain(encoding);
  });

  it('hands a redirect back to the caller instead of following it', async () => {
    const res = await pinnedTransport(toLocalServer)(`http://docs.example:${port}/redirect`, init());

    expect(res.status).toBe(302);
    expect(res.ok).toBe(false);
    expect(res.headers.get('location')).toBe('http://elsewhere.example/');
    expect(seen.filter((r) => r.url === '/redirect')).toHaveLength(1);
  });

  // The policy is stubbed here: the test server's port is not one the guard allows.
  const throughPinned = (opts: Partial<HttpWebFetcherOptions> = {}) => new HttpWebFetcher({
    policy: { decide: async () => ({ allowed: true }) },
    fetchImpl: pinnedTransport(toLocalServer),
    ...opts,
  });

  it('gives up on a body that trickles in past the timeout', async () => {
    const started = Date.now();
    const result = await throughPinned({ timeoutMs: 300 }).fetch(`http://docs.example:${port}/drip`);

    expect(result.success).toBe(false);
    expect(result.output).toContain('timed out');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('caps a gzip bomb at the byte limit while decoding it', async () => {
    const result = await throughPinned({ maxChars: 100 }).fetch(`http://docs.example:${port}/bomb`);

    expect(result.success).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.output).toContain('total 2000000+, body was byte-capped');
  });

  it('rejects with the lookup error when the lookup refuses the host', async () => {
    const refuse: LookupFunction = (_hostname, _options, callback) => callback(new Error('blocked host: test'), []);

    await expect(pinnedTransport(refuse)(`http://docs.example:${port}/`, init())).rejects.toThrow('blocked host');
  });
});
