# Phase 6: Memory history, safe delete, retrieval layer

**Date:** 2026-09-26
**Code under test:** Phase 6 working tree (uncommitted; HEAD = `ff3718a phase 5c`). Extraction aur decider prompts unchanged.
**Models:** extractor aur decider `gpt-4o-mini` (temperature 0). Embeddings `text-embedding-3-small`.

## Kya bana

### Part A: history aur safe delete
- **Decider DELETE ab point nahi hatata.** Memory `state: "archived"` ho jaati hai, saath mein `archivedAt` aur `archivedReason` (ended fact ka text).
  - Jin points mein `state` field nahi hai, wo active maane jaate hain.
  - `state` par keyword payload index add kiya.
- **Saare reads (`search`, `getAll`, `getById`) default mein archived points skip karte hain.** Isme `must_not state == "archived"` filter use hota hai, isliye bina `state` wale purane points bhi match hote hain. Archived bhi dekhne ho to option `includeArchived: true`.
- **History payload ke andar:** har ADD, UPDATE, ARCHIVE aur RESTORE par `{ event, text, at, sessionId }` append hota hai. Sirf last 20 entries rakhi jaati hain.
- **Naye engine methods:**
  - `history(id, { userId })`: `null` agar memory is user ki nahi hai.
  - `restore(id, { userId })`: state wapas active karta hai aur `RESTORE` entry jodta hai.
- **User ke explicit deletes ab bhi hard delete hain:** `engine.delete(id)` aur `deleteAll({ userId })` point poora hata dete hain, archived aur history samet.

### Part B: retrieval layer
- **`vectorStore.search`:** `category` string ho sakta hai ya array (match any).
- **`getContext(query, { userId })` → `{ profile, relevant, smallTalk }`:**
  - `profile`: identity, progress, preference aur goal ki saari active memories, bina vector search. `updatedAt` ke hisaab se newest first, max 15.
  - `relevant`: sirf weak_topic aur other par vector search. Limit 3, threshold `MEMORY_SCORE_THRESHOLD` (default 0.22).
  - **Small-talk gate:** word-list check, LLM call nahi. "thanks", "ok bhai", "theek hai", "samajh aa gaya", sirf emoji, jaise ≤5 words wale messages par embedding aur vector search dono skip; `relevant = []`.
- **`formatContext({ profile, relevant })`:** "Student context (do not cite)" heading ke saath plain-text block. Khaali sections chhod diye jaate hain; kuch bhi na ho to `""`.
- **`search()` ka default behaviour wahi hai** (Mem0 compatibility). Bas `includeArchived` option naya hai.

## Update suite (`eval:update`, 2 runs)

| # | Scenario | Run 1 | Run 2 |
|---|---|---|---|
| 1 | Module 2, phir 3 (+ sessionId, createdAt, **history: ADD Module 2, phir UPDATE Module 3**) | PASS | PASS |
| 2 | Module 3 khatam, phir Module 4 | PASS | PASS |
| 3 | Module 5 + linked lists, phir trees | PASS | PASS |
| 4 | Same conversation 2 baar | PASS | PASS |
| 5 | recursion 2 baar | PASS | PASS |
| 6 | DP weak, phir clear (**archived, includeArchived se dikhta hai, archivedReason set**) | PASS | PASS |
| 7 | Ended fact, kuch stored nahi | PASS | PASS |
| 8 | recursion, phir graphs | PASS | PASS |
| 9a | short, phir one-off "isko detail mein samjhao" | **FAIL** | PASS |
| 9b | short, phir standing "hamesha detail mein samjhaya karo" | PASS | PASS |
| 10 | placement goal, phir Amazon SDE goal | PASS | PASS |
| 11 | Lamba sequence, naam unchanged | PASS | PASS |
| 12 | Do students, B untouched | PASS | PASS |
| 13 | Hinglish module search: Module 3 top | PASS | PASS |
| **15** | **restore archived memory wapas laata hai** (history: ADD, ARCHIVE, RESTORE) | PASS | PASS |
| **16** | **engine.delete archived memory poori hata deta hai** (includeArchived, history, get: sab khaali) | PASS | PASS |
| **Total** | | **15/16** | **16/16** |
| 14 (extra) | Parallel add, same user | PASS | PASS |

**Decider fallbacks: 0** (dono runs). Decider calls: 23 / 21.

