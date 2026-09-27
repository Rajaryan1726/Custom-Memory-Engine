# Held-out comparison: mera engine vs hosted Mem0

Date: 2026-09-27. Engine: v0.1.0 (`src/` is eval ke liye nahi badla). Mem0: hosted, `mem0ai` 3.1.6 `MemoryClient`, alag test project.

Data: `tests/heldout/heldout-cases.json` (held-out set v1, "frozen": in cases pe koi prompt tune nahi hua;
topics, naam aur module numbers purane tests / few-shots se alag hain). Is file ko eval ne sirf padha, edit nahi kiya.
- 18 extraction cases: naya user, ek `add()`, phir `getAll`.
- 12 scenarios: har `sessions` entry ek `add()` (same user, order mein), phir `getAll` vs `expectedState`.

Command (PowerShell):
```
$env:COMPARE_SET = "heldout"; npm run eval:mem0-compare
```
Results: `tests/results/heldout-compare-2026-09-27T07-11-56-638Z.json` (tag `mujgsav8`, 2 runs).

**Harness:** wahi Phase 7c-1 wala (`scripts/eval-mem0-compare.js`). Sirf data-set chunne ka option (`COMPARE_SET=heldout`) joda. Baaki sab same:
- same adapters;
- same neutral judge (`gpt-4o`, temperature 0; judge sirf memory text dekhta hai, provider nahi);
- same Mem0 waiting: event `SUCCEEDED` + read-after-write check, 180 s timeout, late writes ka cleanup se pehle wait;
- same cleanup (`m0eval_` prefix);
- dono providers pe concurrency 3.

**Scoring:**
- *Recall:* expected fact tab mila jab kisi memory text mein uske keyword alternatives mein se koi ho (case-insensitive).
- *Precision:* neutral judge ka memory check.
- *Forbidden claims* aur *scenario expectedState:* neutral judge, 7c-1 jaisa.
- *"allowed" facts:* jo memory judge ke hisaab se allowed fact bata rahi hai, woh precision mein gini nahi jaati (na plus, na minus), aur recall mein bhi nahi. Engine ki 2 memories har run (frontend, biology) aur Mem0 ki 3 / 2 isi wajah se bahar rahin.

---

## 1. Summary: tuned set (7c-1) vs held-out

7c-1 numbers us report ke final pair se hain (`docs/evals/2026-09-27-phase7c-mem0-comparison.md`).

| Metric | Engine tuned r1 / r2 | Engine held-out r1 / r2 | Mem0 tuned r1 / r2 | Mem0 held-out r1 / r2 |
|---|---|---|---|---|
| Scenarios pass | 16/16 · 16/16 (100%) | **11/12 · 11/12 (91.7%)** | 8/16 · 7/16 (46.9%) | **3/12 · 1/12 (16.7%)** |
| Precision (judge) | 94.3% · 96.2% | **90.0% (18/20) · 85.0% (17/20)** | 61.0% · 67.2% | **78.6% (22/28) · 50.0% (13/26)** |
| Recall (keyword) | 100% · 100% | **100% (16/16) · 100%** | 98.0% · 98.0% | **100% (16/16) · 100%** |
| Forbidden facts sach bataye | 0 · 0 (12 claims) | **0 · 0 (13 claims)** | 2 · 3 (12 claims) | **1 · 3 (13 claims)** |
| Avg memories / case | 1.32 · 1.32 | 1.22 · 1.22 | 1.48 · 1.60 | 1.72 · 1.56 |
| add() p50 | 1.6 s · 1.7 s | 1.5 s · 1.4 s | 7.1 s · 9.5 s | 8.2 s · 8.4 s |
| add() p95 | 2.6 s · 2.5 s | 2.6 s · 2.8 s | 53.8 s · 49.0 s | 24.9 s · 98.1 s |
| search p50 | 0.4 s · 0.5 s | 0.4 s · 0.5 s | 0.5 s · 0.5 s | 0.6 s · 0.5 s |
| search p95 | 0.5 s · 0.7 s | 0.5 s · 0.6 s | 3.0 s · 3.0 s | 2.0 s · 2.1 s |
| Mem0 add timeouts (>180 s) | – | – | 2 · 1 | 3 · 1 |
| Memories > 1000 characters | 0 · 0 | 0 · 0 | 7 · 12 | 3 · 8 (sabse lambi 37,941) |

