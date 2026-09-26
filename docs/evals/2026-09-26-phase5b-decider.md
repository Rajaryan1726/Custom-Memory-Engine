# Phase 5b: Update/dedupe decider

**Date:** 2026-09-26
**Code under test:** Phase 5b working tree (uncommitted; HEAD = `1eca9ec phase 5a.1`). Extraction prompt unchanged.
**Models:** extractor aur decider `gpt-4o-mini` (temperature 0).
**Eval:** `npm run eval:update`. Collection `custom_user_memories_update_eval` har run ke end mein delete hoti hai. Poora suite 2 baar chalaya.

## Pipeline (`MemoryEngine.add()`, `dedupe: true` default)

1. Facts extract karo.
2. Saare facts ko ek `embedMany` call mein embed karo.
3. Har fact ke liye user ki memories mein **same category** search karo (limit 5).
4. **Shortcut:** active fact ka text kisi candidate se exactly match kare (case-insensitive) to NOOP, bina LLM call ke.
5. Kisi bache hue fact ka koi candidate na ho: active facts ADD, ended facts NOOP. Decider call skip.
6. Warna bache hue facts ke liye ek `decide()` call.
7. Apply karne ka order: DELETE, phir UPDATE, phir ADD.

Ek hi user ke `add()` calls ek-ek karke chalte hain (in-process queue). `dedupe: false` rakhne par Phase 5a wala behaviour milta hai.

## Scenario results

| # | Scenario | Run 1 | Run 2 |
|---|---|---|---|
| 1 | Module 2, phir Module 3: 1 module memory (Module 3) | PASS | PASS |
| 2 | "Module 3 khatam", phir "Module 4 shuru": 1 module memory (Module 4) | PASS | PASS |
| 3 | Module 5 + linked lists, phir trees: module 5 bacha, topic = trees, linked lists gayab | **FAIL** | **FAIL** |
| 4 | Same conversation 2 baar: count same, doosra add sirf NOOP | PASS | PASS |
| 5 | recursion 2 baar alag words mein: 1 memory | PASS | PASS |
| 6 | DP weak, phir "DP clear": koi DP weak_topic nahi, DELETE event | PASS | PASS |
| 7 | Ended fact jab kuch stored nahi: 0 memories, no error | PASS | PASS |
| 8 | recursion, phir graphs: 2 weak_topic | PASS | PASS |
| 9 | short explanations, phir detail: 1 length preference (detailed) | **FAIL** | **FAIL** |
| 10 | placement goal, phir Amazon SDE goal: 1 goal (Amazon) | PASS | PASS |
| 11 | Lamba mixed sequence: naam wali memory unchanged | PASS | PASS |
| 12 | Do students, A ne DP clear kiya: B ki DP memory untouched | PASS | PASS |
| 13 | Scenario 1 ke baad "main kaunse module pe hoon?": top result Module 3 | PASS | PASS |
| **Total** | | **11/13** | **11/13** |
| 14 (extra) | Same user, 2 parallel `add()` same fact ke saath: 1 memory | PASS | PASS |

**Decider fallbacks:** dono runs mein **0**. Har run mein 18 decider calls hue.

## Failures (dono runs mein same, events ke saath)

Dono failures decider se **pehle**, extraction mein hote hain. Decider ko sahi input mila hi nahi. Is phase mein extraction prompt badalna allowed nahi tha.

**Scenario 3: topic fact galat category mein**
```
add "Main Module 5 pe hoon, abhi linked lists kar raha hoon"
  -> ADD: User is on Module 5 | ADD: User is currently studying linked lists
add "ab trees start kiya"
  -> ADD: User has started trees
state: [progress] User has started trees
       [progress] User is on Module 5
       [other]    User is currently studying linked lists
```
- Extractor ne "studying linked lists" ko `other` mein daala aur "started trees" ko `progress` mein.
- Candidate search same category mein hota hai, isliye decider ko linked lists wali memory dikhi hi nahi, aur trees ADD ho gaya.
- Module slot sahi raha (Module 5 untouched).
- **Root cause:** extraction prompt ki fixed phrasing mein topic slot ka phrasing nahi hai ("User is studying <topic>" progress mein). Isliye extractor topic facts ki category aur wording har baar alag deta hai.

**Scenario 9: "ab detail mein samjhao" se koi fact nahi nikla**
```
add "mujhe short explanations chahiye"
  -> ADD: User prefers short explanations
add "ab detail mein samjhao"
  -> (no facts)
state: User prefers short explanations
```
- Extractor is message ko ek baar ki request samajhta hai, lasting preference nahi. Decider tak kuch pahuncha hi nahi.
- Nateeja: purani "short explanations" preference bani rahti hai, jabki student ne ulta maanga tha.

## Latency (`add()`, n=8 har type, sequential)

