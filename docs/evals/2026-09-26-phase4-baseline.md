> **Note:** This report was moved here from `tests/results/FULL_EVAL_REPORT.md` and is now committed to git, so the closing note that says it will not be committed is outdated.

# Custom Memory Engine: Full Evaluation Report

**Date:** 2026-09-26
**Code under test:** Phase 4 working tree. It was **uncommitted** at eval time; HEAD is `0a0535c phase 3`. The exact `src/` file hashes are in `full-eval-2026-09-26T15-20-08-683Z.json` under `codeUnderTest`.
**Models:** `gpt-4o-mini` (extraction, temperature 0) and `text-embedding-3-small` (1536-dim).
**Qdrant:** local v1.18.3 on port 6337. Every run used the scratch collection `custom_user_memories_eval`, which was deleted afterwards. The final collection list is empty (`[]`).
**Rule followed:** nothing was changed in `src/`, the prompt, the thresholds or the expected outputs. Measurement only.

---

## 1. Verdict

**Nahi, abhi ye Mem0 ko C-RAG course platform mein replace karne ke liye ready nahi hai.**

Kuch cheezein solid hain:
- User isolation perfect hai: 620 result ids check kiye aur 0 leak mile, cross-user `getById` mein 0/90.
- Cost bahut kam hai: 1,000 user messages par takriban $0.13.
- Seedhe-saade Hinglish/English messages se facts nikalna achha chalta hai: original 12 cases par 95.5% precision aur 100% recall, teeno runs mein same.

Lekin real students jaise baat karte hain, wahan system galat memories store karta hai:
- Purani state ko current maan leta hai ("User was on Module 2 last week").
- Negation ko ulta samajhta hai: "User no longer struggles with DP" `weak_topic` mein chala gaya.
- Dost ya behen ke facts student ki memory mein daal deta hai.
- Hypothetical baat ko progress bana deta hai.
- Sabse bada blocker hai update/dedupe ka na hona. Module 2 aur Module 3 dono memory mein rehte hain, aur Hinglish query par **purana Module 2 upar rank hota hai**. Same conversation dobara `add()` karne par memories double ho jaati hain (3 se 6).
- `scoreThreshold` ka koi default nahi hai, isliye "thanks bhai" jaisi query par bhi memories inject hoti hain.
- OpenAI-style multi-part content (`content: [{type:'text',...}]`) **bina kisi error ke drop** ho jaata hai.

Phase 5 (update/dedupe) aur extraction prompt ke fixes ke baad hi Mem0 ki jagah lena safe hoga.

---

## 2. Scorecard

### Step 2: Extraction eval, original 12 cases (3 runs)
| Metric | Run 1 | Run 2 | Run 3 | Mean | Spread |
|---|---|---|---|---|---|
| Precision | 95.5% | 95.5% | 95.5% | 95.5% | 0 |
| Recall | 100% | 100% | 100% | 100% | 0 |
| DIFF cases | `language_preference_hinglish` (3/3 runs, same output every time) | | | | |
| Flaky cases (pass in one run, fail in another) | 0 | | | | |
| Cases whose output text changed across runs | 0/12 | | | | |
| Temperature | **0**, confirmed two ways: in code (`extractor.js` passes `temperature: 0`) and by capturing the actual API request (`[0]`) | | | | |

**Verdict:** 95.5% / 100% **stable hai**, ye koi ek run ka luck nahi tha.

### Step 3: Extended extraction, 22 new cases (3 runs)
| Metric | Run 1 | Run 2 | Run 3 | Mean | Spread |
|---|---|---|---|---|---|
| Precision (keyword scorer) | 72.2% | 73.0% | 73.0% | 72.7% | 0.8 pp |
| Recall | 93.1% | 93.1% | 93.1% | 93.1% | 0 |
| Forbidden facts stored | 7 | 7 | 7 | 7 | 0 |
| DIFF cases | 8/22 (same 8 cases in all 3 runs) | | | | |
| Flaky pass/fail | 0 | | | | |
| Output text changed across runs (temperature 0 hone ke bawajood) | 3/22 (`roman_hindi_weak_topic`, `time_change_goal`, `negation_knows_python_not_java`) | | | | |
| **Semantically wrong facts (manually checked)** | **8 of 37 (~22%)**: the 7 forbidden facts plus the sarcasm case, which the scorer missed | | | | |

