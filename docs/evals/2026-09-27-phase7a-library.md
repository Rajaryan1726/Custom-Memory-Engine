# Phase 7a: Library packaging

**Date:** 2026-09-27
**Code under test:** Phase 7a working tree (uncommitted; HEAD = `2d5eb17 phase 6.1-6.2`). Extraction aur decider prompts unchanged.

## Kya badla
- **Config injection:** `createMemoryEngine({ config, collection })` ab ek explicit config object leta hai: `{ openai: { apiKey, chatModel, embeddingModel, embeddingDim }, qdrant: { url, apiKey }, collection, scoreThreshold }`. `validateConfig()` ek hi error mein har missing ya invalid field ka naam deta hai.
- **Library `src/` ab environment ko nahi chhoota:**
  - dotenv import nahi hota.
  - `process.env` nahi padha jaata. Sirf opt-in `loadConfigFromEnv()` ka default argument, jo call hone par hi chalta hai.
  - Import time par koi throw nahi.
  - Scripts ab `scripts/runtime.js` ke through `.env` load karte hain (env variable names wahi hain).
- **Koi module-level singleton nahi:** OpenAI client (`createLlmClient`), embedder (`createEmbedder`), Qdrant client (`createVectorStore`), per-user queue aur ready-promise har engine instance ke andar bante hain.
  - `extractFacts(messages, { chat })` aur `decide(facts, candidates, { chat })` ko `chat` explicitly milta hai.
  - Judge scripts ka hissa hai aur runtime ka `chat` use karta hai.
- **Public entry `src/index.js`:** `createMemoryEngine`, `loadConfigFromEnv`, `formatContext`, `isSmallTalk`, `CATEGORIES`.
  - `package.json` mein `"exports": "./src/index.js"`, `"files": ["src"]`, version 0.1.0, `"type": "module"`.
  - `dotenv` ab devDependency hai.
- **Naya `npm run check:library`,** aur README mein "Use as a library" section.

## Library check (`npm run check:library`)

| Check | Result |
|---|---|
| 1. `src/index.js` ko child process mein **khaali environment** (`env: {}`) ke saath import kiya. Repo root mein `.env` maujood hai. | **PASS**: koi error nahi, 5 exports mile, aur `.env` ka koi variable child mein nahi aaya |
| 2. Static scan: `src/` mein dotenv ya `process.env` (sirf `loadConfigFromEnv` ka default allowed) | **PASS**: clean |
| 3. `createMemoryEngine` mein fields missing | **PASS**: `invalid config: config.openai.apiKey is required …; config.qdrant.url is required …` |
| 3b. `createMemoryEngine({})` bina config ke | **PASS**: `"config" is required: { … }` |
| 4. Ek process mein do engines, alag collections: A mein add, B se getAll / search / getContext | **PASS**: A ne 2 facts store kiye; B ko 0 / 0 / 0 mile. Dono collections end mein delete. |

**Windows note:** `env: {}` ke saath bhi Windows child process mein apne 11 system variables daal deta hai (`PATH`, `SYSTEMROOT`, `TEMP`, …). Isliye check 1 ye verify karta hai ki **repo ke `.env` ka koi variable** child mein nahi aaya. Pehla version poora khaali env maang raha tha aur isi wajah se FAIL hua tha; library ki koi galti nahi thi.

## Regression (Phase 6.2 se compare)

| Eval | Phase 6.2 | **7a** |
|---|---|---|
| `check` | Setup OK | **Setup OK** |
| `test:llm` | Paris / `{ city: 'Paris' }` / 1536 / 3 | **same** |
| `test:store` | 9/9 PASS | **9/9 PASS** |
| `eval:update` (1 run) | 16/16, fallbacks 0 | **16/16, fallbacks 0** |
| `eval:robustness` | 1,418 ids 0 leaks; 0/90; 0/540; 0/10; legacy 4/4 | **same, sab PASS** |
| `eval:context` | recall 100% (14/14; 8 profile, 6 relevant), search-only 6/6, injected [0,1,0,0,0], profile 5.0, gate 1/19 | **same numbers** |
| Original extraction (1 run) | 100 / 100 / 0 forbidden / judge 100%; calibration 95.7% | **same** |
| Playground | ADD, ADD, ADD, ADD; UPDATE Module 2 → 3; ADD cricket; isolation PASS (20 ids) | **same** |

**Sirf latency alag hai** (run-to-run variation):
- `add()` first p50 1,395 ms (6.2 mein 1,502 ms); repeat p50 2,282 ms (6.2 mein 2,533 ms).
- `getContext` p50 485 ms, p95 778 ms (Phase 6 mein 438 / 1,397 ms).

Behaviour mein koi farak nahi mila.