| | Run 1 p50 | Run 1 p95 | Run 2 p50 | Run 2 p95 | Decider calls |
|---|---|---|---|---|---|
| Pehla add (koi candidate nahi, decider skip) | 1,442 ms | 2,823 ms | 1,590 ms | 2,301 ms | 0 |
| Repeat add (decider call hota hai) | 2,502 ms | 2,748 ms | 2,327 ms | 3,622 ms | 8/8 |

- Decider ki wajah se ~0.8–1 s extra lagta hai: ek aur LLM call, plus har fact ke liye Qdrant search.
- Phase 4 mein `add()` p50 ~1.7 s tha (usmein search step nahi tha). Isliye `add()` ko background mein chalana ab aur bhi zaroori hai.

## Robustness (`npm run eval:robustness`)

- **Isolation:** 620 result ids check kiye, **0 leaks**. Cross-user `getById` **0/90**.
- **Edge inputs:** pehle jaisa. Multi-part content ab bhi PASS.
- **Stale-fact baseline** (Phase 4 mein 2 memories thi, aur Hinglish query par Module 2 upar aata tha): ab `ADD Module 2` ke baad `UPDATE Module 3`, sirf **1 memory**. English aur Hinglish dono queries par "User is on Module 3" top par.

## Playground (`npm run playground`)

- Events ab print hote hain. Module 2 se Module 3 ek `UPDATE` hai, aur student_1 ki 4 memories hain (pehle 5 thi).
- **Isolation check FAIL dikhata hai, lekin koi leak nahi hua** (0 leaked).
  - Wajah: "Mujhe cricket pasand hai" se Phase 5a prompt ab koi fact nahi nikalta, kyunki hobbies durable learning facts nahi maane jaate. Isliye student_2 ki koi memory nahi bani.
  - Check ki shart hai ki student_2 ki kam se kam ek memory ho, isliye ye fail hota hai.
- Playground scenario maine nahi badla; ye aapka faisla hai (neeche dekho).

## Aur jo notice kiya

- **Hobbies ab store nahi hote.** "Mujhe cricket pasand hai" kuch nahi deta. Course platform ke liye shayad theek hai, lekin ye Phase 5a ke prompt ka side-effect hai; kisi ne ise explicitly decide nahi kiya.
- **UPDATE metadata nahi badalta.** Module 3 wali memory ke metadata mein ab bhi `sessionId: session_1` hai, jabki update session_2 se aaya tha. `createdAt` bhi purana rehta hai, jo sahi hai.
- **Ended fact ki wording kaam kar gayi.** "ab DP clear ho gaya" wale ended fact ka text stored memory se exactly match karta tha, isliye DELETE saaf hua.

## Next steps

1. **Extraction prompt (approval ke baad):**
   - Topic slot ki fixed phrasing: `progress`: "User is studying <topic>". Isse scenario 3 theek hona chahiye.
   - "Ab detail mein samjhao / short mein batao" jaise badlaav ko preference maano. Isse scenario 9 theek hona chahiye.
2. **Playground:** student_2 ke liye aisa message rakho jo extract ho (jaise "Mujhe graphs samajh nahi aate"), ya check ko tab skip karo jab student_2 ki koi memory na ho.
3. **UPDATE par metadata:** latest `sessionId` rakhna hai ya original, ye decide karo.

---

## Phase 5c: extraction gaps fix + metadata merge

**Code under test:** Phase 5c working tree (uncommitted; HEAD = `889272a phase 5b`). Decider prompt aur decider logic unchanged.

### Kya badla
- **Extraction prompt:**
  - Current topic ("abhi <topic> kar raha hoon", "ab <topic> start kiya") hamesha `progress` mein "User is studying <topic>" ke roop mein jaata hai.
  - Hobbies `other` mein "User likes <X>" ke roop mein store hote hain.
  - One-off request (sirf current answer ke baare mein) fact nahi hai. Standing request ("hamesha … samjhaya karo") preference hai.
  - 3 naye few-shot examples: union-find, chess, "simple karke" / pseudo-code. Ye terms kisi `tests/*.json` mein nahi hain, aur naye test cases ke terms ("dry run", "football") prompt mein nahi hain (grep se dono taraf check kiya).
- **UPDATE par metadata:** purana metadata + naye `add()` ka metadata merge hota hai, aur naye values jeet-te hain. `createdAt` wahi rehta hai.
- **Tests:**
  - Update scenario 9 ko 9a (one-off) aur 9b (standing) mein toda.
  - Scenario 1 mein `sessionId` aur `createdAt` ke checks add kiye.
  - Extended suite mein 3 naye extraction cases: one-off, standing aur hobby.
  - Playground ka isolation check Phase 3 jaisa hi hai; code same hai, git se compare kiya.

### Update suite (`eval:update`, 2 runs)

