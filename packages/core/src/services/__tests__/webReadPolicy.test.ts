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
  it('turns web reads off with search and both scheme exclusions for every origin', async () => {
    for (const mode of [{}, { autonomous: true }, { setting: 'allow' as const }, { setting: 'ask' as const }, { setting: 'deny' as const }]) {
      const { reads, ask, decisions } = setup({ ...mode, allow: ['!web_search:*', '!https://*', '!http://*'] });
      for (const url of [
        'https://docs.example.com/a', 'http://docs.example.com/',
        'https://docs.example.com:80/a', 'http://93.184.215.14:443/',
        'https://[2606:4700:4700::1111]/', 'https://bücher.example/',
      ]) expect(await reads.decide({ kind: 'fetch', url })).toMatchObject({ allowed: false, reason: expect.stringContaining('excluded') });
      for (const provider of ['duckduckgo', 'openai', 'opencode', 'anthropic']) {
        expect(await reads.decide({ kind: 'search', query: 'tokio', provider })).toMatchObject({ allowed: false, reason: expect.stringContaining('excluded') });
        expect(reads.searchesUnasked(provider)).toBe(false);
      }
      expect(ask).not.toHaveBeenCalled();
      expect(decisions).toHaveLength(10);
      expect(decisions.every((d) => !d.granted && d.source === 'excluded')).toBe(true);
    }
  });

  it('honours exact and wildcard search exclusions in every mode, including native search', async () => {
    for (const mode of [{}, { autonomous: true }, { setting: 'allow' as const }, { setting: 'ask' as const }, { setting: 'deny' as const }]) {
      for (const exclusion of ['!web_search:duckduckgo', '!web_search:*']) {
        const { reads, ask, decisions } = setup({ ...mode, allow: ['web_search:*', exclusion] });
        expect(await reads.decide({ kind: 'search', query: 'tokio', provider: 'duckduckgo' })).toMatchObject({ allowed: false });
        expect(reads.searchesUnasked('duckduckgo')).toBe(false);
        expect(reads.searchesUnasked('openai')).toBe(exclusion === '!web_search:duckduckgo');
        expect(ask).not.toHaveBeenCalled();
        expect(decisions).toEqual([expect.objectContaining({ granted: false, source: 'excluded' })]);
      }
    }
  });

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
    // The prompt names the backend and says a third party receives the query.
    expect(ask.mock.calls[0][0].detail).toMatch(/duckduckgo/i);
    expect(ask.mock.calls[0][0].detail).toMatch(/third party/i);
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
  it('withholds Google, GitLab, Stripe, Hugging Face and npm token shapes without an environment value', async () => {
    // Assembled at runtime so GitHub push protection doesn't flag the source as holding live keys.
    const tokens = [
      ['AIza', 'SyB7nQ2xR9mP4vK8tW6cH1zL5dF0gA3sE7uV'],
      ['glpat-', 'B7nQ2xR9mP4vK8tW6cH1'],
      ['sk_live_', 'B7nQ2xR9mP4vK8tW6cH1zL5dF'],
      ['rk_live_', 'B7nQ2xR9mP4vK8tW6cH1zL5dF'],
      ['hf_', 'B7nQ2xR9mP4vK8tW6cH1zL5dF0gA3sE'],
      ['npm_', 'B7nQ2xR9mP4vK8tW6cH1zL5dF0gA3sE'],
    ].map(([prefix, body]) => prefix + body);
    for (const token of tokens) {
      const { reads, ask, decisions } = setup({ autonomous: true });
      const encoded = token.replace(/./g, (char) => `%${char.charCodeAt(0).toString(16)}`);
      for (const read of [
        { kind: 'search' as const, query: `help with ${token}`, provider: 'duckduckgo' },
        { kind: 'search' as const, query: encoded, provider: 'duckduckgo' },
        { kind: 'fetch' as const, url: `https://docs.example.com/?key=${encoded}` },
      ]) expect(await reads.decide(read)).toMatchObject({ allowed: false, reason: expect.stringContaining('secret') });
      expect(ask).not.toHaveBeenCalled();
      expect(JSON.stringify(decisions)).not.toContain(token);
      expect(JSON.stringify(decisions)).not.toContain(encoded);
      expect(decisions.map((d) => d.source)).toEqual(['secret', 'secret', 'secret']);
    }
  });

  it('does not treat named URL and credential file references as secret values', async () => {
    const env = {
      KEYCLOAK_URL: 'https://keycloak.example.com',
      AZURE_KEY_VAULT_URL: 'https://vault.example.com',
      API_KEY_URL: 'https://keys.example.com',
      SERVICE_TOKEN_FILE: '/home/user/credentials/token.txt',
      PRIVATE_KEY_FILE: 'C:\\Users\\user\\credentials\\private.key',
      SECRET_FILE: '~/credentials/service.json',
      CREDENTIAL_FILE: './credentials/service.json',
      PASSWORD_FILE: '../credentials/password.txt',
      ACCESS_KEY_FILE: '\\\\server\\credentials\\private.key',
      GOOGLE_CREDENTIAL_URI: 'file:///home/user/credentials/service.json',
    };
    const { reads } = setup({ autonomous: true, policy: { env: () => env } });
    for (const url of ['https://keycloak.example.com/', 'https://vault.example.com/', 'https://keys.example.com/']) {
      expect(await reads.decide({ kind: 'fetch', url })).toEqual({ allowed: true });
    }
    for (const value of Object.values(env)) {
      expect(await reads.decide({ kind: 'search', query: `how to configure ${value}`, provider: 'duckduckgo' })).toEqual({ allowed: true });
    }
  });

  it('uses credential words at underscore boundaries, rather than substrings in environment names', async () => {
    const credential = 'private-value-8Hd3nZp7Qr';
    const ordinary = 'docs.example.com';
    for (const name of ['KEY', 'API_KEY', 'SERVICE_TOKEN', 'CLIENT_SECRET', 'DB_PASSWORD', 'SERVICE_CREDENTIAL', 'ACCESS_KEY_ID']) {
      const { reads, decisions } = setup({ autonomous: true, policy: { env: () => ({ [name]: credential }) } });
      expect(await reads.decide({ kind: 'search', query: credential, provider: 'duckduckgo' })).toMatchObject({ allowed: false });
      expect(JSON.stringify(decisions)).not.toContain(credential);
    }
    for (const name of ['KEYCLOAK_URL', 'MONKEY', 'TOKENIZER', 'SECRETARY', 'PASSWORDLESS']) {
      const { reads } = setup({ autonomous: true, policy: { env: () => ({ [name]: ordinary }) } });
      expect(await reads.decide({ kind: 'fetch', url: 'https://docs.example.com/' })).toEqual({ allowed: true });
    }
  });

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
  it('records the actual subagent refusal and reports a gap only the planner can resolve', async () => {
    for (const kind of ['fetch', 'search'] as const) {
      const read = kind === 'fetch'
        ? { kind, url: 'https://docs.example.com/' }
        : { kind, query: 'tokio', provider: 'duckduckgo' };
      const mode = setup({ setting: 'deny', policy: { budget: () => 1 } });
      const remembered = setup({ answer: false, policy: { budget: () => 1 } });
      const missing = setup({ policy: { budget: () => 1 } });
      await remembered.reads.decide(read);
      remembered.decisions.length = 0;
      remembered.ask.mockClear();
      for (const [given, source, reason] of [[mode, 'mode', /allowlist mode/], [remembered, 'remembered', /previously refused/], [missing, 'no-channel', /planner can (fetch|search)(?: it)? directly/]] as const) {
        const decision = await given.reads.decide(read, { prompting: false });
        expect(decision).toMatchObject({ allowed: false, reason: expect.stringMatching(reason) });
        if (source !== 'no-channel') expect(decision.allowed === false && decision.reason).not.toMatch(/planner can (fetch|search)(?: it)? directly/);
        expect(given.decisions).toEqual([expect.objectContaining({ granted: false, source })]);
        expect(given.ask).not.toHaveBeenCalled();
        expect(await given.reads.decide({ kind: 'search', query: 'other', provider: 'other' })).not.toMatchObject({ reason: expect.stringContaining('budget') });
      }
    }
  });

  it('records subagent grants from the mode, allowlist and remembered approval', async () => {
    const full = setup({ autonomous: true });
    const listed = setup({ allow: ['https://docs.example.com/*', 'web_search:duckduckgo'] });
    const remembered = setup();
    const reads = [
      { kind: 'fetch' as const, url: 'https://docs.example.com/' },
      { kind: 'search' as const, query: 'tokio', provider: 'duckduckgo' },
    ];
    for (const read of reads) await remembered.reads.decide(read);
    remembered.decisions.length = 0;
    remembered.ask.mockClear();

    for (const [given, source] of [[full, 'mode'], [listed, 'pre-approved'], [remembered, 'remembered']] as const) {
      for (const read of reads) expect(await given.reads.decide(read, { prompting: false })).toEqual({ allowed: true });
      expect(given.ask).not.toHaveBeenCalled();
      expect(given.decisions.map((d) => [d.req.kind, d.granted, d.source])).toEqual([
        ['url_fetch', true, source], ['web_search', true, source],
      ]);
    }
  });

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

