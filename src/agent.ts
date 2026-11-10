// One user turn: recall → stream model → (parallel searches → stream again)* → persist → distil in background.
import { config } from './config.ts';
import { chatModel } from './models/index.ts';
import { recall } from './memory/recall.ts';
import { store, newId, type Source, type Turn } from './memory/store.ts';
import { distillTurn } from './memory/distill.ts';
import { STATIC_SYSTEM, dynamicSystem } from './prompt.ts';
import { fetchWebSearch, formatWebSearch, SourceRegistry, webSearchTool, type WebSearchInput } from './search/index.ts';
import { localDate, now as clockNow, safeTz } from './time.ts';

export type AgentEvent =
  | { type: 'meta'; conversationId: string; turnId: string; recalled: number; dateRefs: string[] }
  | { type: 'status'; text: string }
  | { type: 'search'; queries: string[]; round: number }
  | { type: 'sources'; sources: Source[] }
  | { type: 'text'; delta: string }
  | { type: 'done'; turnId: string; ms: number; firstTokenMs: number | null; searches: number }
  | { type: 'error'; message: string };

export interface TurnRequest {
  userId: string;
  conversationId?: string;
  message: string;
  tz?: string;
  signal?: AbortSignal;
  emit: (e: AgentEvent) => void;
}

function historyMessages(turns: Turn[]): { role: 'user' | 'assistant'; content: string }[] {
  // Prior turns go in as plain text: tool calls/results from old turns are dropped (they're large and
  // stale). The sources list is kept so "tell me more about the second link" still works.
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const t of turns) {
    out.push({ role: 'user', content: t.user });
    const refs = t.sources.length ? `\n\n(Sources behind that answer, numbered as cited then: ${t.sources.map((s) => `[${s.n}] ${s.url}`).join(' ')})` : '';
    out.push({ role: 'assistant', content: (t.assistant || '(no answer)') + refs });
  }
  return out;
}

export async function runTurn(req: TurnRequest): Promise<void> {
  const started = Date.now();
  const { userId, emit, signal } = req;
  const message = req.message.trim().slice(0, 8000);
  const tz = safeTz(req.tz);
  store.setTz(userId, tz);
  const now = clockNow();
  const today = localDate(now, tz);

  let conv = req.conversationId ? store.getConversation(userId, req.conversationId) : undefined;
  const isNew = !conv;
  conv ??= store.createConversation(userId, now);
  const turnId = newId('t');

  // --- 1. Context: recent history verbatim + recalled memory -------------------------------------
  const history = store.turnsOf(userId, conv.id).slice(-config.historyTurns);
  const mem = recall({
    message,
    today,
    allTurns: store.allTurns(userId),
    conversations: store.listConversations(userId),
    excludeIds: new Set(history.map((t) => t.id)),
  });
  const dateRefs = mem.dateRefs.map((d) => `${d.phrase} → ${d.from}${d.to !== d.from ? `..${d.to}` : ''}`);
  emit({ type: 'meta', conversationId: conv.id, turnId, recalled: mem.turnIds.length, dateRefs });

  const session = chatModel().startSession({
    staticSystem: STATIC_SYSTEM,
    dynamicSystem: dynamicSystem({ now, tz, today, memoryBlock: mem.block }),
    history: historyMessages(history),
    user: message,
    tool: webSearchTool,
  });

  // --- 2. Agent loop ----------------------------------------------------------------------------
  const registry = new SourceRegistry();
  const searches: Turn['searches'] = [];
  let answer = '';
  let firstTokenAt: number | null = null;

  try {
    for (let round = 0; ; round++) {
      const lastRound = round >= config.maxSearchRounds;
      if (round > 0 && answer && !answer.endsWith('\n')) {
        answer += '\n\n';
        emit({ type: 'text', delta: '\n\n' });
      }
      // After the round cap the model must answer with what it has: bounded latency.
      const calls = await session.step({
        allowTools: !lastRound,
        signal,
        onText: (delta) => {
          firstTokenAt ??= Date.now();
          answer += delta;
          emit({ type: 'text', delta });
        },
      });
      if (!calls.length) break;
      // Every call must get a result, even a hallucinated tool name, or the next request is invalid.
      const toolUses = calls.map((c) => (c.name === webSearchTool.name ? c : { ...c, input: { queries: [] } }));

      const allQueries = toolUses.flatMap((t) => ((t.input as WebSearchInput).queries ?? []).map(String));
      emit({ type: 'search', queries: allQueries, round });
      for (const q of allQueries) searches.push({ query: q, at: new Date().toISOString() });

      // All queries from all tool_use blocks hit the network concurrently; numbering happens after, in order.
      const raws = await Promise.all(toolUses.map((tu) => fetchWebSearch(tu.input as WebSearchInput, signal)));
      session.addToolResults(
        toolUses.map((tu, i) => {
          const { text, ok } = formatWebSearch(raws[i], registry, today);
          return { id: tu.id, content: ok ? text : `${text}\nLive search failed. Answer from what you know and say clearly that it could not be verified today.`, isError: !ok };
        }),
      );
      emit({ type: 'sources', sources: [...registry.list] });
    }
  } catch (err) {
    if (signal?.aborted) return;
    const m = (err as Error).message ?? String(err);
    emit({ type: 'error', message: /\b(401|403)\b|authentication|API key rejected/i.test(m) ? `The model API key was rejected. Check ${config.llmKeyVar} in .env.` : `Something went wrong: ${m.slice(0, 300)}` });
    if (!answer) return;
  }

  // --- 3. Persist, then distil off the critical path --------------------------------------------
  const turn: Turn = {
    id: turnId,
    conversationId: conv.id,
    ts: now.toISOString(),
    localDate: today,
    tz,
    user: message,
    assistant: answer.trim(),
    searches,
    sources: registry.list,
    trace: { dateRefs, recalled: mem.turnIds.length, ms: Date.now() - started, firstTokenMs: firstTokenAt ? firstTokenAt - started : null },
  };
  store.addTurn(userId, turn);
  emit({ type: 'done', turnId, ms: turn.trace!.ms, firstTokenMs: turn.trace!.firstTokenMs, searches: searches.length });
  void distillTurn(userId, turn, isNew || conv.title === 'New chat');
}
