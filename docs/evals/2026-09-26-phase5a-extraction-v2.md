# Phase 5a: Extraction prompt v2 (status: active / ended)

**Date:** 2026-09-26
**Code under test:** Phase 5a working tree (uncommitted; HEAD = `cb70cac phase 4.5`). Only the extraction prompt, `extractor.js` and `MemoryEngine.add()` changed in `src/`.
**Models:** extractor `gpt-4o-mini` (temperature 0), judge `gpt-4o` (temperature 0, one fact per call).
**Baseline:** [2026-09-26-phase4-baseline.md](2026-09-26-phase4-baseline.md)

## Kya badla

- Har fact mein ab `status` hai: `"active"` ya `"ended"`.
  - "ab mujhe DP mein dikkat nahi hai" ab `{"text": "User struggles with dynamic programming (DP)", "category": "weak_topic", "status": "ended"}` deta hai.
  - Engine abhi ended facts store nahi karta; unhe `SKIPPED_ENDED` event ke saath return karta hai. Asli update Phase 5b mein hoga.
- **Naye prompt rules:**
  - Sirf current state extract karo.
  - Doosre logon ke facts skip karo.
  - Hypotheticals skip karo.
  - Sarcasm ka asli matlab lo.
  - Language difficulty `weak_topic` nahi, balki preference hai.
- **Har category ke liye fixed phrasing,** aur topic ka poora naam abbreviation ke saath, jaise "dynamic programming (DP)".
- **9 naye few-shot examples.** Inke names, modules aur topics kisi `tests/*.json` file mein nahi hain (grep se check kiya).

## Comparison

Phase 5a ke 2 runs kiye (temperature 0 par bhi output thoda badalta hai). Phase 4 ki keyword precision 3 runs ka mean hai. Judge ke numbers Phase 4.5 se hain, kyunki Phase 4 mein judge tha hi nahi.

| Suite | Metric | Phase 4 baseline | Phase 4.5 (same scorer as now) | Phase 5a run 1 | Phase 5a run 2 | **5a.1 run 1** | **5a.1 run 2** |
|---|---|---|---|---|---|---|---|
| Original (12) | Keyword precision | 95.5% | 95.5% | 100% (21/21) | 100% (21/21) | **100%** (21/21) | **100%** (21/21) |
| Original (12) | Keyword recall | 100% | 100% | 100% (21/21) | 100% (21/21) | **100%** (21/21) | **100%** (21/21) |
| Original (12) | Forbidden facts | 0 | 0 | 0 | 0 | **0** | **0** |
| Original (12) | Judge precision | – | 100%* | 100% (21/21) | 100% (21/21) | **100%** (21/21) | **100%** (21/21) |
| Extended (22) | Keyword precision | 72.7% | 77.1% | 93.3% (28/30) | 90.3% (28/31) | **93.3%** (28/30) | **93.3%** (28/30) |
| Extended (22) | Keyword recall | 93.1% | 96.6% | 100% (29/29) | 100% (29/29) | **100%** (29/29) | **100%** (29/29) |
| Extended (22) | Forbidden facts | 7 | 7 | 0 | 0 | **0** | **0** |
| Extended (22) | Judge precision | – | 68.4% | 87.5% (28/32) | 87.5% (28/32) | **93.8%** (30/32) | **90.6%** (29/32) |
| – | Judge calibration | – | 94.4% (17/18) | 100% (18/18) | 100% (18/18) | **95.7%** (22/23)** | **95.7%** (22/23)** |

\* Phase 4.5 ke original suite mein judge ne ek galat fact (English difficulty as `weak_topic`) ko correct maana tha, isliye wo 100% thoda zyada tha.

\*\* 5a.1 mein calibration set 18 se 23 items ka hua. Purane 18 items par judge ab bhi 18/18 hai. Jo ek disagreement hai, wo naye sarcasm item par hai, jo judge ki pehle se pata galti pakadne ke liye hi add kiya gaya tha. Isliye 100% se 95.7% ek bade test ka result hai, regression nahi.

## Phase 5a.1 (language rule + completed module)

