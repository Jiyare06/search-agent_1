// Vanilla JS client: three views (chat, how it works, memory), SSE streaming, citations, live trace.
const $ = (s, el = document) => el.querySelector(s);
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const state = { conversationId: null, streaming: false, controller: null };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const domain = (u) => {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
};
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtKey = (k) => new Date(`${k}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const prettyRef = (r) => r.replace(/(\d{4})-(\d{2})-(\d{2})/g, (_, y, m, d) => new Date(`${y}-${m}-${d}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));

/* ------------------------------------------------------------------ the cat (original drawing) */
// variant: "full" (sitting, tail wags), "head" (logo / avatar), "sleepy" (empty states)
function catSvg(variant = 'full', size = 120) {
  const head = variant === 'head';
  const sleepy = variant === 'sleepy';
  const eyes = sleepy
    ? '<path d="M45 50 q4 3 8 0 M63 50 q4 3 8 0" stroke="#000" stroke-width="2.6" fill="none" stroke-linecap="round"/>'
    : '<g class="blink"><ellipse cx="49" cy="49" rx="3.2" ry="4" fill="#000"/><ellipse cx="67" cy="49" rx="3.2" ry="4" fill="#000"/><circle cx="50.2" cy="47.6" r="1" fill="#fff"/><circle cx="68.2" cy="47.6" r="1" fill="#fff"/></g>';
  const face = `
    <path d="M37 38 L33 14 L54 29 Z" fill="#fff" stroke="#000" stroke-width="3" stroke-linejoin="round"/>
    <path d="M79 38 L83 14 L62 29 Z" fill="#fff" stroke="#000" stroke-width="3" stroke-linejoin="round"/>
    <path d="M39 32 L37 21 L47 29 Z" fill="#ff8133"/><path d="M77 32 L79 21 L69 29 Z" fill="#ff8133"/>
    <circle cx="58" cy="50" r="24" fill="#fff" stroke="#000" stroke-width="3"/>
    <ellipse cx="42" cy="57" rx="4.5" ry="2.6" fill="#ffc9a6"/><ellipse cx="74" cy="57" rx="4.5" ry="2.6" fill="#ffc9a6"/>
    ${eyes}
    <path d="M55.5 55.5 h5 l-2.5 3 z" fill="#ff8133"/>
    <path d="M54 61 q2 2.2 4 0 q2 2.2 4 0" stroke="#000" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  if (head) return `<svg class="cat" viewBox="30 10 56 66" width="${size}" height="${size}" aria-hidden="true">${face}</svg>`;
  return `<svg class="cat" viewBox="0 0 120 120" width="${size}" height="${size}" aria-hidden="true">
    <path class="tail" d="M78 98 C104 100 110 74 96 62" stroke="#000" stroke-width="6" fill="none" stroke-linecap="round"/>
    <path class="tail" d="M78 98 C104 100 110 74 96 62" stroke="#ff8133" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-dasharray="4 7"/>
    <ellipse cx="58" cy="90" rx="27" ry="22" fill="#fff" stroke="#000" stroke-width="3"/>
    <ellipse cx="47" cy="109" rx="7" ry="4.5" fill="#fff" stroke="#000" stroke-width="2.6"/>
    <ellipse cx="69" cy="109" rx="7" ry="4.5" fill="#fff" stroke="#000" stroke-width="2.6"/>
    ${face}</svg>`;
}

/* ------------------------------------------------------------------ rendering helpers */
function renderMarkdown(text, sources) {
  const byN = new Map((sources || []).map((s) => [s.n, s]));
  let html = DOMPurify.sanitize(marked.parse(text || '', { gfm: true }));
  html = html.replace(/\[(\d{1,3})\](?![^<]*<\/a>)/g, (m, n) => {
    const s = byN.get(Number(n));
    return s ? `<a class="cite" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.title)} — ${esc(domain(s.url))}">${n}</a>` : m;
  });
  return html;
}

function sourcesHtml(sources, text) {
  if (!sources?.length) return '';
  const cited = sources.filter((s) => text.includes(`[${s.n}]`));
  const list = cited.length ? cited : sources.slice(0, 5);
  return `<div class="sources">${list.map((s) => `<a class="source" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.title)}"><b>${s.n}</b><span>${esc(domain(s.url))} · ${esc(s.title)}</span></a>`).join('')}</div>`;
}

