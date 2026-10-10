import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OrdewellMcpServer, mcpClientConfig } from '../mcp';
import { plannerToolHandler, type PlannerToolsHost } from '../plannerTools';
import { ApprovalPolicy, effectiveApprovalMode, type ApprovalModeSetting } from '../ApprovalPolicy';
import { WebReadPolicy } from '../webReadPolicy';
import { HttpWebFetcher, type WebResponse, type WebTransport } from '../HttpWebFetcher';
import type { ApprovalRequest } from '../../interfaces/IApproval';
import { decidePlannerPermission } from '../harness/plannerPermissions';
import { openCodePlannerAsk } from '../harness/openCodeTransport';

const PUBLIC_IP = '93.184.215.14';
const SEARCH_PAGE = `<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fhono.dev%2Fdocs&amp;rut=abc" class='result-link'>Hono docs</a><table><tr><td class='result-snippet'>Routing</td></tr></table>`;

const servers: OrdewellMcpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(servers.splice(0).map((s) => s.dispose()));
});

interface Setup {
  setting?: ApprovalModeSetting;
  autonomous?: boolean;
  /** The person's answer; absent means there is nobody to ask. */
  answer?: boolean;
}

/** A planner's MCP client whose `fetch` and `web_search` reach the session's real fetcher and policy, over a fake network. */
async function plannerClient({ setting = 'auto', autonomous = false, answer }: Setup) {
  const ask = vi.fn(async (_req: ApprovalRequest) => answer ?? false);
  const approval = new ApprovalPolicy({
    mode: (kind) => effectiveApprovalMode(setting, autonomous, kind),
    ...(answer === undefined ? {} : { ask }),
  });
  const transport = vi.fn<WebTransport>(async (url): Promise<WebResponse> => ({
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name === 'content-type' ? 'text/html' : null) },
    body: null,
    text: async () => (url.includes('duckduckgo') ? SEARCH_PAGE : '<p>Migration guide</p>'),
  }));
  const resolveHost = async () => [PUBLIC_IP];
  const fetcher = new HttpWebFetcher({ policy: new WebReadPolicy({ approval, env: () => ({}), resolveHost }), fetchImpl: transport, resolveHost });
  const host: Pick<PlannerToolsHost, 'fetchUrl' | 'webSearch'> = {
    fetchUrl: (url) => fetcher.fetch(url),
    webSearch: (query) => fetcher.search(query),
  };

  const server = new OrdewellMcpServer();
  servers.push(server);
  const config = mcpClientConfig(await server.issuePlannerToken({ sessionId: 's1' }, plannerToolHandler(host as PlannerToolsHost)));
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
  clients.push(client);
  return { client, ask, transport };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.map((part: { type?: string; text?: string }) => (part.type === 'text' ? part.text ?? '' : '')).join('');
}