| # | Scenario | Run 1 | Run 2 |
|---|---|---|---|
| 1 | Module 2, phir 3 (+ sessionId = session_2, createdAt same) | PASS | PASS |
| 2 | Module 3 khatam, phir Module 4 | PASS | PASS |
| 3 | Module 5 + linked lists, phir trees | **PASS** (5b mein FAIL) | **PASS** |
| 4 | Same conversation 2 baar | PASS | PASS |
| 5 | recursion 2 baar | PASS | PASS |
| 6 | DP weak, phir clear | PASS | PASS |
| 7 | Ended fact, kuch stored nahi | PASS | PASS |
| 8 | recursion, phir graphs | PASS | PASS |
| 9a | short, phir one-off "isko detail mein samjhao" | **PASS** | **PASS** |
| 9b | short, phir standing "hamesha detail mein samjhaya karo" | **PASS** | **PASS** |
| 10 | placement goal, phir Amazon SDE goal | PASS | PASS |
| 11 | Lamba sequence, naam unchanged | PASS | PASS |
| 12 | Do students, B untouched | PASS | PASS |
| 13 | Hinglish module search: Module 3 top | PASS | PASS |
| **Total** | | **14/14** | **14/14** |
| 14 (extra) | Parallel add, same user | PASS | PASS |

**Decider fallbacks: 0** (dono runs). Decider calls: 19 per run.

Events jo pehle fail hote the:
```
3.  add "Main Module 5 pe hoon, abhi linked lists kar raha hoon"
      -> ADD: User is on Module 5 | ADD: User is studying linked lists
    add "ab trees start kiya"
      -> UPDATE: "User is studying linked lists" -> "User is studying trees"
9a. add "mujhe short explanations chahiye"   -> ADD: User prefers short explanations
    add "isko detail mein samjhao"          -> (no facts)
9b. add "short se samajh nahi aata, hamesha detail mein samjhaya karo"
      -> UPDATE: "User prefers short explanations" -> "User prefers detailed explanations"
1.  state: User is on Module 3  metadata={"sessionId":"session_2","source":"llm"}  createdAt unchanged=true
```

### Extraction (`eval:extraction:all`, 2 runs)

| Suite | Metric | 5a.1 (run 1 / run 2) | **5c (run 1 / run 2)** |
|---|---|---|---|
| Original (12) | Keyword precision / recall | 100 / 100 | **100 / 100** |
| Original (12) | Forbidden / judge precision | 0 / 100% | **0 / 100%** |
| Extended (22 → 25 cases) | Keyword precision | 93.3% / 93.3% | **90.6% / 90.6%** (29/32) |
| Extended | Keyword recall | 100% / 100% | **96.8% / 96.8%** (30/31) |
| Extended | Forbidden facts | 0 / 0 | **0 / 0** |
| Extended | Judge precision | 93.8% / 90.6% | **90.9% / 90.6%** |
| – | Judge calibration | 95.7% (22/23) | **95.7% (22/23)** |

**Target "koi extraction metric regress na ho": extended suite par MISS.** Keyword precision 2.7 points aur recall 3.2 points gira. Dono runs mein wajah same:

1. **Recall miss: naya one-off rule aur ek purani expectation mein takraav.** Case `long_multiturn_mixed_with_course_questions` mein tutor kehta hai "ek cheat sheet banate hain", aur user bolta hai "haan please, table format mein dena".
   - Naye rule ke hisaab se ye sirf *is* cheat sheet ke baare mein request hai, isliye ab preference nahi bani.
   - Phase 4 mein likhi expectation abhi bhi `preference: table` maangti hai.
   - Mere hisaab se naya behaviour sahi hai aur expectation purani ho gayi hai. Lekin expectation badalna approve nahi hua tha, isliye edit nahi kiya.
2. **Precision miss:** hobby case mein "baaki time coding" se extra "User likes coding" `[other]` aaya. Judge isse correct maanta hai; keyword scorer unexpected ginta hai.
3. `long_multiturn_facts_spread` aur `time_change_goal` ke purane unexpected facts wahi hain jo 5a.1 mein the. Unmein koi naya problem nahi.

**Teeno naye cases dono runs mein sahi:**
- One-off "is solution ka dry run karke dikhao": koi fact nahi.
- Standing "har baar … dry run bhi dikhaya karo": "User prefers to see dry runs along with code".
- Hobby: "User likes playing football" `[other]`.

**Judge:**
- Run 2 mein ek call gpt-4o ki 30k TPM limit se 6 retries ke baad bhi fail hua (`time_change_module`), isliye 1 fact unjudged raha. Judge precision ka denominator 32 raha.
- Judge ki purani galtiyan wahi hain: sarcasm, aur C++ / Python ki category par sakhti.

