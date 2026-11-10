// Native Anthropic Messages API: prompt caching on the static system prompt, effort control,
// adaptive thinking (thinking blocks are echoed back verbatim, as the API requires in tool loops).
import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';
import { llm } from './anthropic-client.ts';
import type { ChatModel, Session, ToolCall } from './types.ts';

export const anthropicModel: ChatModel = {
  label: `anthropic/${config.model}`,

  startSession({ staticSystem, dynamicSystem, history, user, tool }): Session {
    const system: Anthropic.TextBlockParam[] = [
      { type: 'text', text: staticSystem, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: dynamicSystem },
    ];
    const messages: Anthropic.MessageParam[] = [...history.map((h) => ({ role: h.role, content: h.content })), { role: 'user', content: user }];
    const tools = [{ name: tool.name, description: tool.description, input_schema: tool.parameters } as Anthropic.Tool];

    return {
      async step({ allowTools, onText, signal }) {
        const stream = llm().messages.stream(
          {
            model: config.model,
            max_tokens: 16_000,
            system,
            tools,
            tool_choice: allowTools ? { type: 'auto' } : { type: 'none' },
            messages,
            output_config: { effort: config.effort },
          } as Anthropic.MessageStreamParams,
          { signal },
        );
        stream.on('text', onText);
        const msg = await stream.finalMessage();
        const calls: ToolCall[] = msg.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name, input: b.input }));
        if (msg.stop_reason !== 'tool_use' || !calls.length) return [];
        messages.push({ role: 'assistant', content: msg.content });
        return calls;
      },
      addToolResults(results) {
        messages.push({
          role: 'user',
          content: results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.content, is_error: r.isError })),
        });
      },
    };
  },

  async json({ system, user, schema }) {
    const res = await llm().messages.create({
      model: config.fastModel,
      max_tokens: 2500,
      system,
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: user }],
    } as any);
    const text = (res.content as any[]).find((b) => b.type === 'text')?.text ?? '{}';
    return JSON.parse(text);
  },
};
