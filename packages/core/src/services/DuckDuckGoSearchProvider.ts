import type { ISearchProvider, SearchHit, SearchOutcome, SearchTransport } from '../interfaces/ISearchProvider';

/**
 * DuckDuckGo's lite endpoint: no API key, no account, and stable enough for
 * "find me the docs URL". It is HTML scraping, so it is the most brittle thing
 * here by construction — every failure path degrades to a tool result that
 * tells the planner to fall back to `fetch` with a known URL.
 *
 * It is also built for people, so it pushes back on automated traffic. When it
 * answers 429/403, or serves a challenge/captcha page instead of results, the
 * provider marks itself unavailable for a short cooldown shared across
 * sessions (the fetcher injects one process-wide provider), growing on
 * repeated push-backs and reset by a successful search.
 */

const SEARCH_ENDPOINT = 'https://lite.duckduckgo.com/lite/?q=';
const COOLDOWN_BASE_MS = 30_000;
const COOLDOWN_MAX_MS = 5 * 60_000;

/** The markers of a challenge/captcha page. A 200 without any of these and no results is just a parse miss. */
const CHALLENGE_MARKERS: RegExp[] = [
  /captcha/i,
  /unusual traffic/i,
  /are you a robot/i,
  /automated (?:queries|requests|traffic)/i,
  /challenge-form/i,
  /cf-challenge/i,
  /anomaly/i,
];

export function looksLikeChallenge(html: string): boolean {
  return CHALLENGE_MARKERS.some((marker) => marker.test(html));
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

/** Pull result links out of the lite endpoint's markup. */
export function parseSearchHits(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const linkPattern = /<a\b[^>]*class="[^"]*result(?:-link|__a)[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /class="[^"]*result(?:-snippet|__snippet)[^"]*"[^>]*>([\s\S]*?)</gi;

  const snippets: string[] = [];
  for (let m = snippetPattern.exec(html); m; m = snippetPattern.exec(html)) {
    snippets.push(decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
  }

  for (let m = linkPattern.exec(html); m; m = linkPattern.exec(html)) {
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    hits.push({ title, url: decodeEntities(m[1]), snippet: snippets[hits.length] });
  }
  return hits;
}

/**
 * The provider's shared instance: one process-wide provider means the cooldown
 * a push-back starts is seen by every session, not just the one that hit it.
 * `now` is injectable so tests drive the cooldown without waiting.
 */
export class DuckDuckGoSearchProvider implements ISearchProvider {
  readonly id = 'duckduckgo';
  readonly name = 'DuckDuckGo';

  private failures = 0;
  private cooldownUntil = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  coolingDown(): boolean {
    return this.now() < this.cooldownUntil;
  }

  async search(query: string, get: SearchTransport): Promise<SearchOutcome> {
    const page = await get(SEARCH_ENDPOINT + encodeURIComponent(query));
    if (!page.ok) {
      if (page.status === 429 || page.status === 403) return this.block(`HTTP ${page.status}`);
      return { kind: 'error', error: page.error };
    }
    if (looksLikeChallenge(page.body)) return this.block('a challenge page');

    const hits = parseSearchHits(page.body).slice(0, 10);
    if (hits.length === 0) return { kind: 'none' };

    this.failures = 0;
    this.cooldownUntil = 0;
    return { kind: 'hits', hits };
  }

  private block(reason: string): SearchOutcome {
    this.failures += 1;
    const backoff = Math.min(COOLDOWN_BASE_MS * 2 ** (this.failures - 1), COOLDOWN_MAX_MS);
    this.cooldownUntil = this.now() + backoff;
    return { kind: 'blocked', reason };
  }
}

/** The one provider every session's fetcher shares, so a cooldown is process-wide. */
export const sharedSearchProvider = new DuckDuckGoSearchProvider();
