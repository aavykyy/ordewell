import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { DuckDuckGoSearchProvider, looksLikeChallenge, parseSearchHits } from '../DuckDuckGoSearchProvider';
import type { SearchPage } from '../../interfaces/ISearchProvider';

// Captured from lite.duckduckgo.com (trimmed): a results page for `typescript`,
// and the HTTP 202 challenge page DuckDuckGo served for `anomaly detection`.
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'duckduckgo', name), 'utf8');
const LITE_RESULTS = fixture('lite-results-typescript.html');
const LITE_CHALLENGE = fixture('lite-challenge-202.html');

const page = (body: string, status = 200): SearchPage => ({ ok: true, status, body });
const failure = (status: number): SearchPage => ({ ok: false, status, error: `HTTP ${status}` });

describe('parseSearchHits on the real lite page', () => {
  it('reads every result, unwrapping the redirect to the real URL', () => {
    const hits = parseSearchHits(LITE_RESULTS);

    expect(hits).toHaveLength(10);
    expect(hits[0]).toEqual({
      title: 'TypeScript: JavaScript With Syntax For Types.',
      url: 'https://www.typescriptlang.org/',
      snippet: 'TypeScript is a strongly typed programming language that builds on JavaScript, giving you better tooling at any scale. Learn how to use TypeScript to describe your data, catch errors early, and convert to JavaScript.',
    });
    expect(hits.map((h) => h.url)).toEqual([
      'https://www.typescriptlang.org/',
      'https://www.w3schools.com/typescript/index.php',
      'https://en.wikipedia.org/wiki/TypeScript',
      'https://www.typescriptlang.org/docs/',
      'https://www.geeksforgeeks.org/typescript/typescript-tutorial/',
      'https://github.com/microsoft/TypeScript',
      'https://www.w3schools.com/typescript/typescript_intro.php',
      'https://www.runoob.com/typescript/ts-tutorial.html',
      'https://www.tutorialspoint.com/typescript/index.htm',
      'https://www.typescripttutorial.net/',
    ]);
  });
});

describe('parseSearchHits markup tolerance', () => {
  it('accepts either quote style and any attribute order', () => {
    const html = `
      <a class="result-link" href="https://a.example/one">One</a>
      <a rel="nofollow" href='https://b.example/two' class='result-link'>Two</a>
      <a href=https://c.example/three class=result__a>Three</a>`;

    expect(parseSearchHits(html).map((h) => h.url)).toEqual([
      'https://a.example/one',
      'https://b.example/two',
      'https://c.example/three',
    ]);
  });

  it('does not hand a result the snippet of the one after it', () => {
    const html = `
      <a class='result-link' href="https://a.example/">No snippet here</a>
      <a class='result-link' href="https://b.example/">Has one</a>
      <table><tr><td class='result-snippet'>The <b>second</b> result&#39;s &amp; text</td></tr></table>`;

    expect(parseSearchHits(html)).toEqual([
      { title: 'No snippet here', url: 'https://a.example/', snippet: undefined },
      { title: 'Has one', url: 'https://b.example/', snippet: "The second result's & text" },
    ]);
  });

  it('unwraps both protocol-relative and absolute redirect links', () => {
    const html = `
      <a class='result-link' href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2Fp%3Fq%3D1%26r%3D2&amp;rut=abc">A</a>
      <a class='result-link' href="https://duckduckgo.com/l/?uddg=http%3A%2F%2Fb.example%2F">B</a>`;

    expect(parseSearchHits(html).map((h) => h.url)).toEqual(['https://a.example/p?q=1&r=2', 'http://b.example/']);
  });

  it('drops DuckDuckGo ad redirects and non-HTTP targets instead of returning them', () => {
    const html = `
      <a class='result-link' href="https://duckduckgo.com/y.js?ad_domain=x.example&amp;u3=abc">Ad</a>
      <a class='result-link' href="//duckduckgo.com/l/?uddg=javascript%3Aalert(1)">Script</a>
      <a class='result-link' href="https://real.example/">Real</a>`;

    expect(parseSearchHits(html).map((h) => h.url)).toEqual(['https://real.example/']);
  });
});

describe('looksLikeChallenge', () => {
  it('recognises the real challenge page', () => {
    expect(looksLikeChallenge(LITE_CHALLENGE)).toBe(true);
  });

  it.each([
    ['the form', '<form id="challenge-form" action="/x" method="POST"></form>'],
    ['the anomaly script endpoint', '<form action="//duckduckgo.com/anomaly.js?sv=lite" method="POST"></form>'],
    ['the modal', '<div class="anomaly-modal__modal  is-ie"></div>'],
  ])('recognises %s', (_, body) => {
    expect(looksLikeChallenge(body)).toBe(true);
  });

  it('does not mistake a results page, or prose about captchas, for a challenge', () => {
    expect(looksLikeChallenge(LITE_RESULTS)).toBe(false);
    expect(looksLikeChallenge('<html><body>Please complete the CAPTCHA; anomaly detection; unusual traffic</body></html>')).toBe(false);
  });
});

// The lite page echoes the query in its input and title, so a results page
// for a query about captchas or anomalies carries those words everywhere.
function echoingQuery(query: string, { withResults }: { withResults: boolean }): string {
  const echoed = LITE_RESULTS.replaceAll('typescript', query);
  return withResults ? echoed : echoed.replaceAll("class='result-link'", "class='other'");
}

