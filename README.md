# Custom Memory Engine

A long-term memory layer for AI tutoring apps: an alternative to [Mem0](https://github.com/mem0ai/mem0), built for one job. **An AI course tutor must always know the student's *current* state**: their name, which module they are on, what they struggle with right now, and how they like to learn.

It reads each chat turn, extracts durable facts about the student, decides whether each fact is new, a duplicate, or a replacement for an old fact, and stores them per user in Qdrant. Before the tutor answers, it returns a short, prompt-ready student profile. It understands Hinglish, Roman Hindi, English and Devanagari.

- **Stack:** Node.js 20+ (ES modules, plain JavaScript), Qdrant (Docker), OpenAI `gpt-4o-mini` + `text-embedding-3-small`.
- **Version:** 0.2.0. Used as a library by a RAG course platform, behind a provider flag with hosted Mem0 as the fallback.

---

## Head-to-head: this engine vs hosted Mem0

Both providers ran through **one provider-neutral harness**:
- the same inputs;
- the same `gpt-4o` judge at temperature 0, which sees only memory text and never learns which provider produced it;
- 2 runs each.

Mem0 is the hosted platform through `mem0ai` 3.1.6 (the same `MemoryClient` the RAG app used), with default project settings.

### On an unseen test set (held-out v1: 18 extraction cases + 12 update scenarios)

The test set was not used for tuning when these numbers were measured (engine v0.1.0).

| | This engine | Hosted Mem0 | |
|---|---|---|---|
| **Old facts correctly replaced** (update scenarios) | **11 / 12** (both runs) | 1–3 / 12 | higher is better |
| **Correct memories** (judge precision) | **87.5%** | 64.3% | higher is better |
| **Wrong facts saved as true** (forbidden claims) | **0** | 1–3 | lower is better |
| **Write latency, median** | **1.5 s** | 8.3 s | lower is better |
| **Write latency, p95** | **2.6–2.8 s** | 25–98 s | lower is better |
| Writes that took over 3 minutes | **0** | 4 | |
| Memories over 1,000 characters (garbled / repeated) | **0** | 11 (longest 37,941) | |
| Expected facts found (recall) | 100% | 100% | tie |
| Search latency, median | ~0.45 s | ~0.5 s | tie |

### On the original (tuned) test set: 40 extraction cases + 16 update scenarios

| | This engine | Hosted Mem0 |
|---|---|---|
| Update scenarios passed | **16 / 16** (both runs) | 7–8 / 16 |
| Judge precision | **94–96%** | 61–67% |
| Recall | 100% | 98% |
| Forbidden claims stated as true | **0** | 2–3 |

**Home advantage, measured.** The engine's prompts were tuned on the original set, so its numbers there were inflated. On the unseen set, scenarios dropped 8.3 points (100% → 91.7%) and precision 7.8 points (95.3% → 87.5%). Recall and forbidden claims did not drop. The gap to Mem0 stayed large.

### Where this engine wins

- **Current state stays current.** When a student says "ab Module 9 pe hoon" or "DP ab clear ho gaya", the old memory is updated or archived. Mem0 adds the new fact but keeps the contradicting old one, so "Module 8" and "Module 9", or "DP is hard" and "DP is clear", both stay. Mem0's `latestOnly` option did not help: 1/8 on those scenarios.
- **Only durable facts about the student.** The engine skips small talk, one-off requests ("is baar sirf code do"), course questions, the tutor's explanations, and facts about friends or siblings. Mem0 stored all of these.
- **Short, clean memories.** The longest memory is 76 characters, against Mem0 memories of up to ~38k characters of repeated text that would bloat a RAG prompt.
- **Fast, synchronous writes.** `add()` returns when the memory is stored (p50 ~1.5 s). Hosted Mem0's `add()` is asynchronous: 7–10 s typically, sometimes 3–4 minutes before a write is visible.

### Where Mem0 is better

- **Fully managed:** there is no database to run or back up.
- **Dates attached to memories** (temporal info).
- **General purpose,** with a dashboard and graph features on its platform.

Full reports (Hinglish), with every failure and the judge's reasons:
- [docs/evals/2026-09-27-heldout-comparison.md](docs/evals/2026-09-27-heldout-comparison.md)
- [docs/evals/2026-09-27-phase7c-mem0-comparison.md](docs/evals/2026-09-27-phase7c-mem0-comparison.md)

**Honest caveats:**
- The judge's neutral prompts are not calibrated, and it makes some mistakes on both sides. Correcting the obvious ones does not change the result.
- The rules ("past as current is wrong", "a friend's fact is not the student's") come from this tutoring use case.
- Mem0 was not tested with custom project instructions.

---

## How it works

```
add(messages, { userId })
  1. extract    LLM turns the turn into facts:   [progress] (active) User is on Module 9
                                                 [weak_topic] (ended) User struggles with DP
  2. embed      one embeddings call for all facts
  3. candidates same-category memories of THIS user, top 5 per fact
  4. decide     exact duplicate -> NOOP without an LLM call; otherwise one decider call:
                ADD | UPDATE <memory> | DELETE <memory> (ended facts only) | NOOP
  5. validate   invalid decider output never throws; it falls back safely and is logged
  6. apply      DELETE = soft delete (archived, with reason); UPDATE keeps createdAt + history

getContext(query, { userId })
  profile  = identity / progress / preference / goal memories (always included)
  relevant = vector search over weak_topic / other, score >= 0.22
  small-talk gate: "thanks bhai", "ok", emoji -> no vector search at all
```

Example. After these turns from one student:

```
user: Hi, main Kabir hoon
user: Main abhi Module 2 pe hoon
user: DP mein bahut dikkat hai
user: graphs bhi samajh nahi aate
user: Ab main Module 3 pe aa gaya hoon
user: ab DP clear ho gaya
```

the active memories are:

```
[identity]    User's name is Kabir
[progress]    User is on Module 3              <- updated from Module 2, history kept
[weak_topic]  User struggles with graphs
                                               "User struggles with DP" is archived, restorable
```

Categories: `identity`, `progress`, `weak_topic`, `preference`, `goal`, `other`. Memories are always stored in English, in the third person, one fact each.

---

## Improvements, phase by phase

| Phase | What changed | Evidence |
|---|---|---|
| 0–3 | Setup, LLM/embedding wrappers, Qdrant store with strict per-user filtering, naive engine | `test:store` 9/9, 0 cross-user leaks |
| 4 / 4.5 | LLM fact extraction; eval suite; LLM judge with a human-labelled calibration set | baseline: extended suite judge precision 68.4%, **7 forbidden facts** |
| 5a | Extraction v2: `active` / `ended` status; rules for negation, sarcasm, hypotheticals, other people, past vs current, language vs topic | extended forbidden **7 → 0**, judge precision 68.4% → 87.5–93.8% |
| 5b / 5c | Update/dedupe **decider** (ADD / UPDATE / DELETE / NOOP), with a validator and safe fallbacks; per-user write queue (parallel adds of the same fact store it once) | update scenarios 16/16, fallbacks 0 |
| 6 | Soft delete (archive with reason), `history()`, `restore()`, `getContext()` retrieval layer, small-talk gate | context recall 100% (14/14); isolation 1,418 ids, 0 leaks |
| 6.1–6.2 | One-off vs standing preferences ("isko detail mein samjhao" is not a preference); language and format exceptions | one-off message: preference in 0/30 calls (was ~1/10) |
| 7a | Library packaging: config injection, no `process.env` or `.env` reads, no import side effects, isolated engine instances | `check:library` PASS |
| 7c-1 | Provider-neutral head-to-head vs hosted Mem0 | see above |
| Held-out | Unseen test set to measure the home advantage | engine −8 points, still far ahead |
| 7c-2 (v0.1.1) | A decider `DELETE` for an *active* replacing fact ("User has completed stacks") now becomes an `UPDATE` of the stale memory instead of an `ADD` that kept it | "stacks done, now queues": stale memory gone 3/3; held-out scenarios 11/12 → 12/12* |

| 0.2.0 | From the AutoWiki integration eval: cross-category candidates for the decider; skill level as `identity` ("User is comfortable with X") so a level change UPDATEs; context-only messages (`contextMessages` / `context: true`); injectable `llm: { chat, embed }` and `logger`, no fact text in default logs | TypeScript level update 1/5 → **5/5** same id; context re-extraction 0/5 → **5/5** clean ([report](docs/evals/2026-10-05-autowiki-integration-fixes.md)) |

\* Held-out v1 was used to find this fix, so it is no longer a true held-out set. The next held-out set will be real student data.

---

## Quick start

Prerequisites: Node.js 20+, Docker Desktop, an OpenAI API key.

```bash
npm install
cp .env.example .env        # then set OPENAI_API_KEY
npm run db:up               # start Qdrant in Docker
npm run check               # verify config + Qdrant connection
npm run playground          # end-to-end demo
```

The Qdrant dashboard is at `http://localhost:<QDRANT_PORT>/dashboard`. This repo uses port **6337**, because 6333 was taken on the dev machine; change `QDRANT_PORT` and `QDRANT_URL` together.

### Configuration (`.env`, scripts only)

| Variable | Required | Default in `.env.example` | Purpose |
|---|---|---|---|
| `QDRANT_URL` | yes | `http://localhost:6337` | Qdrant REST endpoint |
| `QDRANT_PORT` | for Docker | `6337` | Host port mapped to Qdrant |
| `QDRANT_API_KEY` | no | empty | Only for Qdrant Cloud or a secured instance |
| `OPENAI_API_KEY` | yes | empty | OpenAI key |
| `CHAT_MODEL` | yes | `gpt-4o-mini` | Extraction and decider |
| `EMBEDDING_MODEL` | yes | `text-embedding-3-small` | Embeddings |
| `EMBEDDING_DIM` | yes | `1536` | Must match the embedding model |
| `MEMORY_COLLECTION` | yes | `custom_user_memories` | Qdrant collection name |
| `JUDGE_MODEL` | no | `gpt-4o` | Eval judge only |
| `MEMORY_SCORE_THRESHOLD` | no | `0.22` | Minimum similarity for `getContext()` relevant memories |
| `MEM0_API_KEY` | no | empty | Only for `eval:mem0-compare`; use a separate Mem0 test project |

The library itself never reads these; see [Use as a library](#use-as-a-library).

---

## Use as a library

Build the config from **your app's own** variable names. The engine never reads `process.env` and never loads a `.env` file, so it cannot pick up another service's settings by accident.

```js
import { createMemoryEngine, formatContext } from 'custom-memory-engine';

const memory = createMemoryEngine({
  config: {
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      chatModel: 'gpt-4o-mini',
      embeddingModel: 'text-embedding-3-small',
      embeddingDim: 1536,
    },
    qdrant: { url: process.env.MEMORY_QDRANT_URL, apiKey: process.env.MEMORY_QDRANT_API_KEY },
    collection: 'student_memories',
    scoreThreshold: 0.22, // optional
  },
});

// Before answering: a prompt-ready profile (read once per turn)
const ctx = await memory.getContext(studentMessage, { userId });
const block = formatContext(ctx); // "Student context (do not cite)\nProfile:\n- ...\nRelevant:\n- ..."

// After replying: in the background (e.g. a job queue)
await memory.add(
  [{ role: 'user', content: studentMessage }, { role: 'assistant', content: answer }],
  { userId, metadata: { sessionId } }
);
// -> { results: [{ id, text, event: 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP', previousText? }] }
```

| Method | What it does |
|---|---|
| `add(messages, { userId, metadata, contextMessages })` | Extract, dedupe/update, store. Per-user writes are serialised. Messages in `contextMessages`, or with `context: true`, are shown to the extractor but never extracted from. |
| `getContext(query, { userId })` | `{ profile, relevant, smallTalk }` for the tutor prompt |
| `search(query, { userId, limit, category, scoreThreshold, includeArchived })` | Vector search |
| `getAll({ userId, category, includeArchived })` | All active memories (archived ones on request) |
| `get(id, { userId, includeArchived })` | One memory |
| `history(id, { userId })` | `ADD → UPDATE → ARCHIVE → RESTORE` entries with text, time and sessionId |
| `restore(id, { userId })` | Brings an archived memory back |
| `delete(id, { userId })` / `deleteAll({ userId })` | Hard delete, including history |

- **Every method requires `userId`**, and every Qdrant query filters by it.
- **Exports:** `createMemoryEngine`, `formatContext`, `isSmallTalk`, `CATEGORIES`, `loadConfigFromEnv` (this repo's variable names; reads only when called).
- **Config is checked up front:** `createMemoryEngine` validates it and throws one error naming every missing field.
- **Engines don't share state:** each instance has its own clients and queues.

**Injecting your own LLM clients and logger** (0.2.0):

```js
const memory = createMemoryEngine({
  config: { openai: { embeddingDim: 1536 }, qdrant: { url }, collection: 'wiki_memories' }, // no apiKey / models needed
  llm: {
    chat: async ({ system, user, json, temperature }) => myChat(system, user, { json, temperature }), // text, or object / JSON string when json
    embed: async (texts) => myEmbed(texts), // number[][], one vector per text, embeddingDim long
  },
  logger: { warn: (message, details) => myLog.warn(message, details) }, // details may contain fact text
});

// Earlier turns as context only: they help the extractor but produce no facts.
await memory.add([{ role: 'user', content: 'yes, the second one' }], { userId, contextMessages: previousTurns });
```

- `llm` can also be a client from `createLlmClient()` (`{ openai, chat }`), as before.
- **Fact text stays out of log messages.** The default logger prints decider-fallback messages with `console.warn`, and those messages contain no fact text. The text is passed only in `details`, so only an injected logger ever receives it.

**Integration advice** (as used in the RAG platform):
- Read memory once per turn.
- Sanitise PII before writing.
- Write through a durable job queue.
- Keep memory out of citations and the answer judge: use it only to adapt tone, length and examples.

---

## Project structure

```
src/
  index.js               public entry
  config/index.js        validateConfig(), loadConfigFromEnv()
  llm/client.js          chat() with JSON mode, temperature, retries on 429/5xx
  llm/embed.js           embed() / embedMany()
  stores/vectorStore.js  Qdrant only; every read/update/delete filtered by userId; history, archive state
  memory/MemoryEngine.js add, search, getAll, get, getContext, history, restore, delete, deleteAll
  memory/extractor.js    LLM fact extraction (active / ended)
  memory/decider.js      ADD / UPDATE / DELETE / NOOP + validator and fallbacks
  memory/context.js      small-talk gate, formatContext()
  memory/prompts.js      extraction and decider prompts, categories
  memory/messages.js     string or multi-part content -> text
scripts/                 setup checks, playground, evals, judges, Mem0 comparison harness
  providers/             engine and hosted-Mem0 adapters for the neutral harness
tests/                   extraction cases, retrieval cases, judge calibration set, held-out set
docs/evals/              every evaluation report
```

Folder rules are in [CLAUDE.md](CLAUDE.md):
- `llm/` holds provider wrappers only.
- `stores/` holds storage only.
- `memory/` holds all memory logic.
- **Every Qdrant query filters by `userId`.**

---

## Evaluation

| Script | Latest result |
|---|---|
| `eval:extraction` (12 original cases) | precision 100%, recall 100%, 0 forbidden, judge 100% |
| `eval:extraction:extended` (28 hard cases: typos, negation, sarcasm, other people, time changes, one-off requests) | keyword precision 90.3%, recall 93.5%, **0 forbidden**, judge 94.1% |
| `judge:calibrate` (23 human-labelled facts) | 95.7% agreement |
| `eval:update` (17 scenarios + parallel add) | 17/17 and 15/17 in the v0.1.1 runs; see flakes below |
| `eval:update:9a` (`EVAL_RUNS=5`) | 9a 5/5, 9b 5/5 |
| `eval:context` | context recall 100% (14/14), small-talk gate 1/19, `getContext` p50 ~460 ms |
| `eval:robustness` | 1,418 result ids, **0 cross-user leaks**; 0/90, 0/540, 0/10 breaches |
| `eval:integration` (`INTEGRATION_RUNS`, default 5) | skill-level update 5/5, cross-category 5/5, context-only messages 5/5 + 5/5 |
| `eval:mem0-compare` | engine vs hosted Mem0; `COMPARE_SET=heldout` for the unseen set |

**Other scripts:**
- `check`, `check:library`, `test:llm`, `test:store`, `playground`;
- `eval:retrieval`, `eval:pref-stability`, `eval:perf`, `eval:report`.

On PowerShell, counts and options go through environment variables (`$env:EVAL_RUNS = 5`, `$env:COMPARE_SET = "heldout"`), because `npm run x -- --flag` drops the `--`. Evals use scratch collections and delete them afterwards. Raw results go to `tests/results/`, which is gitignored.

---

## Known limitations

- **LLM variance at temperature 0.** Rare flakes seen in v0.1.1 runs:
  - the same conversation added twice can reword one fact (`UPDATE` instead of `NOOP`);
  - "ab mujhe sorting aa gayi" is occasionally stored as an active fact;
  - the decider sometimes returns no action for a fact (safe `ADD` fallback).
- **Compound goals with dates.** "Finish segment trees and bit manipulation before the 15 Oct mid-sem" can lose one topic, and the exam date becomes its own memory.
- **You run the database.** Qdrant needs hosting, backups and monitoring. There is no migration tool for existing Mem0 memories.
- **Memories carry no event dates**, unlike Mem0: only `createdAt` / `updatedAt` and history timestamps.
- **The tutoring domain is built in:** fixed categories and rules. It is not a general-purpose memory store.
- **The next evaluation step** is a held-out set from real student conversations.
