import { describe, it, expect, vi } from 'vitest';
import { HttpWebFetcher } from '../HttpWebFetcher';
import { WebReadPolicy } from '../webReadPolicy';
import { ApprovalPolicy, effectiveApprovalMode, type ApprovalModeSetting } from '../ApprovalPolicy';

const PUBLIC_IP = '93.184.215.14';

const RESULTS = `
  <html><body>
    <a class="result__a" href="https://hono.dev/docs/routing">Hono Routing</a>
  </body></html>`;

function response(body: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => body,
    body: null,
  } as unknown as Response;
}

interface Setup {
  setting?: ApprovalModeSetting;
  autonomous?: boolean;
  allow?: string[];
  answer?: boolean;
  fetchImpl?: () => Promise<Response>;
}

function makeFetcher({ setting = 'auto', autonomous = false, allow = [], answer = true, fetchImpl = async () => response('<p>page</p>') }: Setup = {}) {
  const ask = vi.fn(async () => answer);
  const approval = new ApprovalPolicy({
    mode: (kind) => effectiveApprovalMode(setting, autonomous, kind),
    preApproved: allow,
    ask,
  });
  const resolveHost = async () => [PUBLIC_IP];
  const fetcher = new HttpWebFetcher({
    policy: new WebReadPolicy({ approval, env: () => ({}), resolveHost }),
    fetchImpl: fetchImpl as never,
    resolveHost,
  });
  return { fetcher, ask };
}

describe('research subagent web reads', () => {
  it('lets a Full subagent read as the planner would, without asking', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response('<p>page</p>'));
    const { fetcher, ask } = makeFetcher({ autonomous: true, fetchImpl });

    const result = await fetcher.forSubagent().fetch('https://docs.example.com/a');

    expect(result.success).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('refuses a Guarded subagent an ungranted origin without asking, and names the digest', async () => {
    const fetchImpl = vi.fn();
    const { fetcher, ask } = makeFetcher({ fetchImpl });

    const result = await fetcher.forSubagent().fetch('https://docs.example.com/a');

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/digest/);
    expect(ask).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lets a Guarded subagent read an origin the session already granted', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response('<p>page</p>'));
    const { fetcher, ask } = makeFetcher({ fetchImpl });

    // The planner reads the origin once, so the grant is standing.
    await fetcher.decide({ kind: 'fetch', url: 'https://docs.example.com/a' });
    expect(ask).toHaveBeenCalledTimes(1);

    const result = await fetcher.forSubagent().fetch('https://docs.example.com/b');

    expect(result.success).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1); // the subagent never raised a prompt
  });

  it('lets a Guarded subagent read an allowlisted origin without asking', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response('<p>page</p>'));
    const { fetcher, ask } = makeFetcher({ allow: ['https://docs.example.com/*'], fetchImpl });

    const result = await fetcher.forSubagent().fetch('https://docs.example.com/a');

    expect(result.success).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('gates subagent search the same way: refused until the session grants it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(RESULTS));
    const { fetcher, ask } = makeFetcher({ fetchImpl });
    const sub = fetcher.forSubagent();

    const denied = await sub.search!('hono');
    expect(denied.success).toBe(false);
    expect(denied.output).toMatch(/digest/);
    expect(ask).not.toHaveBeenCalled();

    await fetcher.search('hono');
    expect(ask).toHaveBeenCalledTimes(1);

    const allowed = await sub.search!('hono');
    expect(allowed.success).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