**Run 1 ka failure (9a), events:**
```
add "mujhe short explanations chahiye"  -> ADD: User prefers short explanations
add "isko detail mein samjhao"          -> UPDATE: "User prefers short explanations" -> "User prefers detailed explanations"
```
- Is baar extractor ne one-off request ko standing preference maan liya, aur decider ne sahi tarah UPDATE kar diya.
- **Ye Phase 6 ki wajah se nahi hai;** extraction prompt aur code badle hi nahi. Ye temperature 0 par bhi extraction ka flakiness hai.
- 9a ab tak 4 runs mein chala hai (5c ke 2 aur Phase 6 ke 2), aur 1 baar fail hua. Asli student ke liye iska matlab: kabhi-kabhi ek baar ki request ("isko detail mein samjhao") poori preference badal degi.
- Maine re-run karke pass nahi karwaya.

**Scenario 1 history (dono runs):** `ADD "User is on Module 2" (session_1)`, phir `UPDATE "User is on Module 3" (session_2)`.

## Robustness (`eval:robustness`)

| Check | Result |
|---|---|
| Isolation: 10 users × 6 memories, har user ki 1 memory archived. Plain, category-filtered aur includeArchived search, engine getAll(includeArchived), getContext, engine.search(includeArchived) | **1,418 ids checked, 0 leaks** (pehle 620) |
| Cross-user `getById` | **0/90** |
| Cross-user `history`, `get(includeArchived)`, `restore` (har user ne har doosre user ki active aur archived memory try ki) | **0/540 breaches**. Victims ki archived memories archived hi rahin. |
| User ki apni archived memory default reads mein | **0/10** (kabhi nahi dikhi) |
| Edge inputs | Pehle jaisa, multi-part content PASS |
| Stale baseline | ADD Module 2, UPDATE Module 3, 1 memory |

**Purane points (bina `state` field):** ek one-off check mein Phase 5 jaisa point (bina `state` aur `history`) seedha Qdrant mein daala. Wo `getAll`, `search` aur `getContext` teeno mein aaya, `state: "active"` report hua, aur history `[]` aayi. Yaani existing data ke liye migration ki zarurat nahi.

## Context eval (`eval:context`, retrieval cases: 4 students, 29 memories, 19 queries)

| Metric | Result |
|---|---|
| **Context recall** (expected memory profile + relevant mein) | **100% (14/14)**: 8 profile mein, 6 relevant mein |
| Search-only subset (expected memory weak_topic/other mein, sirf vector search dhoondh sakta hai) | **100% (6/6)** |
| "Nothing relevant" queries par injected relevant memories | **[0, 1, 0, 0, 0]**, total 1 (BST query par "struggles with dynamic programming", 0.266) |
| Average profile size | 5.0 (har student ke 5 profile-category memories) |
| Small-talk gate fired | 1/19 ("thanks bhai") |
| Formatted context size | mean 259 chars, max 348 |
| getContext latency | p50 438 ms, p95 1,397 ms (search ke saath). Gated query: 63 ms |

**Phase 4 `search()` se comparison (same cases):**
- Phase 4 ka top-1 71.4% aur top-3 100% tha, lekin tab 5 memories bina threshold ke inject hoti thi. Hinglish queries par sahi memory aksar pehle number par nahi aati thi.
- `getContext` mein profile categories hamesha poori jaati hain, isliye wahan ranking ka sawaal hi nahi. Search sirf weak_topic/other par hota hai, max 3, threshold 0.22 ke saath.
- **Nateeja:** tutor ke context mein sahi memory 14/14 baar pahunchi. "Nothing relevant" queries par Phase 4 mein 5-5 memories jaati thi; ab relevant section mein 5 queries par kul 1.

**Kamiyan jo dikhi:**
- **Relevant section mein ab bhi thoda noise hai.** Expected wali 14 queries mein relevant ke andar kai unrelated memories aayi. Jaise "which module is the student on?" par "User studies late at night after college" (0.310), aur "which programming language…" par DP aur graphs. Profile ki wajah se recall 100% hai, lekin relevant ki precision abhi perfect nahi hai.
- **DP wali memory threshold ke bilkul kinare par hai.** "DP ka ye question samjhao" par 0.224 aaya, threshold 0.22 hai. Threshold thoda sa bhi upar kiya to ye Hinglish query miss ho jayegi.
- **Profile har query mein jaata hai,** "thanks bhai" aur "capital of France" mein bhi (5 lines). Ye design ke hisaab se hai (small talk par sirf vector search skip hota hai), lekin har prompt mein ~260 chars jaate hain.
- **p95 1.4 s ek slow embedding call ki wajah se hai** (n=19). p50 438 ms Phase 4 ke `search()` (~422 ms) jitna hi hai.

## Playground

