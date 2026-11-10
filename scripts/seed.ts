// Seeds a few *synthetic* past conversations, dated relative to today, so the memory features can be
// tried immediately ("On Monday we shortlisted…", "Last Tuesday I asked about Postgres…").
// Titles are prefixed with [demo]. The prices are illustrative snapshots, not verified facts —
// which is exactly what the agent should catch when asked "has anything changed since?".
// Usage: npm run seed            (adds demo history)
//        npm run seed -- --reset (wipes the store first)
import { store, newId, type Turn, type Fact } from '../src/memory/store.ts';
import { addDays, localDate, now, safeTz, weekdayOf } from '../src/time.ts';

const tz = safeTz(process.env.SEED_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone);
const today = localDate(now(), tz);
const lastWeekday = (wd: number, minBack = 1) => {
  let k = addDays(today, -minBack);
  while (weekdayOf(k) !== wd) k = addDays(k, -1);
  return k;
};
const USER = 'local';
if (process.argv.includes('--reset')) store.reset();

function seed(date: string, title: string, user: string, assistant: string, facts: Omit<Fact, 'asOf'>[], sources: { url: string; title: string }[]) {
  const at = new Date(`${date}T10:30:00Z`);
  const conv = store.createConversation(USER, at);
  store.renameConversation(USER, conv.id, `[demo] ${title}`);
  const turn: Turn = {
    id: newId('t'),
    conversationId: conv.id,
    ts: at.toISOString(),
    localDate: date,
    tz,
    user,
    assistant,
    searches: [],
    sources: sources.map((s, i) => ({ n: i + 1, ...s })),
    summary: `${title}`,
    facts: facts.map((f) => ({ ...f, asOf: date })),
  };
  store.addTurn(USER, turn);
  console.log(`  ${date}  [demo] ${title}`);
}

console.log(`Seeding demo history (today = ${today}, tz = ${tz}):`);

seed(
  lastWeekday(2, 1), // most recent Tuesday before today
  'Managed Postgres hosting',
  'What are good managed Postgres hosting options for a small SaaS? Compare entry pricing.',
  `For a small SaaS, the usual shortlist is **Neon**, **Supabase**, **AWS RDS**, **Render** and **DigitalOcean Managed Postgres** [1][2].

| Provider | Entry paid plan (at the time) |
|---|---|
| Neon | Launch plan, usage-based from about $19/month |
| Supabase | Pro plan $25/month per org, includes compute credits |
| Render | Basic Postgres from about $6/month |
| DigitalOcean | Managed Postgres from about $15/month |
| AWS RDS | db.t4g.micro on-demand, roughly $12-15/month plus storage |

If you want branching and scale-to-zero, Neon; if you want auth/storage bundled, Supabase.`,
  [
    { subject: 'Neon', claim: 'Launch plan usage-based from about $19/month', kind: 'price', sourceUrl: 'https://neon.com/pricing' },
    { subject: 'Supabase', claim: 'Pro plan $25/month per organization', kind: 'price', sourceUrl: 'https://supabase.com/pricing' },
    { subject: 'Render', claim: 'Basic Postgres from about $6/month', kind: 'price', sourceUrl: 'https://render.com/pricing' },
    { subject: 'DigitalOcean Managed Postgres', claim: 'From about $15/month', kind: 'price', sourceUrl: 'https://www.digitalocean.com/pricing/managed-databases' },
    { subject: 'AWS RDS for PostgreSQL', claim: 'db.t4g.micro roughly $12-15/month plus storage', kind: 'price', sourceUrl: 'https://aws.amazon.com/rds/postgresql/pricing/' },
  ],
  [
    { url: 'https://neon.com/pricing', title: 'Neon pricing' },
    { url: 'https://supabase.com/pricing', title: 'Supabase pricing' },
  ],
);

seed(
  lastWeekday(1, 1), // most recent Monday before today
  'CRM shortlist for sales team',
  'We are a 20-person sales team. Help us shortlist 5 CRM tools. We care about pipeline management, email sequences and a sane price per seat.',
  `Here's a 5-tool shortlist for a 20-seat sales team:

1. **HubSpot Sales Hub** (Professional) — strongest all-rounder; about $90/seat/month at the time.
2. **Pipedrive** — simplest pipeline UX; Growth/Premium tiers about $49-64/seat/month.
3. **Salesforce Sales Cloud** (Enterprise) — most configurable; about $165/seat/month.
4. **Close** — built-in calling and sequences; about $49-109/seat/month.
5. **Attio** — modern, flexible data model; Pro about $69/seat/month.

For 20 seats, Pipedrive or Close is likely the best value; HubSpot if you also want marketing.`,
  [
    { subject: 'User team', claim: '20-person sales team; priorities are pipeline management, email sequences, price per seat', kind: 'user_context' },
    { subject: 'Shortlist', claim: 'HubSpot Sales Hub, Pipedrive, Salesforce Sales Cloud, Close, Attio', kind: 'user_context' },
    { subject: 'HubSpot Sales Hub Professional', claim: 'about $90/seat/month', kind: 'price' },
    { subject: 'Pipedrive', claim: 'about $49-64/seat/month on Growth/Premium tiers', kind: 'price' },
    { subject: 'Salesforce Sales Cloud Enterprise', claim: 'about $165/seat/month', kind: 'price' },
    { subject: 'Close', claim: 'about $49-109/seat/month', kind: 'price' },
    { subject: 'Attio Pro', claim: 'about $69/seat/month', kind: 'price' },
  ],
  [],
);

store.flush();
console.log('Done. Start the app with `npm run dev`.');
