import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';

let client: Anthropic | null = null;
export function llm(): Anthropic {
  return (client ??= new Anthropic({ apiKey: config.llmKey, maxRetries: 2 }));
}

/** Test seam: lets the offline e2e test swap in a scripted fake model. */
export function setLLM(fake: unknown) {
  client = fake as Anthropic;
}
