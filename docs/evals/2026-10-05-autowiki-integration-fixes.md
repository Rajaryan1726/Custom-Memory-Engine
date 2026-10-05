# v0.2.0: fixes from the AutoWiki integration eval

Date: 2026-10-05.
- **Before:** `0bd0bf3` (v0.1.1), run in a separate worktree.
- **After:** this commit.

Both sides ran the same suite, on the same machine and the same OpenAI key:
- `eval:extraction` ×3 and `eval:extraction:extended` ×3
- `eval:retrieval`, `eval:robustness`, `eval:perf`
- `eval:update`, `eval:context`, `eval:report`
- the new `eval:integration` (the "before" side used a copy of the script)

The existing public API is unchanged and old call shapes work as before: `createMemoryEngine`, `add`, `search`, `getAll`, `get`, `delete`, `deleteAll`. Without context messages, the extraction prompt sent to the model is unchanged apart from the new prompt rules.

## What changed

1. **Cross-category candidates** (`src/memory/MemoryEngine.js`, `findCandidates`).
   - Each new fact still gets the top 5 same-category memories.
   - It now also gets the top 5 memories from **any** category with similarity ≥ 0.5, deduplicated.
   - So an old `[other]` "User finds TypeScript hard…" now reaches the decider for a new `[identity]` fact.
   - The score floor keeps unrelated memories out of the decider prompt.
   - Cost: one extra Qdrant query per fact, run in parallel (~95 ms).
2. **Skill level** (`EXTRACTION_PROMPT`).
   - Level with a technology is `identity`, phrased "User is a beginner / comfortable / experienced with X", with one fact per technology.
   - A change of level is a new **active** fact, never an "ended" one.
   - New few-shot example: "Actually I'm comfortable with TypeScript now" → `{"text":"User is comfortable with TypeScript","category":"identity","status":"active"}`.
3. **Context-only messages** (`add`, `extractFacts`, `EXTRACTION_PROMPT`).
   - Use `add(messages, { userId, contextMessages })`, or set `context: true` on a message.
   - Context messages are sent to the model in an "Earlier conversation (context only …)" section and are never extracted from.
   - Only non-context user messages can trigger extraction: a call with only context makes no LLM call.
   - Prompt rule 17 and two few-shot examples back this up. An instruction in the user message alone was not enough: the first "after" run still extracted from context in 4/5 runs.
4. **Injection and logging.**
   - `createMemoryEngine({ llm: { chat, embed } })`:
     - `embed(texts)` returns `number[][]`.
     - `chat({ system, user, json, temperature, model })` returns text, or an object or JSON string when `json` is set.
   - `config.openai.apiKey`, `chatModel` and `embeddingModel` are optional when the matching clients are injected. `embeddingDim` is still required. The old `{ openai, chat }` client still works.
   - `createMemoryEngine({ logger })` takes `{ warn(message, details) }`. Decider-fallback **messages never contain fact text**; the text is only in `details`.
   - The default logger prints just the message with `console.warn`.
   - Scripts use a logger that also prints the fact text, as dev tooling only.

Version 0.1.1 → **0.2.0**: backward-compatible API additions.

**API additions:**
- `add(messages, { userId, metadata, contextMessages })`
- `message.context === true`
- `createMemoryEngine({ llm: { chat, embed }, logger })`
- `extractFacts(messages, { chat, contextMessages })`
- `decide(facts, candidates, { chat, logger })`

## Before / after

### Integration eval (new, `npm run eval:integration`, 5 fresh users per case)

| Case | Before | After |
|---|---|---|
| Skill level: "I'm a beginner with TypeScript" → "Actually I'm comfortable with TypeScript now"; must UPDATE the same id | 1/5 | **5/5** (UPDATE, same id, 5/5) |
| Cross-category: seeded `[other]` TypeScript memory, then the comfortable fact | 5/5* | **5/5** |
| Context-only, `contextMessages` option | 5/5* | **5/5** |
| Context-only, per-message `context: true` | 0/5 (name and Docker level extracted from context) | **5/5** |

\* These two "before" passes don't exercise the fix:
- **Cross-category:** the old extractor put "comfortable with TypeScript" in `[other]`, the same category as the seed, so no cross-category search was needed. After the change the new fact is `[identity]`, and the final memory is `[identity]`, updated from the `[other]` seed.
- **Context-only option:** the old `add()` ignored `contextMessages` completely, so the model never saw the context.

The context test criterion was tightened during the work. "Re-extracted" now means any result (NOOP included) that repeats a context fact. New information from the new message, such as "abhi bas basics" → "User is studying the basics of Rust", is allowed. In the final run, one "after" attempt hit a network `fetch failed`; a rerun was 5/5.

