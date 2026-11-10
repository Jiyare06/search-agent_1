// Live smoke-eval against the real model + search API. Prints latency and the answer for each prompt.
// Usage: npm run seed -- --reset && npm run eval
// Uses the same store as the app, so turns it creates show up in the UI afterwards.
import { missingKeys } from '../src/config.ts';
import { runTurn } from '../src/agent.ts';
import { store } from '../src/memory/store.ts';

const PROMPTS = [
  'Hi! What can you do?', // should NOT search
  'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
  'What did I ask you on 3 November? Is your answer still correct today?',
  'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
  'What did I ask you on 14 February?', // must admit there is no record
  'Who won the most recent Formula 1 race?', // fresh news
];

if (missingKeys().length) {
  console.error(`Missing: ${missingKeys().join(', ')}`);
  process.exit(1);
}
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

for (const message of PROMPTS) {
  let text = '';
  let searches: string[] = [];
  let meta = '';
  let stats = '';
  await runTurn({
    userId: 'local',
    message,
    tz,
    emit: (e) => {
      if (e.type === 'text') text += e.delta;
      if (e.type === 'search') searches.push(...e.queries);
      if (e.type === 'meta') meta = `recalled=${e.recalled} dates=[${e.dateRefs.join(', ')}]`;
      if (e.type === 'done') stats = `total=${(e.ms / 1000).toFixed(1)}s first-token=${e.firstTokenMs ? (e.firstTokenMs / 1000).toFixed(1) + 's' : '-'}`;
      if (e.type === 'error') text += `\n[error] ${e.message}`;
    },
  });
  console.log(`\n${'='.repeat(100)}\n> ${message}\n${meta} | ${stats} | searches: ${searches.length ? searches.map((q) => `"${q}"`).join(', ') : 'none'}\n${'-'.repeat(100)}\n${text}`);
}
await new Promise((r) => setTimeout(r, 3000)); // let background distillation finish
store.flush();
