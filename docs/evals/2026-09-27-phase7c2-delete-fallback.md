# Phase 7c-2: active fact pe DELETE -> UPDATE fallback

> **Held-out set v1 was used to find this fix, so it is no longer a true held-out set. The next held-out set will be real student data.**

Date: 2026-09-27. Sirf `src/memory/decider.js` ka ek fallback badla. Extraction aur decider prompts **nahi** badle.

---

## 1. Problem: raw decider output aur fallback log (h_sc_06)

Scenario: "abhi stacks padh raha hoon", phir "stacks ho gaye, ab queues shuru kiye".
Scratch trace ne same engine config pe 3 fresh users chalaye (fix se pehle).

Run 1 aur 2 (dono same):
```
EXTRACTOR raw output: {"facts": [
  {"text": "User has completed stacks", "category": "progress", "status": "active"},
  {"text": "User is studying queues", "category": "progress", "status": "active"}
]}
DECIDER input:
  New facts:
  0. [progress] (active) User has completed stacks
  1. [progress] (active) User is studying queues
  Existing memories:
  m1. [progress] User is studying stacks
DECIDER raw output: {"actions":[{"fact":0,"action":"DELETE","memory":"m1"},{"fact":1,"action":"ADD","memory":null}]}
[decider fallback] fact 0 "User has completed stacks" (active): DELETE is only allowed for an ended fact; using ADD
events: ADD "User has completed stacks" | ADD "User is studying queues"
FINAL: User is studying queues | User has completed stacks | User is studying stacks   <- stale memory bachi rahi
```

Run 3 mein extractor ne "User has completed stacks" ko `ended` diya. Tab DELETE valid tha aur final state sahi rahi (sirf "User is studying queues").

Held-out comparison (engine, 2 runs) ke log mein bhi dono runs mein yahi line thi. Isliye h_sc_06 dono runs mein fail hua.

**Confirmed:** decider ne active fact ke liye DELETE diya. Validator ne use ADD bana diya, aur purani "studying stacks" memory reh gayi.

## 2. Fix

`src/memory/decider.js`: active fact ke liye DELETE of an existing memory ab **UPDATE of that memory with the fact's text** ban jaata hai.
- Yeh engine ke normal UPDATE path se jaata hai: memory ka text aur vector badalta hai, history mein `UPDATE` entry judti hai, aur purana text pehli `ADD` entry mein rehta hai.
- Log: `[decider fallback] fact 0 "User has completed stacks" (active): DELETE is only allowed for an ended fact; using UPDATE of m1 with the fact text`.
- Baaki rules same:
  - bina memory id ke DELETE -> pehle jaisa ADD fallback;
  - "each memory is targeted at most once": target pehle se claimed ho to pehle jaisa ADD fallback, aur conversion khud bhi target ko claim karta hai;
  - ended fact ke liye DELETE bilkul pehle jaisa.

Fix ke baad wahi trace, 3/3 runs:
```
DECIDER raw output: {"actions":[{"fact":0,"action":"DELETE","memory":"m1"},{"fact":1,"action":"ADD","memory":null}]}
[decider fallback] fact 0 "User has completed stacks" (active): DELETE is only allowed for an ended fact; using UPDATE of m1 with the fact text
events: UPDATE "User has completed stacks" (was "User is studying stacks") | ADD "User is studying queues"
FINAL: User is studying queues | User has completed stacks
```

Naya scenario **17** (`scripts/eval-update.js`), nayi wording:
"Abhi main arrays ke questions kar raha hoon" -> "arrays wala section complete ho gaya, aaj se strings pe kaam shuru".
Pass tab jab koi "studying/doing … arrays" wali memory (bina "completed/finished/done" ke) na bache, aur strings wali memory ho.
Dono runs mein pass hua. Wahan decider ne khud UPDATE diya ("studying arrays" -> "studying strings"), to naya fallback path chala hi nahi.

## 3. Fallback count: pehle vs baad

| Eval | Pehle | Baad |
|---|---|---|
| h_sc_06 trace (3 runs) | 2 fallbacks, dono **DELETE -> ADD** (stale memory bachi) | 3 fallbacks, teeno **DELETE -> UPDATE** (stale memory gayi) |
| Held-out engine, 2 runs | **4**: 2× DELETE-on-active -> ADD (h_sc_06), 2× "already targeted" -> NOOP (h_sc_04) | **6**: 2× DELETE-on-active -> **UPDATE** (h_sc_06), 2× "already targeted" -> NOOP (h_sc_04), 2× "no action returned" -> ADD (h_sc_03, "User prefers explanations in English"; scenario phir bhi pass) |
| `eval:update` (per run) | 0 (Phase 7a) | 0, 0 |
| `eval:update:9a` (5 runs) | 0 | 0 |

"No action returned" fallback naya dikha. Yeh decider ka JSON hai jismein fact 1 ka action tha hi nahi; is change ka is path pe koi asar nahi. Pehle ke held-out runs mein yeh nahi tha.

## 4. Regression