// A runner's own search raises no request, so it is switched on at session
// start only where the policy would allow it without asking (ADR-0027).
describe('WebReadPolicy.searchesUnasked', () => {
  it('turns native search and policy reads off when the live budget is zero', async () => {
    for (const mode of [{ autonomous: true }, { setting: 'allow' as const }, { allow: ['web_search:*', 'https://*'] }]) {
      let budget = 0;
      const { reads, ask } = setup({ ...mode, policy: { budget: () => budget } });
      expect(reads.searchesUnasked('openai')).toBe(false);
      expect(await reads.decide({ kind: 'search', query: 'tokio', provider: 'openai' })).toMatchObject({ allowed: false, reason: expect.stringContaining('budget (0)') });
      expect(await reads.decide({ kind: 'fetch', url: 'https://docs.example.com/' })).toMatchObject({ allowed: false });
      expect(ask).not.toHaveBeenCalled();
      budget = 1;
      expect(reads.searchesUnasked('openai')).toBe(true);
    }
  });

  it.each<[string, Setup, boolean]>([
    ['Full under auto', { autonomous: true }, true],
    ['an explicit allow', { setting: 'allow' }, true],
    ['Guarded under auto', {}, false],
    ['an explicit ask', { setting: 'ask', autonomous: true }, false],
    ['an explicit allowlist, in Full', { setting: 'deny', autonomous: true }, false],
    ['Guarded, with the provider on the allowlist', { allow: ['web_search:openai'] }, true],
  ])('%s → %s', (_label, given, expected) => {
    const { reads, ask, decisions } = setup(given);

    expect(reads.searchesUnasked('openai')).toBe(expected);
    expect(ask).not.toHaveBeenCalled();
    expect(decisions).toEqual([]);
  });

  it('follows a session grant of the same provider, and no other', async () => {
    const { reads } = setup();
    await reads.decide({ kind: 'search', query: 'tokio', provider: 'openai' });

    expect(reads.searchesUnasked('openai')).toBe(true);
    expect(reads.searchesUnasked('duckduckgo')).toBe(false);
  });

  it('names a provider by its label when it asks, and grants by its id', async () => {
    const { reads, ask } = setup();

    await reads.decide({ kind: 'search', query: 'hono', provider: 'opencode', providerLabel: 'OpenCode\'s web search (Exa)' });

    expect(ask.mock.calls[0][0]).toMatchObject({ scope: 'web_search:opencode', detail: 'Planner research wants to search the web with OpenCode\'s web search (Exa)' });
  });
});