### Robustness aur playground
- **Isolation:** 620 ids, **0 leaks**. Cross-user `getById` **0/90**.
- **Stale baseline:** `ADD` Module 2, `UPDATE` Module 3, sirf 1 memory.
- **Playground:** student_2 ke liye `ADD User likes cricket`. Isolation check **PASS** (13 ids, 0 leaked). Module 3 wali memory ka metadata ab `session_2` hai.

### Latency (`add()`, n=8)

| | Run 1 p50 / p95 | Run 2 p50 / p95 |
|---|---|---|
| Pehla add (decider skip) | 1,590 / 1,913 ms | 1,678 / 1,880 ms |
| Repeat add (decider) | 2,585 / 2,877 ms | 3,093 / **7,538** ms |

Run 2 ka p95 ek hi slow call hai (n=8 par p95 = max). Baaki 7 calls normal range mein the. Prompt 3 few-shots se bada hua hai, isliye extraction thoda slow hai.

### Targets ka summary
| Target | Result |
|---|---|
| Koi extraction metric 5a.1 se regress na ho | **MISS** (extended keyword P/R, upar wajah) |
| Update suite dono runs mein har scenario pass | **PASS** (14/14, 14/14) |
| 0 leaks | **PASS** |
| 0 decider fallbacks | **PASS** |

### Next steps
1. `long_multiturn_mixed_with_course_questions` ki expectation update karo (approval ke baad): `expected` se table preference hatao, ya use `allowed` mein daalo.
2. Hobby case mein "User likes coding" ko `allowed` mein add karo (approval ke baad).
3. Judge ke liye 30k TPM limit: eval runs ke beech thoda gap rakho, ya judge concurrency 5 se 3 karo.

### 5c follow-up: approved test edits + judge concurrency

**Edits (approved):**

| Case | Pehle | Ab | Wajah |
|---|---|---|---|
| `long_multiturn_mixed_with_course_questions` | `expected`: `{ "category": "preference", "mustInclude": ["table"] }` | wahi spec `allowed` mein | "haan please, table format mein dena" tutor ke "ek cheat sheet banate hain" ka jawab hai, yaani sirf *is* cheat sheet ke liye request. 5c ke one-off rule ke hisaab se ye standing preference nahi hai. Store ho jaaye to bhi galat nahi, isliye `allowed`. |
| `hobby_is_other` | `allowed` nahi tha | `allowed`: `{ "category": "other", "mustInclude": ["coding"] }` | "baaki time coding" se "User likes coding" ek sahi interest hai (judge bhi correct maanta hai). Required nahi, lekin precision ko nuksaan nahi dena chahiye. |

**Judge concurrency 5 se 3** (`scripts/judge.js`, `MAX_CONCURRENT`). Wajah: gpt-4o ki 30k TPM limit. 5c ke run 2 mein ek judge call 6 retries ke baad bhi fail hua tha.

**Run (1 baar, edits ke baad):**
- Pehli koshish mein OpenAI se "Request timed out" aur "Connection error" aaye (network issue; is change ki wajah se nahi). Wo run invalid maana gaya aur uske numbers use nahi kiye.
- Connectivity check (`test:llm` pass) ke baad dobara chalaya.

| Suite | Metric | 5a.1 (run 1 / run 2) | 5c (run 1 / run 2) | **5c after edits** |
|---|---|---|---|---|
| Original (12) | Keyword precision / recall | 100 / 100 | 100 / 100 | **100 / 100** (21/21) |
| Original (12) | Forbidden / judge precision | 0 / 100% | 0 / 100% | **0 / 100%** |
| Extended (25) | Keyword precision | 93.3% / 93.3% | 90.6% / 90.6% | **93.5%** (29/31) |
| Extended | Keyword recall | 100% / 100% | 96.8% / 96.8% | **100%** (30/30) |
| Extended | Forbidden facts | 0 / 0 | 0 / 0 | **0** |
| Extended | Judge precision | 93.8% / 90.6% | 90.9% / 90.6% | **90.9%** (30/33) |
| – | Judge calibration | 95.7% | 95.7% | **95.7%** (22/23) |
| – | Judge errors (rate limit) | – | 0 / 1 | **0** |

- **Extraction target ab PASS:** keyword precision, recall aur forbidden teeno 5a.1 ke barabar ya behtar hain. Judge precision 5a.1 ki range (90.6–93.8%) ke andar hai.
- **Bache hue 2 keyword UNEXPECTED facts** wahi purane borderline hain jo 5a.1 mein bhi the: "User finds videos boring" `[other]`, aur ended old goal. Ye judge ke hisaab se correct hain.
- **Judge ke 3 WRONG verdicts mein se:**
  - 1 judge ki known galti hai: sarcasm (calibration item #23).
  - 2 category par sakhti hai: Python aur C++ ko judge `preference` chahta hai.
