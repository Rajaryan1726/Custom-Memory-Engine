# Phase 7c-1: mera engine vs hosted Mem0, ek hi neutral harness pe

Date: 2026-09-27. Engine: v0.1.0 (commit 8043e2d, `src/` is phase mein bilkul nahi badla).
Mem0: hosted platform, `mem0ai` 3.1.6 ka `MemoryClient` (wahi client jo RAG app use karta hai),
ek alag test project/key pe (production Mem0 project ko touch nahi kiya).

Command: `npm run eval:mem0-compare` (default 2 runs). Final numbers niche ke run se hain:
`tests/results/mem0-compare-2026-09-27T06-15-11-014Z.json` (tag `mujegwi7`). Ek pehla pair of runs
(`...05-40-48-440Z.json`, tag `mujdagsi`) bhi hua tha; uske numbers section 2 mein stability ke liye diye hain.

---

## 1. Setup: kya aur kaise compare kiya

**Ek interface, do adapters** (`scripts/providers/`):

| Method | Engine adapter | Mem0 adapter |
|---|---|---|
| `add(messages, { userId })` | `engine.add` | `client.add(messages, { userId })` + wait (niche dekho) |
| `getAll({ userId }) -> string[]` | `engine.getAll` (sirf active memories; archived chhupi) | `client.getAll({ filters: { user_id } })`, saare pages |
| `search(query, { userId, limit }) -> string[]` | `engine.search` | `client.search(query, { filters: { user_id }, topK: limit })` |
| `deleteAll({ userId })` | `engine.deleteAll` | `client.deleteAll({ userId })` + event wait + `deleteUsers` |

Library `mem0ai` pe depend nahi karti: `mem0ai` sirf `devDependencies` mein hai (exact `3.1.6`),
aur sirf `scripts/` use import karte hain. `MEM0_API_KEY` sirf scripts `.env` se padhti hain.
Mem0 telemetry is harness mein band hai (`MEM0_TELEMETRY=false`), memory behaviour pe iska koi asar nahi.

**Mem0 ka async add() kaise handle kiya.** Probe se pata chala:
- `POST /v3/memories/add/` turant `{ eventId, status: "PENDING" }` deta hai; memories baad mein likhi jaati hain.
- `asyncMode: false` bhejne se bhi kuch nahi badla (v3 endpoint ise ignore karta hai), to add ko synchronous banane ka koi tareeka nahi mila.
- `GET /v1/event/{eventId}/` kaam karta hai: status `PENDING -> RUNNING -> SUCCEEDED/FAILED`, aur `results` mein ADD/UPDATE/DELETE hue memory ids.

Isliye adapter ka `add()` tab tak return nahi karta jab tak:
1. event `SUCCEEDED` na ho jaaye (har 1 s poll, 180 s timeout; `FAILED` ya timeout = error), **aur**
2. `getAll` mein event ke saare ADD/UPDATE ids dikhne na lagein aur DELETE ids gayab na ho jaayein (read-after-write check; poore run mein ek baar bhi retry ki zaroorat nahi padi: `visibilityRetries: 0`).

Jo add 180 s mein khatam nahi hua, woh error hai: us case/scenario ka koi read nahi hota
(scenario 13, jo scenario 1 ka user padhta hai, scenario 1 fail hone pe skip hota hai). Aise event ids
yaad rakhe jaate hain aur cleanup se pehle unke khatam hone ka wait hota hai (`settlePending`), taaki koi late write cleanup ke baad user dobara na bana de.
add() latency mein yeh saara wait shamil hai.

