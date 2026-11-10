// Search providers behind one small interface. Tavily is the default because it returns LLM-ready
// passages (not just 160-char SERP snippets) and supports date windows; Brave is a fallback.
import { config } from '../config.ts';

export interface SearchOptions {
  recency?: 'day' | 'week' | 'month' | 'year' | 'any';
  since?: string; // YYYY-MM-DD — "what changed since X"
  topic?: 'general' | 'news';
  depth?: 'quick' | 'thorough';
  domains?: string[];
  maxResults?: number;
}

export interface Hit {
  url: string;
  title: string;
  snippet: string;
  published?: string | null;
}

export interface SearchProvider {
  name: string;
  search(query: string, opts: SearchOptions, signal?: AbortSignal): Promise<Hit[]>;
}

async function fetchJson(url: string, init: RequestInit, signal?: AbortSignal, timeoutMs = 12_000): Promise<any> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

export const tavily: SearchProvider = {
  name: 'tavily',
  async search(query, opts, signal) {
    const body: Record<string, unknown> = {
      query,
      search_depth: opts.depth === 'thorough' ? 'advanced' : 'basic',
      chunks_per_source: 3,
      max_results: opts.maxResults ?? 6,
      topic: opts.topic === 'news' ? 'news' : 'general',
      include_published_date: true,
    };
    if (opts.since) body.start_date = opts.since;
    else if (opts.recency && opts.recency !== 'any') body.time_range = opts.recency;
    if (opts.domains?.length) body.include_domains = opts.domains;
    const json = await fetchJson(
      'https://api.tavily.com/search',
      { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.tavilyKey}` }, body: JSON.stringify(body) },
      signal,
    );
    return (json.results ?? []).map((r: any) => ({
      url: r.url,
      title: r.title ?? r.url,
      snippet: String(r.content ?? '').slice(0, 1500),
      published: r.published_date ?? null,
    }));
  },
};

export const brave: SearchProvider = {
  name: 'brave',
  async search(query, opts, signal) {
    const params = new URLSearchParams({ q: opts.domains?.length ? `${query} ${opts.domains.map((d) => `site:${d}`).join(' OR ')}` : query, count: String(opts.maxResults ?? 8), extra_snippets: 'true' });
    if (opts.since) params.set('freshness', `${opts.since}to${new Date().toISOString().slice(0, 10)}`);
    else if (opts.recency && opts.recency !== 'any') params.set('freshness', { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[opts.recency]);
    const json = await fetchJson(`https://api.search.brave.com/res/v1/web/search?${params}`, { headers: { accept: 'application/json', 'x-subscription-token': config.braveKey } }, signal);
    return (json.web?.results ?? []).map((r: any) => ({
      url: r.url,
      title: r.title ?? r.url,
      snippet: [r.description, ...(r.extra_snippets ?? [])].filter(Boolean).join(' … ').replace(/<\/?strong>/g, '').slice(0, 1500),
      published: r.page_age ?? r.age ?? null,
    }));
  },
};

export function defaultProvider(): SearchProvider | null {
  if (config.tavilyKey) return tavily;
  if (config.braveKey) return brave;
  return null;
}
