// Integration eval for the AutoWiki findings: skill-level updates, cross-category duplicates
// and context-only messages. Each case runs INTEGRATION_RUNS times (default 5) on fresh users.
// The count comes from an env var because PowerShell drops "--" in "npm run x -- --flag".
import { QdrantClient } from '@qdrant/js-client-rest';
import { listCollections, saveResult } from './eval-utils.js';
import { config, createMemoryEngine, createVectorStore, embed } from './runtime.js';

const COLLECTION = 'custom_user_memories_integration_eval';
const RUNS = Number.parseInt(process.env.INTEGRATION_RUNS ?? '5', 10);
if (!Number.isInteger(RUNS) || RUNS < 1) throw new Error(`INTEGRATION_RUNS must be a positive integer, got "${process.env.INTEGRATION_RUNS}"`);

const client = new QdrantClient({ ...config.qdrant, checkCompatibility: false });
async function dropCollection() {
  const { exists } = await client.collectionExists(COLLECTION);
  if (exists) await client.deleteCollection(COLLECTION);
}

const engine = createMemoryEngine({ collection: COLLECTION });
const store = createVectorStore({ collection: COLLECTION });
const RUN = `i${Date.now().toString(36)}`;
const user = (name, rep) => `${RUN}_${name}_${rep}`;
const say = (content) => [{ role: 'user', content }];
const TS = /typescript/i;
const fmtEvents = (results) => results.map((r) => `${r.event} "${r.text}"${r.previousText ? ` (was "${r.previousText}")` : ''}`).join(' | ') || '(none)';
const fmtMems = (mems) => mems.map((m) => `[${m.category}] ${m.text}`).join(' | ') || '(none)';

const CASES = [
  {
    name: 'skill-level update (TypeScript beginner -> comfortable)',
    async run(rep) {
      const u = user('skill', rep);
      const first = await engine.add(say("I'm a beginner with TypeScript"), { userId: u });
      const firstTs = first.results.find((r) => TS.test(r.text));
      const second = await engine.add(say("Actually I'm comfortable with TypeScript now"), { userId: u });
      const mems = (await engine.getAll({ userId: u })).results;
      const ts = mems.filter((m) => TS.test(m.text));
      const updatedSameId = second.results.some((r) => r.event === 'UPDATE' && r.id === firstTs?.id);
      const pass = Boolean(firstTs) && updatedSameId && ts.length === 1 && /comfortable/i.test(ts[0].text);
      return { pass, updatedSameId, detail: [`add 1: ${fmtEvents(first.results)}`, `add 2: ${fmtEvents(second.results)}`, `final: ${fmtMems(mems)}`] };
    },
  },
  {
    // The old memory is seeded under [other] (as an older extractor version could store it), so
    // the new [identity] fact can only find it through the cross-category candidate search.
    name: 'cross-category duplicate (old [other] memory, new [identity] fact)',
    async run(rep) {
      const u = user('cross', rep);
      const oldText = 'User finds TypeScript hard and is just starting with it';
      const [oldId] = await store.addMemories(u, [{ text: oldText, vector: await embed(oldText), category: 'other' }]);
      const res = await engine.add(say("Actually I'm comfortable with TypeScript now"), { userId: u });
      const mems = (await engine.getAll({ userId: u })).results;
      const ts = mems.filter((m) => TS.test(m.text));
      const touchedOld = res.results.some((r) => (r.event === 'UPDATE' || r.event === 'DELETE') && r.id === oldId);
      const pass = touchedOld && ts.length === 1 && /comfortable/i.test(ts[0].text);
      return { pass, detail: [`seeded [other] "${oldText}"`, `add: ${fmtEvents(res.results)}`, `final: ${fmtMems(mems)}`] };
    },
  },
  {
    name: 'context-only messages are not re-extracted (contextMessages option)',
    async run(rep) {
      const u = user('ctx', rep);
      const turn1 = [{ role: 'user', content: "Hi, I'm Arjun and I'm learning Rust" }, { role: 'assistant', content: 'Nice! What are you building?' }];
      await engine.add(turn1, { userId: u });
      const before = (await engine.getAll({ userId: u })).results;
      // Turn 1 again as context, plus a new message with no new fact about the user.
      const res = await engine.add(say('a CLI tool, abhi bas basics'), { userId: u, contextMessages: turn1 });
      const after = (await engine.getAll({ userId: u })).results;
      // Context also carries a fact that was never stored: it must not appear now.
      const res2 = await engine.add(say('ok thanks'), {
        userId: u,
        contextMessages: [{ role: 'user', content: 'I also know Go really well' }],
      });
      const final = (await engine.getAll({ userId: u })).results;
      // A re-extraction is any result (NOOP included) that repeats a context fact. New information
      // from the new message itself ("abhi bas basics" -> studying the basics of Rust) is allowed.
      const reExtracted = res.results.filter((r) => /arjun|\blearning rust\b/i.test(r.text));
      const fromContext = final.filter((m) => /\bgo\b/i.test(m.text));
      const pass = reExtracted.length === 0 && fromContext.length === 0 && res2.results.length === 0;
      return {
        pass,
        detail: [
          `turn 1 stored: ${fmtMems(before)}`,
          `turn 2 (turn 1 as context): ${fmtEvents(res.results)}`,
          `turn 3 (unseen fact only in context): ${fmtEvents(res2.results)}`,
          `final: ${fmtMems(final)}`,
        ],
      };
    },
  },
  {
    name: 'context-only messages are not re-extracted (per-message context flag)',
    async run(rep) {
      const u = user('flag', rep);
      const res = await engine.add(
        [
          { role: 'user', content: "My name is Meera and I'm a beginner with Docker", context: true },
          { role: 'assistant', content: 'Got it!', context: true },
          { role: 'user', content: 'thanks' },
        ],
        { userId: u }
      );
      const mems = (await engine.getAll({ userId: u })).results;
      const pass = res.results.length === 0 && mems.length === 0;
      return { pass, detail: [`add: ${fmtEvents(res.results)}`, `final: ${fmtMems(mems)}`] };
    },
  },
];

async function main() {
  await dropCollection();
  const summary = [];
  for (const c of CASES) {
    const runs = [];
    for (let rep = 1; rep <= RUNS; rep++) {
      let outcome;
      try {
        outcome = await c.run(rep);
      } catch (err) {
        outcome = { pass: false, detail: [`ERROR: ${err.message}`] };
      }
      runs.push(outcome);
      console.log(`${outcome.pass ? 'PASS' : 'FAIL'}  run ${rep}  ${c.name}`);
      for (const d of outcome.detail) console.log(`        ${d}`);
    }
    summary.push({ name: c.name, passed: runs.filter((r) => r.pass).length, runs: RUNS, details: runs });
  }
  console.log('\nSummary:');
  for (const s of summary) console.log(`  ${s.passed}/${s.runs}  ${s.name}`);
  const file = await saveResult('integration', { runAt: new Date().toISOString(), runs: RUNS, cases: summary });
  console.log(`\nSaved to ${file}`);
  if (summary.some((s) => s.passed < s.runs)) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  console.error('eval-integration failed:', err.message);
  process.exitCode = 1;
} finally {
  await dropCollection();
  console.log(`Collections after cleanup: ${JSON.stringify(await listCollections())}`);
}
