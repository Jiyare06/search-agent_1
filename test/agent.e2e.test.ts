// Offline end-to-end: a scripted fake model + stubbed search API exercise the real agent loop,
// persistence, recall injection and citation numbering. No network, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(os.tmpdir(), `agent-e2e-${process.pid}.json`);
process.env.TAVILY_API_KEY = 'test';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.LLM_PROVIDER = 'anthropic';
process.env.AGENT_NOW = '2026-11-10T09:00:00Z';

const { setLLM } = await import('../src/models/anthropic-client.ts');
const { runTurn } = await import('../src/agent.ts');
const { store } = await import('../src/memory/store.ts');

const calls: any[] = [];
function fakeStream(script: (params: any) => any) {
  return {
    messages: {
      stream(params: any) {
        calls.push(structuredClone(params));
        const msg = script(params);
        const handlers: ((d: string) => void)[] = [];
        return {
          on(ev: string, fn: (d: string) => void) {
            if (ev === 'text') handlers.push(fn);
            return this;
          },
          async finalMessage() {
            for (const b of msg.content) if (b.type === 'text') for (const chunk of b.text.match(/.{1,8}/gs) ?? []) handlers.forEach((h) => h(chunk));
            return msg;
          },
        };
      },
      async create() {
        return { content: [{ type: 'text', text: JSON.stringify({ title: 'Postgres pricing', summary: 'Asked about Postgres hosting prices.', facts: [{ subject: 'Supabase', claim: 'Pro plan is $25/month', kind: 'price', sourceUrl: 'https://supabase.com/pricing' }] }) }] };
      },
    },
  };
}

globalThis.fetch = (async (_url: string, init: any) => {
  const body = JSON.parse(init.body);
  return new Response(
    JSON.stringify({
      results: [
        { url: 'https://supabase.com/pricing', title: 'Supabase Pricing', content: `Pro $25/mo (${body.query})`, published_date: '2026-11-01' },
        { url: 'https://neon.com/pricing', title: 'Neon Pricing', content: 'Launch $19/mo' },
      ],
    }),
    { status: 200 },
  );
}) as typeof fetch;

test('search round-trip, citations, persistence, then dated recall', async () => {
  store.reset();
  // Turn 1, "last Tuesday": model searches with two queries, then answers citing [1].
  process.env.AGENT_NOW = '2026-11-03T09:00:00Z';
  const { config } = await import('../src/config.ts');
  config.agentNow = '2026-11-03T09:00:00Z';
  setLLM(
    fakeStream((p) =>
      p.messages.at(-1).role === 'user' && typeof p.messages.at(-1).content === 'string'
        ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'web_search', input: { queries: ['supabase pricing', 'neon pricing'] } }] }
        : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Supabase Pro is $25/month [1]; Neon Launch is $19/month [2].' }] },
    ),
  );
  const events: any[] = [];
  await runTurn({ userId: 'u', message: 'Cheapest managed Postgres hosting?', tz: 'UTC', emit: (e) => events.push(e) });
  const done = events.find((e) => e.type === 'done');
  assert.ok(done, JSON.stringify(events.filter((e) => e.type === 'error')));
  assert.deepEqual(events.find((e) => e.type === 'search').queries, ['supabase pricing', 'neon pricing']);
  const srcs = events.findLast((e) => e.type === 'sources').sources;
  assert.deepEqual(srcs.map((s: any) => s.n), [1, 2]); // de-duplicated across both queries
  const toolResult = calls[1].messages.at(-1).content[0].content as string;
  assert.match(toolResult, /\[1\] Supabase Pricing/);
  assert.match(toolResult, /Results retrieved 2026-11-03/);

  await new Promise((r) => setTimeout(r, 20)); // background distillation
  const t1 = store.allTurns('u')[0];
  assert.equal(t1.localDate, '2026-11-03');
  assert.equal(t1.facts?.[0].claim, 'Pro plan is $25/month');
  assert.equal(store.listConversations('u')[0].title, 'Postgres pricing');

  // Turn 2, a week later in a NEW chat: memory must be injected with the resolved date.
  config.agentNow = '2026-11-10T09:00:00Z';
  calls.length = 0;
  setLLM(fakeStream(() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'On 3 Nov you asked about Postgres hosting.' }] })));
  await runTurn({ userId: 'u', message: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', tz: 'UTC', emit: () => {} });
  const sys = calls[0].system.map((b: any) => b.text).join('\n');
  assert.match(sys, /"last tuesday" → Tuesday 3 November 2026: 1 message\(s\) found/);
  assert.match(sys, /\[price\] Supabase: Pro plan is \$25\/month/);
  assert.match(sys, /Current date and time: Tuesday 10 November 2026/);
  assert.equal(calls[0].system[0].cache_control.type, 'ephemeral'); // static prompt is cached
  assert.equal(calls[0].messages.length, 1); // new chat: no stale history, memory comes via recall
});

test('round cap forces an answer', async () => {
  store.reset();
  calls.length = 0;
  setLLM(
    fakeStream((p) =>
      p.tool_choice.type === 'none'
        ? { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Best effort answer.' }] }
        : { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu${calls.length}`, name: 'web_search', input: { queries: [`q${calls.length}`] } }] },
    ),
  );
  const events: any[] = [];
  await runTurn({ userId: 'u', message: 'loop forever', tz: 'UTC', emit: (e) => events.push(e) });
  assert.equal(calls.length, 4); // 3 search rounds + 1 forced answer
  assert.equal(events.filter((e) => e.type === 'search').length, 3);
  assert.ok(events.some((e) => e.type === 'done'));
});
