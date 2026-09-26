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

---

## Phase 6.1: one-off requests ko preference banne se rokna

**Code under test:** Phase 6.1 working tree (uncommitted; HEAD = `0610fd6 phase 6`). Sirf `EXTRACTION_PROMPT` ka preference rule aur few-shots badle. Decider untouched.

### Kya badla
- **Preference rule (rule 13):**
  - Current answer ya explanation ke baare mein request **kabhi fact nahi**, chahe style mention ho. Signals: "isko", "ye", "this", "is question ko", "abhi", ya ek baar ka instruction.
  - "User prefers …" sirf tab jab lasting wish ho ("hamesha", "har baar", "aage se", "from now on", "always"), ya user general tarike se bataye ki wo kaise seekhta hai.
  - Doubt ho to store mat karo.
- **Naya English few-shot pair:**
  - "can you explain this more simply?" → `{"facts": []}`
  - "honestly I only get things once I see them drawn out on a whiteboard" → `User prefers visual explanations drawn out step by step`
- **Wording check (grep, dono taraf):**
  - Prompt ke naye terms kisi `tests/*.json` mein nahi hain.
  - Naye test cases ke terms prompt mein nahi hain, **sirf "lambe" ek exception hai**: wo Phase 5a.1 ke *language-difficulty* few-shot mein pehle se hai ("English explanations bahut lambe aur heavy lagte hain", jo `other` banta hai). Is phase mein wo example chhua nahi.
- **3 naye extended cases:**
  - `one_off_request_english`: "could you go over that part again, but slower?" → expected `[]`, koi preference forbidden
  - `one_off_request_hinglish_2`: "ye wala example ek baar aur chhote steps mein samjha do" → expected `[]`, koi preference forbidden
  - `standing_preference_without_keyword`: "mujhe lambe answers padhne mein bore hota hai" → expected preference (short / concise / brief / long)
- **Naya script:** `npm run eval:pref-stability`. Counts env vars se aate hain: `PREF_ONE_OFF_RUNS` (default 20) aur `PREF_STANDING_RUNS` (default 10).

### Stability measurement

| Measurement | Target | Result |
|---|---|---|
| `extractFacts` akele, 9a message ("isko detail mein samjhao"), 20 baar | 0/20 preference | **0/20: PASS** |
| `extractFacts` akele, 9b message ("short se samajh nahi aata, hamesha detail mein samjhaya karo"), 10 baar | 10/10 preference | **10/10: PASS** (har baar "User prefers detailed explanations") |
| `EVAL_RUNS=5 npm run eval:update:9a` | – | **9a 5/5, 9b 5/5.** Is run ke andar `extractFacts` akele bhi 0/5. Fallbacks 0. |

- Pehle (Phase 6 wrap-up) 9a message par preference ~1/10 baar banti thi. Ab 30 calls mein 0 baar (20 akele, 5 scenario ke andar, 5 akele 9a run mein).
- Agar asli rate ab bhi 10% hota, to 0/20 aane ka chance ~12% hai. Isliye ye strong evidence hai, proof nahi.

### Full regression

| Eval | 5c / Phase 6 | **6.1** |
|---|---|---|
| Judge calibration | 95.7% (22/23) | **95.7%** (22/23), same sarcasm item |
| Original (12): keyword P / R / forbidden / judge P | 100 / 100 / 0 / 100% | **100 / 100 / 0 / 100%** |
| Extended keyword precision | 93.5% (29/31, 25 cases) | **90.3%** (28/31, 28 cases) |
| Extended keyword recall | 100% (30/30) | **93.5%** (29/31) |
| Extended forbidden | 0 | **0** |
| Extended judge precision | 90.9% | **94.1%** (32/34) |
| Update suite (`eval:update`, 1 run) | 16/16 | **16/16**, fallbacks 0 |
| Robustness | 0 leaks, 0/90, 0/540, 0/10, legacy 4/4 | **wahi sab PASS** |

**Target "koi metric regress na ho": MISS** (extended keyword precision aur recall). Do wajah:

1. **Purane case mein regression: `language_vs_topic_hindi_request`.** "English mein padhne mein dikkat hoti hai, Hindi mein samjhao na" se ab sirf `[other] User finds reading in English hard to understand` aaya. **"User prefers explanations in Hindi" gayab ho gaya.**
   - Naya one-off rule "Hindi mein samjhao" ko ek baar ki request padh raha hai (koi "hamesha" nahi), aur ye language rule ko override kar deta hai.
   - Asli student ke liye ye nuksaan hai: tutor Hindi mein jawab dena band kar dega.
   - Original suite ka `language_preference_hinglish` ("Mujhe Hindi mein explain karo please…") abhi bhi sahi hai, isliye problem "samjhao na" jaisi request wording par hai.
2. **Naya case `standing_preference_without_keyword`:** "mujhe lambe answers padhne mein bore hota hai" se `[other] User finds long answers boring` bana, preference nahi.
   - Info bachi hai, lekin `other` sirf vector search se context mein aata hai, profile se nahi. Isliye ye har jawab mein short answers ka signal nahi dega.
   - "Doubt ho to store mat karo" rule, aur "lambe" wala purana language few-shot, dono iski wajah ho sakte hain. Maine test nahi kiya ki asli wajah kaunsi hai.

**Purane 25 cases par alag se:**
- Recall 29/30 = 96.7% (5c mein 100%), yaani sirf Hindi wala regression.
- Precision 28/30 = 93.3% (5c mein 93.5%), lagbhag same.

**Jo sahi hua:** dono naye one-off cases (English aur Hinglish) ne kuch extract nahi kiya, aur `explanation_style_english` ("Please keep explanations short…") ki dono preferences ab bhi bani.

