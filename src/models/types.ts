// The provider-neutral contract the agent loop is written against. Each provider keeps its own
// wire-format transcript internally (Anthropic thinking blocks, Gemini thought signatures, …) so the
// loop never has to know about them.

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  id: string;
  name: string;
  input: any;
}

export interface Session {
  /** One model call. Streams text through onText; returns tool calls ([] = final answer). */
  step(opts: { allowTools: boolean; onText: (delta: string) => void; signal?: AbortSignal }): Promise<ToolCall[]>;
  addToolResults(results: { id: string; content: string; isError: boolean }[]): void;
}

export interface ChatModel {
  readonly label: string;
  startSession(opts: {
    staticSystem: string; // identical every request → cacheable
    dynamicSystem: string; // date, calendar, memory
    history: { role: 'user' | 'assistant'; content: string }[];
    user: string;
    tool: ToolSpec;
  }): Session;
  /** Cheap structured extraction (memory distillation). */
  json(opts: { system: string; user: string; schema: Record<string, unknown> }): Promise<unknown>;
}

/** Tolerant JSON extraction for providers without a strict structured-output mode. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('model did not return JSON');
  }
}