### Existing suite

| Eval | Before (v0.1.1) | After (v0.2.0) |
|---|---|---|
| Original extraction, keyword precision (3 runs) | 95.5 / 100 / 95.5% | **100 / 100 / 100%** |
| Original extraction, recall / forbidden / judge precision | 100% / 0 / 100% ×3 | 100% / 0 / 100% ×3 |
| Extended extraction, keyword precision | 93.8 / 93.8 / 93.8% | **96.8 / 96.8 / 93.5%** |
| Extended extraction, keyword recall | 100 / 100 / 100% | 100 / 100 / **96.8%** |
| Extended extraction, forbidden facts | 0 ×3 | 0 ×3 |
| Extended extraction, judge precision | 91.2 / 91.2 / 94.1% | **85.3 / 88.2 / 88.2%** |
| Judge calibration | 95.7% (22/23) | 95.7% (22/23) |
| Retrieval: top-1 / top-3 / MRR | 71.4% / 100% / 0.857 | same |
| Robustness | 1,418 ids 0 leaks; 0/90; 0/540; 0/10; legacy PASS | same |
| `eval:update` | 17/17, 0 fallbacks | 16/17 (scenario 2), then 17/17 and 17/17 on reruns |
| `eval:context` | recall 14/14, search-only 6/6, injected [0,1,0,0,0], gate 1/19 | same |
| `eval:report` (extraction run-to-run) | flaky: original `language_preference_hinglish` | flaky: extended `joke_virat_kohli` |
| `eval:perf`, extraction call p50 | 1,066 ms | 1,087 ms |
| `eval:perf`, `add()` end to end p50 / p95 (n=10) | 2,711 / 3,130 ms | 3,306 / 3,999 ms |
| `eval:update`, repeat add with decider p50 | 2,743 ms | 2,661 ms |
| `getContext` p50 | 407 ms | 425 ms |

### Metrics that got worse, and why

- **Extended judge precision, −4.9 points on average (92.2% → 87.3%).**
  - **Mostly the judge's rubric versus the requested spec.** The judge's category rubric (`scripts/judge.js`) still says a language skill is a preference. So it marks every `[identity] User knows Python` / `User is comfortable with C++` as "wrong category". That is now the specified category: technology level is `identity`.
  - **One extra fact per run.** "One fact per technology" splits `negation_knows_python_not_java` into "User knows Python" and "User does not know Java". The judge marks both wrong for category, where before it marked one wrong.
  - **One real extraction slip in run 1:** `long_multiturn_facts_spread` gave "User is on Module 3" instead of "User has completed Module 3".
  - **One known judge error on both sides:** `sarcasm_recursion_easy` is the calibration item #23 disagreement.
  - I did not change the judge rubric, so before and after use the same judge.
- **Extended recall 96.8% in 1 of 3 runs.**
  - In `joke_virat_kohli`, "abhi basics hi seekh raha hoon" became `[identity] User is a beginner with coding` instead of a progress fact with "basics". The new skill-level rule over-applies here, so the keyword expectation misses.
  - The judge marks the fact correct, and it happened in 1 of 3 runs, so the report lists the case as flaky.
- **`eval:update` 16/17 in one run.**
  - Scenario 2 ("Module 3 khatam", then "Module 4 shuru") ADDed "User is on Module 4" next to "User has completed Module 3".
  - The decider input for this scenario is the same as before (both facts are `progress`), and no fallback fired.
  - Two reruns gave 17/17. This is a decider flake, like the scenario 4 and 7 flakes noted in v0.1.1.
- **`add()` end-to-end p50 +0.6 s** (n=10, noisy; the first "after" run measured 2.9 s). It comes from:
  - a longer extraction prompt: 2 rules and 3 examples;
  - one extra parallel Qdrant query per fact.
  - The repeat-add p50 with the decider did not rise (2.74 → 2.66 s).

## Offline checks

16 offline checks passed, with an injected fake `chat` / `embed` against local Qdrant:
- **Config:** no `apiKey`, `chatModel` or `embeddingModel` needed when `chat` and `embed` are injected, but all three are still required without injection. `llm` without `embed` is rejected.
- **Prompt:** the old call shape gives the same prompt as before, and a JSON string from an injected `chat` is parsed.
- **Cross-category and update:** a cross-category candidate reaches the decider, and the UPDATE keeps the same id.
- **Context messages:**
  - `contextMessages` and `context: true` both produce a prompt with context before the conversation;
  - an add with only context makes no LLM call;
  - a `contextMessages` value that isn't an array is rejected.
- **Logger:** fallback messages contain no fact text, `details` carry it, and nothing is written to `console.warn` when a logger is injected.