Timeout wale adds latency percentiles mein nahi hain (woh error hain aur scenario fail gina gaya). Cleanup se pehle wait kiya to chaaron `SUCCEEDED` hue.

### Engine ke numbers kitne gire (tuned -> held-out)

- **Scenarios:** 100% -> 91.7%, yaani **8.3 points kam** (dono runs mein 1 fail: `h_sc_06_topic_moves_on`).
- **Precision:** average 95.3% -> 87.5%, yaani **7.8 points kam** (run-wise: 94.3 -> 90.0, 96.2 -> 85.0).
- **Recall:** 100% -> 100%, **koi girawat nahi**. Held-out ke keywords kaafi lenient hain (zyaadatar ek hi group mein kai alternatives), to yeh number zyada kuch nahi batata.
- **Forbidden:** 0 -> 0, **koi girawat nahi**.
- **Latency:** same (add p50 ~1.5 s, search p50 ~0.45 s).

Matlab home advantage tha, lekin chhota: tuned set pe numbers ~8 points fule hue the.
Held-out pe bhi engine Mem0 se saaf aage hai:
- scenarios 91.7% vs 16.7%;
- precision 87.5% vs 64.3% (average);
- forbidden 0 vs 1–3.

Mem0 ke numbers bhi badle: scenarios 46.9% -> 16.7%. Precision average lagbhag same (64.1% -> 64.3%), lekin runs ke beech bahut uchhla (78.6% vs 50.0%).

---

## 2. Har failure, judge reason ke saath

### 2a. Scenarios

| Scenario | Engine r1 | Engine r2 | Mem0 r1 | Mem0 r2 |
|---|---|---|---|---|
| h_sc_01 module correction | pass | pass | fail (timeout) | fail |
| h_sc_02 partial resolution | pass | pass | fail | fail |
| h_sc_03 language switch | pass | pass | fail | fail |
| h_sc_04 goal change | pass | pass | fail | fail |
| h_sc_05 plan then done | pass | pass | fail (timeout) | fail (timeout) |
| h_sc_06 topic moves on | **fail** | **fail** | fail (timeout) | fail |
| h_sc_07 same fact, two scripts | pass | pass | pass | fail |
| h_sc_08 friend then self | pass | pass | pass | pass |
| h_sc_09 name spelling | pass | pass | fail | fail |
| h_sc_10 one-off then standing | pass | pass | fail | fail |
| h_sc_11 small talk around fact | pass | pass | pass | fail |
| h_sc_12 relapse | pass | pass | fail | fail |

**Engine failures**

| Run | Scenario | Final memories | Judge reason |
|---|---|---|---|
| r1 | h_sc_06 | "User is studying queues", "User has completed stacks", "User is studying stacks" | "Memory 3 contradicts the expected state by saying the student is currently studying stacks." |
| r2 | h_sc_06 | same teen memories | "There is a memory stating the user is studying stacks, which contradicts the expected state." |

Run 1 ke log mein decider fallbacks dikhe:
- `fact 0 "User has completed stacks" (active): DELETE is only allowed for an ended fact; using ADD`;
- h_sc_04 mein `memory m1 is already targeted by another action; using NOOP`. h_sc_04 phir bhi pass hua.

**Mem0 failures**

