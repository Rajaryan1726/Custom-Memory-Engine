# custom-memory-engine

A memory layer for AI apps (similar to Mem0). It extracts, stores, and retrieves
per-user memories so they can be plugged into a RAG / chat app. Vector storage is
Qdrant; LLM + embeddings are OpenAI.

## Running locally

Qdrant runs locally via `docker-compose.yml` (container `memory-engine-qdrant`,
image pinned to a specific version, data in a named volume).

- Host port comes from `QDRANT_PORT` (default 6333; this machine uses **6337**
  because 6333 is taken by another project's Qdrant).
- Dashboard: `http://localhost:<QDRANT_PORT>/dashboard`
- Only REST (6333 inside the container) is exposed; gRPC is not.

```
cp .env.example .env     # then fill in OPENAI_API_KEY
npm run db:up            # start Qdrant
npm run check            # verify config + Qdrant connection
npm run db:logs          # tail Qdrant logs
npm run db:down          # stop Qdrant (data persists in the volume)
```

## Folder responsibilities

- `src/config/` — `validateConfig()` for the explicit config object passed to
  `createMemoryEngine({ config })`, and `loadConfigFromEnv()` for scripts only.
  Library code (`src/`) never imports dotenv, never reads `process.env`, and has no
  import-time side effects or module-level clients: everything is created per engine
  instance. Scripts load `.env` through `scripts/runtime.js`.
- `src/llm/` — provider wrappers **only** (chat completion, embeddings). Thin
  adapters; no memory logic.
- `src/stores/` — storage **only** (Qdrant access). No business logic: no
  deciding what to remember, no prompt building.
- `src/memory/` — **all** memory logic (extraction, dedup/update decisions,
  search, ranking). Talks to `llm/` and `stores/` through their interfaces.
- `scripts/` — operational scripts (e.g. `check-setup.js`).
- `tests/` — tests.

## Conventions

- ES modules (`import`/`export`), plain JavaScript, Node 20+.
- async/await everywhere; no raw promise chains or callbacks.
- No provider-specific code (OpenAI SDK, model names, etc.) outside `src/llm/`.
- **Every Qdrant query must filter by `userId`.** No search, scroll, count,
  update, or delete may run without a `userId` filter — memories must never leak
  across users.
- `QDRANT_API_KEY` is optional; pass it to the client only when set.
