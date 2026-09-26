import { mkdir, readFile, writeFile } from 'node:fs/promises';
import config from '../src/config/index.js';
import { extractFacts } from '../src/memory/extractor.js';

const CASES_URL = new URL('../tests/extraction-cases.json', import.meta.url);
const RESULTS_DIR = new URL('../tests/results/', import.meta.url);

function matches(fact, expected) {
  if (fact.category !== expected.category) return false;
  const text = fact.text.toLowerCase();
  return expected.mustInclude.every((kw) => text.includes(kw.toLowerCase()));
}

function describeExpected(e) {
  return `[${e.category}] must include ${e.mustInclude.map((k) => `"${k}"`).join(', ')}`;
}

function pct(num, den) {
  return den === 0 ? 'n/a' : `${((num / den) * 100).toFixed(1)}%`;
}

async function runCase(testCase) {
  try {
    const extracted = await extractFacts(testCase.messages);
    const missed = testCase.expected.filter((e) => !extracted.some((f) => matches(f, e)));
    const unexpected = extracted.filter((f) => !testCase.expected.some((e) => matches(f, e)));
    return { ...testCase, extracted, missed, unexpected, error: null };
  } catch (err) {
    // Count a failed call as extracting nothing, so it shows up as missed facts.
    return { ...testCase, extracted: [], missed: testCase.expected, unexpected: [], error: err.message };
  }
}

async function main() {
  const cases = JSON.parse(await readFile(CASES_URL, 'utf8'));
  console.log(`Running ${cases.length} extraction cases with ${config.openai.chatModel}...\n`);

  const results = await Promise.all(cases.map(runCase));

  let expectedTotal = 0;
  let expectedFound = 0;
  let extractedTotal = 0;
  let extractedMatched = 0;

  for (const r of results) {
    expectedTotal += r.expected.length;
    expectedFound += r.expected.length - r.missed.length;
    extractedTotal += r.extracted.length;
    extractedMatched += r.extracted.length - r.unexpected.length;

    const ok = !r.error && r.missed.length === 0 && r.unexpected.length === 0;
    console.log(`${ok ? 'OK  ' : 'DIFF'}  ${r.name}`);
    if (r.error) console.log(`      error: ${r.error}`);
    if (r.extracted.length === 0) console.log('      extracted: (none)');
    for (const f of r.extracted) console.log(`      extracted: [${f.category}] ${f.text}`);
    for (const e of r.missed) console.log(`      MISSED:     ${describeExpected(e)}`);
    for (const f of r.unexpected) console.log(`      UNEXPECTED: [${f.category}] ${f.text}`);
    console.log();
  }

  const precision = extractedTotal === 0 ? null : extractedMatched / extractedTotal;
  const recall = expectedTotal === 0 ? null : expectedFound / expectedTotal;
  console.log(`Precision: ${pct(extractedMatched, extractedTotal)}  (${extractedMatched}/${extractedTotal} extracted facts matched an expected fact)`);
  console.log(`Recall:    ${pct(expectedFound, expectedTotal)}  (${expectedFound}/${expectedTotal} expected facts found)`);

  const runAt = new Date().toISOString();
  await mkdir(RESULTS_DIR, { recursive: true });
  const fileName = `extraction-${runAt.replace(/[:.]/g, '-')}.json`;
  const report = {
    runAt,
    model: config.openai.chatModel,
    summary: { precision, recall, expectedFound, expectedTotal, extractedMatched, extractedTotal },
    cases: results,
  };
  await writeFile(new URL(fileName, RESULTS_DIR), JSON.stringify(report, null, 2));
  console.log(`\nSaved full run to tests/results/${fileName}`);
}

main().catch((err) => {
  console.error('eval-extraction failed:', err.message);
  process.exitCode = 1;
});
