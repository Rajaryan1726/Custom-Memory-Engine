// Update/dedupe eval (Phase 5b). Each scenario is a sequence of add() calls followed by
// checks on getAll and on the events returned by add().
import { QdrantClient } from '@qdrant/js-client-rest';
import { DECIDER_PROMPT, EXTRACTION_PROMPT } from '../src/memory/prompts.js';
import { listCollections, saveResult, stats, timed } from './eval-utils.js';
import { config, createMemoryEngine, extractFacts, openai } from './runtime.js';

const COLLECTION = 'custom_user_memories_update_eval';

// ---- focused mode -----------------------------------------------------------
// npm run eval:update:9a  ->  --only=9a,9b, repeated EVAL_RUNS times (default 5).
// The count comes from an env var because PowerShell drops "--" in "npm run x -- --flag".
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice('--only='.length).split(',').map((x) => x.trim()).filter(Boolean) : null;
const RUNS = ONLY ? Number.parseInt(process.env.EVAL_RUNS ?? '5', 10) : 1;
if (!Number.isInteger(RUNS) || RUNS < 1) throw new Error(`EVAL_RUNS must be a positive integer, got "${process.env.EVAL_RUNS}"`);

// ---- instrumentation: decider calls, fallbacks, raw extractor/decider output ----
let deciderCalls = 0;
const fallbacks = [];
const llmTrace = []; // { kind: 'extractor' | 'decider', output }
const origCreate = openai.chat.completions.create.bind(openai.chat.completions);
openai.chat.completions.create = async (...args) => {
  const system = args[0]?.messages?.[0]?.content;
  if (system === DECIDER_PROMPT) deciderCalls++;
  const res = await origCreate(...args);
  if (system === DECIDER_PROMPT || system === EXTRACTION_PROMPT) {
    let output;
    try {
      output = JSON.parse(res.choices?.[0]?.message?.content ?? 'null');
    } catch {
      output = res.choices?.[0]?.message?.content;
    }
    llmTrace.push({ kind: system === DECIDER_PROMPT ? 'decider' : 'extractor', output });
  }
  return res;
};
const origWarn = console.warn;
console.warn = (...args) => {
  const line = args.join(' ');
  if (line.startsWith('[decider fallback]')) fallbacks.push(line);
  origWarn(...args);
};

const client = new QdrantClient({ ...config.qdrant, checkCompatibility: false });
async function dropCollection() {
  const { exists } = await client.collectionExists(COLLECTION);
  if (exists) await client.deleteCollection(COLLECTION);
}

// ---- helpers ------------------------------------------------------------------
const engine = createMemoryEngine({ collection: COLLECTION });
const RUN = `r${Date.now().toString(36)}`;
let REP = 1; // repetition number in focused mode, so each repetition uses fresh users
const uid = (name) => `${RUN}_${REP}_${name}`;
const MODULE_RE = /\bmodule\s*\d+/i;

function fmtEvents(results) {
  if (results.length === 0) return '(no facts)';
  return results
    .map((r) => {
      if (r.event === 'UPDATE') return `UPDATE: "${r.previousText}" -> "${r.text}"`;
      if (r.event === 'DELETE') return `DELETE: "${r.previousText}"`;
      return `${r.event}: ${r.text}`;
    })
    .join(' | ');
}

function scenario(name, fn) {
  return { name, fn };
}

async function say(log, userId, content, metadata) {
  const messages = typeof content === 'string' ? [{ role: 'user', content }] : content;
  const traceStart = llmTrace.length;
  const { results } = await engine.add(messages, { userId, metadata });
  const shown = typeof content === 'string' ? content : content.map((m) => `${m.role}: ${m.content}`).join(' / ');
  // Trace attribution is exact for sequential add() calls (all scenarios except the parallel one).
  const trace = llmTrace.slice(traceStart);
  log.push({
    input: shown,
    events: results.map(({ event, text, previousText }) => ({ event, text, previousText })),
    extracted: trace.filter((t) => t.kind === 'extractor').map((t) => t.output?.facts ?? t.output),
    decider: trace.filter((t) => t.kind === 'decider').map((t) => t.output?.actions ?? t.output),
  });
  return results;
}

