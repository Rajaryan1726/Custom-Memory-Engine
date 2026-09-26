// Extraction eval for tests/extraction-cases-extended.json.
// Same scoring as eval-extraction.js, plus two optional case fields:
//   forbidden: facts that must NOT be extracted (reported as critical errors)
//   optional:  facts that are acceptable but not required (ignored by precision and recall)
// and `category` may be a string, a list of acceptable categories, or "any".
import { readFile } from 'node:fs/promises';
import config from '../src/config/index.js';
import { extractFacts } from '../src/memory/extractor.js';
import { saveResult } from './eval-utils.js';

const CASES_URL = new URL('../tests/extraction-cases-extended.json', import.meta.url);

function categoryMatches(actual, wanted) {
  if (wanted === 'any') return true;
  return Array.isArray(wanted) ? wanted.includes(actual) : actual === wanted;
}

function matches(fact, spec) {
  if (!categoryMatches(fact.category, spec.category)) return false;
  const text = fact.text.toLowerCase();
  return spec.mustInclude.every((kw) => text.includes(kw.toLowerCase()));
}

function describe(spec) {
  const cat = Array.isArray(spec.category) ? spec.category.join('|') : spec.category;
  return `[${cat}] must include ${spec.mustInclude.map((k) => `"${k}"`).join(', ')}`;
}

const pct = (num, den) => (den === 0 ? 'n/a' : `${((num / den) * 100).toFixed(1)}%`);

async function runCase(c) {
  const optional = c.optional ?? [];
  const forbidden = c.forbidden ?? [];
  let extracted = [];
  let error = null;
  try {
    extracted = await extractFacts(c.messages);
  } catch (err) {
    error = err.message;
  }
  const missed = c.expected.filter((e) => !extracted.some((f) => matches(f, e)));
  const matchedExpected = extracted.filter((f) => c.expected.some((e) => matches(f, e)));
  const matchedOptional = extracted.filter(
    (f) => !matchedExpected.includes(f) && optional.some((o) => matches(f, o))
  );
  const unexpected = extracted.filter(
    (f) => !matchedExpected.includes(f) && !matchedOptional.includes(f)
  );
  const forbiddenHits = [];
  for (const spec of forbidden) {
    for (const f of extracted) if (matches(f, spec)) forbiddenHits.push({ fact: f, why: spec.why });
  }
  return { ...c, extracted, missed, matchedOptional, unexpected, forbiddenHits, error };
}

async function main() {
  const cases = JSON.parse(await readFile(CASES_URL, 'utf8'));
  console.log(`Running ${cases.length} EXTENDED extraction cases with ${config.openai.chatModel}...\n`);
  const results = await Promise.all(cases.map(runCase));

  let expectedTotal = 0, expectedFound = 0, scored = 0, scoredMatched = 0, forbiddenTotal = 0;
  for (const r of results) {
    expectedTotal += r.expected.length;
    expectedFound += r.expected.length - r.missed.length;
    const matchedExpectedCount = r.extracted.length - r.matchedOptional.length - r.unexpected.length;
    scored += r.extracted.length - r.matchedOptional.length;
    scoredMatched += matchedExpectedCount;
    forbiddenTotal += r.forbiddenHits.length;

    const ok = !r.error && r.missed.length === 0 && r.unexpected.length === 0 && r.forbiddenHits.length === 0;
    console.log(`${ok ? 'OK  ' : 'DIFF'}  ${r.name}   (${r.covers})`);
    if (r.error) console.log(`      error: ${r.error}`);
    if (r.extracted.length === 0) console.log('      extracted: (none)');
    for (const f of r.extracted) console.log(`      extracted: [${f.category}] ${f.text}`);
    for (const e of r.missed) console.log(`      MISSED:     ${describe(e)}`);
    for (const f of r.unexpected) console.log(`      UNEXPECTED: [${f.category}] ${f.text}`);
    for (const h of r.forbiddenHits) console.log(`      FORBIDDEN:  [${h.fact.category}] ${h.fact.text}  <- ${h.why}`);
    console.log();
  }

  const precision = scored === 0 ? null : scoredMatched / scored;
  const recall = expectedTotal === 0 ? null : expectedFound / expectedTotal;
  console.log(`Precision: ${pct(scoredMatched, scored)}  (${scoredMatched}/${scored} scored facts matched an expected fact; optional matches excluded)`);
  console.log(`Recall:    ${pct(expectedFound, expectedTotal)}  (${expectedFound}/${expectedTotal} expected facts found)`);
  console.log(`Forbidden facts extracted: ${forbiddenTotal}`);

  const file = await saveResult('extraction-extended', {
    runAt: new Date().toISOString(),
    model: config.openai.chatModel,
    summary: { precision, recall, expectedFound, expectedTotal, scoredMatched, scored, forbiddenTotal },
    cases: results,
  });
  console.log(`\nSaved full run to ${file}`);
}

main().catch((err) => {
  console.error('eval-extraction-extended failed:', err.message);
  process.exitCode = 1;
});
