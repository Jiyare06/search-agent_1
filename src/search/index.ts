// The one tool. Takes several queries at once (fan-out in parallel, one model round-trip),
// caches, de-duplicates across queries, numbers sources for citation, and degrades gracefully.
import type { Source } from '../memory/store.ts';
import type { ToolSpec } from '../models/types.ts';
import { brave, defaultProvider, tavily, type Hit, type SearchOptions, type SearchProvider } from './providers.ts';
import { config } from '../config.ts';

export interface WebSearchInput extends SearchOptions {
  queries: string[];
}

export const webSearchTool: ToolSpec = {
  name: 'web_search',
  description:
    'Search the web. Use for anything that may have changed since your training data (prices, plans, releases, news, people in roles, availability, versions, laws) or that you are not certain of. ' +
    'Pass 1-4 complementary queries in ONE call — they run in parallel. Prefer specific queries naming the product/entity and the attribute ("HubSpot Sales Hub pricing per seat 2026"). ' +
    'Use `since` (YYYY-MM-DD) when checking what changed after a past date, `recency` for news-like questions, and `domains` to hit primary sources such as a vendor pricing page.',
  parameters: {
    type: 'object',
    properties: {
      queries: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4, description: 'One to four distinct search queries.' },
      recency: { type: 'string', enum: ['day', 'week', 'month', 'year', 'any'], description: 'Only return results from this recent window.' },
      since: { type: 'string', description: 'Only return results published on/after this date (YYYY-MM-DD).' },
      topic: { type: 'string', enum: ['general', 'news'], description: '"news" for current events and announcements.' },
      depth: { type: 'string', enum: ['quick', 'thorough'], description: '"thorough" returns richer passages but is slower. Default quick.' },
      domains: { type: 'array', items: { type: 'string' }, description: 'Restrict to these domains, e.g. ["supabase.com"].' },
    },
    required: ['queries'],
  },
};

const cache = new Map<string, { at: number; hits: Hit[] }>();
const TTL = 10 * 60_000;

async function cachedSearch(p: SearchProvider, q: string, opts: SearchOptions, signal?: AbortSignal): Promise<Hit[]> {
  const key = JSON.stringify([p.name, q.toLowerCase().trim(), opts]);
  const c = cache.get(key);
  if (c && Date.now() - c.at < TTL) return c.hits;
  const hits = await p.search(q, opts, signal);
  cache.set(key, { at: Date.now(), hits });
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return hits;
}

async function searchWithFallback(q: string, opts: SearchOptions, signal?: AbortSignal): Promise<Hit[]> {
  const primary = defaultProvider();
  if (!primary) throw new Error('No search provider configured (set TAVILY_API_KEY or BRAVE_API_KEY).');
  try {
    return await cachedSearch(primary, q, opts, signal);
  } catch (err) {
    const secondary = primary === tavily && config.braveKey ? brave : null;
    if (!secondary || signal?.aborted) throw err;
    return cachedSearch(secondary, q, opts, signal);
  }
}

const normUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();

/** Per-turn citation registry: numbers are unique across all searches in a turn, URLs are de-duplicated. */
export class SourceRegistry {
  readonly list: Source[] = [];
  private byUrl = new Map<string, Source>();
  get(url: string) {
    return this.byUrl.get(normUrl(url));
  }
  add(h: Hit): Source {
    const key = normUrl(h.url);
    let s = this.byUrl.get(key);
    if (!s) {
      s = { n: this.list.length + 1, url: h.url, title: h.title, published: h.published ?? null, snippet: h.snippet.slice(0, 300) };
      this.byUrl.set(key, s);
      this.list.push(s);
    }
    return s;
  }
}

export interface RawSearch {
  queries: string[];
  opts: SearchOptions;
  results: PromiseSettledResult<Hit[]>[];
}

/** Phase 1 (network, parallel-safe): run all queries concurrently. */
export async function fetchWebSearch(input: WebSearchInput, signal?: AbortSignal): Promise<RawSearch> {
  const queries = [...new Set((input.queries ?? []).map((q) => String(q).trim()).filter(Boolean))].slice(0, 4);
  const opts: SearchOptions = {
    recency: input.recency,
    since: /^\d{4}-\d{2}-\d{2}$/.test(input.since ?? '') ? input.since : undefined,
    topic: input.topic,
    depth: input.depth,
    domains: input.domains?.filter(Boolean).slice(0, 10),
    maxResults: queries.length > 2 ? 5 : 6,
  };
  if (!queries.length) return { queries, opts, results: [] };
  const results = await Promise.allSettled(queries.map((q) => searchWithFallback(q, opts, signal)));
  return { queries, opts, results };
}

/** Phase 2 (sync): assign citation numbers and render the text the model reads. */
export function formatWebSearch(raw: RawSearch, registry: SourceRegistry, retrievedOn: string): { text: string; ok: boolean } {
  const errors: string[] = [];
  const blocks: string[] = [];
  const shown = new Set<number>();
  raw.results.forEach((r, i) => {
    if (r.status === 'rejected') {
      errors.push(`"${raw.queries[i]}": ${(r.reason as Error)?.message ?? r.reason}`);
      return;
    }
    for (const h of r.value) {
      const src = registry.add(h);
      if (shown.has(src.n)) continue;
      shown.add(src.n);
      const date = h.published ? String(h.published).slice(0, 10) : 'unknown';
      blocks.push(`[${src.n}] ${h.title}\nURL: ${h.url}\nPublished: ${date}\n${h.snippet}`);
    }
  });
  const header = `Results retrieved ${retrievedOn} for: ${raw.queries.map((q) => `"${q}"`).join('; ')}${raw.opts.since ? ` (since ${raw.opts.since})` : ''}`;
  let text = blocks.length ? `${header}\n\n${blocks.join('\n\n')}` : `${header}\n\nNo results.`;
  if (!raw.queries.length) text = 'No queries were provided.';
  if (errors.length) text += `\n\nSearch errors: ${errors.join(' | ')}`;
  return { text, ok: blocks.length > 0 || errors.length === 0 };
}
