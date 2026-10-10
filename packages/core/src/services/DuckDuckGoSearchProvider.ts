import type { ISearchProvider, SearchHit, SearchOutcome, SearchTransport } from '../interfaces/ISearchProvider';

/**
 * DuckDuckGo's lite endpoint: no API key, no account, and stable enough for
 * "find me the docs URL". It is HTML scraping, so it is the most brittle thing
 * here by construction — every failure path degrades to a tool result that
 * tells the planner to fall back to `fetch` with a known URL.
 *
 * It is also built for people, so it pushes back on automated traffic. When it
 * answers 429/403/202, or serves its challenge page instead of results, the
 * provider marks itself unavailable for a short cooldown shared across
 * sessions (the fetcher injects one process-wide provider), growing on
 * repeated push-backs and reset by a successful search.
 */

const SEARCH_ENDPOINT = 'https://lite.duckduckgo.com/lite/?q=';
const COOLDOWN_BASE_MS = 30_000;
const COOLDOWN_MAX_MS = 5 * 60_000;

/**
 * What DuckDuckGo's challenge page is made of (HTTP 202, an image puzzle):
 * `<form id="challenge-form" action="//duckduckgo.com/anomaly.js?…">` around
 * `anomaly-modal__*` elements. These are matched as markup, never as words: the
 * page, and a normal results page, echo the query, so "recaptcha react" or
 * "anomaly detection" would otherwise read as a challenge.
 */
const CHALLENGE_MARKERS: RegExp[] = [
  /<form\b[^>]*\bid\s*=\s*["']challenge-form["']/i,
  /<form\b[^>]*\baction\s*=\s*["'][^"']*\/anomaly\.js\b/i,
  /<div\b[^>]*\bclass\s*=\s*["'][^"']*\banomaly-modal/i,
];

export function looksLikeChallenge(html: string): boolean {
  return CHALLENGE_MARKERS.some((marker) => marker.test(html));
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Attributes of one start tag, in either quote style (or none) and any order. */
function attributesOf(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const pattern = /([a-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  for (let m = pattern.exec(tag); m; m = pattern.exec(tag)) {
    attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

const RESULT_LINK_CLASS = /(?:^|\s)result(?:-link|__a)(?:\s|$)/;
const SNIPPET_ELEMENT = /<(\w+)\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bresult(?:-snippet|__snippet)\b)[^>]*>([\s\S]*?)<\/\1>/i;

/**
 * Lite wraps every result in `//duckduckgo.com/l/?uddg=<encoded target>`, a
 * tracking redirect the planner could not fetch (it is protocol-relative, and
 * would spend a hop through DuckDuckGo). Anything still pointing at
 * DuckDuckGo itself after unwrapping is an ad redirect, not a result.
 */
function resolveResultUrl(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href, 'https://duckduckgo.com/');
  } catch {
    return undefined;
  }
  if (url.hostname === 'duckduckgo.com' || url.hostname.endsWith('.duckduckgo.com')) {
    const target = url.pathname === '/l/' ? url.searchParams.get('uddg') : null;
    if (!target) return undefined;
    try {
      url = new URL(target);
    } catch {
      return undefined;
    }
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
}

/**
 * Pull result links out of the lite endpoint's markup. A result's snippet is
 * looked for only between its link and the next one: a result with no snippet
 * must not borrow its neighbour's.
 */
export function parseSearchHits(html: string): SearchHit[] {
  const links: { start: number; end: number; href: string; title: string }[] = [];
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (let m = anchor.exec(html); m; m = anchor.exec(html)) {
    const attrs = attributesOf(m[1]);
    const href = attrs.get('href');
    if (!href || !RESULT_LINK_CLASS.test(attrs.get('class') ?? '')) continue;
    links.push({ start: m.index, end: m.index + m[0].length, href: decodeEntities(href), title: plainText(m[2]) });
  }

  const hits: SearchHit[] = [];
  links.forEach((link, i) => {
    const url = resolveResultUrl(link.href);
    if (!url || !link.title) return;
    const region = html.slice(link.end, links[i + 1]?.start ?? html.length);
    hits.push({ title: link.title, url, snippet: snippetIn(region) });
  });
  return hits;
}

function snippetIn(region: string): string | undefined {
  const match = SNIPPET_ELEMENT.exec(region);
  return match ? plainText(match[2]) || undefined : undefined;
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
    // Lite answers 202 only to serve the challenge, so it is a block whatever the body says.
    if (page.status === 202) return this.block('HTTP 202');

    // Parse first: a page with results is never a challenge, and one without
    // is only a block if it carries the challenge's own markup.
    const hits = parseSearchHits(page.body).slice(0, 10);
    if (hits.length === 0) return looksLikeChallenge(page.body) ? this.block('a challenge page') : { kind: 'none' };

    this.failures = 0;
    this.cooldownUntil = 0;
    return { kind: 'hits', hits };
  }

  private block(reason: string): SearchOutcome {
    // Searches already in flight when the first push-back lands all come back
    // blocked; they are one event, not a streak, so only one grows the cooldown.
    if (!this.coolingDown()) {
      this.failures += 1;
      const backoff = Math.min(COOLDOWN_BASE_MS * 2 ** (this.failures - 1), COOLDOWN_MAX_MS);
      this.cooldownUntil = this.now() + backoff;
    }
    return { kind: 'blocked', reason };
  }
}

/** The one provider every session's fetcher shares, so a cooldown is process-wide. */
export const sharedSearchProvider = new DuckDuckGoSearchProvider();
