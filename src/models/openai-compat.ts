// OpenAI-compatible Chat Completions (Gemini, Groq, OpenRouter, OpenAI, Ollama, LM Studio…).
// Plain fetch + a small SSE parser: no extra SDK, and full control over the streamed tool-call deltas.
import { config } from '../config.ts';
import { parseJsonLoose, type ChatModel, type Session, type ToolCall } from './types.ts';

type Msg = Record<string, any>;

async function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.llmKey) headers.authorization = `Bearer ${config.llmKey}`;
  // Free tiers rate-limit aggressively: retry 429/5xx twice, honouring Retry-After (capped).
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${config.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (res.ok) return res;
    const retryable = res.status === 429 || res.status >= 500;
    const text = await res.text().catch(() => '');
    if (!retryable || attempt >= 2) {
      const hint = res.status === 429 ? ' (rate limit / free-tier quota reached — wait a minute or switch MODEL)' : res.status === 401 || res.status === 403 ? ' (API key rejected)' : '';
      throw new Error(`LLM HTTP ${res.status}${hint}: ${text.slice(0, 300)}`);
    }
    const wait = Math.min(Number(res.headers.get('retry-after')) * 1000 || 1500 * (attempt + 1), 8000);
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** Yields parsed `data:` payloads from an SSE body. */
async function* sse(res: Response): AsyncGenerator<any> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data);
      } catch {
        /* keep-alive or partial noise */
      }
    }
  }
}

/** Merge a streamed tool-call delta. Unknown fields (e.g. Gemini's thought signature) are preserved. */
function mergeToolDelta(acc: Msg, d: Msg) {
  for (const [k, v] of Object.entries(d)) {
    if (k === 'index') continue;
    if (k === 'function') {
      acc.function ??= { name: '', arguments: '' };
      if (v.name) acc.function.name = acc.function.name || v.name;
      if (v.arguments) acc.function.arguments += v.arguments;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      acc[k] = { ...(acc[k] ?? {}), ...v };
    } else if (v !== null && v !== undefined && v !== '') {
      acc[k] = v;
    }
  }
}

export const openAICompatModel: ChatModel = {
  label: `${config.provider}/${config.model}`,

  startSession({ staticSystem, dynamicSystem, history, user, tool }): Session {
    const messages: Msg[] = [
      // One system message; static part first so providers with automatic prefix caching can reuse it.
      { role: 'system', content: `${staticSystem}\n\n${dynamicSystem}` },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: user },
    ];
    const tools = [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }];

    return {
      async step({ allowTools, onText, signal }) {
        const body: Record<string, unknown> = { model: config.model, messages, stream: true, tools, tool_choice: allowTools ? 'auto' : 'none' };
        if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;
        const res = await post(body, signal);

        let content = '';
        const calls: Msg[] = [];
        for await (const chunk of sse(res)) {
          if (chunk.error) throw new Error(`LLM stream error: ${JSON.stringify(chunk.error).slice(0, 300)}`);
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;
          if (typeof delta.content === 'string' && delta.content) {
            content += delta.content;
            onText(delta.content);
          }
          for (const tc of delta.tool_calls ?? []) {
            const idx = typeof tc.index === 'number' ? tc.index : calls.length;
            calls[idx] ??= { type: 'function' };
            mergeToolDelta(calls[idx], tc);
          }
        }

        const valid = calls.filter((c) => c?.function?.name);
        if (!valid.length) return [];
        valid.forEach((c, i) => (c.id ||= `call_${Date.now()}_${i}`)); // some providers omit ids
        messages.push({ role: 'assistant', content: content || null, tool_calls: valid });
        return valid.map<ToolCall>((c) => {
          let input: any;
          try {
            input = c.function.arguments ? JSON.parse(c.function.arguments) : {};
          } catch {
            input = { queries: [] }; // malformed arguments → empty search; the model sees "No queries" and recovers
          }
          return { id: c.id, name: c.function.name, input };
        });
      },
      addToolResults(results) {
        for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      },
    };
  },

  async json({ system, user, schema }) {
    // No response_format: JSON mode support varies across compatible servers. Ask, then parse tolerantly.
    const res = await post({
      model: config.fastModel,
      messages: [
        { role: 'system', content: `${system}\n\nReply with ONLY a JSON object matching this JSON Schema, no prose:\n${JSON.stringify(schema)}` },
        { role: 'user', content: user },
      ],
    });
    const json: any = await res.json();
    return parseJsonLoose(json.choices?.[0]?.message?.content ?? '');
  },
};
