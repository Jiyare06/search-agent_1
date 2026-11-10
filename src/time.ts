// Time is a first-class input for this agent: half the test prompts are "on Monday…", "last Tuesday…",
// "on 3 November…". LLMs are unreliable at calendar arithmetic, so we resolve dates deterministically
// here and hand the model (a) a calendar table and (b) already-resolved date ranges.
import { config } from './config.ts';

export type DateKey = string; // YYYY-MM-DD in the user's timezone

export interface DateRange {
  phrase: string; // the text that produced it, e.g. "last Tuesday"
  from: DateKey;
  to: DateKey; // inclusive
  ambiguous?: boolean; // e.g. the "other" reading of "last Tuesday"
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function now(): Date {
  if (config.agentNow) {
    const d = new Date(config.agentNow);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export function safeTz(tz: string | undefined): string {
  if (!tz) return config.defaultTz;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return config.defaultTz;
  }
}

/** Calendar date of an instant, as seen in `tz`. */
export function localDate(d: Date, tz: string): DateKey {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function localTime(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

// Pure date-key arithmetic (done in UTC so DST never shifts a day).
const toUTC = (k: DateKey) => new Date(`${k}T00:00:00Z`);
const fromUTC = (d: Date): DateKey => d.toISOString().slice(0, 10);
export const addDays = (k: DateKey, n: number): DateKey => {
  const d = toUTC(k);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUTC(d);
};
export const weekdayOf = (k: DateKey): number => toUTC(k).getUTCDay();
export const weekdayName = (k: DateKey) => WEEKDAYS[weekdayOf(k)][0].toUpperCase() + WEEKDAYS[weekdayOf(k)].slice(1, 3);

export function prettyDate(k: DateKey): string {
  const d = toUTC(k);
  return `${WEEKDAYS[d.getUTCDay()][0].toUpperCase()}${WEEKDAYS[d.getUTCDay()].slice(1)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()][0].toUpperCase()}${MONTHS[d.getUTCMonth()].slice(1)} ${d.getUTCFullYear()}`;
}

/** Days between two keys (b - a). */
export const diffDays = (a: DateKey, b: DateKey) => Math.round((toUTC(b).getTime() - toUTC(a).getTime()) / 86_400_000);

/** A compact table of the last two weeks so the model never has to do weekday math itself. */
export function calendarBlock(today: DateKey, days = 14): string {
  const rows: string[] = [];
  for (let i = 0; i < days; i++) {
    const k = addDays(today, -i);
    const rel = i === 0 ? 'today' : i === 1 ? 'yesterday' : `${i} days ago`;
    rows.push(`${weekdayName(k)} ${k} (${rel})`);
  }
  return rows.join('\n');
}

const NUM_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, couple: 2, few: 3 };

/**
 * Extract past-oriented date references from a user message.
 * Bias: this agent is asked about things that already happened, so ambiguous dates resolve to the past.
 */
export function resolveDateRefs(text: string, today: DateKey): DateRange[] {
  const t = text.toLowerCase();
  const out: DateRange[] = [];
  const push = (r: DateRange) => {
    if (r.from > today) return; // never look into the future
    if (r.to > today) r.to = today;
    if (!out.some((o) => o.from === r.from && o.to === r.to)) out.push(r);
  };
  let m: RegExpExecArray | null;

  // ISO dates
  for (const mm of t.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) push({ phrase: mm[0], from: mm[0], to: mm[0] });

  // "3 November", "3rd of Nov", "November 3", "Nov 3rd, 2026"
  // Full names or abbreviations only, with a word boundary — "5 marketing tools" must not become 5 March.
  const mon = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\\.?(?![a-z])';
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${mon}(?:,?\\s+(20\\d{2}))?`, 'g');
  const monthDay = new RegExp(`\\b${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(20\\d{2}))?`, 'g');
  const absolute = (day: number, monStr: string, year: string | undefined, phrase: string) => {
    const mi = MONTHS.findIndex((x) => x.startsWith(monStr.slice(0, 3)));
    if (mi < 0 || day < 1 || day > 31) return;
    let y = year ? Number(year) : Number(today.slice(0, 4));
    let k = `${y}-${String(mi + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!year && k > today) k = `${--y}-${k.slice(5)}`; // "3 November" said in January means last year
    push({ phrase, from: k, to: k });
  };
  while ((m = dayMonth.exec(t))) absolute(Number(m[1]), m[2], m[3], m[0]);
  while ((m = monthDay.exec(t))) absolute(Number(m[2]), m[1], m[3], m[0]);

  // Bare "today" is usually about the present ("is it still correct today?"), not a memory reference.
  if (/\bthis (morning|afternoon|evening)\b|\bearlier today\b/.test(t)) push({ phrase: 'earlier today', from: today, to: today });
  if (/\bday before yesterday\b/.test(t)) push({ phrase: 'the day before yesterday', from: addDays(today, -2), to: addDays(today, -2) });
  else if (/\byesterday\b/.test(t)) push({ phrase: 'yesterday', from: addDays(today, -1), to: addDays(today, -1) });

  // "N days/weeks ago"
  const ago = /\b(\d+|a|an|one|two|three|four|five|six|seven|couple|few)\s+(?:of\s+)?(day|week|month)s?\s+ago\b/g;
  while ((m = ago.exec(t))) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUM_WORDS[m[1]];
    const unit = m[2] === 'day' ? 1 : m[2] === 'week' ? 7 : 30;
    const center = addDays(today, -n * unit);
    // "a week ago" is fuzzy: widen the window proportionally
    const slack = unit === 1 ? (m[1] === 'couple' || m[1] === 'few' ? 1 : 0) : unit === 7 ? 2 : 7;
    push({ phrase: m[0], from: addDays(center, -slack), to: addDays(center, slack) });
  }

  // Weekdays: "on Monday", "last Tuesday", "this Wednesday", bare "Friday"
  const wd = /\b(last|this|past|previous|on)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/g;
  while ((m = wd.exec(t))) {
    const target = WEEKDAYS.indexOf(m[2]);
    const todayWd = weekdayOf(today);
    let back = (todayWd - target + 7) % 7; // 0 = today
    const qualifier = m[1];
    if (back === 0 && (qualifier === 'last' || qualifier === 'previous' || qualifier === 'past')) back = 7;
    const k = addDays(today, -back);
    push({ phrase: m[0].trim(), from: k, to: k });
    // "last Tuesday" said on a Thursday is genuinely ambiguous (2 or 9 days ago). Offer both; recall decides.
    if ((qualifier === 'last' || qualifier === 'previous') && back > 0 && back < 7) {
      const k2 = addDays(k, -7);
      push({ phrase: `${m[0].trim()} (alternative reading)`, from: k2, to: k2, ambiguous: true });
    }
  }

  // Weeks / months
  const mondayOf = (k: DateKey) => addDays(k, -((weekdayOf(k) + 6) % 7));
  if (/\blast week\b|\bprevious week\b/.test(t)) {
    const thisMon = mondayOf(today);
    push({ phrase: 'last week', from: addDays(thisMon, -7), to: addDays(thisMon, -1) });
  }
  if (/\b(this|earlier this) week\b/.test(t)) push({ phrase: 'this week', from: mondayOf(today), to: today });
  if (/\blast month\b/.test(t)) {
    const [y, mo] = today.split('-').map(Number);
    const py = mo === 1 ? y - 1 : y;
    const pm = mo === 1 ? 12 : mo - 1;
    const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    push({ phrase: 'last month', from: `${py}-${String(pm).padStart(2, '0')}-01`, to: `${py}-${String(pm).padStart(2, '0')}-${last}` });
  }
  if (/\b(this|earlier this) month\b/.test(t)) push({ phrase: 'this month', from: `${today.slice(0, 8)}01`, to: today });
  return out;
}