| Run | Scenario | Judge reason (aur final memories ka saar) |
|---|---|---|
| r1 | h_sc_01 | add 180 s mein khatam nahi hua (timeout) |
| r1 | h_sc_02 | "Memory 2 contradicts the expected state by saying the student does not understand hashing in general." ("hashing samajh nahi aata" wali memory rahi) |
| r1 | h_sc_03 | "There is a memory stating the student prefers Hinglish" (English aur Hinglish dono preferences) |
| r1 | h_sc_04 | "Memory 2 contradicts the expected state by stating the student wants a web development job." |
| r1 | h_sc_05 | timeout |
| r1 | h_sc_06 | timeout |
| r1 | h_sc_09 | "There is a memory stating the name as Ishan" (Ishan aur Ishaan dono) |
| r1 | h_sc_10 | "A memory states the student prefers code without explanations" (one-off "sirf code do" ko lasting preference bana diya) |
| r1 | h_sc_12 | "There is a memory stating the student now understands the concept of greedy" (teeno states: weak, clear, phir weak) |
| r2 | h_sc_01 | "Memory 2 states the user is on module 9" (Module 8, 9 aur 8-correction teeno; ek 25,392 characters ki) |
| r2 | h_sc_02 | same as r1 |
| r2 | h_sc_03 | same as r1 (Hinglish wali memory 5,809 characters) |
| r2 | h_sc_04 | same as r1 |
| r2 | h_sc_05 | timeout |
| r2 | h_sc_06 | "Memory 2 contradicts the expected state by saying the student is currently studying stacks." |
| r2 | h_sc_07 | "The memory list contains multiple notes about the user's difficulty with binary search, which implies duplication" (ek hi memory, 37,373 characters, text baar baar repeat) |
| r2 | h_sc_09 | same as r1 |
| r2 | h_sc_10 | same as r1 |
| r2 | h_sc_11 | "The memory stored is about the student's difficulty in general, not specifically about struggling with tries." (ek 9,940 characters ki repeated memory; judge ke hisaab se usme "tries" ka zikr nahi dikha) |
| r2 | h_sc_12 | same as r1 |

### 2b. Extraction (galat memories aur forbidden hits)

**Engine**

| Run | Case | Memory | Judge reason |
|---|---|---|---|
| r1 | h_ex_14_exam_goal | "User has a mid-sem exam on October 15" | "Not durable; it's a one-off event." |
| r1 | h_ex_14_exam_goal | "User wants to complete segment trees before the mid-sem exam" | "Not supported; user wants to complete both segment trees and bit manipulation before the exam." |
| r2 | h_ex_02_future_plan | "User is on Module 8" | "Past as current: User will start Module 9 next week." |
| r2 | h_ex_14_exam_goal | "User wants to complete segment tree" | "Not durable; it's a one-off request for the current answer." |
| r2 | h_ex_14_exam_goal | "User has a mid-sem exam on October 15" | "Not durable; it's a one-off event." |

Engine: forbidden hits 0, recall misses 0.

**Mem0**

| Run | Case | Memory (chhota kiya) | Judge reason |
|---|---|---|---|
| r1 | h_ex_03_temporary_state | "User asked for a quick explanation of stack push and pop operations." | "Not durable: it is a one-off request for the current answer." |
| r1 | h_ex_03_temporary_state | "User felt very tired on September 27, 2026…" | "Not durable; it's a one-off expression of fatigue…" |
| r1 | h_ex_14_exam_goal | "User's mid-semester exam is scheduled for October 15, 2026…" | "Not durable; it's a one-off event." |
| r1 | h_ex_15_small_talk_mixed | "User said they will return later…" | "Not durable: It's a one-off statement about returning later…" |
| r1 | h_ex_16_one_off_code_only | "User prefers receiving only the queue code without any explanation…" | "Not durable; it's a one-off request…". **Forbidden hit:** "prefers code without explanations in general" |
| r1 | h_ex_18_false_premise_question | "User's notes state that heap sort is stable…" | "Not durable; it's a one-off request for confirmation about heap sort." |
| r2 | h_ex_01_quiz_score | "User scored 3 out of 10… User is a user of the system…" (9,951 chars) | "Garbled: excessive repetition of 'User is a user of the system'" |
| r2 | h_ex_03_temporary_state | "User wants a quick explanation of stack push and pop operations" | "Not durable; it's a one-off request for the current answer." |
| r2 | h_ex_03_temporary_state | "User felt very tired… User wants a quick explanation…" (18,161 chars) | "Garbled: excessive repetition of the same memory". **Forbidden hit:** "prefers quick or short explanations in general" |
| r2 | h_ex_06_teacher_said | "User was told by their professor during a viva that their grasp of hashing concepts is weak…" | "Wrong person; the student said it, not a professor." |
| r2 | h_ex_07_teammate | "In the user's group project, Kabir is responsible for backend… SQL joins…" (2,710 chars) | "Wrong person: the memory is about Kabir, not the student." |
| r2 | h_ex_10_long_content_question | "User wants to understand the difference between greedy algorithms and dynamic programming…" | "Not durable; it's a one-off request…". **Forbidden hits:** "struggles with greedy algorithms" aur "struggles with dynamic programming" |
| r2 | h_ex_13_assistant_context | "User is comfortable with hashmaps… but they do not have any tries available…" | "Not durable; includes a one-off comment about tries not coming to them." |
| r2 | h_ex_14_exam_goal | "User's mid-semester exam is scheduled for October 15, 2026…" | "Not durable; it's a one-off event." |
| r2 | h_ex_16_one_off_code_only | "User requested queue code without explanation…" | "Not durable; it's a one-off request for the current answer." |
| r2 | h_ex_17_typos_no_punct | "User does not understand Dijkstra's graph algorithm and is asking why a priority queue is used in it" | "Not durable; it's a one-off course question." |
| r2 | h_ex_17_typos_no_punct | "User is currently on module 12 of their study material or course" | "Not durable; it's a one-off request for the current answer." |
| r2 | h_ex_18_false_premise_question | "User asks whether heap sort is a stable sorting algorithm…" | "Not durable; it's a one-off course question." |
| r2 | h_ex_18_false_premise_question | "User's personal notes state that heap sort is stable…" | "Not durable; it's a course question." |

