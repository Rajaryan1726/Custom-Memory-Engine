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
