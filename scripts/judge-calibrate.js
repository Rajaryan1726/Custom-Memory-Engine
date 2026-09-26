// Judge calibration: runs the judge on facts with fixed human labels and reports agreement.
// Run directly (npm run judge:calibrate) for per-item output, or import runCalibration().
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { saveResult } from './eval-utils.js';
import { judgeFact } from './judge.js';
import { config } from './runtime.js';

const CALIBRATION_URL = new URL('../tests/judge-calibration.json', import.meta.url);

export async function runCalibration() {
  const { items } = JSON.parse(await readFile(CALIBRATION_URL, 'utf8'));
  const results = await Promise.all(
    items.map(async (item) => {
      const { verdict, reason } = await judgeFact(item.messages, item.fact);
      return { id: item.id, fact: item.fact, label: item.label, why: item.why, verdict, reason, agree: verdict === item.label };
    })
  );
  const rate = (xs) => (xs.length === 0 ? null : xs.filter((r) => r.agree).length / xs.length);
  const wrongItems = results.filter((r) => r.label === 'wrong');
  const correctItems = results.filter((r) => r.label === 'correct');
  return {
    judgeModel: config.openai.judgeModel,
    agreement: rate(results),
    agreed: results.filter((r) => r.agree).length,
    total: results.length,
    wrongCaught: rate(wrongItems), // known-wrong facts the judge marked wrong
    correctKept: rate(correctItems), // known-correct facts the judge marked correct
    items: results,
  };
}

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

export function calibrationLine(c) {
  return (
    `Judge calibration (${c.judgeModel}): ${pct(c.agreement)} agreement (${c.agreed}/${c.total}); ` +
    `known-wrong caught ${pct(c.wrongCaught)}, known-correct kept ${pct(c.correctKept)}`
  );
}

async function main() {
  const c = await runCalibration();
  console.log(`Judge calibration, model ${c.judgeModel}\n`);
  for (const r of c.items) {
    const ended = r.fact.status === 'ended' ? ' (ENDED)' : '';
    console.log(`${r.agree ? 'AGREE   ' : 'DISAGREE'}  label=${r.label.padEnd(7)} judge=${r.verdict.padEnd(8)} [${r.fact.category}]${ended} ${r.fact.text}`);
    console.log(`          case: ${r.id}  (${r.why})`);
    console.log(`          judge reason: ${r.reason}`);
  }
  console.log(`\n${calibrationLine(c)}`);
  const file = await saveResult('judge-calibration', { runAt: new Date().toISOString(), ...c });
  console.log(`Saved to ${file}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('judge-calibrate failed:', err.message);
    process.exitCode = 1;
  });
}
