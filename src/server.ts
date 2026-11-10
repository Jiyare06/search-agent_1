// Plain node:http. The surface is five routes; a framework would add more than it saves.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, missingKeys } from './config.ts';
import { runTurn, type AgentEvent } from './agent.ts';
import { store } from './memory/store.ts';
import { defaultProvider } from './search/providers.ts';
import { chatModel } from './models/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC: Record<string, [string, string]> = {
  '/': [path.join(root, 'public/index.html'), 'text/html; charset=utf-8'],
  '/app.js': [path.join(root, 'public/app.js'), 'text/javascript; charset=utf-8'],
  '/style.css': [path.join(root, 'public/style.css'), 'text/css; charset=utf-8'],
  '/vendor/marked.js': [path.join(root, 'node_modules/marked/lib/marked.umd.js'), 'text/javascript; charset=utf-8'],
  '/vendor/purify.js': [path.join(root, 'node_modules/dompurify/dist/purify.min.js'), 'text/javascript; charset=utf-8'],
};

// This is a single-user local app; the store is keyed by user so multi-user is an auth layer away.
const USER = 'local';

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function readBody(req: http.IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      return fs.createReadStream(file).pipe(res);
    }

    if (p === '/api/health') {
      return json(res, 200, { ok: missingKeys().length === 0, missing: missingKeys(), model: chatModel().label, search: defaultProvider()?.name ?? null });
    }

    if (p === '/api/conversations' && req.method === 'GET') return json(res, 200, store.listConversations(USER));

    // Memory browser: tracked facts + a by-day timeline. Read-only views over the same store recall uses.
    if (p === '/api/memory' && req.method === 'GET') {
      const convs = new Map(store.listConversations(USER).map((c) => [c.id, c.title]));
      const turns = [...store.allTurns(USER)].sort((a, b) => b.ts.localeCompare(a.ts));
      // Newest first; the same claim recorded twice is shown once (its latest as-of date).
      const seen = new Set<string>();
      const facts = turns
        .flatMap((t) => (t.facts ?? []).map((f) => ({ ...f, conversationId: t.conversationId, turnId: t.id })))
        .filter((f) => {
          const k = `${f.subject}|${f.claim}`.toLowerCase();
          return !seen.has(k) && !!seen.add(k);
        });
      const days = new Map<string, { conversationId: string; title: string; user: string; summary?: string }[]>();
      for (const t of turns) {
        const list = days.get(t.localDate) ?? days.set(t.localDate, []).get(t.localDate)!;
        list.push({ conversationId: t.conversationId, title: convs.get(t.conversationId) ?? 'Chat', user: t.user, summary: t.summary });
      }
      return json(res, 200, { facts, days: [...days.entries()].map(([date, items]) => ({ date, items })) });
    }

    if (p === '/api/stats' && req.method === 'GET') {
      const turns = store.allTurns(USER);
      const weekAgo = Date.now() - 7 * 864e5;
      return json(res, 200, {
        conversations: store.listConversations(USER).length,
        turns: turns.length,
        facts: turns.reduce((n, t) => n + (t.facts?.length ?? 0), 0),
        searchesThisWeek: turns.filter((t) => Date.parse(t.ts) > weekAgo).reduce((n, t) => n + t.searches.length, 0),
        lastActive: turns.at(-1)?.ts ?? null,
      });
    }

    const m = p.match(/^\/api\/conversations\/([\w-]+)$/);
    if (m && req.method === 'GET') {
      const conv = store.getConversation(USER, m[1]);
      if (!conv) return json(res, 404, { error: 'not found' });
      return json(res, 200, { conversation: conv, turns: store.turnsOf(USER, conv.id) });
    }
    if (m && req.method === 'DELETE') {
      store.deleteConversation(USER, m[1]);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      const message = String(body.message ?? '').trim();
      if (!message) return json(res, 400, { error: 'message is required' });

      // Server-Sent Events over the POST response: streaming with no websocket machinery.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const send = (e: AgentEvent) => res.writableEnded || res.write(`data: ${JSON.stringify(e)}\n\n`);

      const missing = missingKeys();
      if (missing.length) {
        send({ type: 'error', message: `Missing configuration: ${missing.join(', ')}. Copy .env.example to .env and fill it in.` });
        return res.end();
      }

      const ac = new AbortController();
      res.on('close', () => ac.abort()); // user hit stop / closed the tab → stop spending tokens
      await runTurn({ userId: USER, conversationId: body.conversationId || undefined, message, tz: body.tz, signal: ac.signal, emit: send });
      return res.end();
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    else res.end();
  }
});

server.listen(config.port, () => {
  const missing = missingKeys();
  console.log(`\n  Chat agent running at http://localhost:${config.port}`);
  console.log(`  llm=${chatModel().label}  search=${defaultProvider()?.name ?? 'none'}  effort=${config.effort}`);
  if (missing.length) console.log(`  ⚠ missing: ${missing.join(', ')} — copy .env.example to .env\n`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    store.flush();
    process.exit(0);
  });
}
