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

| Suite | Metric | Phase 4 baseline | Phase 4.5 (same scorer as now) | **Phase 5a run 1** | **Phase 5a run 2** |
|---|---|---|---|---|---|
| Original (12) | Keyword precision | 95.5% | 95.5% | **100%** (21/21) | **100%** (21/21) |
| Original (12) | Keyword recall | 100% | 100% | **100%** (21/21) | **100%** (21/21) |
| Original (12) | Forbidden facts | 0 | 0 | **0** | **0** |
| Original (12) | Judge precision | – | 100%* | **100%** (21/21) | **100%** (21/21) |
| Extended (22) | Keyword precision | 72.7% | 77.1% | **93.3%** (28/30) | **90.3%** (28/31) |
| Extended (22) | Keyword recall | 93.1% | 96.6% | **100%** (29/29) | **100%** (29/29) |
| Extended (22) | Forbidden facts | 7 | 7 | **0** | **0** |
| Extended (22) | Judge precision | – | 68.4% | **87.5%** (28/32) | **87.5%** (28/32) |
| – | Judge calibration | – | 94.4% (17/18) | **100%** (18/18) | **100%** (18/18) |

\* Phase 4.5 ke original suite mein judge ne ek galat fact (English difficulty as `weak_topic`) ko correct maana tha, isliye wo 100% thoda zyada tha.

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
