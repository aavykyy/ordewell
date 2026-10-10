import { describe, it, expect, vi } from 'vitest';
import { ApprovalPolicy, effectiveApprovalMode, type ApprovalModeSetting } from '../ApprovalPolicy';
import { WebReadPolicy, type WebReadPolicyOptions } from '../webReadPolicy';
import type { ApprovalRequest } from '../../interfaces/IApproval';

const PUBLIC_IP = '93.184.215.14';

interface Setup {
  setting?: ApprovalModeSetting;
  autonomous?: boolean;
  allow?: string[];
  answer?: boolean;
  policy?: Partial<WebReadPolicyOptions>;
}

function setup({ setting = 'auto', autonomous = false, allow = [], answer = true, policy = {} }: Setup = {}) {
  const ask = vi.fn(async (_req: ApprovalRequest) => answer);
  const decisions: { req: ApprovalRequest; granted: boolean; source: string }[] = [];
  const approval = new ApprovalPolicy({
    mode: (kind) => effectiveApprovalMode(setting, autonomous, kind),
    preApproved: allow,
    ask,
    onDecision: (req, granted, source) => decisions.push({ req, granted, source }),
  });
  const reads = new WebReadPolicy({ approval, env: () => ({}), resolveHost: async () => [PUBLIC_IP], ...policy });
  return { reads, ask, decisions };
}

describe('WebReadPolicy in Full', () => {
  it('allows a public fetch under auto without asking anyone', async () => {
    const { reads, ask } = setup({ autonomous: true });

    const decision = await reads.decide({ kind: 'fetch', url: 'https://docs.example.com/guide' });

    expect(decision).toEqual({ allowed: true });
    expect(ask).not.toHaveBeenCalled();
  });

  it('refuses a fetch when the mode is explicitly allowlist, and says why', async () => {
    const { reads, ask } = setup({ setting: 'deny', autonomous: true });

    const decision = await reads.decide({ kind: 'fetch', url: 'https://docs.example.com/guide' });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toMatch(/allowlist/);
    expect(ask).not.toHaveBeenCalled();
  });

  it('lets an exclusion win over Full', async () => {
    const { reads } = setup({ autonomous: true, allow: ['!https://*.internal.example/*'] });

    const decision = await reads.decide({ kind: 'fetch', url: 'https://wiki.internal.example/page' });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toMatch(/excluded/);
  });

  it('lets an exclusion win over an allow rule and over allow mode', async () => {
    const { reads } = setup({ setting: 'allow', allow: ['https://*.internal.example/*', '!https://*.internal.example/*'] });

    expect((await reads.decide({ kind: 'fetch', url: 'https://wiki.internal.example/page' })).allowed).toBe(false);
  });
});