/** "How I got this": the same pipeline as the How-it-works page, filled with this answer's real data. */
function traceHtml({ dateRefs = [], recalled = 0, queries = [], sources = [], ms, firstTokenMs }) {
  const chips = [];
  if (dateRefs.length) chips.push(`<span class="chip">${esc(prettyRef(dateRefs[0]))}</span>`);
  chips.push(`<span class="chip">${recalled} memor${recalled === 1 ? 'y' : 'ies'}</span>`);
  chips.push(`<span class="chip">${queries.length ? `${queries.length} search${queries.length > 1 ? 'es' : ''}` : 'no search needed'}</span>`);
  if (sources.length) chips.push(`<span class="chip">${sources.length} sources</span>`);
  if (ms) chips.push(`<span class="chip">${(ms / 1000).toFixed(1)}s</span>`);
  const steps = [
    `<li><span class="out">Recall</span>${dateRefs.length ? `Resolved ${dateRefs.map((d) => `<code>${esc(prettyRef(d))}</code>`).join(', ')}. ` : ''}${recalled ? `Pulled ${recalled} earlier message${recalled > 1 ? 's' : ''} from memory.` : 'Nothing relevant in memory.'}</li>`,
    `<li><span class="out">Search</span>${queries.length ? queries.map((q) => `<q>${esc(q)}</q>`).join(', ') : 'Answered without searching: nothing here changes over time.'}</li>`,
    sources.length ? `<li><span class="out">Read</span>${sources.length} pages, e.g. ${sources.slice(0, 3).map((s) => esc(domain(s.url))).join(', ')}</li>` : '',
    ms ? `<li><span class="out">Answer</span>First words after ${firstTokenMs ? (firstTokenMs / 1000).toFixed(1) + 's' : '—'}, finished in ${(ms / 1000).toFixed(1)}s.</li>` : '',
  ].join('');
  return `<details class="trace"><summary><span class="why">How I got this</span>${chips.join('')}</summary><ol>${steps}</ol></details>`;
}

function scrollDown(force) {
  const m = $('#messages');
  if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 160) m.scrollTop = m.scrollHeight;
}