**Neutral judge** (`scripts/neutral-judge.js`): `gpt-4o`, temperature 0, dono providers ke liye same prompts.
Judge sirf memory ka plain text dekhta hai: category, status, events, score ya provider ka naam kabhi nahi.
Judge ko aaj ki date di jaati hai, kyunki Mem0 memories pe "as of 2026-09-27" likhta hai aur bina date ke judge unhe "future date" bol kar galat maar raha tha.
1500 characters se lambi memory dono providers ke liye same tarah kaati jaati hai.
- *Memory check*: conversation + ek memory -> correct/wrong + reason. Wrong agar: kisi aur ke baare mein, past ko current bataye, negation/sarcasm literal le, hypothetical ko real maane, durable na ho (small talk, one-off request, course question), unsupported ho, ya garbled/repeated ho.
- *Scenario check*: final memory list + plain-English expected state -> pass/fail + reason.
- *Assertion check* (ended/forbidden ke liye): ek memory + ek plain-English claim -> kya memory claim ko abhi sach bata rahi hai?

**Data**
- 16 update scenarios (`scripts/eval-update.js` ke saare, + extra 14 "parallel add"), `scripts/compare-data.js` mein har ek ka plain-English expected state. Teen scenario engine-only APIs test karte the, unhe caller-visible version mein badla:
  - 1: sessionId / createdAt / history() -> sirf final state.
  - 15: `restore()` -> "DP weak, clear, phir se weak".
  - 16: `delete(id)` -> `deleteAll()` ke baad kuch nahi bachna chahiye.
- 40 extraction cases (original 12 + extended 28). Har case: naya user, ek `add()`, phir `getAll`.
  - Precision = judge-correct / total memories.
  - Recall = expected active facts jo kisi bhi memory text mein keyword se mile (category/status ignore). Total 51.
  - Ended (1 claim) aur forbidden (12 claims): kitni memories inhe abhi bhi sach bata rahi hain. 2 forbidden specs sirf category rule the ("English" ko course weak_topic maan lena); category-free harness unhe dekh hi nahi sakta, isliye skip kiye.
- Saare test userIds `m0eval_` se shuru. Dono providers ko ek saath same inputs; dono pe concurrency 3.

---

## 2. Summary table (final pair, dono providers, dono runs)

| Metric | Engine run 1 | Mem0 run 1 | Engine run 2 | Mem0 run 2 |
|---|---|---|---|---|
| Update scenarios pass (core 16) | **16/16** | 8/16 | **16/16** | 7/16 |
| Extra 14: parallel add | 1/1 | 1/1 | 1/1 | 1/1 |
| Precision (judge), 40 cases | **94.3%** (50/53) | 61.0% (36/59) | **96.2%** (51/53) | 67.2% (43/64) |
| &nbsp;&nbsp;original suite | 95.2% (20/21) | 75.0% (12/16) | 100.0% (21/21) | 83.3% (15/18) |
| &nbsp;&nbsp;extended suite | 93.8% (30/32) | 55.8% (24/43) | 93.8% (30/32) | 60.9% (28/46) |
| Recall (keyword) | 100.0% (51/51) | 98.0% (50/51) | 100.0% (51/51) | 98.0% (50/51) |
| "Ended" fact abhi bhi sach bataya | 0 | 0 | 0 | 0 |
| Forbidden fact sach bataya (12 claims) | **0** | 2 | **0** | 3 |
| Avg memories / case | 1.32 | 1.48 | 1.32 | 1.60 |
| add() p50 (Mem0: wait ke saath) | **1.6 s** | 7.1 s | **1.7 s** | 9.5 s |
| add() p95 | **2.6 s** | 53.8 s | **2.5 s** | 49.0 s |
| search p50 | 0.4 s | 0.5 s | 0.5 s | 0.5 s |
| search p95 | **0.5 s** | 3.0 s | **0.7 s** | 3.0 s |
| add timeouts (>180 s) | 0 | 2 | 0 | 1 |
| Memories > 1000 characters | 0 (sabse lambi 76) | 7 (sabse lambi 16,656) | 0 (76) | 12 (25,837) |

Pehla pair (purana harness code, same inputs, same judge), stability ke liye:

