// Shared extraction-eval runner: keyword scoring + LLM judge scoring, side by side.
//
// Case fields:
//   expected:  facts that must be extracted (recall + precision)
//   allowed:   facts that are fine to extract but not required (ignored by precision and recall)
//   forbidden: facts that must NOT be extracted (reported as critical errors)
// Spec fields:
//   category:    a category, a list of acceptable categories, or "any"
//   mustInclude: keywords that must all appear (case-insensitive); an inner array means "any of",
//                e.g. [["ML", "Machine Learning"]]
//   status:      "active" (default) or "ended"; a fact only matches if its status matches too
import { readFile } from 'node:fs/promises';
import config from '../src/config/index.js';
import { extractFacts } from '../src/memory/extractor.js';
import { saveResult } from './eval-utils.js';
import { calibrationLine, runCalibration } from './judge-calibrate.js';
import { judgeFacts } from './judge.js';

function categoryMatches(actual, wanted) {
  if (wanted === 'any') return true;
  return Array.isArray(wanted) ? wanted.includes(actual) : actual === wanted;
}

export function matches(fact, spec) {
  if ((fact.status ?? 'active') !== (spec.status ?? 'active')) return false;
  if (!categoryMatches(fact.category, spec.category)) return false;
  const text = fact.text.toLowerCase();
  return spec.mustInclude.every((kw) =>
    (Array.isArray(kw) ? kw : [kw]).some((alt) => text.includes(alt.toLowerCase()))
  );
}

function describe(spec) {
  const cat = Array.isArray(spec.category) ? spec.category.join('|') : spec.category;
  const kws = spec.mustInclude.map((k) => (Array.isArray(k) ? `(${k.map((a) => `"${a}"`).join(' or ')})` : `"${k}"`));
  const status = spec.status && spec.status !== 'active' ? ` (status: ${spec.status})` : '';
  return `[${cat}]${status} must include ${kws.join(', ')}`;
}

const factLabel = (f) => `[${f.category}]${f.status === 'ended' ? ' (ENDED)' : ''} ${f.text}`;

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const ratio = (num, den) => (den === 0 ? null : num / den);

function scoreKeywords(c, extracted) {
  const allowed = c.allowed ?? [];
  const forbidden = c.forbidden ?? [];
  const missed = c.expected.filter((e) => !extracted.some((f) => matches(f, e)));
  const matchedExpected = extracted.filter((f) => c.expected.some((e) => matches(f, e)));
  const matchedAllowed = extracted.filter((f) => !matchedExpected.includes(f) && allowed.some((a) => matches(f, a)));
  const unexpected = extracted.filter((f) => !matchedExpected.includes(f) && !matchedAllowed.includes(f));
  const forbiddenHits = [];
  for (const spec of forbidden) {
    for (const f of extracted) if (matches(f, spec)) forbiddenHits.push({ fact: f, why: spec.why });
  }
  return { missed, matchedExpected, matchedAllowed, unexpected, forbiddenHits };
}

async function runCase(c) {
  let extracted = [];
  let error = null;
  try {
    extracted = await extractFacts(c.messages);
  } catch (err) {
    error = err.message;
  }
  const kw = scoreKeywords(c, extracted);

  let judge = null;
  let judgeError = null;
  if (!error) {
    try {
      judge = { facts: await judgeFacts(c.messages, extracted) };
    } catch (err) {
      judgeError = err.message;
    }
  }
  return { ...c, extracted, ...kw, error, judge, judgeError };
}

