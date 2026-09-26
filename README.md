# Custom Memory Engine

A long-term memory layer for AI tutoring apps, similar to [Mem0](https://github.com/mem0ai/mem0).

It reads a conversation between a student and a tutor, extracts durable facts about the student (name, progress, weak topics, learning preferences, goals), stores them as vectors in Qdrant, and retrieves the relevant ones for the next answer. It is built to plug into a RAG-based course platform, and it handles Hinglish, Roman Hindi, English and Devanagari input.

- **Stack:** Node.js 20+ (ES modules, plain JavaScript), Qdrant (local via Docker), OpenAI `gpt-4o-mini` for extraction and `text-embedding-3-small` for embeddings.
- **Status:** Phase 4.5 of 5. Extraction, storage, search and user isolation work end to end. **It is not yet ready to replace Mem0 in production.** Update/dedupe logic (Phase 5) is missing; see [Known limitations](#known-limitations).

---

## How it works

```
messages ──► extract facts (LLM) ──► embed facts ──► store in Qdrant (per user)
                                                          │
query ─────► embed query ──────────► vector search (filtered by userId) ──► top memories
```

Example. Input conversation:

```
user: Hi, main Raj hoon aur main recursion samajhne mein struggle kar raha hoon
assistant: Koi baat nahi, chalo step by step samajhte hain
user: Main abhi Module 2 pe hoon
user: Mujhe code examples se jaldi samajh aata hai
user: thanks!
```

Stored memories (always English, third person, one fact each, with a category):

```
[identity]    User's name is Raj
[weak_topic]  User is struggling with recursion
[progress]    User is currently on Module 2
[preference]  User learns quickly with code examples
```

Greetings and "thanks!" are ignored. Categories: `identity`, `progress`, `weak_topic`, `preference`, `goal`, `other`.

---

## Quick start

Prerequisites: Node.js 20+, Docker Desktop, an OpenAI API key.

```bash
npm install
cp .env.example .env        # then set OPENAI_API_KEY
npm run db:up               # start Qdrant in Docker
npm run check               # verify config + Qdrant connection
npm run test:llm            # verify chat + embeddings
npm run playground          # end-to-end demo
```

The Qdrant dashboard is at `http://localhost:<QDRANT_PORT>/dashboard`. This repo uses port **6337**, because 6333 was already taken on the dev machine; change `QDRANT_PORT` and `QDRANT_URL` together if needed.

### Configuration (`.env`)

| Variable | Required | Default in `.env.example` | Purpose |
|---|---|---|---|
| `QDRANT_URL` | yes | `http://localhost:6337` | Qdrant REST endpoint |
| `QDRANT_PORT` | for Docker | `6337` | Host port mapped to Qdrant |
| `QDRANT_API_KEY` | no | empty | Only for Qdrant Cloud or a secured instance |
| `OPENAI_API_KEY` | yes | empty | OpenAI key |
| `CHAT_MODEL` | yes | `gpt-4o-mini` | Fact extraction |
| `EMBEDDING_MODEL` | yes | `text-embedding-3-small` | Embeddings |
| `EMBEDDING_DIM` | yes | `1536` | Must match the embedding model |
| `MEMORY_COLLECTION` | yes | `custom_user_memories` | Qdrant collection name |
| `JUDGE_MODEL` | no | `gpt-4o` | Eval judge only (falls back to `gpt-4o-mini`) |
| `MEMORY_SCORE_THRESHOLD` | no | `0.22` | Minimum similarity for `getContext()` relevant memories |

These variables are read only by this repo's **scripts** (through `loadConfigFromEnv()`), and they fail fast with a clear error naming any missing variable. The library itself never reads the environment; see [Use as a library](#use-as-a-library).

---

## Usage

```js
import { createMemoryEngine, loadConfigFromEnv } from 'custom-memory-engine';

// Inside this repo: config from .env (load it first, e.g. import 'dotenv/config').
// In another app, build the config object yourself, see "Use as a library" below.
const memory = createMemoryEngine({ config: loadConfigFromEnv() }); // + { collection, extraction: 'llm' | 'naive' }

// After each chat turn (ideally in the background, it takes ~1.7 s):
const { results } = await memory.add(
  [
    { role: 'user', content: 'Main abhi Module 3 pe hoon' },
    { role: 'assistant', content: 'Great!' },
  ],
  { userId: 'student_42', metadata: { sessionId: 'abc' } }
);
// results: [{ id, text: 'User is on Module 3', event: 'ADD' }]

// Before answering (run in parallel with your RAG retrieval):
const { results: memories } = await memory.search('which module is the student on?', {
  userId: 'student_42',
  limit: 3,
  scoreThreshold: 0.22, // recommended starting point, see Evaluation
});

await memory.getAll({ userId: 'student_42', category: 'weak_topic' });
await memory.delete(id, { userId: 'student_42' });
await memory.deleteAll({ userId: 'student_42' });
```

- Every method requires `userId` and throws without it.
- `content` can be a string or an OpenAI-style array of parts; only `{ type: "text" }` parts are read.
- The collection and its payload indexes are created automatically on first use.
- Search results: `{ id, text, score, category, metadata, createdAt, updatedAt, state }`.

---

## Use as a library

Install it from a local path or git (for example `npm install ../custom-memory-engine`), then build the config from **your app's own** environment variable names. The engine never reads `process.env` and never loads a `.env` file, so it cannot pick up your app's variables by accident (for example your RAG app's `QDRANT_URL`).

```js
import { createMemoryEngine, formatContext } from 'custom-memory-engine';

const memory = createMemoryEngine({
  config: {
    openai: {
      apiKey: process.env.MEMORY_OPENAI_API_KEY,
      chatModel: process.env.MEMORY_CHAT_MODEL ?? 'gpt-4o-mini',
      embeddingModel: 'text-embedding-3-small',
      embeddingDim: 1536,
    },
    qdrant: { url: process.env.MEMORY_QDRANT_URL, apiKey: process.env.MEMORY_QDRANT_API_KEY },
    collection: 'student_memories',
    scoreThreshold: 0.22, // optional
  },
});

// Before answering:
const ctx = await memory.getContext(studentMessage, { userId });
const block = formatContext(ctx); // "Student context (do not cite)" + profile/relevant lines

// After replying (in the background):
memory.add([{ role: 'user', content: studentMessage }], { userId, metadata: { sessionId } }).catch(console.error);
```

- **Exports:** `createMemoryEngine`, `loadConfigFromEnv` (reads this repo's variable names, only when called), `formatContext`, `isSmallTalk`, `CATEGORIES`.
- **Importing has no side effects:** no environment reads, no `.env` loading, no clients created. `npm run check:library` verifies this in a child process with an empty environment.
- **`createMemoryEngine` validates the config** and throws one error naming every missing field (for example `config.openai.apiKey is required`).
- **Every engine instance has its own** OpenAI client, embedder, Qdrant client and per-user queue. Two engines with different configs or collections in one process share nothing.

---

## Project structure

```
src/
  index.js               public entry: createMemoryEngine, loadConfigFromEnv, formatContext, isSmallTalk, CATEGORIES
  config/index.js        validateConfig() for the explicit config object; loadConfigFromEnv() for scripts
  llm/client.js          createLlmClient(): chat() with JSON mode, temperature, retries on 429/5xx
  llm/embed.js           createEmbedder(): embed() / embedMany(), one API call per batch, dimension check
  stores/vectorStore.js  Qdrant access only; every read/update/delete filtered by userId
  memory/MemoryEngine.js createMemoryEngine(): add, search, getAll, get, getContext, history, restore, delete, deleteAll
  memory/extractor.js    extractFacts(): LLM extraction + normalisation
  memory/prompts.js      extraction prompt and categories
  memory/messages.js     contentToText(): string or multi-part content -> text
scripts/                 setup checks, playground, eval runners, LLM judge (scripts/runtime.js loads .env)
tests/                   eval cases, retrieval cases, judge calibration set
docs/evals/              committed evaluation reports
```

Folder rules (see [CLAUDE.md](CLAUDE.md)):
- `llm/` contains provider wrappers only.
- `stores/` handles storage only, with no business logic.
- `memory/` holds all memory logic.
- No provider-specific code outside `src/llm/`.
- **Every Qdrant query filters by `userId`.**

---

## npm scripts

| Script | What it does |
|---|---|
| `db:up` / `db:down` / `db:logs` | Start, stop and tail the Qdrant container |
| `check` | Config + Qdrant connectivity check |
| `check:library` | Library safety: side-effect-free import, config validation, two isolated engines |
| `test:llm` | Chat, JSON mode and embeddings smoke test |
| `test:store` | Vector store tests, including cross-user isolation (uses a scratch collection) |
| `playground` / `playground:naive` | End-to-end demo in LLM or naive extraction mode |
| `eval:extraction` | 12 original extraction cases: keyword scorer + LLM judge |
| `eval:extraction:extended` | 22 harder cases: typos, negation, sarcasm, other people, time changes |
| `eval:extraction:all` | Both extraction suites |
| `judge:calibrate` | Checks the LLM judge against 18 human-labelled facts |
| `eval:retrieval` | Top-1/top-3/MRR on synthetic students; score distribution and threshold sweep |
| `eval:robustness` | Isolation at scale, edge inputs, stale-fact baseline |
| `eval:perf` | Latency, tokens and cost |
| `eval:report` | Combines the latest runs into one JSON |

On Windows PowerShell, `npm run x -- --flag` drops the `--`, so use the dedicated scripts, such as `playground:naive`. Eval scripts use scratch Qdrant collections and delete them afterwards. Raw results go to `tests/results/`, which is gitignored.

---

## Evaluation

Full baseline report (Hinglish): [docs/evals/2026-09-26-phase4-baseline.md](docs/evals/2026-09-26-phase4-baseline.md). Latest numbers as of Phase 4.5, 2026-09-26:

### Extraction

| Suite | Keyword precision | Judge precision | Recall (keyword) | Forbidden facts stored |
|---|---|---|---|---|
| Original, 12 cases | 95.5% | 100% | 100% | 0 |
| Extended, 22 cases | 77.1% | 68.4% | 96.6% | 7 |

- **Keyword scorer:** a fact must have the expected category and contain the expected keywords. It is fast, but it cannot see negation: it once passed "User finds recursion easy" for a sarcastic message.
- **LLM judge** (`gpt-4o`, one fact per call, temperature 0): checks polarity, the person, past vs current state, hypotheticals and category. **Calibration: 94.4% agreement (17/18)**. It catches 8 of 9 known-wrong facts and keeps 9 of 9 known-correct ones.
  - It still accepts language difficulty filed as `weak_topic`.
  - It is a bit strict on borderline categories.
- **Stability:** the original suite gave identical scores across 3 runs, with no flaky cases. At temperature 0, the wording of facts still varies in about 3 of 22 extended cases.

### Retrieval, isolation, performance

| Metric | Result |
|---|---|
| Top-1 / top-3 accuracy, MRR | 71.4% / 100% / 0.857 (4 students, 29 memories, 19 queries) |
| Relevant vs irrelevant scores | They overlap between 0.22 and 0.38. Recommended `scoreThreshold` is **0.22**, which keeps all relevant results and drops 71% of irrelevant ones. |
| User isolation | **0 leaks** in 620 result ids (10 users) and **0/90** cross-user `getById` |
| Edge inputs | Empty, emoji-only and course-question-only inputs store nothing. Devanagari and 5,000-char messages are handled. Multi-part content works. |
| `add()` latency | p50 1.7 s, p95 2.0 s |
| `search()` latency | p50 0.42 s, mostly embedding. Qdrant alone is about 0.1 s. |
| Cost | **~$0.13 per 1,000 user messages** (one add + one search each). Prices checked 2026-09-26. |

---

## Known limitations

These are ordered by how much they would affect students, with evidence from the evals:

1. **No update or dedupe (Phase 5).**
   - Old facts are never replaced: after "Module 2" and then "Module 3", both are stored, and a Hinglish query ranks Module 2 first.
   - Re-adding the same conversation duplicates memories: 3 facts become 6.
2. **Extraction misreads some messages.**
   - Negation: "ab DP mein dikkat nahi hai" becomes a `weak_topic`.
   - Sarcasm is read literally.
   - Hypotheticals ("agar main module 5 pe hota…") are stored as progress.
   - Past state is stored as current.
   - Facts about a sibling are stored in the student's memory.
   - Difficulty with English is filed as a `weak_topic`.
3. **No default score threshold.** Small talk like "thanks bhai" still retrieves memories (score 0.31).
4. **Hinglish queries score lower** against English memories, which lowers top-1 accuracy.
5. **Not yet at Mem0 parity:**
   - `add()` only returns `ADD` events.
   - There is no memory history or audit log.
   - Search can't filter on metadata other than `category`.
   - There is no agent/session scoping.

**Integration advice until Phase 5 lands:**
- Call `add()` in the background, after the reply is sent.
- Run `search()` in parallel with RAG retrieval.
- Send `add()` only **new** messages, not a sliding window.
- Use `scoreThreshold: 0.22` and `limit: 3`.

---

## Roadmap

- [x] Phase 0: project setup, Qdrant via Docker, config
- [x] Phase 1: LLM and embedding wrappers
- [x] Phase 2: vector store with strict per-user isolation
- [x] Phase 3: naive end-to-end engine
- [x] Phase 4: LLM fact extraction + evaluation suite
- [x] Phase 4.5: multi-part content, LLM judge with calibration, full baseline report
- [ ] Phase 5: update/dedupe (ADD / UPDATE / DELETE / NOOP against existing memories)
- [ ] Extraction prompt fixes for negation, time, other people, hypotheticals and language vs topic
- [ ] Retrieval defaults (threshold, small-talk skip) and Hinglish query handling
- [ ] Integration into the C-RAG course platform