| | Engine r1 | Mem0 r1 | Engine r2 | Mem0 r2 |
|---|---|---|---|---|
| Scenarios | 16/16 | 7/16 | 16/16 | 8/16 |
| Precision | 94.3% | 60.7% | 94.3% | 62.0% |
| Recall | 100% | 92.2% | 100% | 92.2% |
| Forbidden sach | 0 | 3 | 0 | 2 |
| add p50 / p95 | 1.7 / 2.6 s | 8.0 / 90.9 s | 1.6 / 3.2 s | 6.9 / 68.9 s |
| Timeouts | 0 | 1 | 0 | 3 |

Chaaron runs mein picture same hai. Pehle pair mein Mem0 ka recall kam isliye tha kyunki 4 timeouts ke cases ki memories aayi hi nahi.

---

## 3. Update scenarios: side by side

Cell = pass/fail (final memory count; scenario 12 mein A/B, 13 mein search results).

| # | Scenario | Engine r1 | Engine r2 | Mem0 r1 | Mem0 r2 |
|---|---|---|---|---|---|
| 1 | Module 2 -> Module 3 | pass (1) | pass (1) | **fail** (2) | **fail** (3) |
| 2 | Module 3 khatam -> Module 4 | pass (1) | pass (1) | pass (2) | pass (2) |
| 3 | Module 5 + linked lists -> trees | pass (2) | pass (2) | **fail** (3) | **fail** (3) |
| 4 | same conversation do baar | pass (4) | pass (4) | pass (2) | pass (1) |
| 5 | recursion do baar, alag shabd | pass (1) | pass (1) | pass (1) | pass (1) |
| 6 | DP weak -> DP clear | pass (0) | pass (0) | **fail** (2) | **fail** (2) |
| 7 | "ab sorting aa gayi" | pass (0) | pass (0) | pass (1) | pass (1) |
| 8 | recursion, phir graphs | pass (2) | pass (2) | pass (2) | pass (2) |
| 9a | short pref, phir one-off "detail mein" | pass (1) | pass (1) | **fail** (2) | **fail** (2) |
| 9b | short pref, phir "hamesha detail" | pass (1) | pass (1) | **fail** (2) | **fail** (2) |
| 10 | placement goal -> Amazon SDE goal | pass (1) | pass (1) | **fail** (2) | **fail** (2) |
| 11 | lambi mixed sequence | pass (3) | pass (3) | **fail** (timeout) | **fail** (timeout) |
| 12 | A DP clear kare, B untouched | pass (0/1) | pass (0/1) | pass (2/1) | **fail** (2/1) |
| 13 | search "main kaunse module pe hoon?" | pass | pass | pass | pass |
| 15 | (adapted) DP weak -> clear -> phir weak | pass (1) | pass (1) | **fail** (3) | **fail** (3) |
| 16 | (adapted) deleteAll | pass (0) | pass (0) | pass (0) | pass (0) |
| 14 | (extra) parallel add, same fact | pass (1) | pass (1) | pass (1) | pass (1) |

Engine ka koi failure nahi. Mem0 ke har failure ka judge reason (final pair):

| # | Mem0 run 1: judge reason | Mem0 run 2: judge reason |
|---|---|---|
| 1 | "There is a memory stating the student is on Module 2" (Module 3 aur Module 2 dono "as of 2026-09-27" current) | same; ek memory khud likhti hai "supersedes the previous Module 2 memory" phir bhi Module 2 wali memory rehti hai |
| 3 | "User is currently working on linked lists" abhi bhi hai | same (do memories linked lists ko current batati hain) |
| 6 | "User reports having a lot of difficulty with DP" rehti hai, "DP is now clear" ke saath | same |
| 9a | one-off "isko detail mein samjhao" ko preference jaisi memory bana diya ("preference for more thorough answers now") | same |
| 9b | nayi "hamesha detail" memory aa gayi, purani "short explanations" wali nahi hati | same |
| 10 | DSA goal do alag memories: placement aur Amazon SDE | same |
| 11 | add 180 s mein khatam nahi hua (timeout). Pehle pair mein timeout ke bina bhi fail tha: Module 2 aur "DP difficulty" dono current rahe | same (timeout) |
| 12 | pass | A ke paas "difficulty with DP" aur "DP clear" dono |
| 15 | "DP is now clear" rehti hai + DP difficulty do baar (ek 16,675 characters ki) | "DP is now clear" rehti hai + DP difficulty do baar |