describe('DuckDuckGoSearchProvider challenge detection', () => {
  it('blocks on the real challenge page whatever status carried it', async () => {
    for (const status of [200, 202]) {
      const provider = new DuckDuckGoSearchProvider(() => 1_000);

      const outcome = await provider.search('anomaly detection', async () => page(LITE_CHALLENGE, status));

      expect(outcome).toMatchObject({ kind: 'blocked' });
      expect(provider.coolingDown()).toBe(true);
    }
  });

  it('treats any 202 as a block, since lite answers 202 only for a challenge', async () => {
    const provider = new DuckDuckGoSearchProvider(() => 1_000);

    const outcome = await provider.search('q', async () => page('', 202));

    expect(outcome).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('202') });
    expect(provider.coolingDown()).toBe(true);
  });

  it.each(['recaptcha react', 'anomaly detection', 'are you a robot unusual traffic'])(
    'does not start a cooldown for a query about "%s" with results',
    async (query) => {
      const provider = new DuckDuckGoSearchProvider(() => 1_000);

      const outcome = await provider.search(query, async () => page(echoingQuery(query, { withResults: true })));

      expect(outcome).toMatchObject({ kind: 'hits' });
      expect(provider.coolingDown()).toBe(false);
    },
  );

  it.each(['recaptcha react', 'anomaly detection'])(
    'reports a plain miss, not a block, for "%s" when nothing parses',
    async (query) => {
      const provider = new DuckDuckGoSearchProvider(() => 1_000);

      const outcome = await provider.search(query, async () => page(echoingQuery(query, { withResults: false })));

      expect(outcome).toEqual({ kind: 'none' });
      expect(provider.coolingDown()).toBe(false);
    },
  );
});

describe('DuckDuckGoSearchProvider', () => {
  it('returns parsed hits for a results page, with no request of its own', async () => {
    const provider = new DuckDuckGoSearchProvider();

    const outcome = await provider.search('typescript', async () => page(LITE_RESULTS));

    expect(outcome).toMatchObject({ kind: 'hits', hits: expect.arrayContaining([
      expect.objectContaining({ title: 'TypeScript - Wikipedia', url: 'https://en.wikipedia.org/wiki/TypeScript' }),
    ]) });
    expect(provider.coolingDown()).toBe(false);
  });

  it('treats a 200 page with no results and no challenge as a plain miss, not a block', async () => {
    const provider = new DuckDuckGoSearchProvider(() => 1_000);

    const outcome = await provider.search('q', async () => page('<html><body>nothing here</body></html>'));

    expect(outcome).toEqual({ kind: 'none' });
    expect(provider.coolingDown()).toBe(false);
  });

  it('marks the provider unavailable after a 429 and says why', async () => {
    const provider = new DuckDuckGoSearchProvider(() => 1_000);

    const outcome = await provider.search('q', async () => failure(429));

    expect(outcome).toEqual({ kind: 'blocked', reason: expect.stringContaining('429') });
    expect(provider.coolingDown()).toBe(true);
  });

  it('treats a 403 or a challenge page as a block too', async () => {
    const forbidden = new DuckDuckGoSearchProvider(() => 1_000);
    expect(await forbidden.search('q', async () => failure(403))).toMatchObject({ kind: 'blocked' });
    expect(forbidden.coolingDown()).toBe(true);

    const challenged = new DuckDuckGoSearchProvider(() => 1_000);
    expect(await challenged.search('q', async () => page(LITE_CHALLENGE)))
      .toEqual({ kind: 'blocked', reason: expect.stringContaining('challenge') });
    expect(challenged.coolingDown()).toBe(true);
  });

  it('counts searches blocked together in one cooldown window as a single block', async () => {
    let now = 0;
    const provider = new DuckDuckGoSearchProvider(() => now);

    await Promise.all([1, 2, 3].map(() => provider.search('q', async () => failure(429))));

    // Three concurrent push-backs must leave the base cooldown, not 4x it.
    now = 29_999;
    expect(provider.coolingDown()).toBe(true);
    now = 30_000;
    expect(provider.coolingDown()).toBe(false);
  });

  it('grows the cooldown on repeated failures and resets it on success', async () => {
    let now = 0;
    const provider = new DuckDuckGoSearchProvider(() => now);
    const block = () => provider.search('q', async () => failure(429));

    await block();
    // First block: base cooldown.
    now = 29_999;
    expect(provider.coolingDown()).toBe(true);
    now = 30_000;
    expect(provider.coolingDown()).toBe(false);

    // A second consecutive block doubles it.
    now = 30_001;
    await block();
    now = 30_001 + 59_999;
    expect(provider.coolingDown()).toBe(true);
    now = 30_001 + 60_000;
    expect(provider.coolingDown()).toBe(false);

    // A success clears the streak, so the next block starts over at the base.
    expect(await provider.search('q', async () => page(LITE_RESULTS))).toMatchObject({ kind: 'hits' });
    expect(provider.coolingDown()).toBe(false);
    now += 1_000_000;
    await block();
    now += 29_999;
    expect(provider.coolingDown()).toBe(true);
  });
});
