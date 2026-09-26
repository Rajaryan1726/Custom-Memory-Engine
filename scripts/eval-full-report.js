// Combines the latest eval runs in tests/results/ into one full-eval-<timestamp>.json,
// and computes run-to-run stability for the extraction evals.
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { RESULTS_DIR, round, saveResult } from './eval-utils.js';

const SRC_FILES = [
  'src/config/index.js',
  'src/llm/client.js',
  'src/llm/embed.js',
  'src/memory/extractor.js',
  'src/memory/MemoryEngine.js',
  'src/memory/prompts.js',
  'src/stores/vectorStore.js',
];

async function latest(prefixRegex, count) {
  const files = (await readdir(RESULTS_DIR)).filter((f) => prefixRegex.test(f)).sort();
  const picked = files.slice(-count);
  return Promise.all(
    picked.map(async (f) => ({ file: `tests/results/${f}`, data: JSON.parse(await readFile(new URL(f, RESULTS_DIR), 'utf8')) }))
  );
}

function caseStatus(c) {
  return !c.error && c.missed.length === 0 && c.unexpected.length === 0 && (c.forbiddenHits?.length ?? 0) === 0;
}

function stability(runs) {
  const precisions = runs.map((r) => r.data.summary.precision);
  const recalls = runs.map((r) => r.data.summary.recall);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const names = runs[0].data.cases.map((c) => c.name);
  const perCase = names.map((name) => {
    const byRun = runs.map((r) => r.data.cases.find((c) => c.name === name));
    const statuses = byRun.map(caseStatus);
    const outputs = byRun.map((c) => c.extracted.map((f) => `[${f.category}] ${f.text}`).sort().join(' | '));
    return {
      name,
      passes: statuses.filter(Boolean).length,
      runs: statuses.length,
      flaky: new Set(statuses).size > 1,
      outputChangedAcrossRuns: new Set(outputs).size > 1,
      outputs: [...new Set(outputs)],
    };
  });
  return {
    files: runs.map((r) => r.file),
    precision: { perRun: precisions.map((x) => round(x)), mean: round(mean(precisions)), spread: round(Math.max(...precisions) - Math.min(...precisions)) },
    recall: { perRun: recalls.map((x) => round(x)), mean: round(mean(recalls)), spread: round(Math.max(...recalls) - Math.min(...recalls)) },
    diffCases: perCase.filter((c) => c.passes < c.runs).map((c) => c.name),
    flakyCases: perCase.filter((c) => c.flaky).map((c) => c.name),
    outputChangedCases: perCase.filter((c) => c.outputChangedAcrossRuns).map((c) => ({ name: c.name, variants: c.outputs })),
  };
}

async function srcHashes() {
  const out = {};
  for (const f of SRC_FILES) {
    const buf = await readFile(new URL(`../${f}`, import.meta.url));
    out[f] = createHash('sha256').update(buf).digest('hex').slice(0, 12);
  }
  return out;
}

async function main() {
  const original = await latest(/^extraction-\d{4}-.*\.json$/, 3);
  const extended = await latest(/^extraction-extended-.*\.json$/, 3);
  const [retrieval] = await latest(/^retrieval-.*\.json$/, 1);
  const [robustness] = await latest(/^robustness-.*\.json$/, 1);
  const [perf] = await latest(/^perf-.*\.json$/, 1);

  const report = {
    generatedAt: new Date().toISOString(),
    codeUnderTest: {
      note: 'Phase 4 working tree, uncommitted at eval time (HEAD = phase 3 commit). Hashes identify the exact src/ files evaluated.',
      srcSha256Prefix: await srcHashes(),
    },
    extractionOriginal: { ...stability(original), lastRunCases: original.at(-1).data.cases },
    extractionExtended: {
      ...stability(extended),
      forbiddenPerRun: extended.map((r) => r.data.summary.forbiddenTotal),
      lastRunCases: extended.at(-1).data.cases,
    },
    retrieval: { file: retrieval.file, ...retrieval.data },
    robustness: { file: robustness.file, ...robustness.data },
    perf: { file: perf.file, ...perf.data },
  };

  const s = report;
  console.log('Extraction (original 12):');
  console.log(`  precision per run ${JSON.stringify(s.extractionOriginal.precision.perRun)} mean ${s.extractionOriginal.precision.mean} spread ${s.extractionOriginal.precision.spread}`);
  console.log(`  recall    per run ${JSON.stringify(s.extractionOriginal.recall.perRun)} mean ${s.extractionOriginal.recall.mean} spread ${s.extractionOriginal.recall.spread}`);
  console.log(`  DIFF cases: ${JSON.stringify(s.extractionOriginal.diffCases)}  flaky: ${JSON.stringify(s.extractionOriginal.flakyCases)}`);
  console.log(`  output text changed across runs: ${JSON.stringify(s.extractionOriginal.outputChangedCases.map((c) => c.name))}`);
  console.log('Extraction (extended):');
  console.log(`  precision per run ${JSON.stringify(s.extractionExtended.precision.perRun)} mean ${s.extractionExtended.precision.mean} spread ${s.extractionExtended.precision.spread}`);
  console.log(`  recall    per run ${JSON.stringify(s.extractionExtended.recall.perRun)} mean ${s.extractionExtended.recall.mean} spread ${s.extractionExtended.recall.spread}`);
  console.log(`  forbidden per run ${JSON.stringify(s.extractionExtended.forbiddenPerRun)}`);
  console.log(`  DIFF cases: ${JSON.stringify(s.extractionExtended.diffCases)}`);
  console.log(`  flaky: ${JSON.stringify(s.extractionExtended.flakyCases)}`);
  for (const c of s.extractionExtended.outputChangedCases) {
    console.log(`  output changed: ${c.name}`);
    c.variants.forEach((v) => console.log(`      ${v}`));
  }
  const file = await saveResult('full-eval', report);
  console.log(`\nSaved to ${file}`);
}

main().catch((err) => {
  console.error('eval-full-report failed:', err.message);
  process.exitCode = 1;
});
