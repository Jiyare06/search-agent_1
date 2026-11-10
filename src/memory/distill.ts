// After each answer is streamed, a cheap model distils it into a one-line summary and a list of
// checkable facts. This runs off the critical path: the user never waits for it.
import { chatModel } from '../models/index.ts';
import { config } from '../config.ts';
import { store, type Fact, type Turn } from './store.ts';

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'A 2-6 word title for the conversation, only meaningful for the first turn.' },
    summary: { type: 'string', description: 'One sentence: what the user asked and the gist of the answer.' },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subject: { type: 'string' },
          claim: { type: 'string' },
          kind: { type: 'string', enum: ['price', 'feature', 'release', 'policy', 'stat', 'user_context', 'other'] },
          sourceUrl: { type: 'string' },
        },
        required: ['subject', 'claim', 'kind', 'sourceUrl'],
      },
    },
  },
  required: ['title', 'summary', 'facts'],
};

const INSTRUCTIONS = `Extract memory from one chat turn so a future assistant can (a) recall what was discussed and (b) check later whether the facts changed.
- facts: concrete, independently checkable claims made in the ANSWER (prices with units and plan names, features shipped, release dates, numbers, policies). One claim per item, keep numbers exact. Include sourceUrl when a citation backed it, else "".
- Also add facts of kind "user_context" for things the USER stated about themselves or their situation (team size, shortlisted options, constraints, decisions). Name every item in a list the user gave.
- Skip opinions and generic advice. 0-15 facts.`;

export async function distillTurn(userId: string, turn: Turn, needsTitle: boolean): Promise<void> {
  try {
    const sources = turn.sources.map((s) => `[${s.n}] ${s.url}`).join('\n');
    if (!config.distill) throw new Error('disabled (DISTILL=off)');
    const out = (await chatModel().json({
      system: INSTRUCTIONS,
      schema,
      user: `Date: ${turn.localDate}\n\nUSER:\n${turn.user}\n\nANSWER:\n${turn.assistant}\n\nSOURCES:\n${sources || '(none)'}`,
    })) as { title?: string; summary?: string; facts?: Omit<Fact, 'asOf'>[] };
    store.patchTurn(userId, turn.id, {
      summary: typeof out.summary === 'string' ? out.summary.slice(0, 300) : undefined,
      facts: (Array.isArray(out.facts) ? out.facts : []).filter((f) => f?.subject && f?.claim).slice(0, 20).map((f) => ({ ...f, sourceUrl: f.sourceUrl || undefined, asOf: turn.localDate })),
    });
    if (needsTitle && typeof out.title === 'string' && out.title) store.renameConversation(userId, turn.conversationId, out.title.slice(0, 60));
  } catch (err) {
    // Memory still works without distillation (recall falls back to the raw answer text).
    console.warn('[distill] skipped:', (err as Error).message);
    if (needsTitle) store.renameConversation(userId, turn.conversationId, turn.user.slice(0, 48));
  }
}