describe('WebReadPolicy in Guarded', () => {
  it('asks once per origin', async () => {
    const { reads, ask } = setup();

    expect((await reads.decide({ kind: 'fetch', url: 'https://docs.example.com/a' })).allowed).toBe(true);
    expect((await reads.decide({ kind: 'fetch', url: 'https://docs.example.com/b?page=2' })).allowed).toBe(true);
    expect((await reads.decide({ kind: 'fetch', url: 'https://other.example.org/' })).allowed).toBe(true);

    expect(ask.mock.calls.map(([req]) => req.scope)).toEqual(['https://docs.example.com/*', 'https://other.example.org/*']);
  });

  it('asks once per session for search, scoped to the provider', async () => {
    const { reads, ask } = setup();

    expect((await reads.decide({ kind: 'search', query: 'tokio changelog', provider: 'duckduckgo' })).allowed).toBe(true);
    expect((await reads.decide({ kind: 'search', query: 'serde derive', provider: 'duckduckgo' })).allowed).toBe(true);

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatchObject({ kind: 'web_search', subject: 'tokio changelog', scope: 'web_search:duckduckgo' });
  });

  it('lets an allowlisted origin run without asking', async () => {
    const { reads, ask } = setup({ allow: ['https://docs.example.com/*'] });

    expect((await reads.decide({ kind: 'fetch', url: 'https://docs.example.com/a' })).allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('refuses a search the user declined', async () => {
    const { reads } = setup({ answer: false });

    const decision = await reads.decide({ kind: 'search', query: 'tokio', provider: 'duckduckgo' });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toMatch(/not approved/);
  });
});

describe('WebReadPolicy search under allowlist mode', () => {
  it('refuses a search in Full when the mode is explicitly allowlist', async () => {
    const { reads, ask } = setup({ setting: 'deny', autonomous: true });

    expect((await reads.decide({ kind: 'search', query: 'tokio', provider: 'duckduckgo' })).allowed).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it('allows a search in Full under auto', async () => {
    const { reads, ask } = setup({ autonomous: true });

    expect((await reads.decide({ kind: 'search', query: 'tokio', provider: 'duckduckgo' })).allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('WebReadPolicy egress guard', () => {
  const modes: Setup[] = [
    { autonomous: true },
    { autonomous: false },
    { setting: 'allow' },
    { setting: 'ask' },
    { setting: 'deny', allow: ['http://169.254.169.254/*', 'http://[::ffff:a9fe:a9fe]/*'] },
  ];

  it.each(modes)('refuses a private or metadata host without asking (%o)', async (mode) => {
    const { reads, ask } = setup(mode);

    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://[::ffff:a9fe:a9fe]/', 'http://localhost:8080/', 'http://10.0.0.5/']) {
      const decision = await reads.decide({ kind: 'fetch', url });
      expect(decision.allowed, url).toBe(false);
    }
    expect(ask).not.toHaveBeenCalled();
  });

  it('refuses a name that resolves to a private address', async () => {
    const { reads } = setup({ autonomous: true, policy: { resolveHost: async () => [PUBLIC_IP, '192.168.1.10'] } });

    const decision = await reads.decide({ kind: 'fetch', url: 'https://rebind.example.com/' });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toMatch(/private/);
  });

  it('refuses a non-web scheme', async () => {
    const { reads } = setup({ setting: 'allow' });

    expect((await reads.decide({ kind: 'fetch', url: 'file:///etc/passwd' })).allowed).toBe(false);
  });
});

describe('WebReadPolicy secret check', () => {
  const HELD = 'or-held-Zq81vXk2mPw9';
  const ENV_VALUE = 'envSecret-77Hq2LmN';

  function guarded() {
    return setup({
      autonomous: true,
      policy: { secrets: () => [HELD], env: () => ({ MY_SERVICE_TOKEN: ENV_VALUE, HOME: '/home/someone-long', SHORT_KEY: 'abc' }) },
    });
  }

  async function refused(read: Parameters<WebReadPolicy['decide']>[0]): Promise<string> {
    const { reads, ask } = guarded();
    const decision = await reads.decide(read);
    expect(decision.allowed).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    return decision.allowed ? '' : decision.reason;
  }

  it('refuses a held secret in the query, and does not echo it', async () => {
    const reason = await refused({ kind: 'fetch', url: `https://collect.example.com/log?k=${HELD}` });
    expect(reason).toMatch(/secret/);
    expect(reason).not.toContain(HELD);
    expect(reason).not.toContain('collect.example.com/log?');
  });

  it('refuses a held secret percent-encoded in the path', async () => {
    const encoded = [...HELD].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
    await refused({ kind: 'fetch', url: `https://collect.example.com/${encoded}/x` });
  });

  it('refuses a held secret double-encoded in the query', async () => {
    await refused({ kind: 'fetch', url: `https://collect.example.com/?q=${encodeURIComponent(encodeURIComponent(`k=${HELD}`))}` });
  });

  it('refuses the value of a sensitive environment variable', async () => {
    await refused({ kind: 'fetch', url: `https://collect.example.com/a/${ENV_VALUE}` });
  });

  it('refuses a held secret in a search query', async () => {
    const reason = await refused({ kind: 'search', query: `what is ${HELD}`, provider: 'duckduckgo' });
    expect(reason).not.toContain(HELD);
  });

  it.each([
    ['a GitHub token', 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'],
    ['a fine-grained GitHub token', 'github_pat_' + '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'],
    ['an OpenAI-style key', 'sk-' + 'proj-Ab3dEf6hIj9kLm2nOp5qRs8t'],
    ['an AWS access key id', 'AKIA' + 'IOSFODNN7EXAMPLE'],
    ['a Slack token', 'xoxb-' + '123456789012-abcdefABCDEF'],
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ])('refuses %s in a URL', async (_label, token) => {
    const reason = await refused({ kind: 'fetch', url: `https://collect.example.com/?t=${encodeURIComponent(token)}` });
    expect(reason).not.toContain(token);
  });

  it('refuses a PEM header in a search query', async () => {
    await refused({ kind: 'search', query: '-----BEGIN RSA PRIVATE KEY----- MIIEowIBAAKCAQEA', provider: 'duckduckgo' });
  });

  it('allows ordinary URLs that only look a little like token prefixes', async () => {
    const { reads } = guarded();
    for (const url of [
      'https://scikit-learn.org/stable/sk-learn-documentation-for-beginners',
      'https://example.com/task-runner-abcdefghijklmnopqrstuv',
      'https://docs.example.com/home/someone-long',
    ]) {
      expect((await reads.decide({ kind: 'fetch', url })).allowed, url).toBe(true);
    }
  });
});

describe('WebReadPolicy budget', () => {
  it('refuses reads past the budget with a note the planner can report', async () => {
    const { reads } = setup({ autonomous: true, policy: { budget: () => 2 } });

    expect((await reads.decide({ kind: 'fetch', url: 'https://a.example.com/' })).allowed).toBe(true);
    expect((await reads.decide({ kind: 'search', query: 'tokio', provider: 'duckduckgo' })).allowed).toBe(true);
    const over = await reads.decide({ kind: 'fetch', url: 'https://b.example.com/' });

    expect(over.allowed).toBe(false);
    expect(over.allowed === false && over.reason).toMatch(/budget/);
  });

  it('holds the cap when reads arrive in parallel', async () => {
    const { reads } = setup({ autonomous: true, policy: { budget: () => 2 } });

    const decisions = await Promise.all([1, 2, 3, 4].map((i) => reads.decide({ kind: 'fetch', url: `https://a.example.com/${i}` })));

    expect(decisions.filter((d) => d.allowed)).toHaveLength(2);
  });

  it('does not spend the budget on reads that were refused', async () => {
    const { reads } = setup({ setting: 'ask', answer: false, policy: { budget: () => 1 } });

    await reads.decide({ kind: 'fetch', url: 'http://127.0.0.1/' });
    await reads.decide({ kind: 'fetch', url: 'https://declined.example.com/' });

    const decision = await reads.decide({ kind: 'fetch', url: 'https://other.example.com/' });
    expect(decision.allowed === false && decision.reason).toMatch(/not approved/);
  });

  it('starts a new budget with each planner turn', async () => {
    let turn = 't1';
    const { reads } = setup({ autonomous: true, policy: { budget: () => 1, turn: () => turn } });

    expect((await reads.decide({ kind: 'fetch', url: 'https://a.example.com/' })).allowed).toBe(true);
    expect((await reads.decide({ kind: 'fetch', url: 'https://a.example.com/2' })).allowed).toBe(false);
    turn = 't2';
    expect((await reads.decide({ kind: 'fetch', url: 'https://a.example.com/3' })).allowed).toBe(true);
  });
});

describe('WebReadPolicy record', () => {
  it('records every decision, refusals before the approval included, with why', async () => {
    const HELD = 'or-held-Zq81vXk2mPw9';
    const { reads, decisions } = setup({
      autonomous: true,
      allow: ['!https://internal.example.com/*'],
      policy: { secrets: () => [HELD], budget: () => 1 },
    });

    await reads.decide({ kind: 'fetch', url: 'https://docs.example.com/' });
    await reads.decide({ kind: 'fetch', url: 'https://internal.example.com/' });
    await reads.decide({ kind: 'fetch', url: 'http://169.254.169.254/' });
    await reads.decide({ kind: 'fetch', url: `https://${HELD}.collect.example.com/` });
    await reads.decide({ kind: 'search', query: 'tokio', provider: 'duckduckgo' });

    expect(decisions.map((d) => [d.req.kind, d.granted, d.source])).toEqual([
      ['url_fetch', true, 'mode'],
      ['url_fetch', false, 'excluded'],
      ['url_fetch', false, 'guard'],
      ['url_fetch', false, 'secret'],
      ['web_search', false, 'budget'],
    ]);
    expect(JSON.stringify(decisions[3].req)).not.toContain(HELD);
  });

  it('withholds a secret even from a URL that does not parse', async () => {
    const HELD = 'or-held-Zq81vXk2mPw9';
    const { reads, decisions } = setup({ autonomous: true, policy: { secrets: () => [HELD] } });

    const decision = await reads.decide({ kind: 'fetch', url: `https://exa mple.com:99999/${HELD}` });

    expect(decision.allowed).toBe(false);
    expect(decisions).toEqual([expect.objectContaining({ granted: false, source: 'secret' })]);
    expect(JSON.stringify(decisions)).not.toContain(HELD);
  });
});