**Pattern:** Mem0 naye fact ko ADD karta hai lekin purane contradicting fact ko UPDATE/DELETE nahi karta.
To "current state" wale sawalon pe (module, DP weak/clear, preference badli, goal badla) dono version reh jaate hain.

**`latestOnly` bhi try kiya.** Mem0 v3 mein `getAll`/`search` ka `latestOnly: true` option hai jo "superseded" memories chhupata hai. RAG app ise pass nahi karti.
Ek alag variant (`COMPARE_PROVIDERS=mem0-latest`, 1 run, stale-state scenarios 1, 3, 6, 9b, 10, 11, 15, 13) chalaya:
1/8 pass, sirf 13. 10 timeout hua, baaki same tarah fail hue (Module 2 + 3, DP weak + clear, short + detail, sab dikhte rahe).
Matlab Mem0 in memories ko superseded mark hi nahi karta, to `latestOnly` se yahan koi fark nahi padta.

---

## 4. Extraction: failures side by side (final pair)

Engine ki galat memories (judge ke hisaab se), dono runs:

| Case | Memory | Judge reason | Mera note |
|---|---|---|---|
| sarcasm_recursion_easy (r1, r2) | "User struggles with recursion" | "sarcasm read literally" | **Judge ki galti.** Student 3 din se atka hai; yahi expected weak_topic hai |
| three_facts_one_message (r1) | "User is on Module 5" | "module progress is not a lasting fact" | **Judge ki galti.** Current module durable fact hai |
| nickname_preference (r1, r2) | "User's name is Sneha" | "prefers to be called Snehu" | Bahas ho sakti hai; judge ka verdict rakha |

Mem0 ki galat memories, pattern ke hisaab se (run 1 / run 2 counts):

| Pattern | r1 | r2 | Misaal |
|---|---|---|---|
| Garbled / baar baar repeated text | 8 | 6 | "User's name is Raj and they are struggling …" (kai hazaar characters), "hobby_is_other: `User`" (sirf ek shabd) |
| Assistant / course content ko student ki memory bana diya | 7 | 6 | "Recursion is when a function calls itself…", "Merge sort … O(n log n)", "Assistant provided bubble sort code…" |
| One-off request ko memory bana diya | 2 | 2 | "User asked for a dry-run demonstration…", "User requested a slower … explanation" |
| Kisi aur ke baare mein (dost, behen) | 2 | 1 | "User's friend is weak in graphs…", "User's sister is on Module 7 and likes DP" |
| Past ko current / hypothetical / sawal ko fact | 3 | 2 | "User was on module 2 during the week of…", "User feels that if they were on module 5…", "User is wondering whether to apply recursion before DP" |
| Sarcasm / joke literal | 0 | 2 | "User finds recursion easy but has been stuck…", "User jokingly says they are the Virat Kohli of coding" |
| Judge ki galti (Mem0 ke khilaaf) | 1 | 2 | "third-year student at NIT Patna" -> "past as current"; "User is currently on model 6 now" -> "not durable" |
| **Total wrong** | **23** | **21** | |

Forbidden / ended claims jo Mem0 ne sach bataye (engine: 0 har run):

