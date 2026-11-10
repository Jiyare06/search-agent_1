# DESIGN

## How it works

```
browser ──POST /api/chat──▶ recall (≈1 ms, no LLM) ──▶ Sonnet 5.5 (stream) ──tool_use──▶ web_search ×N in parallel
   ▲  SSE: meta/search/sources/text/done                    ▲                                   │
   └────────────────────────────────────────────────────────┴──────── tool_result ◀─────────────┘
                                         after "done": persist turn ─▶ Haiku distils summary + facts (background)
```

One turn = **recall → stream → (search → stream)\* → persist → distil**.

1. **Recall, deterministically, before the model runs.** The test prompts are mostly about *time* ("on Monday", "last Tuesday", "on 3 November"). `time.ts` resolves date phrases in the user's timezone (past-biased; "last Friday" said on a Tuesday yields both readings, and recall keeps whichever has records). `recall.ts` pulls the turns from those days, plus BM25-ranked turns from any day, plus a 30-day index of chat titles, and puts them in the system prompt. If the user names a date with nothing on it, the prompt says so (**"NO conversation on record"**), so the model has nothing to invent from.
2. **One model call that decides whether to search.** The model (Claude Sonnet 5.5 at `effort: medium` by default; any OpenAI-compatible model, such as Gemini or Groq, through the same `ChatModel` interface) gets a single `web_search` tool that takes **1–4 queries at once**, plus `since` / `recency` / `domains` / `depth`. Fanning out inside one call means one model round trip instead of four. The loop is capped at 3 search rounds, after which `tool_choice: none` forces an answer, so latency has a ceiling.
3. **Search layer.** Tavily by default (it returns passages rather than 160-character snippets, and supports `start_date`), Brave as the fallback, and automatic failover between them. A 10-minute cache. URLs are de-duplicated across queries, and a per-turn `SourceRegistry` gives citation numbers that stay stable across rounds. Results carry their published dates and the retrieval date, so the model can date-stamp claims.
4. **Streaming UX.** The SSE stream shows live status ("Searching 'HubSpot pricing…'"), then the tokens, then citation pills, then the sources it actually cited. Stop works end to end: the client aborts, `res.on('close')` fires, and the model call is cancelled so no tokens are wasted.
5. **Memory that can be checked later.** After the reply has streamed, Haiku 5.5 uses structured JSON output to extract a one-line summary and **dated, checkable facts** (`{subject, claim, kind, sourceUrl, asOf}`). It also extracts what the *user* said (`user_context`: "20-person team", the 5 shortlisted tools). "Has pricing changed since?" then becomes a diff: earlier claims from memory against fresh search results, reported per item as **Changed / Unchanged / Couldn't verify**.

## Why this shape

- **Speed:** memory adds no extra LLM hop, searches run in parallel, the static prompt is cached (`cache_control`), old tool results are dropped from history (earlier turns are replayed as text only), and distillation happens off the critical path. Time-to-first-token is roughly one model call when no search is needed, and about two calls plus one search when it is.
- **Correctness:** the code does the date maths, not the LLM. The prompt carries a 14-day calendar plus pre-resolved ranges. Prices are compared against what we *actually said*, not paraphrased recollections. Every web claim is cited and dated. The search tool's description tells the model its training data is stale for anything volatile.
- **Good to talk to:** answer first, no preamble, at most one clarifying question. When memory is missing, the agent says so in one line, then still gives a labelled best guess. The UI shows live progress (recall → search → write) and a **How I got this** panel under every answer. A **Memory** page lists the tracked facts with a one-click **Re-check**, so you can see and check the agent's reasoning.

## Considered and rejected

- **A `recall_memory` tool.** The brief says one tool. A second tool would also cost a round trip on exactly the questions that need memory most, and deterministic recall is testable (`test/recall.test.ts`).
- **Embeddings / vector DB for memory.** Overkill for one user's history. BM25 plus exact date lookup is more precise for "what did I ask on X". Embeddings come in when history reaches the thousands of turns.
- **Anthropic's server-side web search.** It's simpler (one key), but you give up control of caching, date filters, provider fallback, source numbering and the latency budget.
- **LangChain / an agent framework.** The loop is about 80 lines. A framework would hide the parts I'm being judged on.
- **A planner → searcher → writer pipeline.** It's better for deep research, but adds 1–2 serial LLM calls to every turn. A single tool-using model with parallel queries is faster for chat.
- **One provider only.** The loop is written against a small `ChatModel` / `Session` interface. Each adapter keeps its own wire transcript (Anthropic thinking blocks, Gemini thought signatures), so the loop never sees them.
- **SQLite.** Native builds can break `npm install`. A JSON file with atomic writes sits behind a small `Store` class, so swapping in a database is mechanical.
- **Page fetching / scraping.** Tavily's passages are usually enough. Fetching full pages roughly doubles latency (see next steps).

## With another week

1. **Evals as a harness, not vibes:** about 100 dated multi-session scenarios (seed history, set `AGENT_NOW`, ask). Score with an LLM judge on date resolution, no hallucinated memory, citation support and staleness, and track p50/p95 time to first token.
2. **A `fetch_page` step inside `web_search`** (`depth: thorough`). It would extract the pricing table from the vendor page itself, because SERP passages often lag.
3. **Proactive change tracking:** a nightly job re-checks `price` / `release` facts from the last 30 days and tells the user what changed before they ask.
4. **Fact-level memory:** merge facts across turns into an entity table (current value plus history), so "what's the latest we know about Supabase?" doesn't depend on which turn it came from.
5. Auth plus a real database (multi-user is already keyed by `userId`), a model router (Haiku for chit-chat, Sonnet for research), and claim-level citation verification before display.