// A lookup is itself a request: `<data>.attacker.tld` reaches the attacker's
// name server whether or not the fetch that follows is refused. So a name is
// resolved only once every other check has let the read through.
describe('WebReadPolicy resolves a name last', () => {
  function spied(given: Setup) {
    const resolveHost = vi.fn(async (_host: string) => [PUBLIC_IP]);
    return { ...setup({ ...given, policy: { resolveHost, ...given.policy } }), resolveHost };
  }

  it('never resolves an excluded host', async () => {
    const { reads, resolveHost } = spied({ autonomous: true, allow: ['!https://*.attacker.example/*'] });

    const decision = await reads.decide({ kind: 'fetch', url: 'https://leaked-data.attacker.example/' });

    expect(decision.allowed === false && decision.reason).toMatch(/excluded/);
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it('never resolves a host once the budget is spent', async () => {
    const { reads, resolveHost } = spied({ autonomous: true, policy: { budget: () => 0 } });

    const decision = await reads.decide({ kind: 'fetch', url: 'https://leaked-data.attacker.example/' });

    expect(decision.allowed === false && decision.reason).toMatch(/budget/);
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it('never resolves a host the user declined', async () => {
    const { reads, ask, resolveHost } = spied({ answer: false });

    const decision = await reads.decide({ kind: 'fetch', url: 'https://leaked-data.attacker.example/' });

    expect(decision.allowed === false && decision.reason).toMatch(/not approved/);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it('never resolves a host a research subagent may not fetch', async () => {
    const { reads, resolveHost } = spied({});

    const decision = await reads.decide({ kind: 'fetch', url: 'https://leaked-data.attacker.example/' }, { prompting: false });

    expect(decision.allowed === false && decision.reason).toMatch(/research agents/);
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it('resolves an allowed host, and gives the budget back when it resolves privately', async () => {
    const resolveHost = vi.fn(async (host: string) => (host === 'rebind.example.com' ? ['10.0.0.7'] : [PUBLIC_IP]));
    const { reads } = setup({ autonomous: true, policy: { resolveHost, budget: () => 1 } });

    const refused = await reads.decide({ kind: 'fetch', url: 'https://rebind.example.com/' });
    expect(refused.allowed === false && refused.reason).toMatch(/private address 10\.0\.0\.7/);

    expect((await reads.decide({ kind: 'fetch', url: 'https://docs.example.com/' })).allowed).toBe(true);
    expect(resolveHost.mock.calls.map(([host]) => host)).toEqual(['rebind.example.com', 'docs.example.com']);
  });

  it('vets subagent grants after recording their source and refunds a private-host refusal', async () => {
    for (const [given, source] of [
      [{ autonomous: true }, 'mode'],
      [{ allow: ['https://*.example.com/*'] }, 'pre-approved'],
      [{}, 'remembered'],
    ] satisfies [Setup, string][]) {
      let turn = 'grant';
      const resolveHost = vi.fn(async (_host: string) => [PUBLIC_IP]);
      const { reads, ask, decisions } = setup({ ...given, policy: { resolveHost, budget: () => 1, turn: () => turn } });
      if (source === 'remembered') await reads.decide({ kind: 'fetch', url: 'https://rebind.example.com/' });
      turn = 'subagent';
      decisions.length = 0;
      ask.mockClear();
      resolveHost.mockClear();
      resolveHost.mockImplementationOnce(async () => {
        expect(decisions).toEqual([expect.objectContaining({ granted: true, source })]);
        return ['10.0.0.7'];
      });

      const refused = await reads.decide({ kind: 'fetch', url: 'https://rebind.example.com/' }, { prompting: false });

      expect(refused).toMatchObject({ allowed: false, reason: expect.stringMatching(/private address 10\.0\.0\.7/) });
      expect(decisions.map((d) => [d.granted, d.source])).toEqual([[true, source], [false, 'guard']]);
      expect((await reads.decide({ kind: 'fetch', url: 'https://rebind.example.com/' }, { prompting: false })).allowed).toBe(true);
      expect(resolveHost).toHaveBeenCalledTimes(2);
      expect(ask).not.toHaveBeenCalled();
    }
  });
});