### Step 4: Retrieval (4 students, 29 memories, 19 queries)
| Metric | Value |
|---|---|
| Top-1 accuracy | **71.4%** (10/14) |
| Top-3 accuracy | 100% (14/14) |
| MRR | 0.857 |
| Highest score on "nothing relevant" queries | France 0.063 · BST insert 0.267 · joke 0.129 · **"thanks bhai" 0.308** · weather 0.132 |
| Relevant (query, memory) pair scores | min 0.224 · p50 0.374 · max 0.678 (n=16) |
| Irrelevant pair scores | min −0.006 · p50 0.166 · p95 0.310 · max 0.376 (n=122) |
| Overlap zone | **0.224 to 0.376**: relevant aur irrelevant scores yahan mix hote hain |
| Recommended `scoreThreshold` (not applied) | **0.22**: saare relevant rakhta hai aur 71% irrelevant hata deta hai. 0.30 par 25% relevant bhi chale jaate hain (Phase 4 mein maine ~0.3 suggest kiya tha, data ke hisaab se wo galat tha). |

### Step 5: Isolation and robustness
| Check | Result |
|---|---|
| Isolation: 10 users × 6 memories × 8 queries (plain search, category-filtered search, getAll) | 620 ids checked, **0 leaks: PASS** |
| Cross-user `getById` | **0/90 breaches: PASS** |
| Edge: empty `messages: []` | empty result, no API call |
| Edge: blank user message | empty result, no API call |
| Edge: only assistant messages | empty result, no API call |
| Edge: ~5,000 chars, facts buried in the middle | stored 2, both correct ("Module 6", "heaps"), 2.9 s |
| Edge: emojis only | empty result (1 LLM call) |
| Edge: Devanagari | stored 3, correct and in English ("Ravi", "Module 2", "recursion") |
| Edge: multi-part content array | **empty result, silently**: no error, no memory |
| Edge: messages not an array | clear error |
| Edge: missing userId | clear error |
| Stale fact (Module 2, then Module 3) | **2 memories exist**. English query ranks Module 3 first (0.678 vs 0.665); **Hinglish query "main kaunse module pe hoon?" ranks Module 2 first** (0.448 vs 0.438) |
| Duplicates (same facts added twice, sliding window) | 3 facts became **6 memories** |

### Step 6: Cost and latency (sequential calls)
| Metric | p50 | p95 |
|---|---|---|
| Extraction (LLM call), n=34 | 1,062 ms | 1,911 ms |
| Embedding, 1 text, n=20 | 375 ms | 585 ms |
| Embedding, batch of 3, n=10 | 595 ms | 836 ms |
| Search, Qdrant only, n=30 | 96 ms | 110 ms |
| Search, engine (embed + Qdrant), n=20 | 422 ms | 462 ms |
| `add()` end-to-end, 1 message, n=10 | 1,711 ms | 1,975 ms |
| Tokens per extraction | prompt p50 701 (692–807), completion p50 42, **cached 0** | |
| Facts per extraction | mean 1.79 | |
| **Cost per 1,000 user messages** | **$0.13** (extraction $0.1299, fact embeddings $0.0002, query embeddings $0.0002) | |

Pricing was checked on https://developers.openai.com/api/docs/pricing on 2026-09-26:
- gpt-4o-mini: $0.15 per 1M input, $0.075 per 1M cached input, $0.60 per 1M output
- text-embedding-3-small: $0.02 per 1M tokens

Assumption: har user message par ek `add()` aur ek `search()`.

---

## 3. Top 5 problems (students ko kitna nuksaan hoga, us order mein)

### 1. Purane facts replace nahi hote, aur duplicates badhte rehte hain (Phase 5 ka kaam)
Tutor galat module ke hisaab se padhayega, aur har turn par memory store phoolta jayega.
- **Stale baseline:** "Main abhi Module 2 pe hoon" ke baad "Ab main Module 3 pe aa gaya hoon" bheja to 2 memories bani. Hinglish query `main kaunse module pe hoon?` ka result:
  - `0.448 User is on Module 2`
  - `0.438 User is on Module 3`
- **Extraction bhi purani state store karta hai:**
  - `time_change_module`: "User was on Module 2 last week" `[progress]`
  - `time_change_goal`: "User initially wanted to do web development" `[goal]`
- **Duplicates:** sliding-window style mein same conversation dobara `add()` kiya to 3 facts se 6 memories ban gayi.