/* ------------------------------------------------------------------ hero / empty state */
const ROUTES = [
  { tag: 'Check what changed', title: 'Has anything changed since we talked?', prompt: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', desc: 'I compare what I told you then with today’s web, item by item.' },
  { tag: 'Recall a past chat', title: 'What did I ask you on a given day?', prompt: 'What did I ask you yesterday? Is your answer still correct today?', desc: 'Dates like “last Tuesday” or “3 November” are resolved exactly.' },
  { tag: 'Compare options', title: 'Shortlist and compare tools', prompt: 'Compare HubSpot, Pipedrive and Close for a 20-person sales team: price per seat and key features.', desc: 'Current prices from primary sources, cited and dated.' },
  { tag: 'Catch up', title: 'What’s new this week?', prompt: 'What shipped in the latest Node.js release?', desc: 'Fresh results, with publish dates on every source.' },
];

async function renderHero() {
  const m = $('#messages');
  m.innerHTML = `
    <div class="hero">
      <div class="hero-top">
        <div>
          <span class="chip"><span class="dot"></span>Web search · memory by date</span>
          <h1>Answers that know <em>what day it is.</em></h1>
          <p>I search the web when facts may have changed, cite every claim, and remember our earlier chats, so you can ask what changed since last time.</p>
        </div>
        <div class="hero-cat">${catSvg('full', 150)}</div>
      </div>
      <div id="hero-stats" class="stats"></div>
      <div class="eyebrow routes-title">What brings you here?</div>
      <div class="routes">${ROUTES.map((r, i) => `<button class="route" data-i="${i}"><div class="tag">${esc(r.tag)}</div><h4>${esc(r.title)}</h4><p>${esc(r.desc)}</p></button>`).join('')}</div>
    </div>`;
  m.querySelectorAll('.route').forEach((b) => (b.onclick = () => send(ROUTES[b.dataset.i].prompt)));
  renderStats($('#hero-stats'));
}

async function renderStats(el) {
  const s = await fetch('/api/stats').then((r) => r.json()).catch(() => null);
  if (!s || !el) return;
  const items = [
    [s.conversations, 'chats remembered'],
    [s.facts, 'facts tracked'],
    [s.searchesThisWeek, 'searches this week'],
    [s.lastActive ? fmtDate(s.lastActive) : '—', 'last chat'],
  ];
  el.innerHTML = items.map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${l}</span></div>`).join('');
}

/* ------------------------------------------------------------------ messages */
function addUser(text) {
  $('.hero')?.remove();
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<div class="bubble">${esc(text)}</div>`;
  $('#messages').append(el);
  scrollDown(true);
}

function addAssistant() {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = `<div class="avatar">${catSvg('head', 22)}</div><div class="progress"></div><div class="content"></div><div class="src"></div><div class="tr"></div>`;
  $('#messages').append(el);
  return el;
}

function renderTurn(t) {
  addUser(t.user);
  const el = addAssistant();
  el.querySelector('.progress').remove();
  el.querySelector('.content').innerHTML = renderMarkdown(t.assistant, t.sources);
  el.querySelector('.src').innerHTML = sourcesHtml(t.sources, t.assistant);
  el.querySelector('.tr').innerHTML = traceHtml({ ...(t.trace || {}), queries: t.searches.map((s) => s.query), sources: t.sources });
}

/* Live progress chips: recall → search → write */
function progress(el) {
  const box = el.querySelector('.progress');
  const steps = { recall: ['on', 'Checking memory…'], search: ['wait', 'Search if needed'], write: ['wait', 'Write answer'] };
  const draw = () => (box.innerHTML = Object.values(steps).map(([s, label]) => `<span class="chip ${s}"><span class="dot"></span><span>${label}</span></span>`).join(''));
  draw();
  return {
    set(step, status, label) {
      steps[step] = [status, label ?? steps[step][1]];
      draw();
    },
    remove() {
      box.remove();
    },
  };
}

async function send(text) {
  if (!text.trim() || state.streaming) return;
  show('chat');
  addUser(text);
  const el = addAssistant();
  const p = progress(el);
  const contentEl = el.querySelector('.content');
  let answer = '';
  let sources = [];
  const queries = [];
  let meta = { dateRefs: [], recalled: 0 };
  let pending = false;
  const paint = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      contentEl.innerHTML = renderMarkdown(answer, sources);
      scrollDown();
    });
  };

  setStreaming(true);
  state.controller = new AbortController();
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text, conversationId: state.conversationId, tz }),
      signal: state.controller.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!line.startsWith('data: ')) continue;
        const e = JSON.parse(line.slice(6));
        if (e.type === 'meta') {
          meta = e;
          const isNew = !state.conversationId;
          state.conversationId = e.conversationId;
          history.replaceState(null, '', `#chat/${e.conversationId}`);
          if (isNew) loadConversations();
          const label = e.dateRefs.length ? `${prettyRef(e.dateRefs[0])} · ${e.recalled} memor${e.recalled === 1 ? 'y' : 'ies'}` : `${e.recalled} memor${e.recalled === 1 ? 'y' : 'ies'}`;
          p.set('recall', 'done', label);
          p.set('search', 'on', 'Deciding whether to search…');
        } else if (e.type === 'search') {
          queries.push(...e.queries);
          p.set('search', 'on', `Searching ${e.queries.map((q) => `<q>${esc(q)}</q>`).join(', ')}`);
        } else if (e.type === 'sources') {
          sources = e.sources;
          p.set('search', 'done', `Read ${sources.length} sources`);
          p.set('write', 'on', 'Writing…');
        } else if (e.type === 'text') {
          if (!queries.length) p.set('search', 'done', 'No search needed');
          p.set('write', 'on', 'Writing…');
          answer += e.delta;
          paint();
        } else if (e.type === 'error') {
          el.insertAdjacentHTML('beforeend', `<div class="error">${esc(e.message)}</div>`);
        } else if (e.type === 'done') {
          el.querySelector('.tr').innerHTML = traceHtml({ ...meta, queries, sources, ms: e.ms, firstTokenMs: e.firstTokenMs });
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') el.insertAdjacentHTML('beforeend', `<div class="error">Connection lost: ${esc(err.message)}</div>`);
  } finally {
    p.remove();
    contentEl.innerHTML = renderMarkdown(answer, sources);
    el.querySelector('.src').innerHTML = sourcesHtml(sources, answer);
    setStreaming(false);
    setTimeout(loadConversations, 2500); // the title is generated in the background
  }
}

function setStreaming(on) {
  state.streaming = on;
  $('#send').hidden = on;
  $('#stop').hidden = !on;
  if (!on) $('#input').focus();
}

/* ------------------------------------------------------------------ conversations */
async function loadConversations() {
  const list = await fetch('/api/conversations').then((r) => r.json());
  const nav = $('#conversations');
  nav.innerHTML = list.length ? '' : '<div class="empty-note">No chats yet.</div>';
  let last = '';
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 864e5).toDateString();
  for (const c of list) {
    const d = new Date(c.updatedAt);
    const g = d.toDateString() === today ? 'Today' : d.toDateString() === yesterday ? 'Yesterday' : fmtDate(c.updatedAt);
    if (g !== last) nav.insertAdjacentHTML('beforeend', `<div class="conv-group">${g}</div>`);
    last = g;
    const b = document.createElement('button');
    b.className = 'conv' + (c.id === state.conversationId ? ' active' : '');
    b.innerHTML = `<span>${esc(c.title)}</span><i class="del" title="Delete">×</i>`;
    b.onclick = (e) => (e.target.classList.contains('del') ? deleteConversation(c.id) : openConversation(c.id));
    nav.append(b);
  }
}