| Run | Case | Claim | Mem0 memory |
|---|---|---|---|
| r1 | time_change_module | student abhi Module 2 pe hai | "User was on module 2 during the week of September 14–20, 2026" (assertion judge ne ise current maana; bahas ho sakti hai) |
| r1 | one_off_request_hinglish_2 | chhote steps ki lasting preference | "User prefers explanations to be broken down into smaller … steps" |
| r2 | sarcasm_recursion_easy | student ko recursion easy lagta hai | "User finds recursion easy but has been stuck on the same question…" |
| r2 | one_off_request_english | slow explanations ki lasting preference | "…indicating a preference for a more gradual…" |
| r2 | one_off_request_hinglish_2 | chhote steps ki lasting preference | "User prefers explanations to be broken down into smaller steps…" |

Recall misses: engine 0. Mem0 r1: sarcasm_recursion_easy ka "recursion" (woh add timeout ho gaya tha), r2: "3rd year" (Mem0 ne "third-year" likha; keyword match ki seema hai, Mem0 ki asli galti nahi).

**Judge noise ko theek karke** (sirf upar ke saaf judge-errors palte, meri manual reading, judge ka nahi):
Engine 52/53 = 98.1% dono runs; Mem0 37/59 = 62.7% (r1), 45/64 = 70.3% (r2). Gap waisa hi rehta hai.

---

## 5. Latency

| | Engine | Mem0 |
|---|---|---|
| add() p50 | 1.6–1.7 s | 7.1–9.5 s |
| add() p95 | 2.5–2.6 s | 49–54 s |
| add() max (jo khatam hue) | 3.6 s | 142 s |
| add timeouts (>180 s) | 0 | 1–2 per run. Baad mein check kiya: yeh events 195–236 s mein SUCCEEDED hue |
| search p50 | 0.4–0.5 s | 0.5 s |
| search p95 | 0.5–0.7 s | 3.0 s |

Timeout wale adds p95 mein shamil nahi hain. Unhe 180 s gin ke Mem0 add p95 run 1 mein 94 s aur run 2 mein 52 s hota hai.
Engine ki latency mein sirf OpenAI calls hain (gpt-4o-mini + embeddings) aur local Qdrant. Mem0 ki latency mein unki queue aur processing hai.
Dono pe concurrency 3 thi.

---

## 6. Seemayein (honestly)

- **Home advantage.** Yeh 40 cases aur 16 scenarios wahi hain jin pe engine ke prompts (phase 5–6) tune hue the. Mem0 inhe pehli baar dekh raha hai. Isliye gap ka kuch hissa overfitting ho sakta hai. Asli faisle se pehle ek naya held-out set (bina tuning ke likha hua) chalana chahiye.
- **Judge calibrate nahi hai.** Neutral prompts ka calibration run nahi hua. Upar dikhaya ki judge dono taraf galti karta hai (engine ke khilaaf 1–2, Mem0 ke khilaaf 1–2 per run). Gap itna bada hai ki yeh noise nateeja nahi badalta.
- **Rules meri app ke hisaab se hain.** "Past as current", "dost ki baat student ki nahi", "one-off request memory nahi" meri RAG app ki zaroorat hai. Mem0 ka design zyada "sab kuch dates ke saath yaad rakho" type ka hai. Kisi aur app ke liye Mem0 ki "User was on module 2 last week" jaisi memories kaam ki ho sakti hain.
- **Mem0 plan / project settings.** Test project default settings pe tha (custom instructions/categories nahi diye). Mem0 ke project-level `customInstructions` se shayad one-off/assistant-content wali galtiyan kam ho sakti hain. Yeh test nahi kiya.
- 2 forbidden specs (category-only) skip kiye; recall keyword-based hai ("3rd year" vs "third-year" jaisi misses).

---

## 7. Verdict

**Mem0 kahan better ya barabar hai.**
Quality ke kisi bhi metric pe is data pe Mem0 aage nahi nikla. Barabar raha:
- recall (98% vs 100%, aur Mem0 ke misses timeout ya keyword ki wajah se);
- "ended" fact (dono 0);
- search p50 (~0.5 s);
- scenario 2, 4, 5, 7, 8, 13, 14, 16.

