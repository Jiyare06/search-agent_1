// The OpenAI-compatible path (Gemini / Groq / Ollama): streamed tool-call deltas are reassembled,
// provider-specific fields (Gemini thought signatures) are echoed back, and tool results are wired by id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(os.tmpdir(), `agent-oai-${process.pid}.json`);
process.env.LLM_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = 'test';
process.env.TAVILY_API_KEY = 'test';
process.env.AGENT_NOW = '2026-11-10T09:00:00Z';

const requests: any[] = [];
const sseBody = (chunks: any[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

globalThis.fetch = (async (url: string, init: any) => {
  const body = JSON.parse(init.body);
  if (String(url).includes('tavily')) {
    return new Response(JSON.stringify({ results: [{ url: 'https://neon.com/pricing', title: 'Neon pricing', content: 'Launch $19/mo', published_date: '2026-11-01' }] }));
  }
  requests.push(body);
  if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"title":"Neon","summary":"s","facts":[]}\n```' } }] }));
  if (requests.filter((r) => r.stream).length === 1) {
    // Tool call streamed in pieces, with a Gemini-style thought signature attached.
    return sseBody([
      { choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"queries":["neon' }, extra_content: { google: { thought_signature: 'SIG' } } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' pricing"]}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
  }
  return sseBody([{ choices: [{ delta: { content: 'Neon Launch is ' } }] }, { choices: [{ delta: { content: '$19/month [1].' } }] }]);
}) as typeof fetch;

const { runTurn } = await import('../src/agent.ts');

test('gemini/openai-compatible tool loop', async () => {
  const events: any[] = [];
  await runTurn({ userId: 'u', message: 'Neon pricing?', tz: 'UTC', emit: (e) => events.push(e) });
  assert.ok(events.some((e) => e.type === 'done'), JSON.stringify(events));
  assert.deepEqual(events.find((e) => e.type === 'search').queries, ['neon pricing']);
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'Neon Launch is $19/month [1].');

  const second = requests.filter((r) => r.stream)[1];
  assert.equal(second.model, 'gemini-3.5-flash-lite');
  const assistant = second.messages.at(-2);
  assert.equal(assistant.tool_calls[0].function.arguments, '{"queries":["neon pricing"]}');
  assert.equal(assistant.tool_calls[0].extra_content.google.thought_signature, 'SIG'); // echoed back
  const tool = second.messages.at(-1);
  assert.equal(tool.role, 'tool');
  assert.equal(tool.tool_call_id, 'call_1');
  assert.match(tool.content, /\[1\] Neon pricing/);
  assert.equal(requests[0].tool_choice, 'auto');
});