function printCase(r) {
  const kwOk = !r.error && r.missed.length === 0 && r.unexpected.length === 0 && r.forbiddenHits.length === 0;
  const judgeOk = r.judge && r.judge.facts.every((f) => f.verdict === 'correct');
  console.log(`${kwOk ? 'OK  ' : 'DIFF'} keyword | ${judgeOk ? 'OK   ' : 'ISSUE'} judge   ${r.name}${r.covers ? `   (${r.covers})` : ''}`);
  if (r.error) console.log(`      extraction error: ${r.error}`);
  if (r.judgeError) console.log(`      judge error: ${r.judgeError}`);
  if (r.extracted.length === 0) console.log('      extracted: (none)');
  r.extracted.forEach((f, i) => {
    const kwTag = r.matchedExpected.includes(f) ? 'expected' : r.matchedAllowed.includes(f) ? 'allowed ' : 'UNEXPECTED';
    const j = r.judge?.facts[i];
    const jTag = j ? (j.verdict === 'correct' ? 'correct' : `${j.verdict.toUpperCase()}: ${j.reason}`) : '-';
    console.log(`      extracted: ${factLabel(f)}`);
    console.log(`                 keyword: ${kwTag}   judge: ${jTag}`);
  });
  for (const e of r.missed) console.log(`      KEYWORD MISSED: ${describe(e)}`);
  for (const h of r.forbiddenHits) console.log(`      FORBIDDEN:      ${factLabel(h.fact)}  <- ${h.why}`);
  console.log();
}

function summarize(results) {
  let expectedTotal = 0, expectedFound = 0, scored = 0, scoredMatched = 0, forbiddenTotal = 0;
  let judged = 0, judgeCorrect = 0, judgeWrong = 0, judgeUnjudged = 0, judgeErrors = 0;
  for (const r of results) {
    expectedTotal += r.expected.length;
    expectedFound += r.expected.length - r.missed.length;
    scored += r.extracted.length - r.matchedAllowed.length;
    scoredMatched += r.matchedExpected.length;
    forbiddenTotal += r.forbiddenHits.length;
    if (r.judge) {
      judged += r.judge.facts.length;
      judgeCorrect += r.judge.facts.filter((f) => f.verdict === 'correct').length;
      judgeWrong += r.judge.facts.filter((f) => f.verdict === 'wrong').length;
      judgeUnjudged += r.judge.facts.filter((f) => f.verdict === 'unjudged').length;
    } else if (!r.error) {
      judgeErrors++;
    }
  }
  return {
    // keyword scores (field names kept from earlier runs for comparability)
    precision: ratio(scoredMatched, scored),
    recall: ratio(expectedFound, expectedTotal),
    expectedFound, expectedTotal, scoredMatched, scored, forbiddenTotal,
    judge: {
      model: config.openai.judgeModel,
      precision: ratio(judgeCorrect, judged),
      correct: judgeCorrect, wrong: judgeWrong, unjudged: judgeUnjudged, extracted: judged, errors: judgeErrors,
    },
  };
}

/**
 * Runs an extraction eval over a cases file and prints keyword vs judge scores.
 * Returns { results, summary, file }.
 */
export async function runExtractionEval({ casesUrl, label, resultPrefix }) {
  const calibration = await runCalibration();
  console.log(calibrationLine(calibration));
  for (const r of calibration.items.filter((i) => !i.agree)) {
    console.log(`  disagrees on: label=${r.label} judge=${r.verdict}  [${r.fact.category}] ${r.fact.text}`);
  }

  const cases = JSON.parse(await readFile(casesUrl, 'utf8'));
  console.log(`\nRunning ${cases.length} ${label} extraction cases. Extractor: ${config.openai.chatModel}, judge: ${config.openai.judgeModel}\n`);

  const results = await Promise.all(cases.map(runCase));
  results.forEach(printCase);

  const s = summarize(results);
  console.log(`Scores (${label}):`);
  console.log('                 keyword                 judge');
  console.log(`  precision      ${pct(s.precision).padEnd(8)}(${s.scoredMatched}/${s.scored})        ${pct(s.judge.precision).padEnd(8)}(${s.judge.correct}/${s.judge.extracted} correct)`);
  console.log(`  recall         ${pct(s.recall).padEnd(8)}(${s.expectedFound}/${s.expectedTotal})        (keyword only)`);
  console.log(`  forbidden      ${s.forbiddenTotal}`);
  if (s.judge.unjudged || s.judge.errors) console.log(`  judge unjudged facts: ${s.judge.unjudged}, judge errors: ${s.judge.errors}`);
  console.log(calibrationLine(calibration));

  const file = await saveResult(resultPrefix, {
    runAt: new Date().toISOString(),
    model: config.openai.chatModel,
    judgeModel: config.openai.judgeModel,
    summary: s,
    judgeCalibration: calibration,
    cases: results,
  });
  console.log(`\nSaved full run to ${file}`);
  return { results, summary: s, file };
}