### 2. Negation, sarcasm aur hypothetical baatein ulte facts ban jaati hain
Agar platform `weak_topic` se "revise these topics" dikhata hai, to galat topics dikhenge.
- `negation_resolved_weakness`: "ab mujhe DP mein dikkat nahi hai" se **"User no longer struggles with DP" `[weak_topic]`** bana.
- `sarcasm_recursion_easy`: "haan haan, recursion toh bahut easy hai… 3 din se atka hoon 🙃" se **"User finds recursion easy" `[weak_topic]`** bana. Ye bilkul ulta hai. Keyword scorer ne ise *pass* maan liya (neeche section 4 dekho).
- `hypothetical_module`: "agar main module 5 pe hota…" se "User would find the question easy if they were on Module 5" `[progress]` bana.
- **Language vs topic:** `language_vs_topic_both` mein "User struggles with understanding technical terms in English" `[weak_topic]` bana. Original `language_preference_hinglish` mein bhi yahi pattern hai, teeno runs mein.

### 3. Doosre logon ke facts student ki memory mein chale jaate hain
- `other_person_sister_vs_self`: "meri behen Module 7 pe hai aur usko DP bahut pasand hai" se ye store hua:
  - "User's sister is on Module 7" `[other]`
  - "User's sister likes DP" `[other]`
- Text technically sahi hai, lekin "which module / what does the student like" jaisi search mein ye memories aayengi aur LLM confuse hoga.
- Positive baat: `other_person_friend_weak` (dost graphs mein weak) mein **kuch store nahi hua**. Matlab problem tab aata hai jab doosre ka fact aur user ka fact ek hi message mein mix hon.

### 4. Retrieval: koi threshold nahi, aur Hinglish queries kamzor
Har query par (small talk par bhi) up to 5 memories inject hoti hain. Hinglish mein sahi memory pehle number par nahi aati.
- `"thanks bhai"` → `0.308 User's name is Arjun`. Ye score kai relevant scores se zyada hai.
- `"DP ka ye question samjhao"` → `0.300 User's name is Priya` pehle, sahi `0.224 User struggles with dynamic programming` doosre number par.
- `"student ka career goal kya hai?"` → college (0.340) goal (0.313) se upar.
- Top-1 sirf 71.4% hai. Saare 4 top-1 misses mein query ya to Hinglish thi ya generic "student/answer" wording wali. Relevant aur irrelevant scores 0.22 se 0.38 ke beech overlap karte hain, isliye koi clean threshold nahi hai.

### 5. Multi-part message content bina kisi error ke gayab
- Edge case `multi-part content array (OpenAI format)`: `[{type:'text', text:'Main Module 3 pe hoon'}]` par **empty result, koi error nahi**.
- Agar C-RAG app OpenAI ka array format bhejta hai (images/attachments wale messages mein aam hai), to us student ki memory kabhi banegi hi nahi, aur kisi ko pata bhi nahi chalega.

---

## 4. Surprises, aur jo aapne nahi poocha par jaanna chahiye

1. **Keyword scorer quality ko zyada achha dikhata hai.** Ye negation nahi pakad sakta.
   - `sarcasm_recursion_easy` "pass" hua, jabki fact ulta tha ("User finds recursion easy" `[weak_topic]`, "recursion" keyword match ho gaya).
   - Isliye extended ka asli error rate forbidden count (7) se zyada hai: manually check karne par 8/37 facts galat nikle.
2. **Mere banaye test cases ki 2 kamiyan (edit nahi kiye, sirf report kar raha hoon):**
   - `time_change_goal` mein expected keyword "ML" hai, lekin model "Machine Learning" likhta hai, isliye sahi fact bhi miss count hua. Recall ka ek miss scorer ki galti hai.
   - `long_multiturn_facts_spread` mein "User finds videos boring and tends to fall asleep" ek valid preference hai, lekin case ise allow nahi karta.
   - Original `language_preference_hinglish` wala DIFF bhi borderline hai: fact sach hai, sirf category galat hai.