### Next steps (approval ke baad)
1. **Language rule ko one-off rule se exempt karo:** "<language> mein samjhao/batao" hamesha preference hai, kyunki language ek baar ke liye nahi maangi jaati. Ek few-shot bhi.
2. **General-learning few-shot:** "X padhne mein bore hota hai / X se kuch samajh nahi aata" wala ek Hinglish example jo preference banaye, taaki "doubt ho to skip" rule isko `other` mein na bheje.
3. Dono ke baad `eval:pref-stability` aur `eval:extraction:all` dobara chalao.

---

## Phase 6.2: 6.1 ke do regressions fix

**Code under test:** Phase 6.2 working tree (uncommitted; HEAD = `0610fd6 phase 6`, 6.1 ke changes bhi uncommitted). Sirf `EXTRACTION_PROMPT` badla. Decider aur expected outputs untouched.

### Kya badla
- **Language exception:** "<language> mein samjhao", "<language> mein batao", "explain in <language>" hamesha preference hain ("User prefers explanations in <language>"), chahe request jaisi lagein. Ye one-off rule ka explicit exception hai.
- **Format exception:** explanation ke FORMAT (length, theory vs practice, text vs video, pace) ki general complaint preference hai, `other` nahi. User jo format chahta hai wahi store hota hai.
- **Naya Hinglish few-shot:** "theory-heavy chapters se kuch palle nahi padta, hands-on kaam jaldi dimaag mein baithta hai" → `User prefers practical, hands-on explanations`. Isme koi word kisi test case se share nahi hota; "lambe", "bore", "padhne" aur "answers" prompt ke few-shots mein nahi hain.
- **5a.1 language few-shot reword:** "lecture ke English explanations bahut lambe aur heavy lagte hain" → "lecture ki English itni bhaari lagti hai ki aadha samajh hi nahi aata". Output wahi hai (`other`: "User finds explanations in English hard to understand"). "lambe" ab prompt mein kahin nahi.

### Wording overlap (few-shot conversations vs `tests/*.json` conversations, dono taraf)
Word-level script se check kiya; function words (hai, mein, ko, …) chhod diye. **Jo overlap abhi bhi bacha hai:**
- **Marathi language few-shot (5a.1):** "samjhao", "technical", "confuse", "English". Ye language cases (`language_vs_topic_*`, `mixed_progress_and_weak_topic`) se share hote hain.
- **Pseudo-code few-shot (5c):** "hamesha", "yaad", "waise" (`long_multiturn_mixed_with_course_questions`).
- **Ek-ek word:** "khatam" (long multiturn), "clear" (negation), "khelta" (hobby), "karke" (one-off), "dikhaya" (standing request), "trees" ("segment trees" mein).
- **Generic words:** "pasand", "pehle", "gaya", "module", "question", "student", "year", "thanks", "hello", "help" wagairah.
- **Rule text (few-shot nahi):**
  - 6.1 ka example "mujhe short answers se kuch samajh nahi aata" mein "answers" hai, jo `standing_preference_without_keyword` mein bhi hai.
  - Format rule ka "too long … prefers it shorter" meaning mein us case ke answer ke kareeb hai (spec ne yahi meaning maangi thi).

### Results

| Measurement | Target | 6.1 | **6.2** |
|---|---|---|---|
| `eval:pref-stability`: one-off (9a message) | 0/20 | 0/20 | **0/20 PASS** |
| `eval:pref-stability`: standing (9b message) | 10/10 | 10/10 | **10/10 PASS** |
| `language_vs_topic_hindi_request` | Hindi preference | ✗ (sirf `other`) | **✓ "User prefers explanations in Hindi"** |
| `standing_preference_without_keyword` ("lambe answers … bore") | preference | ✗ (`other`) | **✓ "User prefers shorter answers"** |
| `EVAL_RUNS=5 eval:update:9a` | – | 9a 5/5, 9b 5/5 | **9a 5/5, 9b 5/5**; extractFacts alone 0/5; fallbacks 0 |

| Regression | 5c / Phase 6 baseline | 6.1 | **6.2** |
|---|---|---|---|
| Judge calibration | 95.7% (22/23) | 95.7% | **95.7%** (same sarcasm item) |
| Original (12): P / R / forbidden / judge P | 100 / 100 / 0 / 100% | same | **100 / 100 / 0 / 100%** |
| Extended keyword precision | 93.5% | 90.3% | **93.8%** (30/32) |
| Extended keyword recall | 100% | 93.5% | **100%** (31/31) |
| Extended forbidden | 0 | 0 | **0** |
| Extended judge precision | 90.9% | 94.1% | **91.2%** (31/34) |
| Update suite (1 run) | 16/16 | 16/16 | **16/16**, fallbacks 0 |
| Robustness | 0 leaks, 0/90, 0/540, 0/10, legacy 4/4 | same | **same, sab PASS** |

**Saare targets PASS.**
- Judge precision 91.2% hai, jo 5c ke 90.9% se upar hai. 6.1 ke 94.1% se neeche hai, lekin 6.1 baseline nahi tha.
- Judge ke 3 WRONG verdicts wahi purani galtiyan hain: sarcasm (calibration item #23), aur Python / C++ ki category par sakhti. Koi naya galat fact nahi.
- Language-difficulty case (`language_vs_topic_both`) ab bhi sahi hai: `[other] User finds technical terms in English hard to understand`. Koi language guess nahi hui.
- Dono naye one-off cases (English aur Hinglish) ab bhi kuch extract nahi karte.

**Limitation:** har eval sirf ek run hai (sirf pref-stability aur 9a repeated hain). Extraction suites ka 1 run temperature 0 wale drift ko poori tarah nahi pakadta.
