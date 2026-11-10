// Recall runs *before* the model, on every turn, in a few milliseconds. No extra LLM round-trip and no
// second "memory tool": the model receives exactly the past turns it needs, already resolved by date.
import { type DateKey, type DateRange, resolveDateRefs, prettyDate, diffDays, localTime } from '../time.ts';
import type { Turn, Conversation } from './store.ts';

const STOP = new Set(
  'a an the and or but if of to in on at for with from by about as is are was were be been being do does did have has had i me my we our you your it its this that these those what which who whom when where why how any some all can could would should will just than then there here into over since still today yesterday last week month ask asked tell told said say again answer correct right changed change has have anything something them they their up out more most very'.split(
    ' ',
  ),
);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9.+#\- ]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[.\-]+|[.\-]+$/g, ''))
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** Does the message refer back to our shared history? Controls whether we state "no record" explicitly. */
export function hasRecallCue(msg: string): boolean {
  const t = msg.toLowerCase();
  return (
    /\b(i|we|you)\b[^.?!]{0,40}\b(ask|asked|discuss|discussed|talk|talked|shortlist|shortlisted|said|told|mention|mentioned|recommend|recommended|chat|chatted|decide|decided|compare|compared|look(ed)? at|pick|picked|chose|choose|went with|settled on)\b/.test(
      t,
    ) ||
    /\b(your|the|that) (previous |last |earlier )?(answer|recommendation|advice|reply|list|shortlist)\b/.test(t) ||
    /\bstill (correct|true|accurate|valid|right|current)\b|\bchanged since\b|\bsince then\b|\blast time\b|\bpreviously\b|\bremember\b/.test(t)
  );
}

function docText(t: Turn, title = ''): string {
  return [title, t.user, t.summary ?? '', (t.facts ?? []).map((f) => `${f.subject} ${f.claim}`).join(' '), t.assistant.slice(0, 600)].join(' ');
}

/** Small BM25. Corpus is one user's history, so brute force is fine for a long time. */
export function rank(query: string, turns: Turn[], k = 4, titles?: Map<string, string>): { turn: Turn; score: number }[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !turns.length) return [];
  const docs = turns.map((t) => tokenize(docText(t, titles?.get(t.conversationId))));
  const avg = docs.reduce((s, d) => s + d.length, 0) / docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const N = docs.length;
  const scored = docs.map((d, i) => {
    const tf = new Map<string, number>();
    for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1);
    let s = 0;
    for (const w of q) {
      const f = tf.get(w);
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
      s += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.length / avg))));
    }
    return { turn: turns[i], score: s };
  });
  const best = Math.max(0, ...scored.map((x) => x.score));
  // Absolute floor + relative cutoff: a strong match shouldn't drag in turns that only share "pricing".
  return scored
    .filter((x) => x.score > 0.6 && x.score >= best * 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

function renderTurn(t: Turn, today: DateKey, conv?: Conversation): string {
  const ago = diffDays(t.localDate, today);
  const when = `${prettyDate(t.localDate)} at ${localTime(new Date(t.ts), t.tz)} (${ago === 0 ? 'today' : ago === 1 ? 'yesterday' : `${ago} days ago`})`;
  const lines = [`### ${when}${conv ? ` — chat "${conv.title}"` : ''}`, `User said: ${t.user}`];
  if (t.facts?.length) {
    lines.push(`Facts recorded at the time (as of ${t.localDate}):`);
    for (const f of t.facts.slice(0, 15)) lines.push(`- [${f.kind}] ${f.subject}: ${f.claim}${f.sourceUrl ? ` (${f.sourceUrl})` : ''}`);
  }
  const answer = t.assistant.length > 1800 ? `${t.assistant.slice(0, 1800)}…[truncated]` : t.assistant;
  lines.push(`Your answer then:\n${answer}`);
  if (t.sources.length) lines.push(`Sources cited then: ${t.sources.slice(0, 8).map((s) => `${s.title} <${s.url}>`).join('; ')}`);
  return lines.join('\n');
}

export interface RecallResult {
  block: string; // goes into the system prompt
  dateRefs: DateRange[];
  turnIds: string[];
}

export function recall(opts: {
  message: string;
  today: DateKey;
  allTurns: Turn[];
  conversations: Conversation[];
  excludeIds: Set<string>; // turns already in the verbatim history window
}): RecallResult {
  const { message, today, allTurns, conversations, excludeIds } = opts;
  const convById = new Map(conversations.map((c) => [c.id, c]));
  const titles = new Map(conversations.map((c) => [c.id, c.title]));
  const pool = allTurns.filter((t) => !excludeIds.has(t.id));
  const dateRefs = resolveDateRefs(message, today);
  const cue = hasRecallCue(message);
  const sections: string[] = [];
  const picked = new Set<string>();
  let budget = 24_000; // ~6k tokens of memory max: recall must not slow every turn down

  const add = (t: Turn) => {
    if (picked.has(t.id)) return;
    const r = renderTurn(t, today, convById.get(t.conversationId));
    if (r.length > budget) return;
    budget -= r.length;
    picked.add(t.id);
    sections.push(r);
  };

  // 1) Explicit dates: exact lookup, ranked by relevance within the day.
  const dateNotes: string[] = [];
  for (const r of dateRefs) {
    const hits = allTurns.filter((t) => t.localDate >= r.from && t.localDate <= r.to);
    const label = r.from === r.to ? prettyDate(r.from) : `${prettyDate(r.from)} – ${prettyDate(r.to)}`;
    if (r.ambiguous && !hits.length) continue;
    dateNotes.push(`"${r.phrase}" → ${label}: ${hits.length ? `${hits.length} message(s) found` : 'NO conversation on record'}`);
    const ranked = rank(message, hits, 6, titles).map((x) => x.turn);
    for (const t of [...ranked, ...hits.filter((h) => !ranked.includes(h))].slice(0, 6)) if (!excludeIds.has(t.id)) add(t);
  }

  // 2) Topical relevance across all history (covers "the CRM tools we shortlisted" with no date).
  for (const { turn } of rank(message, pool, 4, titles)) add(turn);

  // 3) A lightweight index of recent chats, so "what have we talked about?" works and the model knows
  //    what exists even when the lexical match missed.
  const byDay = new Map<string, Set<string>>();
  for (const t of allTurns) {
    if (diffDays(t.localDate, today) > 30) continue;
    const title = convById.get(t.conversationId)?.title ?? 'chat';
    (byDay.get(t.localDate) ?? byDay.set(t.localDate, new Set()).get(t.localDate)!).add(t.summary ? `${title}: ${t.summary}` : `${title}: "${t.user.slice(0, 90)}"`);
  }
  const index = [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 14)
    .map(([d, items]) => `- ${prettyDate(d)}: ${[...items].slice(0, 4).join(' | ')}`);

  const parts: string[] = [];
  if (dateNotes.length) parts.push(`Date references in the user's message (resolved for you — trust these):\n${dateNotes.map((n) => `- ${n}`).join('\n')}`);
  if (sections.length) parts.push(`Relevant past turns (verbatim records from earlier chats with this user):\n\n${sections.join('\n\n')}`);
  else if (cue) parts.push('No earlier conversation matching this reference was found in memory. Do not invent one.');
  if (index.length) parts.push(`Index of recent chats (last 30 days):\n${index.join('\n')}`);
  if (!allTurns.length) parts.push('This user has no earlier conversation history at all.');

  return { block: parts.join('\n\n'), dateRefs, turnIds: [...picked] };
}
