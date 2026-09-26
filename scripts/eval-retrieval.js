// Retrieval eval: seeds synthetic students directly into a scratch collection
// (bypassing extraction, so only retrieval is measured), then queries through
// MemoryEngine.search exactly as an app would.
import { readFile } from 'node:fs/promises';
import { EVAL_COLLECTION, dropEvalCollection, listCollections, round, saveResult, stats } from './eval-utils.js';
import { createMemoryEngine, createVectorStore, embedMany } from './runtime.js';

const CASES_URL = new URL('../tests/retrieval-cases.json', import.meta.url);

async function seed(students) {
  const store = createVectorStore({ collection: EVAL_COLLECTION });
  await store.ensureCollection();

  const flat = Object.entries(students).flatMap(([userId, mems]) =>
    Object.entries(mems).map(([key, m]) => ({ userId, key, ...m }))
  );
  const vectors = await embedMany(flat.map((m) => m.text));
  flat.forEach((m, i) => (m.vector = vectors[i]));

  const idToKey = new Map();
  for (const userId of Object.keys(students)) {
    const mine = flat.filter((m) => m.userId === userId);
    const ids = await store.addMemories(userId, mine.map(({ text, vector, category }) => ({ text, vector, category })));
    ids.forEach((id, i) => idToKey.set(id, mine[i].key));
  }
  return idToKey;
}

/** Threshold sweep over (query, memory) pairs: relevant pairs should be kept, irrelevant dropped. */
function sweepThresholds(relevant, irrelevant) {
  const rows = [];
  for (let t = 0.1; t <= 0.8001; t += 0.01) {
    const keptRel = relevant.filter((s) => s >= t).length / relevant.length;
    const droppedIrr = irrelevant.filter((s) => s < t).length / irrelevant.length;
    rows.push({ threshold: round(t, 2), keptRelevant: keptRel, droppedIrrelevant: droppedIrr, balanced: (keptRel + droppedIrr) / 2 });
  }
  const best = rows.reduce((a, b) => (b.balanced > a.balanced ? b : a));
  const safe = [...rows].reverse().find((r) => r.keptRelevant >= 0.95) ?? rows[0];
  return { rows, best, safe };
}

function histogram(values, lo = 0, hi = 0.8, step = 0.05) {
  const lines = [];
  for (let b = lo; b < hi - 1e-9; b += step) {
    const n = values.filter((v) => v >= b && v < b + step).length;
    lines.push(`${b.toFixed(2)}-${(b + step).toFixed(2)} | ${'#'.repeat(n)} ${n || ''}`);
  }
  return lines;
}