async function openConversation(id) {
  if (state.streaming) return;
  const data = await fetch(`/api/conversations/${id}`).then((r) => (r.ok ? r.json() : null));
  if (!data) return newChat();
  state.conversationId = id;
  show('chat', false);
  $('#messages').innerHTML = '';
  data.turns.forEach(renderTurn);
  scrollDown(true);
  document.body.classList.remove('sidebar-open');
  history.replaceState(null, '', `#chat/${id}`);
  loadConversations();
}

async function deleteConversation(id) {
  await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
  if (id === state.conversationId) newChat();
  loadConversations();
}

function newChat() {
  if (state.streaming) return;
  state.conversationId = null;
  history.replaceState(null, '', '#chat');
  show('chat', false);
  renderHero();
  $('#input').focus();
  loadConversations();
  document.body.classList.remove('sidebar-open');
}

/* ------------------------------------------------------------------ how it works */
const STEPS = [
  { t: 'Recall', h: 'Read the date, then my memory', d: 'Phrases like “last Tuesday” or “on 3 November” are turned into exact calendar dates in your timezone by plain code — no model guessing. Past chats from those days, plus any on the same topic, are added to the context.', tags: ['Date resolver', 'BM25 ranking', '30-day chat index', '≈1 ms'], out: 'The exact past messages, with the facts I stated then.' },
  { t: 'Decide', h: 'Decide whether the web is needed', d: 'One model call reads your question with that memory. Small talk, maths or “what did I ask you?” need no search. Prices, releases, news and “has it changed?” do.', tags: ['Single tool', 'Streaming', 'Prompt caching'], out: 'Either an answer straight away, or a search plan.' },
  { t: 'Search', h: 'Search several angles at once', d: 'Up to four queries run in parallel in a single step, optionally limited to “since” a date or to a vendor’s own site. Results are de-duplicated and numbered so citations stay stable.', tags: ['Parallel queries', 'Date filters', 'Provider fallback', '10-min cache'], out: 'Numbered, dated sources the model can cite.' },
  { t: 'Answer', h: 'Answer first, cite every claim', d: 'The bottom line comes first, then the detail. Volatile facts carry a date, sources are cited inline, and when you ask “is it still correct?” every old claim gets a verdict: Changed, Unchanged or Couldn’t verify.', tags: ['Inline citations', 'Change verdicts', 'Max 3 search rounds'], out: 'A streamed answer with source links.' },
  { t: 'Remember', h: 'Write down what can be checked later', d: 'After you have your answer, a cheaper model extracts the checkable facts (prices, releases, what you told me) with today’s date. That is what makes “has anything changed since?” a real comparison.', tags: ['Runs after the answer', 'Dated facts', 'Your context'], out: 'New rows in Memory → Facts I’m tracking.' },
];
let stepIdx = 0;
function renderHow() {
  $('#step-rail').innerHTML = STEPS.map((s, i) => `<li><button class="${i === stepIdx ? 'active' : ''}" data-i="${i}"><span class="ico">${i + 1}</span>${s.t}</button></li>`).join('');
  $('#step-rail').querySelectorAll('button').forEach((b) => (b.onclick = () => ((stepIdx = Number(b.dataset.i)), renderHow())));
  const s = STEPS[stepIdx];
  $('#step-card').innerHTML = `
    <span class="eyebrow of">Step ${stepIdx + 1} of ${STEPS.length}</span>
    <div class="num">0${stepIdx + 1}</div>
    <h3>${esc(s.h)}</h3>
    <p>${esc(s.d)}</p>
    <div class="tags">${s.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
    <div class="output"><span class="out">Output</span>${esc(s.out)}</div>`;
}