const fmtFacts = (facts) =>
  Array.isArray(facts) && facts.length
    ? facts.map((f) => `[${f.category}] (${f.status ?? 'active'}) ${f.text}`).join(' | ')
    : '(none)';

const mems = async (userId) => (await engine.getAll({ userId })).results;

// ---- scenarios ----------------------------------------------------------------
const SCENARIOS = [
  scenario('1. Module 2, then Module 3', async (log) => {
    const u = uid('s1');
    await say(log, u, 'Main abhi Module 2 pe hoon', { sessionId: 'session_1' });
    const createdAt = (await mems(u)).find((m) => MODULE_RE.test(m.text))?.createdAt;
    await say(log, u, 'Ab main Module 3 pe aa gaya hoon', { sessionId: 'session_2' });
    const modules = (await mems(u)).filter((m) => MODULE_RE.test(m.text));
    const m = modules[0];
    const hist = m ? await engine.history(m.id, { userId: u }) : null;
    const histOk =
      Array.isArray(hist) &&
      hist.length === 2 &&
      hist[0].event === 'ADD' && /module 2\b/i.test(hist[0].text) && hist[0].sessionId === 'session_1' &&
      hist[1].event === 'UPDATE' && /module 3\b/i.test(hist[1].text) && hist[1].sessionId === 'session_2';
    const pass =
      modules.length === 1 &&
      /module 3\b/i.test(m.text) &&
      m.metadata?.sessionId === 'session_2' &&
      m.createdAt === createdAt &&
      histOk;
    return {
      pass,
      detail: [
        ...modules.map((x) => `${x.text}  metadata=${JSON.stringify(x.metadata)}  createdAt unchanged=${x.createdAt === createdAt}`),
        `history: ${(hist ?? []).map((h) => `${h.event} "${h.text}" (${h.sessionId})`).join(' -> ')}`,
      ],
    };
  }),

  scenario('2. Module 3 khatam, then Module 4 shuru', async (log) => {
    const u = uid('s2');
    await say(log, u, 'Maine Module 3 khatam kar liya');
    await say(log, u, 'Aaj se Module 4 shuru kiya');
    const modules = (await mems(u)).filter((m) => MODULE_RE.test(m.text));
    return { pass: modules.length === 1 && /module 4\b/i.test(modules[0].text), detail: modules.map((m) => m.text) };
  }),

  scenario('3. Module 5 + linked lists, then trees', async (log) => {
    const u = uid('s3');
    await say(log, u, 'Main Module 5 pe hoon, abhi linked lists kar raha hoon');
    await say(log, u, 'ab trees start kiya');
    const all = await mems(u);
    const modules = all.filter((m) => MODULE_RE.test(m.text));
    const pass =
      modules.length === 1 &&
      /module 5\b/i.test(modules[0].text) &&
      all.some((m) => m.category === 'progress' && /tree/i.test(m.text)) &&
      !all.some((m) => /linked list/i.test(m.text));
    return { pass, detail: all.map((m) => `[${m.category}] ${m.text}`) };
  }),

  scenario('4. Same conversation added twice', async (log) => {
    const u = uid('s4');
    const convo = [
      { role: 'user', content: 'Hi, main Raj hoon. Main Module 2 pe hoon aur recursion mein dikkat hai' },
      { role: 'assistant', content: 'Chalo shuru karte hain' },
      { role: 'user', content: 'mujhe code examples se jaldi samajh aata hai' },
    ];
    await say(log, u, convo);
    const before = (await mems(u)).length;
    const second = await say(log, u, convo);
    const after = (await mems(u)).length;
    const pass = before === after && second.length > 0 && second.every((r) => r.event === 'NOOP');
    return { pass, detail: [`count before=${before}, after=${after}`] };
  }),

  scenario('5. recursion twice in different words', async (log) => {
    const u = uid('s5');
    await say(log, u, 'mujhe recursion samajh nahi aata');
    await say(log, u, 'recursion mein abhi bhi dikkat hai');
    const rec = (await mems(u)).filter((m) => /recursion/i.test(m.text));
    return { pass: rec.length === 1, detail: rec.map((m) => m.text) };
  }),

  scenario('6. DP weak, then DP clear', async (log) => {
    const u = uid('s6');
    await say(log, u, 'DP mein bahut dikkat hai');
    const second = await say(log, u, 'ab DP clear ho gaya');
    const all = await mems(u);
    const dpWeak = all.filter((m) => m.category === 'weak_topic' && /\bDP\b|dynamic programming/i.test(m.text));
    const archived = (await engine.getAll({ userId: u, includeArchived: true })).results.filter(
      (m) => m.state === 'archived' && /\bDP\b|dynamic programming/i.test(m.text)
    );
    const pass =
      dpWeak.length === 0 &&
      second.some((r) => r.event === 'DELETE') &&
      archived.length === 1 &&
      typeof archived[0].archivedReason === 'string' &&
      archived[0].archivedReason.length > 0 &&
      Boolean(archived[0].archivedAt);
    return {
      pass,
      detail: [
        ...all.map((m) => `[${m.category}] ${m.text}`),
        ...archived.map((m) => `archived: "${m.text}"  reason="${m.archivedReason}"  at=${m.archivedAt}`),
      ],
    };
  }),

  scenario('7. Ended fact with nothing stored', async (log) => {
    const u = uid('s7');
    await say(log, u, 'ab mujhe sorting aa gayi');
    const all = await mems(u);
    return { pass: all.length === 0, detail: all.map((m) => `[${m.category}] ${m.text}`) };
  }),

  scenario('8. recursion, then graphs', async (log) => {
    const u = uid('s8');
    await say(log, u, 'mujhe recursion samajh nahi aata');
    await say(log, u, 'graphs bhi samajh nahi aate');
    const weak = (await mems(u)).filter((m) => m.category === 'weak_topic');
    return { pass: weak.length === 2, detail: weak.map((m) => m.text) };
  }),

  scenario('9a. short explanations, then one-off "isko detail mein samjhao"', async (log) => {
    const u = uid('s9a');
    await say(log, u, 'mujhe short explanations chahiye');
    const before = (await mems(u)).filter((m) => m.category === 'preference');
    await say(log, u, 'isko detail mein samjhao');
    const after = (await mems(u)).filter((m) => m.category === 'preference');
    const shortPref = after.find((m) => m.id === before[0]?.id);
    const pass =
      before.length === 1 &&
      after.length === 1 &&
      shortPref?.text === before[0].text &&
      /short|brief|concise/i.test(shortPref.text);
    return { pass, detail: after.map((m) => m.text) };
  }),

  scenario('9b. short explanations, then standing "hamesha detail mein samjhaya karo"', async (log) => {
    const u = uid('s9b');
    await say(log, u, 'mujhe short explanations chahiye');
    await say(log, u, 'short se samajh nahi aata, hamesha detail mein samjhaya karo');
    const len = (await mems(u)).filter((m) => m.category === 'preference' && /short|brief|concise|detail/i.test(m.text));
    return { pass: len.length === 1 && /detail/i.test(len[0].text), detail: len.map((m) => m.text) };
  }),

  scenario('10. placement goal, then Amazon SDE goal', async (log) => {
    const u = uid('s10');
    await say(log, u, 'placement ke liye DSA strong karna hai');
    await say(log, u, 'Amazon SDE ke liye DSA strong karna hai');
    const goals = (await mems(u)).filter((m) => m.category === 'goal');
    return { pass: goals.length === 1 && /amazon/i.test(goals[0].text), detail: goals.map((m) => m.text) };
  }),

  scenario('11. Long mixed sequence, name survives', async (log) => {
    const u = uid('s11');
    await say(log, u, 'Hi, main Kabir hoon');
    const name = (await mems(u)).find((m) => /kabir/i.test(m.text));
    for (const msg of [
      'Main abhi Module 2 pe hoon',
      'DP mein bahut dikkat hai',
      'graphs bhi samajh nahi aate',
      'Ab main Module 3 pe aa gaya hoon',
      'ab DP clear ho gaya',
    ]) {
      await say(log, u, msg);
    }
    const all = await mems(u);
    const nameNow = all.find((m) => m.id === name?.id);
    const pass = Boolean(name) && nameNow?.text === name.text && nameNow?.updatedAt === name.updatedAt;
    const modules = all.filter((m) => MODULE_RE.test(m.text));
    const info = [
      `module memories: ${modules.map((m) => m.text).join('; ')}`,
      `DP weak_topic left: ${all.some((m) => m.category === 'weak_topic' && /\bDP\b|dynamic programming/i.test(m.text))}`,
      `graphs kept: ${all.some((m) => /graph/i.test(m.text))}`,
    ];
    return { pass, detail: [...all.map((m) => `[${m.category}] ${m.text}`), ...info] };
  }),

  scenario('12. Two students, A clears DP, B untouched', async (log) => {
    const a = uid('s12a');
    const b = uid('s12b');
    await say(log, a, 'DP mein bahut dikkat hai');
    await say(log, b, 'DP mein bahut dikkat hai');
    const bBefore = (await mems(b)).find((m) => /\bDP\b|dynamic programming/i.test(m.text));
    await say(log, a, 'ab DP clear ho gaya');
    const bAfter = (await mems(b)).find((m) => m.id === bBefore?.id);
    const aDp = (await mems(a)).filter((m) => m.category === 'weak_topic' && /\bDP\b|dynamic programming/i.test(m.text));
    const pass = Boolean(bBefore) && bAfter?.text === bBefore.text && bAfter?.updatedAt === bBefore.updatedAt;
    return { pass, detail: [`B DP memory: ${bAfter?.text ?? '(gone)'}`, `A DP weak_topic left: ${aDp.length}`] };
  }),

  scenario('13. After scenario 1, search "main kaunse module pe hoon?"', async () => {
    const { results } = await engine.search('main kaunse module pe hoon?', { userId: uid('s1'), limit: 3 });
    return {
      pass: results.length > 0 && /module 3\b/i.test(results[0].text),
      detail: results.map((r) => `${r.score.toFixed(3)} ${r.text}`),
    };
  }),

  scenario('15. restore brings an archived memory back', async (log) => {
    const u = uid('s15');
    await say(log, u, 'DP mein bahut dikkat hai');
    await say(log, u, 'ab DP clear ho gaya');
    const archived = (await engine.getAll({ userId: u, includeArchived: true })).results.find((m) => m.state === 'archived');
    const hiddenBefore = !(await mems(u)).some((m) => m.id === archived?.id);
    const restored = archived ? await engine.restore(archived.id, { userId: u }) : null;
    const visibleAfter = (await mems(u)).find((m) => m.id === archived?.id);
    const hist = archived ? await engine.history(archived.id, { userId: u }) : [];
    const events = (hist ?? []).map((h) => h.event);
    const pass =
      Boolean(archived) &&
      hiddenBefore &&
      restored?.state === 'active' &&
      visibleAfter?.state === 'active' &&
      visibleAfter.archivedReason === undefined &&
      events.join(',') === 'ADD,ARCHIVE,RESTORE';
    return { pass, detail: [`visible after restore: ${visibleAfter?.text ?? '(no)'}`, `history: ${events.join(' -> ')}`] };
  }),

  scenario('16. engine.delete removes a memory completely (archived one)', async (log) => {
    const u = uid('s16');
    await say(log, u, 'DP mein bahut dikkat hai');
    await say(log, u, 'ab DP clear ho gaya');
    const archived = (await engine.getAll({ userId: u, includeArchived: true })).results.find((m) => m.state === 'archived');
    if (archived) await engine.delete(archived.id, { userId: u });
    const stillThere = (await engine.getAll({ userId: u, includeArchived: true })).results.some((m) => m.id === archived?.id);
    const hist = archived ? await engine.history(archived.id, { userId: u }) : 'n/a';
    const got = archived ? await engine.get(archived.id, { userId: u, includeArchived: true }) : 'n/a';
    const pass = Boolean(archived) && !stillThere && hist === null && got === null;
    return { pass, detail: [`in includeArchived: ${stillThere}, history: ${JSON.stringify(hist)}, get: ${JSON.stringify(got)}`] };
  }),

  scenario('17. finish one topic, start the next', async (log) => {
    const u = uid('s17');
    await say(log, u, 'Abhi main arrays ke questions kar raha hoon');
    await say(log, u, 'arrays wala section complete ho gaya, aaj se strings pe kaam shuru');
    const all = await mems(u);
    // "studying arrays"-style memory = mentions arrays, says the student is on it now, and does not say it is done.
    const staleArrays = all.filter(
      (m) =>
        /\barrays?\b/i.test(m.text) &&
        /\b(studying|learning|practi[cs]ing|working on|doing|solving|currently)\b/i.test(m.text) &&
        !/\b(complete[d]?|finished|done)\b/i.test(m.text)
    );
    const pass = staleArrays.length === 0 && all.some((m) => /\bstrings?\b/i.test(m.text));
    return { pass, detail: all.map((m) => `[${m.category}] ${m.text}`) };
  }),

  scenario('14 (extra). Two parallel add() calls, same user, same fact', async (log) => {
    const u = uid('s14');
    await Promise.all([
      say(log, u, 'mujhe backtracking samajh nahi aata'),
      say(log, u, 'mujhe backtracking samajh nahi aata'),
    ]);
    const bt = (await mems(u)).filter((m) => /backtracking/i.test(m.text));
    return { pass: bt.length === 1, detail: bt.map((m) => m.text) };
  }),
];