3. **Temperature 0 bhi fully deterministic nahi hai.** 22 mein se 3 extended cases mein output wording runs ke beech badli, jaise "…the base case in recursion" wala extra fact sirf ek run mein aaya. Pass/fail stable raha, lekin exact-match tests mat likhna.
4. **Prompt caching ka fayda nahi mil raha.** Prompt ~700 tokens ka hai aur OpenAI caching 1,024 tokens se shuru hoti hai, isliye `cached_tokens` = 0. Cost itni kam hai ki abhi farak nahi padta, lekin prompt bada karoge to caching apne aap shuru ho sakti hai.
5. **Latency ka integration par asar:**
   - `add()` p50 ~1.7 s hai. Ise student ko reply bhejne ke **baad, background mein** chalana chahiye.
   - `search()` p50 ~0.42 s hai, jismein ~0.37 s embedding ka hai. Ise RAG retrieval ke **saath parallel** chalao, warna har jawab ~0.4 s slow hoga.
   - Localhost Qdrant par bhi search ~96 ms le raha hai. Docker Desktop/WSL networking aur REST ka overhead hai; production Linux par kam hoga.
6. **Hinglish query aur English memory ka gap.** Memories English mein store hoti hain, isliye Hinglish queries ke scores kam aate hain (jaise 0.224 vs English queries par 0.4–0.6). Retrieval quality ka ye structural issue hai.
7. **Achhi khabar:**
   - Devanagari input sahi English facts mein convert hua.
   - 5,000 chars ke beech dabe facts bhi mile.
   - Emoji-only aur course-question-only inputs par kuch store nahi hua.
   - Dost ke weak topic wala case sahi skip hua.
8. **Mem0 parity gaps** (eval mein measure nahi kiya, lekin replace karne se pehle zaroori):
   - `add()` sirf `ADD` events deta hai, `UPDATE`/`DELETE`/`NOOP` nahi.
   - Memory history ya audit nahi hai.
   - Search mein `category` ke alawa metadata filter nahi hai.
   - Agent/run/session scoping nahi hai.
9. **Eval ki validity:** ye run uncommitted code par hua. Exact file hashes JSON mein saved hain, taaki baad mein pata rahe ki kya test hua.

---

## 5. Recommended next steps (priority order)

1. **Phase 5: update/dedupe.** Naye facts ko existing similar memories se compare karke ADD/UPDATE/DELETE/NOOP decide karo. Isse problem #1 (stale + duplicates) solve hoga.
   - Acceptance tests: stale baseline mein ek hi "Module 3" memory bache, aur same conversation dobara add karne par count na badhe.
2. **Extraction prompt fixes** (aapki approval ke baad; ye tuning hai, isliye maine nahi kiya):
   - Sirf current state store karo; "pehle/pichle hafte" wali baat skip karo.
   - Negation ko `weak_topic` mein mat daalo.
   - Doosre logon ke facts skip karo.
   - Hypotheticals skip karo.
   - Sarcasm ko literally mat lo.
   - Language difficulty ko `preference`/`other` mein rakho.
   - Har rule ke liye few-shot examples add karo, aur har change ke baad dono eval suites re-run karo.
3. **Multi-part content handle karo.** `content` array se text parts nikaalo, ya kam se kam clear error throw karo. Abhi ye bina error ke drop hota hai.
4. **Retrieval defaults (app level):**
   - `scoreThreshold` ~0.22 se start karo aur `limit` 3.
   - Pure small talk par memory search skip karo.
   - Hinglish queries ke liye query ko English mein rewrite karne ka option test karo. Latency badhegi, isliye pehle measure karo.
5. **Scorer improve karo.** Keyword match ke saath ek LLM-judge ya negation-aware check add karo. Upar bataye 2 case-design issues aapki approval se fix karo.
6. **Integration pattern:** `add()` async/background mein aur `search()` RAG retrieval ke parallel. Jab tak dedupe nahi hai, `add()` ko sirf **naye** messages bhejo, poori sliding window nahi.
7. **Phase 4 commit karo,** eval scripts ke saath, taaki agla eval ek fixed commit par ho.

---

### Raw data files
- `tests/results/full-eval-2026-09-26T15-20-08-683Z.json`: sab kuch combined, stability analysis aur src hashes ke saath
- `tests/results/extraction-2026-09-26T15-12-55-886Z.json`, `…15-12-58-267Z.json`, `…15-13-00-594Z.json`: original eval, 3 runs
- `tests/results/extraction-extended-*.json`: extended eval, 3 runs
- `tests/results/retrieval-2026-09-26T15-16-32-049Z.json`
- `tests/results/robustness-2026-09-26T15-17-38-944Z.json`
- `tests/results/perf-2026-09-26T15-19-40-496Z.json`
- The duplicate check (3 facts becoming 6) was a one-off command. It is not in the JSON files.

Note: `tests/results/` `.gitignore` mein hai, isliye ye report aur JSON commit nahi honge, jab tak aap `.gitignore` nahi badalte.