**Kya badla:**
- **Language rule:** "User prefers explanations in <language>" sirf tab store hota hai jab user khud language maange. Sirf difficulty batane par category `other` mein "User finds ... in <language> hard to understand" jaata hai. Few-shot mein dono cases hain (Marathi maangna, aur bina language maange English explanations heavy lagna).
- **Completed module ka few-shot:** "aaj Module 10 khatam ho gaya finally" se "User has completed Module 10". "Module 10" aur "khatam ho gaya" dono kisi test file mein nahi hain (grep se check kiya).
- **Calibration mein 5 naye items** (sirf add kiye, purane items untouched; git diff mein koi line remove nahi hui):

| Item | Label | Judge (5a.1) |
|---|---|---|
| `[weak_topic] (ENDED) User struggles with dynamic programming (DP)`: user bola DP ab problem nahi | correct | correct ✓ |
| `[preference] (ENDED) User prefers explanations in Hindi`: user bola ab Hindi ki zarurat nahi | correct | correct ✓ |
| `[weak_topic] (ENDED) User struggles with recursion`: user ab bhi struggle kar raha hai | wrong | wrong ✓ |
| `[preference] User prefers explanations in Hindi`: user ne sirf English terms mushkil bataye | wrong | wrong ✓ |
| `[weak_topic] User struggles with recursion`: sarcasm ka sahi matlab | correct | **wrong ✗** |

**Targets:**
- **5a se kisi metric par regression nahi:** **PASS.**
  - Original suite dono runs mein 100 / 100 / 0 / 100.
  - Extended keyword precision 93.3% dono runs mein (5a mein 93.3% / 90.3%).
  - Recall 100%, forbidden 0.
  - Judge precision 93.8% / 90.6% (5a mein 87.5%).
  - Calibration wala note upar dekho.
- **Language error dono runs mein gayab:** **PASS.** Case `language_vs_topic_both` mein dono runs mein `[other] User finds technical terms in English hard to understand` aaya; koi invented preference nahi. Case `language_vs_topic_hindi_request` mein Hindi preference ab bhi sahi aati hai.
- **Completed-module error dono runs mein gayab:** **PASS.**
  - Case `long_multiturn_facts_spread` mein dono runs mein "User has completed Module 3".
  - Original case `mixed_progress_and_weak_topic` mein bhi "User has completed Module 4".