// ---- latency ------------------------------------------------------------------
async function latency() {
  const N = 8;
  const first = [];
  const repeat = [];
  let firstDecider = 0;
  let repeatDecider = 0;
  for (let i = 0; i < N; i++) {
    const u = uid(`lat${i}`);
    let calls = deciderCalls;
    first.push((await timed(() => engine.add([{ role: 'user', content: `Main Module ${i + 2} pe hoon` }], { userId: u }))).ms);
    firstDecider += deciderCalls - calls;
    calls = deciderCalls;
    repeat.push((await timed(() => engine.add([{ role: 'user', content: `Ab main Module ${i + 3} pe aa gaya hoon` }], { userId: u }))).ms);
    repeatDecider += deciderCalls - calls;
  }
  return { first: stats(first), repeat: stats(repeat), firstDeciderCalls: firstDecider, repeatDeciderCalls: repeatDecider, n: N };
}

// ---- focused mode: repeat selected scenarios ---------------------------------
const NINE_A_FOLLOW_UP = [{ role: 'user', content: 'isko detail mein samjhao' }];

async function runFocused() {
  const selected = SCENARIOS.filter((sc) => ONLY.some((id) => sc.name.startsWith(`${id}.`)));
  if (selected.length === 0) throw new Error(`--only=${ONLY.join(',')} matched no scenario`);
  console.log(`Focused run: ${selected.map((sc) => sc.name.split('.')[0]).join(', ')} x ${RUNS} (EVAL_RUNS)\n`);

  const tally = new Map(selected.map((sc) => [sc.name, { pass: 0, fail: 0, failures: [] }]));
  for (REP = 1; REP <= RUNS; REP++) {
    for (const sc of selected) {
      const log = [];
      let outcome;
      try {
        outcome = await sc.fn(log);
      } catch (err) {
        outcome = { pass: false, detail: [`ERROR: ${err.message}`] };
      }
      const t = tally.get(sc.name);
      if (outcome.pass) t.pass++;
      else t.fail++;
      console.log(`run ${REP}  ${outcome.pass ? 'PASS' : 'FAIL'}  ${sc.name}`);
      for (const a of log) {
        console.log(`        add "${a.input}"`);
        console.log(`          extracted: ${a.extracted.map(fmtFacts).join(' // ') || '(no extractor call)'}`);
        console.log(`          decider:   ${a.decider.length ? JSON.stringify(a.decider) : '(not called)'}`);
        console.log(`          events:    ${fmtEvents(a.events)}`);
      }
      for (const d of outcome.detail ?? []) console.log(`        state: ${d}`);
      if (!outcome.pass) t.failures.push({ run: REP, adds: log, detail: outcome.detail });
    }
  }

  // The 9a follow-up message through the extractor alone, exactly as add() passes it.
  console.log(`\nextractFacts alone on ${JSON.stringify(NINE_A_FOLLOW_UP)}, ${RUNS} times:`);
  const alone = [];
  for (let i = 1; i <= RUNS; i++) {
    const facts = await extractFacts(NINE_A_FOLLOW_UP);
    const hasPreference = facts.some((f) => f.category === 'preference');
    alone.push({ facts, hasPreference });
    console.log(`  ${i}: ${hasPreference ? 'PREFERENCE' : 'no preference'}  ${fmtFacts(facts)}`);
  }

  console.log('\nSummary:');
  for (const [name, t] of tally) console.log(`  ${name}: ${t.pass} pass, ${t.fail} fail (of ${RUNS})`);
  console.log(`  extractFacts alone: preference fact in ${alone.filter((a) => a.hasPreference).length}/${RUNS}`);
  console.log(`  decider fallbacks: ${fallbacks.length}`);

  const file = await saveResult('update-9a', {
    runAt: new Date().toISOString(),
    runs: RUNS,
    scenarios: [...tally].map(([name, t]) => ({ name, ...t })),
    extractAlone: alone,
    fallbacks,
  });
  console.log(`\nSaved to ${file}`);
}

