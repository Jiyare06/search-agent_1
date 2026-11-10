# Search Agent

A chat agent with one tool, web search, plus long-term memory of every earlier chat, organised by date. It answers questions like *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"*

## Run

```bash
cp .env.example .env     # Windows: copy .env.example .env
# add ONE LLM key (GEMINI_API_KEY is free) and TAVILY_API_KEY (free plan)
npm install
npm run dev              # → http://localhost:3000
```

Node 20.12+ is required.

### LLM providers

| Key in `.env` | Default model | Cost |
|---|---|---|
| `GEMINI_API_KEY` | `gemini-3.5-flash-lite` | free tier, no card (daily request cap) |
| `GROQ_API_KEY` | `openai/gpt-oss-120b` | free tier (low tokens-per-minute) |
| `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` | paid, best results |
| `OPENAI_BASE_URL` + `MODEL` | anything | e.g. local Ollama, free |

Set `MODEL=` to choose another model from that provider. On tight free quotas, `DISTILL=off` saves one call per turn.

## Try the memory features right away

```bash
npm run seed             # adds two clearly-labelled [demo] chats: last Tuesday (Postgres) and Monday (CRM shortlist)
```

Then ask:

- "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
- "What did I ask you on 14 February?" The agent should say it has no record of that.

`npm run seed -- --reset` wipes the store first. To freeze the clock for testing, set `AGENT_NOW=2026-11-10T09:00:00Z`.

## Scripts

| | |
|---|---|
| `npm run dev` | dev server with reload |
| `npm test` | unit tests (date resolution, recall) plus an offline end-to-end test of the agent loop with a fake model and fake search |
| `npm run eval` | runs the example prompts against the live APIs and prints latency, the searches made and the answers |
| `npm run typecheck` | `tsc --noEmit` |

## Layout

```
src/
  server.ts          node:http, SSE streaming, 5 routes
  agent.ts           the turn loop (provider-neutral)
  models/            Anthropic (native) + OpenAI-compatible (Gemini, Groq, Ollama…)
  prompt.ts          static (cached) + dynamic system prompt
  time.ts            clock, timezone, date-phrase resolution
  memory/store.ts    JSON persistence (conversations, turns, facts)
  memory/recall.ts   date lookup + BM25 + chat index → <memory>
  memory/distill.ts  background summary + fact extraction
  search/            web_search tool, providers (Tavily, Brave), cache, citations
public/              vanilla JS UI: chat, How it works, Memory (tracked facts + timeline), About
```

See [DESIGN.md](DESIGN.md) for the reasoning.