- Events aur naya **e2** section: `getContext` + `formatContext`.
- "recursion ka example do" par Profile mein 3 lines aayi aur Relevant mein "User struggles with recursion".
- "thanks!" par small-talk gate chala: sirf Profile, vector search skip.
- Isolation check **PASS** (20 ids, 0 leaked; ab getContext ke ids bhi check hote hain).

## Jo notice kiya

- **archivedReason aksar memory text jaisa hi hota hai** ("User struggles with dynamic programming (DP)"), kyunki ended fact usi wording mein likha jaata hai. Ye sahi hai, lekin user ke asli shabd ("ab DP clear ho gaya") isme nahi hote. Wo chahiye to reason mein source message bhi rakhna padega.
- **Ek archived weak_topic dobara aaye to kya hoga:** decider candidates mein archived memories nahi aati. Isliye "DP mein phir dikkat hai" ek **nayi** memory ADD karega, purani restore nahi karega. History do alag memories mein bat jayegi.
- **`restore` ek already-active memory par no-op hai** (koi history entry nahi).

## Next steps
1. **9a flakiness:** one-off vs standing ke liye extraction prompt mein ek aur contrast example, ya decider mein rule ki single-message preference change ke liye confirmation chahiye. Pehle decide karo ki kitna flaky chalega.
2. **Relevant noise:** relevant ke liye alag, thoda ooncha threshold (jaise 0.25) ya limit 2 try karo, aur DP wale 0.224 case par asar dekho.
3. **Archived memory ka dobara aana:** decider ko archived candidates bhi dikhao, taaki wo naya ADD karne ke bajaye RESTORE kar sake.

---

## Phase 6 wrap-up

### Legacy point check ab permanent hai
One-off check ab `scripts/eval-robustness.js` mein "Legacy point (no state field) counts as active" section ke roop mein hai. Raw Qdrant client se ek point bina `state` aur `history` ke likha jaata hai (store use nahi kiya, kyunki store ye fields khud jod deta), phir 4 checks:

| Check | Result |
|---|---|
| `getAll` mein dikhe, `state: "active"` ke saath | PASS |
| `search` mein dikhe | PASS |
| `getContext` ke relevant mein dikhe | PASS |
| `history` `[]` de (null nahi) | PASS |

Is run mein baaki robustness bhi same raha: 1,418 ids par 0 leaks, cross-user 0/90 aur 0/540, archived memory default reads mein 0/10.

### 9a flakiness measurement (koi fix nahi)

`npm run eval:update:9a` (sirf scenarios 9a aur 9b; runs ki ginti env var `EVAL_RUNS` se, default 5). `EVAL_RUNS=5` ke saath chalaya.

| Scenario | Pass | Fail |
|---|---|---|
| 9a: short, phir one-off "isko detail mein samjhao" | 4 | **1** (run 3) |
| 9b: short, phir standing "hamesha detail mein samjhaya karo" | 5 | 0 |

**9a failure (run 3), exact extractor output aur decider events:**
```
add "mujhe short explanations chahiye"
  extracted: [preference] (active) User prefers short explanations
  decider:   (not called)
  events:    ADD: User prefers short explanations
add "isko detail mein samjhao"
  extracted: [preference] (active) User prefers detailed explanations
  decider:   [{"fact":0,"action":"UPDATE","memory":"m1","text":"User prefers detailed explanations"}]
  events:    UPDATE: "User prefers short explanations" -> "User prefers detailed explanations"
```
- Baaki 4 runs mein follow-up par `extracted: (none)` aaya aur decider call nahi hua.
- Decider ne failure mein bhi apna kaam sahi kiya: preference fact aaya to usne UPDATE kiya. **Galti poori tarah extraction mein hai.**

**9b:** paanchon runs mein same output: `[preference] (active) User prefers detailed explanations`, phir decider ne UPDATE kiya. Koi failure nahi.

**`extractFacts` akele, same input par** (`[{"role": "user", "content": "isko detail mein samjhao"}]`, yaani wahi jo `add()` bhejta hai), 5 baar: **preference fact 0/5** (paanchon baar `(none)`).

**Total tasveer:**
- Is run mein us exact message par extractor 10 baar chala (5 scenario ke andar, 5 akele), aur **1/10 baar** preference bani.
- 9a scenario ab tak 9 runs mein chala hai (5c: 2, Phase 6: 2, wrap-up: 5), aur **2/9 baar fail** hua.
- Sample chhota hai, lekin ek baar ki request ke galat tarah preference ban jaane ki dar lagbhag **10–20%** hai.
- Temperature 0 par bhi gpt-4o-mini same input par hamesha same output nahi deta.

**Decider fallbacks:** 0.
