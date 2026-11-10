import { config } from '../config.ts';
import { anthropicModel } from './anthropic.ts';
import { openAICompatModel } from './openai-compat.ts';
import type { ChatModel } from './types.ts';

export function chatModel(): ChatModel {
  return config.provider === 'anthropic' ? anthropicModel : openAICompatModel;
}
export type { ChatModel, ToolSpec, ToolCall, Session } from './types.ts';