async function main() {
  const { students, queries } = JSON.parse(await readFile(CASES_URL, 'utf8'));
  await dropEvalCollection();
  const idToKey = await seed(students);
  const engine = createMemoryEngine({ collection: EVAL_COLLECTION });

  const perQuery = [];
  const relevantScores = [];
  const irrelevantScores = [];
  const topIrrelevantScores = [];

  for (const q of queries) {
    const size = Object.keys(students[q.userId]).length;
    // limit = all of the user's memories, so every memory gets a score.
    const { results } = await engine.search(q.query, { userId: q.userId, limit: size });
    const ranked = results.map((r) => ({ key: idToKey.get(r.id), text: r.text, score: r.score }));

    const rank = ranked.findIndex((r) => q.expected.includes(r.key)) + 1; // 0 = not found
    for (const r of ranked) (q.expected.includes(r.key) ? relevantScores : irrelevantScores).push(r.score);
    const firstIrrelevant = ranked.find((r) => !q.expected.includes(r.key));
    if (firstIrrelevant) topIrrelevantScores.push(firstIrrelevant.score);

    perQuery.push({ ...q, noneExpected: q.expected.length === 0, rank, top3: ranked.slice(0, 3) });
  }

  const withExpected = perQuery.filter((q) => !q.noneExpected);
  const noneQueries = perQuery.filter((q) => q.noneExpected);
  const top1 = withExpected.filter((q) => q.rank === 1).length / withExpected.length;
  const top3 = withExpected.filter((q) => q.rank >= 1 && q.rank <= 3).length / withExpected.length;
  const mrr = withExpected.reduce((s, q) => s + (q.rank ? 1 / q.rank : 0), 0) / withExpected.length;

  console.log(`Retrieval eval: ${Object.keys(students).length} students, ${idToKey.size} memories, ${queries.length} queries\n`);
  for (const q of perQuery) {
    const tag = q.noneExpected ? 'NONE' : q.rank === 1 ? 'TOP1' : q.rank && q.rank <= 3 ? 'TOP3' : `MISS(rank ${q.rank || '-'})`;
    console.log(`${tag.padEnd(12)} [${q.userId}] "${q.query}"  expected: ${q.expected.join(', ') || '(nothing)'}`);
    for (const r of q.top3) console.log(`      ${r.score.toFixed(3)}  ${q.expected.includes(r.key) ? '*' : ' '} ${r.text}`);
  }

  console.log(`\nTop-1 accuracy: ${(top1 * 100).toFixed(1)}%  (${withExpected.filter((q) => q.rank === 1).length}/${withExpected.length})`);
  console.log(`Top-3 accuracy: ${(top3 * 100).toFixed(1)}%`);
  console.log(`MRR:            ${mrr.toFixed(3)}`);
  console.log('\n"Nothing relevant" queries, highest score returned:');
  for (const q of noneQueries) console.log(`  ${q.top3[0].score.toFixed(3)}  "${q.query}"  -> ${q.top3[0].text}`);

  const rel = stats(relevantScores);
  const irr = stats(irrelevantScores);
  const topIrr = stats(topIrrelevantScores);
  console.log('\nScore distribution (query, memory) pairs:');
  console.log(`  relevant   n=${rel.n}  min=${rel.min.toFixed(3)} p50=${rel.p50.toFixed(3)} max=${rel.max.toFixed(3)}`);
  console.log(`  irrelevant n=${irr.n}  min=${irr.min.toFixed(3)} p50=${irr.p50.toFixed(3)} p95=${irr.p95.toFixed(3)} max=${irr.max.toFixed(3)}`);
  console.log(`  highest irrelevant per query: p50=${topIrr.p50.toFixed(3)} max=${topIrr.max.toFixed(3)}`);
  console.log('\n  relevant:');
  histogram(relevantScores).forEach((l) => console.log(`    ${l}`));
  console.log('  irrelevant:');
  histogram(irrelevantScores).forEach((l) => console.log(`    ${l}`));

  const sweep = sweepThresholds(relevantScores, irrelevantScores);
  console.log('\nThreshold sweep (not applied):');
  for (const r of sweep.rows.filter((r) => Math.round(r.threshold * 100) % 5 === 0)) {
    console.log(`  t=${r.threshold.toFixed(2)}  keeps ${(r.keptRelevant * 100).toFixed(0)}% relevant, drops ${(r.droppedIrrelevant * 100).toFixed(0)}% irrelevant`);
  }
  console.log(`  best balanced: t=${sweep.best.threshold} (keeps ${(sweep.best.keptRelevant * 100).toFixed(0)}% relevant, drops ${(sweep.best.droppedIrrelevant * 100).toFixed(0)}% irrelevant)`);
  console.log(`  highest t keeping >=95% relevant: t=${sweep.safe.threshold} (drops ${(sweep.safe.droppedIrrelevant * 100).toFixed(0)}% irrelevant)`);

  const file = await saveResult('retrieval', {
    runAt: new Date().toISOString(),
    summary: {
      top1: round(top1), top3: round(top3), mrr: round(mrr),
      noneQueryTopScores: noneQueries.map((q) => ({ query: q.query, topScore: round(q.top3[0].score), topText: q.top3[0].text })),
      relevantScores: rel, irrelevantScores: irr, highestIrrelevantPerQuery: topIrr,
      thresholdBestBalanced: sweep.best, thresholdSafe95: sweep.safe,
    },
    queries: perQuery,
    thresholdSweep: sweep.rows,
  });
  console.log(`\nSaved to ${file}`);
}

try {
  await main();
} catch (err) {
  console.error('eval-retrieval failed:', err.message);
  process.exitCode = 1;
} finally {
  await dropEvalCollection();
  console.log(`Collections after cleanup: ${JSON.stringify(await listCollections())}`);
}
