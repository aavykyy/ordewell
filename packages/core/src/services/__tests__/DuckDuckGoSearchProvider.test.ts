import { describe, it, expect } from 'vitest';
import { DuckDuckGoSearchProvider, looksLikeChallenge, parseSearchHits } from '../DuckDuckGoSearchProvider';
import type { SearchPage } from '../../interfaces/ISearchProvider';

const RESULTS = `
  <html><body>
    <a class="result__a" href="https://hono.dev/docs/routing">Hono Routing</a>
    <a class="result__snippet">Define routes with app.get.</a>
    <a class="result__a" href="https://github.com/honojs/hono">honojs/hono</a>
  </body></html>`;

const page = (body: string, status = 200): SearchPage => ({ ok: true, status, body });
const failure = (status: number): SearchPage => ({ ok: false, status, error: `HTTP ${status}` });

describe('parseSearchHits', () => {
  it('pulls titles, URLs and snippets out of the lite markup', () => {
    expect(parseSearchHits(RESULTS)).toEqual([
      { title: 'Hono Routing', url: 'https://hono.dev/docs/routing', snippet: 'Define routes with app.get.' },
      { title: 'honojs/hono', url: 'https://github.com/honojs/hono', snippet: undefined },
    ]);
  });
});

describe('looksLikeChallenge', () => {
  it.each([
    ['<html>Please complete the CAPTCHA</html>'],
    ['<p>Our systems have detected unusual traffic from your computer</p>'],
    ['<div class="cf-challenge">Checking your browser</div>'],
  ])('recognises %s', (body) => {
    expect(looksLikeChallenge(body)).toBe(true);
  });

  it('does not mistake an ordinary results page for a challenge', () => {
    expect(looksLikeChallenge(RESULTS)).toBe(false);
    expect(looksLikeChallenge('<html><body>No results</body></html>')).toBe(false);
  });
});

describe('DuckDuckGoSearchProvider', () => {
  it('returns parsed hits for a results page, with no request of its own', async () => {
    const provider = new DuckDuckGoSearchProvider();

    const outcome = await provider.search('hono routing', async () => page(RESULTS));

    expect(outcome).toEqual({ kind: 'hits', hits: [
      { title: 'Hono Routing', url: 'https://hono.dev/docs/routing', snippet: 'Define routes with app.get.' },
      { title: 'honojs/hono', url: 'https://github.com/honojs/hono', snippet: undefined },
    ] });
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
    expect(await challenged.search('q', async () => page('Please complete the CAPTCHA to continue')))
      .toEqual({ kind: 'blocked', reason: expect.stringContaining('challenge') });
    expect(challenged.coolingDown()).toBe(true);
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
    expect(await provider.search('q', async () => page(RESULTS))).toMatchObject({ kind: 'hits' });
    expect(provider.coolingDown()).toBe(false);
    now += 1_000_000;
    await block();
    now += 29_999;
    expect(provider.coolingDown()).toBe(true);
  });
});