describe('the planner MCP tools fetch and web_search (ADR-0027)', () => {
  it('read without asking in Full', async () => {
    const { client, ask, transport } = await plannerClient({ autonomous: true, answer: true });

    const page = await client.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/migrate' } });
    const found = await client.callTool({ name: 'web_search', arguments: { query: 'hono routing' } });

    expect(page.isError).toBe(false);
    expect(textOf(page)).toContain('Migration guide');
    expect(found.isError).toBe(false);
    expect(textOf(found)).toContain('https://hono.dev/docs');
    expect(ask).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('ask in Guarded, and read once granted', async () => {
    const { client, ask } = await plannerClient({ answer: true });

    const page = await client.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/migrate' } });
    const found = await client.callTool({ name: 'web_search', arguments: { query: 'hono routing' } });

    expect(page.isError).toBe(false);
    expect(found.isError).toBe(false);
    expect(ask.mock.calls.map(([req]) => req.kind)).toEqual(['url_fetch', 'web_search']);
  });

  it('are refused in Guarded with nobody to ask, and say why', async () => {
    const { client, transport } = await plannerClient({});

    const page = await client.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/migrate' } });
    const found = await client.callTool({ name: 'web_search', arguments: { query: 'hono routing' } });

    expect(page.isError).toBe(true);
    expect(textOf(page)).toMatch(/^Fetch not approved: https:\/\/docs\.example\.com\/\*/);
    expect(found.isError).toBe(true);
    expect(textOf(found)).toMatch(/^Web search not approved/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('are refused in Full when the mode is explicitly allowlist', async () => {
    const { client, transport } = await plannerClient({ setting: 'deny', autonomous: true, answer: true });

    expect((await client.callTool({ name: 'fetch', arguments: { url: 'https://docs.example.com/migrate' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'web_search', arguments: { query: 'hono routing' } })).isError).toBe(true);
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuse a private address, whatever the mode allows', async () => {
    const { client, transport } = await plannerClient({ setting: 'allow', answer: true });

    const result = await client.callTool({ name: 'fetch', arguments: { url: 'http://169.254.169.254/latest/meta-data/' } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Fetch refused:/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuse an empty query before it reaches the policy', async () => {
    const { client, ask } = await plannerClient({ answer: true });

    const result = await client.callTool({ name: 'web_search', arguments: { query: '   ' } });

    expect(result.isError).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('describe themselves as fallbacks for a built-in tool, and promise no pause', async () => {
    const { client } = await plannerClient({});

    const tools = (await client.listTools()).tools.filter((t) => t.name === 'fetch' || t.name === 'web_search');

    expect(tools).toHaveLength(2);
    for (const tool of tools) {
      expect(tool.description).toMatch(/fallback: if you have a built-in web (fetch|search) tool, use that instead/i);
      expect(tool.description).not.toMatch(/wait|pause/i);
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });
});

// OpenCode's own search stays native; the policy decides it as a search (ADR-0027).
describe('a runner\'s own search, asked as kind search', () => {
  function gate(setting: ApprovalModeSetting, autonomous: boolean, answer?: boolean) {
    const ask = vi.fn(async (_req: ApprovalRequest) => answer ?? false);
    const approval = new ApprovalPolicy({ mode: (kind) => effectiveApprovalMode(setting, autonomous, kind), ...(answer === undefined ? {} : { ask }) });
    const fetcher = new HttpWebFetcher({ policy: new WebReadPolicy({ approval, env: () => ({}) }) });
    return { ask, gate: { approval, fetcher, workspaceRoot: '/repo' } };
  }
  const websearch = openCodePlannerAsk('websearch', { metadata: { query: 'hono routing' } }, []);

  it('is allowed in Full without asking', async () => {
    const { ask, gate: g } = gate('auto', true, true);
    expect(await decidePlannerPermission(websearch, {}, g)).toEqual({ decision: 'allow' });
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks in Guarded once per session, naming the third party that receives the query', async () => {
    const { ask, gate: g } = gate('auto', false, true);
    expect(await decidePlannerPermission(websearch, {}, g)).toEqual({ decision: 'allow' });
    expect(await decidePlannerPermission(openCodePlannerAsk('codesearch', { metadata: { query: 'zod refine' } }, []), {}, g)).toEqual({ decision: 'allow' });

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatchObject({ kind: 'web_search', subject: 'hono routing', scope: 'web_search:opencode', detail: expect.stringContaining('Exa') });
  });

  it('is denied with the policy\'s reason under an explicit allowlist, and when the query carries a secret', async () => {
    const { gate: allowlist } = gate('deny', true, true);
    expect(await decidePlannerPermission(websearch, {}, allowlist)).toEqual({ decision: 'deny', note: expect.stringMatching(/^Web search not approved/) });

    const { ask, gate: full } = gate('auto', true, true);
    const leaky = openCodePlannerAsk('websearch', { metadata: { query: 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' } }, []);
    expect(await decidePlannerPermission(leaky, {}, full)).toEqual({ decision: 'deny', note: expect.stringMatching(/^Web search refused: the query contains what looks like a secret/) });
    expect(ask).not.toHaveBeenCalled();
  });
});
