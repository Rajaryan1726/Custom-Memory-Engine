// Robustness eval: isolation at scale, edge inputs, and the stale-fact baseline.
import { embedMany } from '../src/llm/embed.js';
import { createMemoryEngine } from '../src/memory/MemoryEngine.js';
import { createVectorStore } from '../src/stores/vectorStore.js';
import { EVAL_COLLECTION, dropEvalCollection, listCollections, saveResult } from './eval-utils.js';

const NAMES = ['Aarav', 'Diya', 'Kabir', 'Ananya', 'Vihaan', 'Isha', 'Reyansh', 'Meera', 'Arnav', 'Saanvi'];
const TOPICS = ['recursion', 'dynamic programming', 'graphs', 'pointers', 'hashing', 'trees', 'sorting', 'linked lists', 'stacks', 'bit manipulation'];
const STYLES = ['code examples', 'diagrams', 'videos', 'short bullet points', 'real-life analogies'];
const GOALS = ['a Google internship', 'placements', 'GATE', 'a startup job', 'competitive programming'];

const ISOLATION_QUERIES = [
  'which module is the student on?',
  'what is the student weak at?',
  'how does the student like to learn?',
  'student ka goal kya hai?',
  "what is the student's name?",
  'recursion samjhao',
  'Aarav',
  'User',
];

// ---- isolation at scale ---------------------------------------------------

async function isolation(store) {
  const users = NAMES.map((name, i) => ({
    userId: `iso_user_${i}`,
    memories: [
      { text: `User's name is ${name}`, category: 'identity' },
      { text: `User is on Module ${i + 1}`, category: 'progress' },
      { text: `User struggles with ${TOPICS[i]}`, category: 'weak_topic' },
      { text: `User prefers learning with ${STYLES[i % STYLES.length]}`, category: 'preference' },
      { text: `User wants to get ${GOALS[i % GOALS.length]}`, category: 'goal' },
      { text: `User studies from ${['Delhi', 'Pune', 'Patna', 'Chennai', 'Jaipur'][i % 5]}`, category: 'other' },
    ],
  }));

  const all = users.flatMap((u) => u.memories);
  const vectors = await embedMany(all.map((m) => m.text));
  let k = 0;
  for (const u of users) {
    u.memories.forEach((m) => (m.vector = vectors[k++]));
    u.ids = new Set(await store.addMemories(u.userId, u.memories));
  }

  const queryVectors = await embedMany(ISOLATION_QUERIES);
  let checks = 0;
  let leaks = 0;
  const leakDetails = [];

  for (const u of users) {
    const record = (id, where) => {
      checks++;
      if (!u.ids.has(id)) {
        leaks++;
        leakDetails.push({ userId: u.userId, id, where });
      }
    };
    for (let q = 0; q < ISOLATION_QUERIES.length; q++) {
      // limit far above the user's own count, so leaks would have room to appear
      const results = await store.search(u.userId, queryVectors[q], { limit: 50 });
      results.forEach((r) => record(r.id, `search "${ISOLATION_QUERIES[q]}"`));
      const byCat = await store.search(u.userId, queryVectors[q], { limit: 50, category: 'weak_topic' });
      byCat.forEach((r) => record(r.id, `search+category "${ISOLATION_QUERIES[q]}"`));
    }
    (await store.getAll(u.userId)).forEach((r) => record(r.id, 'getAll'));
  }

  // cross-user point access: every user tries every other user's first memory
  let crossAttempts = 0;
  let crossBreaches = 0;
  for (const a of users) {
    for (const b of users) {
      if (a === b) continue;
      const victimId = [...b.ids][0];
      crossAttempts++;
      if ((await store.getById(a.userId, victimId)) !== null) crossBreaches++;
    }
  }

  return {
    users: users.length,
    memoriesPerUser: users[0].memories.length,
    queries: ISOLATION_QUERIES.length,
    resultIdsChecked: checks,
    leaks,
    leakDetails,
    crossUserGetById: { attempts: crossAttempts, breaches: crossBreaches },
  };
}

// ---- edge inputs ----------------------------------------------------------

function longMessage() {
  const filler =
    'Aaj ka lecture bahut lamba tha aur sir ne bahut saare examples diye, kuch samajh aaye kuch nahi, phir lab mein bhi time lag gaya. ';
  const facts = ' Waise main abhi Module 6 pe hoon aur mujhe heaps samajh nahi aate. ';
  let text = '';
  while (text.length < 2400) text += filler;
  text += facts;
  while (text.length < 5000) text += filler;
  return text.slice(0, 5000);
}