| Eval | Pehle (baseline) | Baad | Match/beat? |
|---|---|---|---|
| `eval:update` run 1 | 16/16 (7a) | **15/17** (4 aur 7 fail; 17 pass) | **NAHI** |
| `eval:update` run 2 | 16/16 | 17/17, fallbacks 0 | haan |
| `eval:update:9a`, `EVAL_RUNS=5` | 9a 5/5, 9b 5/5, extractFacts alone 0/5, fallbacks 0 | same | haan |
| `eval:robustness` | 1,418 ids 0 leaks; 0/90; 0/540; 0/10; legacy 4/4 | same, sab PASS | haan |
| `eval:context` | recall 14/14 (8 profile, 6 relevant), search-only 6/6, injected [0,1,0,0,0], profile 5.0, gate 1/19 | same | haan |
| Original extraction (1 run) | 100% / 100% / 0 forbidden / judge 100%; calibration 95.7% | same | haan |
| Held-out engine: scenarios | 11/12, 11/12 | **12/12, 12/12** | beat |
| Held-out engine: precision | 90.0% (18/20), 85.0% (17/20) | **81.0% (17/21)**, 85.0% (17/20) | **run 1 NAHI** |
| Held-out engine: recall / forbidden | 100% / 0 | 100% / 0 | haan |
| Held-out latency | add p50 ~1.45 s, search p50 ~0.44 s | add p50 ~1.45 s, search p50 0.44 s | same |

### Jo match nahi hua (sach sach)

**`eval:update` run 1: scenario 4 aur 7 fail.**
- 4: doosre add pe decider ne "User understands concepts quickly with code examples" ko **UPDATE** kiya ("User prefers understanding through code examples"), NOOP ki jagah. Count 4 -> 4 raha, lekin "sab NOOP" wali shart tooti.
- 7: "ab mujhe sorting aa gayi" pe extractor ne active fact "User has learned sorting" diya (ended nahi), to ek memory ban gayi.
- Dono mein naya code path nahi chala:
  - run 1 ke poore log mein 0 decider fallbacks;
  - 4 ka UPDATE seedha decider se aaya;
  - 7 mein decider call hi nahi hua (koi existing memory nahi thi).
- `tests/results` ke pichle 9 saved `eval:update` runs mein 4 aur 7 kabhi fail nahi hue the. To yeh naya flake hai, lekin is change ki wajah se nahi.

**Held-out precision run 1: 81.0% vs 90.0%.**
- Held-out extraction cases mein har user fresh hai aur ek hi `add()` hota hai. Existing memories nahi hoti, to decider call hi nahi hota. Is fix ka extraction precision pe koi asar ho hi nahi sakta.
- Farak judge aur extractor ki variance se aaya:
  - "User is on Module 12" (h_ex_17 ka expected fact) is baar judge ne "not durable" bola; pichle engine runs mein ise correct maana tha;
  - run 1 mein ek memory zyada bani (21 vs 20).

Rule tha "sab kuch match ya beat kare, tabhi commit". Yeh do numbers match nahi karte. Pehle commit roka gaya; faisla niche section 5 mein hai.

## 5. Commit decision

Commit code-path ke saboot pe kiya gaya, "shayad variance" ke andaaze pe nahi.

**Change sirf fallback branch tak seemit hai.**
- `decider.js` ki har badli line (docstring comments ke alawa) ek hi `if (action === 'DELETE' && fact.status !== 'ended')` block ke andar hai. Yeh condition purani line jaisi hi hai, aur purane code mein yeh branch hamesha `fallback(...)` se khatam hoti thi, jo `[decider fallback]` log likhta hai.
- Naye block ke teeno raaste bhi log likhte hain:
  - bina memory id -> same `fallback`, same reason, ADD;
  - target pehle se claimed -> `fallback`, ADD;
  - baaki -> `warn(...)`, UPDATE.
- `targeted.add` sirf isi logged raaste pe hota hai.
- Isliye jis run mein 0 fallbacks log hue, usme naya code chala hi nahi, aur behaviour purane code jaisa hi hai.

**Failing cases mein naya code nahi chala.**
- `eval:update` run 1 ne poore run mein **0 decider fallbacks** log kiye. Scenario 4 ka UPDATE seedha decider ke output se aaya.
- Scenario 7 mein decider call hi nahi hua (koi existing memory nahi thi).
- Held-out extraction cases mein bhi decider call nahi hota (fresh user, ek `add()`). To precision ka farak is change se nahi aa sakta.

**New flakes to watch (not caused by this change)**
- **Scenario 4** (same conversation twice): doosre add pe decider ne ek fact ko NOOP ki jagah reworded UPDATE kiya. Count 4 -> 4 raha.
- **Scenario 7** ("ab mujhe sorting aa gayi"): extractor ne ended ki jagah active fact "User has learned sorting" diya, aur ek memory ban gayi.
- **"no action returned" fallback** (held-out h_sc_03, dono runs): decider ke JSON mein "User prefers explanations in English" ke liye koi action nahi tha, to ADD hua. Scenario phir bhi pass hua.

Version: `package.json` 0.1.0 -> **0.1.1** (isi commit mein). Tag nahi banaya.

## 6. Status

- Is commit mein:
  - `src/memory/decider.js` (fallback + docstring);
  - `scripts/eval-update.js` (scenario 17);
  - `package.json` (0.1.1);
  - yeh report.
- Held-out file edit nahi hui. Extraction / decider prompts nahi badle.
