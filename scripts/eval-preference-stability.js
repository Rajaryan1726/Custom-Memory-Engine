// Repeats extractFacts on the update-eval 9a / 9b follow-up messages (exactly what add()
// passes) and counts how often a preference fact comes back.
// Counts come from env vars because PowerShell drops "--" in "npm run x -- --flag":
//   PREF_ONE_OFF_RUNS  (default 20): 9a one-off message, target 0 preferences
//   PREF_STANDING_RUNS (default 10): 9b standing message, target all preferences
import { saveResult } from './eval-utils.js';
import { extractFacts } from './runtime.js';

function runsFrom(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got "${process.env[name]}"`);
  return n;
}

const CASES = [
  {
    name: '9a one-off',
    messages: [{ role: 'user', content: 'isko detail mein samjhao' }],
    runs: runsFrom('PREF_ONE_OFF_RUNS', 20),
    wantPreference: false,
  },
  {
    name: '9b standing',
    messages: [{ role: 'user', content: 'short se samajh nahi aata, hamesha detail mein samjhaya karo' }],
    runs: runsFrom('PREF_STANDING_RUNS', 10),
    wantPreference: true,
  },
];

const fmt = (facts) => (facts.length ? facts.map((f) => `[${f.category}] (${f.status}) ${f.text}`).join(' | ') : '(none)');

async function main() {
  const summary = [];
  for (const c of CASES) {
    console.log(`${c.name}: ${JSON.stringify(c.messages)} x ${c.runs}`);
    const outputs = [];
    for (let i = 1; i <= c.runs; i++) {
      const facts = await extractFacts(c.messages);
      const hasPreference = facts.some((f) => f.category === 'preference' && f.status === 'active');
      outputs.push({ facts, hasPreference });
      console.log(`  ${String(i).padStart(2)}: ${hasPreference ? 'PREFERENCE   ' : 'no preference'}  ${fmt(facts)}`);
    }
    const count = outputs.filter((o) => o.hasPreference).length;
    const target = c.wantPreference ? c.runs : 0;
    const pass = count === target;
    summary.push({ name: c.name, runs: c.runs, preferences: count, target, pass, outputs });
    console.log(`  => preference in ${count}/${c.runs} (target ${target}/${c.runs})  ${pass ? 'PASS' : 'MISS'}\n`);
  }
  const file = await saveResult('pref-stability', { runAt: new Date().toISOString(), cases: summary });
  console.log(`Saved to ${file}`);
}

main().catch((err) => {
  console.error('eval-preference-stability failed:', err.message);
  process.exitCode = 1;
});
