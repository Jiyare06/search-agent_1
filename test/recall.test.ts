import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recall, hasRecallCue, rank } from '../src/memory/recall.ts';
import type { Turn, Conversation } from '../src/memory/store.ts';

const TODAY = '2026-11-10';
const conv = (id: string, title: string): Conversation => ({ id, title, createdAt: '', updatedAt: '' });
const turn = (id: string, c: string, date: string, user: string, assistant: string, extra: Partial<Turn> = {}): Turn => ({
  id, conversationId: c, ts: `${date}T10:00:00Z`, localDate: date, tz: 'UTC', user, assistant, searches: [], sources: [], ...extra,
});

const turns = [
  turn('t1', 'c1', '2026-11-03', 'What are the cheapest managed Postgres hosting options?', 'Neon free tier, Supabase Pro at $25/month...', {
    facts: [{ subject: 'Supabase', claim: 'Pro plan $25/month', kind: 'price', asOf: '2026-11-03' }],
  }),
  turn('t2', 'c2', '2026-11-09', 'We shortlisted HubSpot, Pipedrive, Close, Attio and Salesforce for our 20-person sales team', 'Good shortlist...'),
  turn('t3', 'c3', '2026-11-05', 'Recipe for banana bread', 'Here is a recipe...'),
];
const convs = [conv('c1', 'Postgres hosting'), conv('c2', 'CRM shortlist'), conv('c3', 'Banana bread')];

test('date reference pulls that day, with facts', () => {
  const r = recall({ message: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', today: TODAY, allTurns: turns, conversations: convs, excludeIds: new Set() });
  assert.deepEqual(r.turnIds, ['t1']);
  assert.match(r.block, /Supabase: Pro plan \$25\/month/);
  assert.match(r.block, /Tuesday 3 November 2026/);
});

test('topical recall without a date', () => {
  const r = recall({ message: 'Has any of the CRM tools we shortlisted changed pricing?', today: TODAY, allTurns: turns, conversations: convs, excludeIds: new Set() });
  assert.ok(r.turnIds.includes('t2'));
  assert.ok(!r.turnIds.includes('t3'));
});

test('explicit "no record" instead of a hallucination invitation', () => {
  const r = recall({ message: 'What did I ask you on 1 November?', today: TODAY, allTurns: turns, conversations: convs, excludeIds: new Set() });
  assert.match(r.block, /Sunday 1 November 2026: NO conversation on record/);
});

test('empty history is stated', () => {
  const r = recall({ message: 'What did I ask you on 3 November?', today: TODAY, allTurns: [], conversations: [], excludeIds: new Set() });
  assert.match(r.block, /no earlier conversation history/);
});

test('recall cue detection', () => {
  assert.ok(hasRecallCue('What did I ask you on 3 November?'));
  assert.ok(hasRecallCue('Is your answer still correct today?'));
  assert.ok(!hasRecallCue('What is the capital of Peru?'));
});

test('bm25 ignores irrelevant turns', () => {
  assert.equal(rank('quantum chromodynamics', turns).length, 0);
});