/* ------------------------------------------------------------------ memory */
let memoryData = { facts: [], days: [] };
async function renderMemory() {
  renderStats($('#stats'));
  memoryData = await fetch('/api/memory').then((r) => r.json());
  drawFacts();
  $('#timeline').innerHTML = memoryData.days.length
    ? memoryData.days
        .slice(0, 30)
        .map(
          (d) => `<div class="day"><div class="date">${esc(fmtKey(d.date))}</div><div class="items">${d.items
            .slice(0, 6)
            .map((it) => `<button data-c="${esc(it.conversationId)}">${esc(it.title)}<small>${esc((it.summary || it.user).slice(0, 140))}</small></button>`)
            .join('')}</div></div>`,
        )
        .join('')
    : `<div class="empty-note">${catSvg('sleepy', 44)}Nothing yet. Your chats will appear here by date.</div>`;
  $('#timeline').querySelectorAll('button').forEach((b) => (b.onclick = () => openConversation(b.dataset.c)));
}

function drawFacts() {
  const q = $('#fact-filter').value.trim().toLowerCase();
  const facts = memoryData.facts.filter((f) => !q || `${f.subject} ${f.claim}`.toLowerCase().includes(q));
  const latest = memoryData.facts[0]?.asOf;
  $('#facts-title').innerHTML = `${memoryData.facts.length} fact${memoryData.facts.length === 1 ? '' : 's'} I'm tracking${latest ? `<small>latest from ${esc(fmtKey(latest))}</small>` : ''}`;
  $('#facts').innerHTML = facts.length
    ? facts
        .slice(0, 100)
        .map(
          (f, i) => `<li><span class="dot k-${esc(f.kind)}"></span><div><b>${esc(f.subject)}</b> — ${esc(f.claim)}<span class="sub">${esc(f.kind.replace('_', ' '))} · as of ${esc(fmtKey(f.asOf))}${f.sourceUrl ? ` · <a href="${esc(f.sourceUrl)}" target="_blank" rel="noopener">${esc(domain(f.sourceUrl))}</a>` : ''}</span></div>${f.kind === 'user_context' ? '<span></span>' : `<button class="recheck" data-i="${memoryData.facts.indexOf(f)}">Re-check</button>`}</li>`,
        )
        .join('')
    : `<div class="empty-note">${catSvg('sleepy', 44)}${q ? 'No fact matches that search.' : 'No facts yet. Ask about prices or releases and I’ll start tracking them.'}</div>`;
  $('#facts').querySelectorAll('.recheck').forEach(
    (b) =>
      (b.onclick = () => {
        const f = memoryData.facts[Number(b.dataset.i)];
        newChat();
        send(`On ${fmtKey(f.asOf)} you told me: "${f.subject}: ${f.claim}". Is that still correct today? If it changed, what changed and when?`);
      }),
  );
}

/* ------------------------------------------------------------------ routing */
function show(view, updateHash = true) {
  for (const v of ['chat', 'how', 'memory']) $(`#view-${v}`).hidden = v !== view;
  document.querySelectorAll('.nav a[data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  if (updateHash && view !== 'chat') history.replaceState(null, '', `#${view}`);
  if (view === 'how') renderHow();
  if (view === 'memory') renderMemory();
  document.body.classList.remove('sidebar-open');
}

function route() {
  const h = location.hash.slice(1);
  if (h.startsWith('chat/')) return openConversation(h.slice(5));
  if (h === 'how' || h === 'memory') return show(h, false);
  newChat();
}

/* ------------------------------------------------------------------ boot */
document.querySelectorAll('[data-cat]').forEach((el) => (el.innerHTML = catSvg(el.dataset.cat, Number(el.dataset.size) || 22)));
const input = $('#input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = '';
  input.style.height = 'auto';
  send(text);
});
$('#stop').onclick = () => state.controller?.abort();
$('#new-chat').onclick = newChat;
$('#new-chat-top').onclick = newChat;
$('#toggle-sidebar').onclick = () => document.body.classList.toggle('sidebar-open');
$('#fact-filter').addEventListener('input', drawFacts);
$('#open-about').onclick = (e) => {
  e.preventDefault();
  $('#about').showModal();
};
document.querySelectorAll('.nav a[data-view]').forEach((a) =>
  a.addEventListener('click', (e) => {
    e.preventDefault();
    if (a.dataset.view === 'chat') return state.conversationId ? openConversation(state.conversationId) : newChat();
    show(a.dataset.view);
  }),
);
window.addEventListener('hashchange', () => !state.streaming && route());

fetch('/api/health')
  .then((r) => r.json())
  .then((h) => {
    $('#config-info').textContent = `${h.model} · search: ${h.search ?? 'none'}`;
    if (!h.ok) {
      $('#banner').hidden = false;
      $('#banner').textContent = `Missing configuration: ${h.missing.join(', ')}. Copy .env.example to .env, add the keys, and restart.`;
    }
  });

loadConversations().then(route);