**Manual check (extended suite, dono runs):** koi sach mein galat fact nahi mila. Jo bache hain, wo scorer ya judge ki sakhti hain:
- **Judge ki galti:**
  - `sarcasm_recursion_easy` mein sahi fact ko wrong bola (dono runs; calibration item #23 yahi galti dikhata hai).
  - Run 2 mein naya `other` English-difficulty fact wrong bola, kyunki judge rubric mein abhi ye nahi likha ki language difficulty `other` mein jaati hai.
- **Borderline:**
  - "User is comfortable with C++" `[other]`: judge `preference` chahta hai.
  - "User finds videos boring" `[other]`: `allowed` spec sirf `preference` leta hai.
  - Ended goal ka text "User's previous goal was to do web development": fixed phrasing "User wants to …" follow nahi karta. Phase 5b mein existing memory se match karne ke liye ye wording matter karegi.
- **Chhoti wording issue (original suite):** "User is on linked lists" (keyword aur judge dono pass). Ye fixed phrasing ka side-effect hai; "User is studying linked lists" behtar hota.

**5a.1 ke baad next steps:**
1. **Judge rubric update (approval ke baad):** "language difficulty jo `other` mein ho wo correct hai", aur sarcasm ke liye ek clear line. Calibration item #23 isse measure hoga.
2. **Phase 5b:** ended facts ki wording existing memory se exactly match nahi hogi ("User's previous goal was…" vs "User wants to…"). Isliye decider ko text-exact match ki jagah similarity ya LLM comparison use karna padega.

### Targets
- **Original suite regress nahi karna chahiye** (precision aur recall ≥ 95%): **PASS**. Dono runs mein 100% / 100%.
- **Extended forbidden facts 7 se ≤ 2 hone chahiye:** **PASS**. Dono runs mein 0.

Lekin forbidden count sirf un galtiyon ko pakadta hai jo pehle se pata thi. Naye prompt ne ek **naya failure mode** paida kiya hai, jo forbidden list mein nahi tha (neeche #1 dekho).

## Jo abhi bhi galat hai (manually check kiya, dono runs)

1. **Language difficulty se preference "invent" hoti hai.** Ye naya problem hai, prompt rule 8 ki wajah se.
   - Case `language_vs_topic_both`: "technical terms English mein samajh nahi aate, par graphs mein toh genuinely problem hai"
     - Run 1: **"User prefers explanations in English"**. Ye ulta hai.
     - Run 2: **"User prefers explanations in Hindi"**. User ne Hindi maanga hi nahi tha.
   - Rule kehta hai "store the language the user wants", lekin jab user koi language maangta hi nahi, tab model khud ek language bana leta hai.
   - Keyword scorer ne run 1 mein ise `allowed` maan liya (scorer blind spot). Judge ne dono runs mein pakda.
2. **"Completed" ki jagah "is on" likha gaya.**
   - Case `long_multiturn_facts_spread`: "module 3 kal khatam kiya" se **"User is on Module 3"** bana, dono runs mein. Phase 4 mein yahi "User has completed Module 3" aata tha.
   - Keyword check pass hua (sirf "Module 3" check hota hai). Judge ne pakda.
   - Fixed phrasing ne yahan precision kam kar di.
3. **Ended goal extract hua.** Case `time_change_goal`: naye goal ke saath "User wanted to do web development" `(ENDED)` bhi aaya.
   - Nuksaan nahi hai: store nahi hota, aur Phase 5b mein kaam bhi aayega.
   - Lekin prompt rule 2 ("past state skip karo") se thoda inconsistent hai. Keyword scorer ise unexpected ginta hai.

**Judge ki galti (extractor sahi tha):** case `sarcasm_recursion_easy` mein extractor ne sahi "User struggles with recursion" diya. Judge ne dono runs mein sarcasm ko literally padha aur ise WRONG bola. Isliye extended judge precision 87.5% asal se thoda kam hai.

**Borderline, jinhe galti nahi maanta:**
- "User is comfortable with C++" `[other]`: judge `preference` chahta tha.
- "User finds videos boring" `[other]`: `allowed` spec sirf `preference` accept karta hai.

**Manual count, extended suite:** run 1 mein 32 mein se 2 facts sach mein galat the (#1 aur #2), yaani ~94% precision. Run 2 mein 32 mein se 2 galat (#1 ka Hindi version aur #2).

## Test / calibration changes

- **Expectation edit** (sirf ek, schema ki wajah se): `negation_resolved_weakness`
  - Pehle: `{"category": ["progress", "other"], "mustInclude": ["DP"]}`
  - Ab: `{"category": "weak_topic", "status": "ended", "mustInclude": [["DP", "dynamic programming"]]}`
- **Scorer:** `status` optional hai (default `"active"`). Ye `expected`, `allowed` aur `forbidden` teeno par lagta hai. Isliye ended DP fact ab "weak_topic DP" forbidden rule mein nahi phansta; wo rule ab sirf *active* weak_topic ke liye hai.
- **Calibration labels:** koi label edit nahi kiya; sab naye schema mein bhi sahi hain. Lekin do gaps hain:
  - Set mein koi **"ended" item nahi hai**, isliye ended facts par judge calibrated nahi hai.
  - **Invented language preference** wali galti ka bhi koi item nahi hai.
- **Calibration 94.4% se 100%:** judge prompt mein sirf ended status ka rule add hua aur fact ke saath "(status: active)" dikhne laga. Is change se English-as-weak_topic wala item bhi sahi ho gaya. Ye 2 runs ka result hai, pakka proof nahi.

## Cost par asar

- Prompt ~700 se **~1,444 tokens** ka ho gaya (naye rules aur 9 examples ki wajah se).
- Extraction cost lagbhag double: **~$0.25 per 1,000 messages** (pehle ~$0.13). Ye estimate hai, `eval:perf` dobara nahi chalaya.
- Prompt ab 1,024 tokens se bada hai, isliye OpenAI prompt caching lag sakti hai aur cached tokens aadhe daam par aate hain. Smoke test ki pehli call mein `cached_tokens` 0 tha; production traffic mein ye badhega.

## Next steps

1. **Phase 5b:** update/dedupe decider. `SKIPPED_ENDED` facts ab update logic ke liye ready hain.
2. **Prompt fix (approval ke baad):** language difficulty par tabhi preference banao jab user khud language maange. Warna fact skip karo, ya `other` mein "User finds technical terms in English difficult" rakho.
3. **Prompt fix:** "khatam kiya / finished" ke liye "User has completed Module N" ka few-shot example.
4. **Calibration set mein add karo:** ek correct ended fact, ek invented language preference, aur sarcasm wala *correct* fact ("User struggles with recursion"). Aakhri item judge ki us galti ko pakdega.