Operational fayde Mem0 ke paas hain jo is eval ne naape nahi: koi Qdrant chalana/backup nahi, scaling unki zimmedari, memories pe dates / temporal info, graph features, aur dashboard.

**Engine kahan better hai (saaf taur pe).**
1. **Update / current state:** 16/16 vs 7–8/16. Mem0 purane contradicting facts nahi hatata (module, DP weak/clear, preference, goal), aur `latestOnly` se bhi fark nahi pada.
2. **Precision:** 94–96% vs 61–67%. Mem0 assistant ka content, course answers, one-off requests aur dost/behen ki baatein student ki memory bana deta hai.
3. **Garbled memories:** Mem0 ne har run mein 7–12 memories 1000+ characters ki banayi (26k tak, ek hi line baar baar). Engine ki sabse lambi memory 76 characters. RAG prompt mein yeh seedha token waste aur confusion hai.
4. **Latency:** add p50 ~1.7 s vs 7–10 s, p95 2.6 s vs ~50 s, aur Mem0 pe kuch adds 3–4 minute le gaye.

**RAG app switch ke liye matlab.**
- Is data pe `MEMORY_PROVIDER=custom` ko default banane ka case mazboot hai. RAG ke liye sabse zaroori cheez "student ka *current* state" hai (kaunsa module, kya abhi weak hai, kaunsi preference), aur wahin Mem0 sabse kamzor hai.
- Mem0 ka async write RAG mein user ko block nahi karta (write BullMQ queue se jaata hai). Lekin agla turn tab tak naya fact nahi dekhega jab tak Mem0 process na kar le (typical 7–10 s, kabhi 1–4 min). Engine pe write queue se ~2 s mein ho jaata hai.
- Switch se pehle teen cheezein:
  1. held-out eval set (home advantage hatane ke liye);
  2. existing Mem0 memories ka migration plan (abhi koi migration nahi hai);
  3. `memory-qdrant` ka backup/monitoring, kyunki ab infra hamari zimmedari hogi.
- Rollback aasaan hai: provider flag (`MEMORY_PROVIDER=mem0`) wapas karna kaafi hai.

---

## 8. Cleanup proof (final run)

- **Engine:** 114 users bane; `deleteAll` ke baad sabki `getAll` = 0 memories; test collection `m0eval_engine_compare` drop, `collectionsAfter: []`.
- **Mem0:** 114 users bane.
  - 3 late writes (2 run 1 ke, 1 run 2 ka timeout) ka cleanup se pehle wait kiya; teeno `SUCCEEDED`.
  - 112 users cleanup mein delete hue, 2 pehle hi delete the (scenario 16). 0 delete errors.
  - Iske baad Mem0 project ki user list mein `m0eval_` se shuru hone wale users: **0**. Pehle se delete hue users ki memory count: 0.
- Pehle pair aur `latestOnly` probes ke baad bhi alag se verify kiya: saare timed-out events SUCCEEDED, un users ki memories 0, aur `m0eval_` users left on Mem0: `[]`.

## 9. Files

- `scripts/eval-mem0-compare.js`: harness (runs, collect, judge, score, cleanup + proof).
- `scripts/providers/engineProvider.js`, `scripts/providers/mem0Provider.js`: adapters.
- `scripts/neutral-judge.js`: neutral judge. `scripts/judge.js` se sirf `limited`, `withRateLimitRetry` aur `transcript` export kiye.
- `scripts/compare-data.js`: 16 scenarios ka expected state + ended/forbidden claims.
- `package.json`: `mem0ai` 3.1.6 devDependency, script `eval:mem0-compare`. Lockfile mein Mem0 ke dev-only peer deps aaye (library users pe asar nahi: devDependencies publish/install nahi hoti).