// ---- main ---------------------------------------------------------------------
async function main() {
  await dropCollection();
  const results = [];
  for (const s of SCENARIOS) {
    const log = [];
    const fbBefore = fallbacks.length;
    let outcome;
    try {
      outcome = await s.fn(log);
    } catch (err) {
      outcome = { pass: false, detail: [`ERROR: ${err.message}`] };
    }
    const r = { name: s.name, ...outcome, adds: log, fallbacks: fallbacks.slice(fbBefore) };
    results.push(r);
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
    for (const a of r.adds) console.log(`        add "${a.input}"\n          -> ${fmtEvents(a.events)}`);
    for (const d of r.detail ?? []) console.log(`        state: ${d}`);
    for (const f of r.fallbacks) console.log(`        ${f}`);
  }

  const lat = await latency();
  const core = results.filter((r) => !r.name.includes('(extra)'));
  const passed = core.filter((r) => r.pass).length;

  console.log(`\nScenarios passed: ${passed}/${core.length}   (extra: ${results.filter((r) => r.name.includes('(extra)') && r.pass).length}/${results.length - core.length})`);
  console.log(`Decider fallbacks: ${fallbacks.length}`);
  console.log(`Decider calls (whole run): ${deciderCalls}`);
  console.log(`\nadd() latency, n=${lat.n}:`);
  console.log(`  first add (no candidates): p50=${lat.first.p50.toFixed(0)}ms p95=${lat.first.p95.toFixed(0)}ms  decider calls: ${lat.firstDeciderCalls}`);
  console.log(`  repeat add (decider):      p50=${lat.repeat.p50.toFixed(0)}ms p95=${lat.repeat.p95.toFixed(0)}ms  decider calls: ${lat.repeatDeciderCalls}`);

  const file = await saveResult('update-eval', {
    runAt: new Date().toISOString(),
    passed,
    total: core.length,
    fallbacks,
    deciderCalls,
    latency: lat,
    scenarios: results,
  });
  console.log(`\nSaved to ${file}`);
  if (passed < core.length) process.exitCode = 1;
}

try {
  await (ONLY ? runFocused() : main());
} catch (err) {
  console.error('eval-update failed:', err.message);
  process.exitCode = 1;
} finally {
  await dropCollection();
  console.log(`Collections after cleanup: ${JSON.stringify(await listCollections())}`);
}
