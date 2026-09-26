# Custom-Memory-Engine

A memory layer for AI apps (similar to Mem0), backed by Qdrant and OpenAI.

## Quick start

```bash
cp .env.example .env     # then fill in OPENAI_API_KEY
npm install
npm run db:up            # start Qdrant in Docker
npm run check            # verify config + Qdrant connection
npm run test:llm         # verify chat + embeddings
```

Qdrant dashboard: http://localhost:6337/dashboard (port set by `QDRANT_PORT`).

See [CLAUDE.md](CLAUDE.md) for architecture and conventions.
