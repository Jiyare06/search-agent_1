import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDateRefs, localDate, calendarBlock, addDays } from '../src/time.ts';

// Tuesday 10 Nov 2026
const TODAY = '2026-11-10';
const ranges = (s: string) => resolveDateRefs(s, TODAY).map((r) => `${r.from}..${r.to}${r.ambiguous ? '?' : ''}`);

test('absolute dates resolve to the past', () => {
  assert.deepEqual(ranges('What did I ask you on 3 November?'), ['2026-11-03..2026-11-03']);
  assert.deepEqual(ranges('on Nov 3rd'), ['2026-11-03..2026-11-03']);
  assert.deepEqual(ranges('back on December 20'), ['2025-12-20..2025-12-20']); // future → last year
  assert.deepEqual(ranges('on 2026-10-01'), ['2026-10-01..2026-10-01']);
});

test('weekdays resolve to the most recent past occurrence', () => {
  assert.deepEqual(ranges('On Monday we shortlisted 5 CRM tools'), ['2026-11-09..2026-11-09']);
  // said on a Tuesday, "last Tuesday" means a week ago
  assert.deepEqual(ranges('Last Tuesday I asked you about Postgres hosting'), ['2026-11-03..2026-11-03']);
  // said on a Tuesday, "last Friday" is ambiguous: 4 days ago, or 11
  assert.deepEqual(ranges('last Friday'), ['2026-11-06..2026-11-06', '2026-10-30..2026-10-30?']);
});

test('relative phrases', () => {
  assert.deepEqual(ranges('yesterday'), ['2026-11-09..2026-11-09']);
  assert.deepEqual(ranges('2 days ago'), ['2026-11-08..2026-11-08']);
  assert.deepEqual(ranges('last week'), ['2026-11-02..2026-11-08']);
  assert.deepEqual(ranges('last month'), ['2026-10-01..2026-10-31']);
});

test('no false positives on numbers and words', () => {
  assert.deepEqual(ranges('Compare 5 marketing tools for a 20-person sales team'), []);
  assert.deepEqual(ranges('Best Postgres hosting?'), []);
});

test('timezone decides the calendar day', () => {
  const instant = new Date('2026-11-09T20:00:00Z');
  assert.equal(localDate(instant, 'Asia/Kolkata'), '2026-11-10'); // already Tuesday in India
  assert.equal(localDate(instant, 'America/New_York'), '2026-11-09');
});

test('calendar table and date math', () => {
  assert.match(calendarBlock(TODAY, 3), /^Tue 2026-11-10 \(today\)\nMon 2026-11-09 \(yesterday\)/);
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});
