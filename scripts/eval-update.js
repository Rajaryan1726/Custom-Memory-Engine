// Update/dedupe eval (Phase 5b). Each scenario is a sequence of add() calls followed by
// checks on getAll and on the events returned by add().
import { QdrantClient } from '@qdrant/js-client-rest';
import config from '../src/config/index.js';
import { openai } from '../src/llm/client.js';
import { createMemoryEngine } from '../src/memory/MemoryEngine.js';
import { DECIDER_PROMPT } from '../src/memory/prompts.js';
import { listCollections, saveResult, stats, timed } from './eval-utils.js';

const COLLECTION = 'custom_user_memories_update_eval';

// ---- instrumentation: decider calls and fallbacks ----------------------------
let deciderCalls = 0;
const fallbacks = [];
const origCreate = openai.chat.completions.create.bind(openai.chat.completions);
openai.chat.completions.create = async (...args) => {
  if (args[0]?.messages?.[0]?.content === DECIDER_PROMPT) deciderCalls++;
  return origCreate(...args);
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
const uid = (name) => `${RUN}_${name}`;
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

async function say(log, userId, content) {
  const messages = typeof content === 'string' ? [{ role: 'user', content }] : content;
  const { results } = await engine.add(messages, { userId });
  const shown = typeof content === 'string' ? content : content.map((m) => `${m.role}: ${m.content}`).join(' / ');
  log.push({ input: shown, events: results.map(({ event, text, previousText }) => ({ event, text, previousText })) });
  return results;
}

const mems = async (userId) => (await engine.getAll({ userId })).results;

// ---- scenarios ----------------------------------------------------------------
const SCENARIOS = [
  scenario('1. Module 2, then Module 3', async (log) => {
    const u = uid('s1');
    await say(log, u, 'Main abhi Module 2 pe hoon');
    await say(log, u, 'Ab main Module 3 pe aa gaya hoon');
    const modules = (await mems(u)).filter((m) => MODULE_RE.test(m.text));
    return { pass: modules.length === 1 && /module 3\b/i.test(modules[0].text), detail: modules.map((m) => m.text) };
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
    const pass = dpWeak.length === 0 && second.some((r) => r.event === 'DELETE');
    return { pass, detail: all.map((m) => `[${m.category}] ${m.text}`) };
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

  scenario('9. short explanations, then detailed', async (log) => {
    const u = uid('s9');
    await say(log, u, 'mujhe short explanations chahiye');
    await say(log, u, 'ab detail mein samjhao');
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
  await main();
} catch (err) {
  console.error('eval-update failed:', err.message);
  process.exitCode = 1;
} finally {
  await dropCollection();
  console.log(`Collections after cleanup: ${JSON.stringify(await listCollections())}`);
}