async function edgeInputs(engine) {
  const cases = [
    { name: 'empty messages array', messages: [] },
    { name: 'blank user message', messages: [{ role: 'user', content: '   ' }] },
    { name: 'only assistant messages', messages: [{ role: 'assistant', content: 'Main aapka tutor hoon. Aap Module 2 pe ho.' }] },
    { name: 'very long message (~5000 chars, facts buried in the middle)', messages: [{ role: 'user', content: longMessage() }] },
    { name: 'emojis only', messages: [{ role: 'user', content: '😂😂🔥🔥👍🙏' }] },
    { name: 'Devanagari script', messages: [{ role: 'user', content: 'मेरा नाम रवि है, मैं मॉड्यूल 2 पर हूँ और मुझे रिकर्शन समझ नहीं आता' }] },
    {
      name: 'multi-part content array (OpenAI format)',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Main Module 3 pe hoon' }] }],
      mustStore: /module 3/i,
    },
    { name: 'messages not an array', messages: 'Main Module 3 pe hoon' },
    { name: 'missing userId', messages: [{ role: 'user', content: 'Main Module 3 pe hoon' }], userId: null },
  ];

  const out = [];
  for (const c of cases) {
    const userId = c.userId === null ? undefined : 'edge_user';
    const start = performance.now();
    let outcome;
    try {
      const { results } = await engine.add(c.messages, { userId });
      outcome = results.length === 0
        ? { outcome: 'empty result' }
        : { outcome: `stored ${results.length}`, stored: results.map((r) => r.text) };
    } catch (err) {
      outcome = { outcome: 'error', error: err.message };
    }
    const entry = {
      name: c.name,
      inputChars: typeof c.messages === 'string' ? c.messages.length : JSON.stringify(c.messages).length,
      ms: Math.round(performance.now() - start),
      ...outcome,
    };
    if (c.mustStore) {
      entry.check = { mustStore: String(c.mustStore), pass: (outcome.stored ?? []).some((t) => c.mustStore.test(t)) };
    }
    out.push(entry);
  }
  await engine.deleteAll({ userId: 'edge_user' });
  return out;
}

// ---- stale fact baseline --------------------------------------------------

async function staleFact(engine) {
  const userId = 'stale_user';
  const first = await engine.add([{ role: 'user', content: 'Main abhi Module 2 pe hoon' }], { userId });
  const second = await engine.add([{ role: 'user', content: 'Ab main Module 3 pe aa gaya hoon' }], { userId });
  const all = await engine.getAll({ userId });
  const searches = {};
  for (const q of ['which module is the student on?', 'main kaunse module pe hoon?']) {
    searches[q] = (await engine.search(q, { userId, limit: 3 })).results.map((r) => ({ text: r.text, score: r.score }));
  }
  return {
    added: [...first.results, ...second.results].map((r) => `${r.event} ${r.text}`),
    memoryCount: all.results.length,
    memories: all.results.map((r) => ({ text: r.text, category: r.category, createdAt: r.createdAt })),
    searches,
  };
}

// ---- main -------------------------------------------------------------------

async function main() {
  await dropEvalCollection();
  const store = createVectorStore({ collection: EVAL_COLLECTION });
  await store.ensureCollection();
  const engine = createMemoryEngine({ collection: EVAL_COLLECTION });

  console.log('=== Isolation at scale ===');
  const iso = await isolation(store);
  console.log(`  ${iso.users} users x ${iso.memoriesPerUser} memories, ${iso.queries} queries each (plain + category-filtered search, getAll)`);
  console.log(`  result ids checked: ${iso.resultIdsChecked}, leaks: ${iso.leaks}  ${iso.leaks === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  cross-user getById: ${iso.crossUserGetById.breaches}/${iso.crossUserGetById.attempts} breaches  ${iso.crossUserGetById.breaches === 0 ? 'PASS' : 'FAIL'}`);

  console.log('\n=== Edge inputs (engine.add, llm mode) ===');
  const edges = await edgeInputs(engine);
  for (const e of edges) {
    console.log(`  ${e.name}  [${e.inputChars} chars, ${e.ms} ms]`);
    console.log(`      -> ${e.outcome}${e.error ? `: ${e.error}` : ''}`);
    for (const s of e.stored ?? []) console.log(`         stored: ${s}`);
    if (e.check) console.log(`      ${e.check.pass ? 'PASS' : 'FAIL'}  must store a fact matching ${e.check.mustStore}`);
  }
  const edgeFailures = edges.filter((e) => e.check && !e.check.pass).length;

  console.log('\n=== Stale fact baseline (Module 2, then Module 3) ===');
  const stale = await staleFact(engine);
  stale.added.forEach((a) => console.log(`  ${a}`));
  console.log(`  memories for user: ${stale.memoryCount}`);
  for (const [q, rs] of Object.entries(stale.searches)) {
    console.log(`  Q: ${q}`);
    rs.forEach((r) => console.log(`      ${r.score.toFixed(3)}  ${r.text}`));
  }

  const file = await saveResult('robustness', { runAt: new Date().toISOString(), isolation: iso, edgeInputs: edges, staleFact: stale });
  console.log(`\nSaved to ${file}`);
  if (iso.leaks > 0 || iso.crossUserGetById.breaches > 0 || edgeFailures > 0) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  console.error('eval-robustness failed:', err.message);
  process.exitCode = 1;
} finally {
  await dropEvalCollection();
  console.log(`Collections after cleanup: ${JSON.stringify(await listCollections())}`);
}
