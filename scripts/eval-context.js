// Context eval (Phase 6): runs getContext() over the retrieval cases and measures
// whether the expected memory reaches the tutor's context (profile + relevant).
import { readFile } from 'node:fs/promises';
import { embedMany } from '../src/llm/embed.js';
import { createMemoryEngine, formatContext } from '../src/memory/MemoryEngine.js';
import { createVectorStore } from '../src/stores/vectorStore.js';
import config from '../src/config/index.js';
import { EVAL_COLLECTION, dropEvalCollection, listCollections, saveResult, stats, timed } from './eval-utils.js';

const CASES_URL = new URL('../tests/retrieval-cases.json', import.meta.url);
const PHASE4 = { top1: 0.714, top3: 1.0 };
const pct = (x) => `${(x * 100).toFixed(1)}%`;

async function seed(students) {
  const store = createVectorStore({ collection: EVAL_COLLECTION });
  await store.ensureCollection();
  const flat = Object.entries(students).flatMap(([userId, mems]) =>
    Object.entries(mems).map(([key, m]) => ({ userId, key, ...m }))
  );
  const vectors = await embedMany(flat.map((m) => m.text));
  flat.forEach((m, i) => (m.vector = vectors[i]));

  const idToKey = new Map();
  const keyToCategory = new Map(flat.map((m) => [m.key, m.category]));
  for (const userId of Object.keys(students)) {
    const mine = flat.filter((m) => m.userId === userId);
    const ids = await store.addMemories(userId, mine.map(({ text, vector, category }) => ({ text, vector, category })));
    ids.forEach((id, i) => idToKey.set(id, mine[i].key));
  }
  return { idToKey, keyToCategory };
}

async function main() {
  const { students, queries } = JSON.parse(await readFile(CASES_URL, 'utf8'));
  await dropEvalCollection();
  const { idToKey, keyToCategory } = await seed(students);
  const engine = createMemoryEngine({ collection: EVAL_COLLECTION });
  await engine.getAll({ userId: 'warmup' }); // lazy ensureCollection outside the timings

  const rows = [];
  for (const q of queries) {
    const { value: ctx, ms } = await timed(() => engine.getContext(q.query, { userId: q.userId }));
    const profileKeys = ctx.profile.map((m) => idToKey.get(m.id));
    const relevantKeys = ctx.relevant.map((m) => idToKey.get(m.id));
    const inProfile = q.expected.some((k) => profileKeys.includes(k));
    const inRelevant = q.expected.some((k) => relevantKeys.includes(k));
    rows.push({
      ...q,
      ms,
      smallTalk: ctx.smallTalk,
      profileKeys,
      relevant: ctx.relevant.map((m) => ({ key: idToKey.get(m.id), text: m.text, score: m.score })),
      found: inProfile || inRelevant,
      foundIn: inProfile ? 'profile' : inRelevant ? 'relevant' : null,
      expectedCategories: q.expected.map((k) => keyToCategory.get(k)),
      contextChars: formatContext(ctx).length,
    });
  }

  const withExpected = rows.filter((r) => r.expected.length > 0);
  const none = rows.filter((r) => r.expected.length === 0);
  const recall = withExpected.filter((r) => r.found).length / withExpected.length;
  // Harder subset: expected memory lives in weak_topic/other, so only the vector search can find it.
  const searchOnly = withExpected.filter((r) => r.expectedCategories.every((c) => c === 'weak_topic' || c === 'other'));
  const searchOnlyRecall = searchOnly.length ? searchOnly.filter((r) => r.found).length / searchOnly.length : null;
  const noneInjected = none.map((r) => r.relevant.length);
  const gateFired = rows.filter((r) => r.smallTalk).length;
  const lat = stats(rows.map((r) => r.ms));
  const latSearch = stats(rows.filter((r) => !r.smallTalk).map((r) => r.ms));
  const latGated = stats(rows.filter((r) => r.smallTalk).map((r) => r.ms));
  const profileSize = stats(rows.map((r) => r.profileKeys.length));
  const chars = stats(rows.map((r) => r.contextChars));

  console.log(`Context eval: ${Object.keys(students).length} students, ${idToKey.size} memories, ${queries.length} queries, threshold ${config.memory.scoreThreshold}\n`);
  for (const r of rows) {
    const tag = r.expected.length === 0 ? `NONE (${r.relevant.length} injected)` : r.found ? `FOUND in ${r.foundIn}` : 'MISSED';
    console.log(`${tag.padEnd(22)} [${r.userId}] "${r.query}"${r.smallTalk ? '  [small-talk gate]' : ''}  expected: ${r.expected.join(', ') || '(nothing)'}`);
    for (const m of r.relevant) console.log(`        relevant ${m.score.toFixed(3)}  ${m.text}`);
  }

  console.log(`\nContext recall (expected memory in profile + relevant): ${pct(recall)} (${withExpected.filter((r) => r.found).length}/${withExpected.length})`);
  console.log(`  of which found in profile: ${withExpected.filter((r) => r.foundIn === 'profile').length}, in relevant: ${withExpected.filter((r) => r.foundIn === 'relevant').length}`);
  if (searchOnly.length) {
    console.log(`  search-only subset (expected in weak_topic/other): ${pct(searchOnlyRecall)} (${searchOnly.filter((r) => r.found).length}/${searchOnly.length})`);
  }
  console.log(`Nothing-relevant queries, relevant memories injected: ${JSON.stringify(noneInjected)}  (total ${noneInjected.reduce((a, b) => a + b, 0)})`);
  console.log(`Average profile size: ${profileSize.mean.toFixed(1)} (min ${profileSize.min}, max ${profileSize.max})`);
  console.log(`Small-talk gate fired: ${gateFired}/${rows.length} queries`);
  console.log(`Formatted context size: mean ${chars.mean.toFixed(0)} chars (max ${chars.max})`);
  console.log(`getContext latency: p50=${lat.p50.toFixed(0)}ms p95=${lat.p95.toFixed(0)}ms (with search: p50=${latSearch.p50.toFixed(0)}ms; gated: ${gateFired ? `p50=${latGated.p50.toFixed(0)}ms` : 'n/a'})`);
  console.log(`\nPhase 4 search() baseline on the same cases: top-1 ${pct(PHASE4.top1)}, top-3 ${pct(PHASE4.top3)}`);

  const file = await saveResult('context', {
    runAt: new Date().toISOString(),
    threshold: config.memory.scoreThreshold,
    summary: {
      contextRecall: recall,
      searchOnlyRecall,
      noneInjected,
      avgProfileSize: profileSize.mean,
      gateFired,
      queries: rows.length,
      latency: lat,
      latencyWithSearch: latSearch,
      latencyGated: latGated,
      contextChars: chars,
      phase4: PHASE4,
    },
    rows,
  });
  console.log(`Saved to ${file}`);
}

try {
  await main();
} catch (err) {
  console.error('eval-context failed:', err.message);
  process.exitCode = 1;
} finally {
  await dropEvalCollection();
  console.log(`Collections after cleanup: ${JSON.stringify(await listCollections())}`);
}