Mem0: recall misses 0.

### 2c. Judge ki galtiyan (judge verdict hi gina gaya hai; yeh sirf note hai)

- Engine r2 "User is on Module 8" (h_ex_02): case ka expected fact yahi hai; judge ne "past as current" bola.
- Mem0 r2 "does not understand Dijkstra's…" aur "currently on module 12" (h_ex_17): dono expected facts hain; judge ne "not durable" bola.
- Mem0 r2 h_ex_06 "told by their professor…": memory sahi hai; judge ne "wrong person" bola.
- Mem0 r2 h_sc_07: ek hi (repeated) memory ko "duplication" gina. Isko garbled maanna zyada theek hota, lekin scenario tab bhi fail hi hota.

Inko palat dein to bhi tasveer nahi badalti:
- engine r2 precision 17/20 -> 18/20;
- Mem0 r2 precision 13/26 -> 16/26.

---

## 3. Failure patterns (sirf list; prompt badlaav ka koi sujhav nahi)

**Engine**
1. **"X ho gaya, ab Y shuru"** (h_sc_06): purana "studying stacks" active raha. "completed stacks" ek *naye active* fact ki tarah add hua, ended fact ki tarah nahi. Isliye decider use DELETE nahi kar paya (fallback: ADD).
2. **Ek goal ke andar do cheezein + date** (h_ex_14): "segment tree aur bit manipulation" wala goal adhoora bana (sirf segment tree). Exam date ek alag memory bani, jise judge "one-off event" maanta hai.
3. **Plan ke saath current state** (h_ex_02, sirf r2 judge ke hisaab se): memory sahi thi ("User is on Module 8"); judge ki galti lagti hai.

**Mem0**
1. **Purana state nahi hatata** (h_sc_01, 02, 03, 04, 06, 09, 12): naya fact ADD, purana contradicting fact reh jaata hai. Module, hashing, language, goal, topic, naam ki spelling, greedy relapse, sabme yahi. 7c-1 wala hi pattern.
2. **One-off request ko lasting preference** (h_sc_10, h_ex_16, h_ex_03).
3. **Course sawal / temporary baat ko memory** (h_ex_10, h_ex_18, h_ex_15, thakaan, exam date).
4. **Garbled / repeated text:** 3 aur 8 memories 1000+ characters ki, sabse lambi 37,941.
5. **Kisi aur ke baare mein** (h_ex_07, Kabir teammate).
6. **Latency:** 4 adds 180 s se zyada (run 1 mein 3, run 2 mein 1); add p95 run 2 mein 98 s.

---

## 4. Cleanup proof

- **Engine:** 60 users; `deleteAll` ke baad saari `getAll` = 0; `m0eval_engine_compare` collection drop, `collectionsAfter: []`.
- **Mem0:** 60 users.
  - 4 late writes (timeout wale) ka wait kiya; chaaron `SUCCEEDED`.
  - 60 users delete hue, 0 delete errors.
  - Iske baad Mem0 project mein `m0eval_` users: **0**.
- Script ka final result: `Runs completed: 2/2. Cleanup proven: true`.
