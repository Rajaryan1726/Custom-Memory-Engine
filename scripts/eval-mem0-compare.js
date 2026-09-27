// Phase 7c-1: head-to-head eval of this engine vs hosted Mem0 (mem0ai MemoryClient) through
// ONE provider-neutral harness. Both providers get exactly the same inputs, the same neutral
// judge (scripts/neutral-judge.js) and the same scoring; the judge never learns which
// provider produced a memory.
//
//   npm run eval:mem0-compare
// Env (PowerShell-friendly, no "--" flags):
//   COMPARE_RUNS=2            full runs (default 2)
//   COMPARE_PROVIDERS=engine,mem0   (also: mem0-latest = Mem0 read with latestOnly: true)
//   COMPARE_CASE_LIMIT=N      only the first N extraction cases (smoke tests)
//   COMPARE_SCENARIOS=1,13    only these update scenarios (smoke tests)
//   COMPARE_SET=tuned|heldout tuned (default) = the 7c-1 data; heldout = tests/heldout/heldout-cases.json
//                             (read-only here: extraction cases + multi-session scenarios)
//
// Every test userId starts with "m0eval_". At the end every such user is deleted from both
// providers and the script proves none is left (Mem0 entity list, engine getAll + collection).
import { readFile } from 'node:fs/promises';
import { CASE_CLAIMS, SEARCH_LATENCY_QUERY, UPDATE_SCENARIOS } from './compare-data.js';
import { saveResult, stats, timed } from './eval-utils.js';
import { checkAssertion, checkMemory, checkScenario, NEUTRAL_JUDGE_MODEL } from './neutral-judge.js';
import { createEngineProvider } from './providers/engineProvider.js';
import { createMem0Provider } from './providers/mem0Provider.js';
import { config, createQdrantClient } from './runtime.js';

const PREFIX = 'm0eval_';
const TAG = Date.now().toString(36);
const ENGINE_COLLECTION = 'm0eval_engine_compare';
const CONCURRENCY = 3; // same for both providers: scenarios and extraction cases in flight at once
const SEARCH_LIMIT = 5;

const RUNS = Number.parseInt(process.env.COMPARE_RUNS ?? '2', 10);
if (!Number.isInteger(RUNS) || RUNS < 1) throw new Error(`COMPARE_RUNS must be a positive integer, got "${process.env.COMPARE_RUNS}"`);
const PROVIDERS = (process.env.COMPARE_PROVIDERS ?? 'engine,mem0').split(',').map((x) => x.trim()).filter(Boolean);
const CASE_LIMIT = process.env.COMPARE_CASE_LIMIT ? Number.parseInt(process.env.COMPARE_CASE_LIMIT, 10) : Infinity;
const ONLY_SCENARIOS = process.env.COMPARE_SCENARIOS ? process.env.COMPARE_SCENARIOS.split(',').map((x) => x.trim()) : null;

const SET = process.env.COMPARE_SET ?? 'tuned';
if (!['tuned', 'heldout'].includes(SET)) throw new Error(`COMPARE_SET must be "tuned" or "heldout", got "${SET}"`);
const readJson = async (file) => JSON.parse(await readFile(new URL(`../tests/${file}`, import.meta.url), 'utf8'));
const loadCases = async (file, suite) => (await readJson(file)).map((c) => ({ ...c, suite }));

/**
 * Held-out file -> the harness's own shapes. Extraction case: one add of `messages`;
 * expectedFacts[].keywords has the same shape as mustInclude (each inner array = any-of);
 * forbidden / allowed are plain-English claims for the assertion judge. Scenario: each
 * `sessions` entry is one add() for the same user, in order, then getAll vs expectedState.
 */
async function loadHeldout() {
  const data = await readJson('heldout/heldout-cases.json');
  const cases = data.extraction.map((c) => ({
    name: c.id,
    suite: 'heldout',
    messages: c.messages,
    expected: c.expectedFacts.map((f) => ({ claim: f.claim, mustInclude: f.keywords })),
    claims: { forbidden: c.forbidden ?? [], allowed: c.allowed ?? [] },
  }));
  const scenarios = data.scenarios.map((sc) => ({
    id: sc.id,
    name: sc.id,
    steps: sc.sessions.map((messages) => ({ say: messages })),
    checks: [{ as: 'a', expected: sc.expectedState }],
  }));
  return { cases, scenarios };
}

const DATA =
  SET === 'heldout'
    ? await loadHeldout()
    : {
        cases: [...(await loadCases('extraction-cases.json', 'original')), ...(await loadCases('extraction-cases-extended.json', 'extended'))],
        scenarios: UPDATE_SCENARIOS,
      };
const CASES = DATA.cases.slice(0, CASE_LIMIT);
const SCENARIOS = DATA.scenarios.filter((s) => !ONLY_SCENARIOS || ONLY_SCENARIOS.includes(s.id));

// ---- helpers --------------------------------------------------------------------
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

const toMessages = (say) => (typeof say === 'string' ? [{ role: 'user', content: say }] : say);
const shown = (say) => (typeof say === 'string' ? say : say.map((m) => `${m.role}: ${m.content}`).join(' / '));

/** Keyword match on memory text only (category and status are ignored). */
function keywordMatch(text, spec) {
  const t = text.toLowerCase();
  return spec.mustInclude.every((kw) => (Array.isArray(kw) ? kw : [kw]).some((alt) => t.includes(alt.toLowerCase())));
}

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const ratio = (a, b) => (b === 0 ? null : a / b);
const ms = (x) => (x === undefined || x === null ? 'n/a' : `${Math.round(x)} ms`);
const oneLine = (s, n = 220) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}… (${t.length} chars)` : t;
};

// ---- collect: run the inputs through one provider ----------------------------------
async function collect(provider, run, used) {
  const lat = { add: [], search: [] };
  const uid = (key) => {
    const id = `${PREFIX}${TAG}_r${run}_${provider.name}_${key}`;
    used.add(id);
    return id;
  };

  async function timedAdd(say, userId) {
    const { value, ms: t } = await timed(() => provider.add(toMessages(say), { userId }));
    lat.add.push(t);
    return { input: shown(say), events: value.events, ms: t };
  }

  async function runScenario(sc) {
    const ref = (key) => (key.includes(':') ? uid(`s${key.split(':')[0]}_${key.split(':')[1]}`) : uid(`s${sc.id}_${key}`));
    const adds = [];
    const checks = [];
    let error = null;
    try {
      for (const step of sc.steps) {
        if (step.deleteAll) {
          await provider.deleteAll({ userId: ref(step.deleteAll) });
          adds.push({ input: `deleteAll(${step.deleteAll})`, events: [] });
        } else if (step.parallel) {
          adds.push(...(await Promise.all(step.parallel.map((say) => timedAdd(say, ref('a'))))));
        } else {
          adds.push({ as: step.as ?? 'a', ...(await timedAdd(step.say, ref(step.as ?? 'a'))) });
        }
      }
      for (const c of sc.checks) {
        if (c.search) {
          const { value, ms: t } = await timed(() => provider.search(c.search.query, { userId: ref(c.search.as), limit: c.search.limit }));
          lat.search.push(t);
          checks.push({ user: c.search.as, search: c.search.query, label: 'Search results in rank order (1 = first result)', expected: c.expected, memories: value });
        } else {
          checks.push({ user: c.as, label: 'Memories about the student', expected: c.expected, memories: await provider.getAll({ userId: ref(c.as) }) });
        }
      }
    } catch (err) {
      error = err.message;
    }
    return { id: sc.id, name: sc.name, extra: Boolean(sc.extra), adds, checks, error };
  }

  // Scenario 13 reads scenario 1's user, so it runs after the others, and only if scenario 1
  // finished without error (otherwise a Mem0 write of scenario 1 may still be running).
  const first = SCENARIOS.filter((s) => s.id !== '13');
  const later = SCENARIOS.filter((s) => s.id === '13');
  const done = await pool(first, CONCURRENCY, runScenario);
  const s1 = done.find((s) => s.id === '1');
  const skip13 = (sc) => ({ id: sc.id, name: sc.name, extra: Boolean(sc.extra), adds: [], checks: [], error: `skipped: scenario 1 failed (${s1?.error ?? 'not run'})` });
  const scenarios = [...done, ...(await pool(later, 1, (sc) => (s1 && !s1.error ? runScenario(sc) : skip13(sc))))];

  const cases = await pool(CASES, CONCURRENCY, async (c, i) => {
    const userId = uid(`x${i}`);
    let memories = [];
    let error = null;
    try {
      await timedAdd(c.messages, userId);
      memories = await provider.getAll({ userId });
      const { ms: t } = await timed(() => provider.search(SEARCH_LATENCY_QUERY, { userId, limit: SEARCH_LIMIT }));
      lat.search.push(t);
    } catch (err) {
      error = err.message;
    }
    return { name: c.name, suite: c.suite, memories, error };
  });

  return { scenarios, cases, latency: { add: lat.add, search: lat.search } };
}

// ---- judge + score ----------------------------------------------------------------
async function judgeRun(collected) {
  const scenarios = await Promise.all(
    collected.scenarios.map(async (s) => {
      const checks = await Promise.all(
        s.checks.map(async (c) => ({ ...c, ...(await checkScenario(c.memories, c.expected, { label: c.label })) }))
      );
      const pass = !s.error && checks.length > 0 && checks.every((c) => c.verdict === 'pass');
      return { ...s, checks, pass };
    })
  );

  const cases = await Promise.all(
    collected.cases.map(async (r, i) => {
      const c = CASES[i];
      const judged = await Promise.all(r.memories.map(async (m) => ({ text: m, ...(await checkMemory(c.messages, m)) })));
      const expectedActive = c.expected.filter((e) => (e.status ?? 'active') === 'active');
      const found = expectedActive.map((e) => ({ spec: e.mustInclude, found: r.memories.some((m) => keywordMatch(m, e)) }));

      const claims = c.claims ?? CASE_CLAIMS[c.name] ?? {};
      const cache = new Map();
      const assert = (m, claim) => {
        const key = `${claim}\u0000${m}`;
        if (!cache.has(key)) cache.set(key, checkAssertion(m, claim));
        return cache.get(key);
      };
      const scoreClaims = async (list = []) =>
        Promise.all(
          list.map(async (claim) => {
            const hits = [];
            for (const m of r.memories) {
              const a = await assert(m, claim);
              if (a.asserts) hits.push({ text: m, reason: a.reason });
            }
            return { claim, hits };
          })
        );
      // Memories that state an "allowed" fact neither help nor hurt precision (held-out set only).
      const allowed = await scoreClaims(claims.allowed);
      const allowedTexts = new Set(allowed.flatMap((a) => a.hits.map((h) => h.text)));
      for (const m of judged) if (allowedTexts.has(m.text)) m.allowed = true;
      return {
        ...r,
        judged,
        allowed,
        recall: found,
        ended: await scoreClaims(claims.ended),
        forbidden: await scoreClaims(claims.forbidden),
        skipped: claims.skipped ?? [],
      };
    })
  );
  return { scenarios, cases, latency: collected.latency };
}

function summarize(j) {
  const core = j.scenarios.filter((s) => !s.extra);
  const extra = j.scenarios.filter((s) => s.extra);
  const bySuite = (suite) => {
    const cs = suite ? j.cases.filter((c) => c.suite === suite) : j.cases;
    const all = cs.flatMap((c) => c.judged);
    const mems = all.filter((m) => !m.allowed); // precision ignores memories that state an allowed fact
    const exp = cs.flatMap((c) => c.recall);
    return {
      cases: cs.length,
      memories: mems.length,
      allowedExcluded: all.length - mems.length,
      correct: mems.filter((m) => m.verdict === 'correct').length,
      unjudged: mems.filter((m) => m.verdict === 'unjudged').length,
      precision: ratio(mems.filter((m) => m.verdict === 'correct').length, mems.length),
      expectedFound: exp.filter((e) => e.found).length,
      expectedTotal: exp.length,
      recall: ratio(exp.filter((e) => e.found).length, exp.length),
      endedAsserted: cs.flatMap((c) => c.ended).reduce((n, x) => n + x.hits.length, 0),
      endedClaims: cs.flatMap((c) => c.ended).length,
      forbiddenAsserted: cs.flatMap((c) => c.forbidden).reduce((n, x) => n + x.hits.length, 0),
      forbiddenClaims: cs.flatMap((c) => c.forbidden).length,
      avgMemories: ratio(all.length, cs.length),
      errors: cs.filter((c) => c.error).length,
    };
  };
  return {
    scenariosPassed: core.filter((s) => s.pass).length,
    scenariosTotal: core.length,
    extraPassed: extra.filter((s) => s.pass).length,
    extraTotal: extra.length,
    scenarioErrors: j.scenarios.filter((s) => s.error).length,
    extraction: { all: bySuite(null), original: bySuite('original'), extended: bySuite('extended') },
    addLatency: stats(j.latency.add),
    searchLatency: stats(j.latency.search),
  };
}

// ---- cleanup + proof -----------------------------------------------------------------
async function cleanup(providers, used) {
  const proof = {};
  for (const p of providers) {
    const ids = [...used[p.name]];
    const failed = [];
    // Mem0 writes that timed out may still land; wait for them before deleting anything.
    const settled = p.settlePending ? await p.settlePending() : [];
    // Mem0: a second deleteAll on an already deleted user leaves its event PENDING for good,
    // so only users still listed as entities are deleted; the rest are checked by count below.
    const listed = p.listUsers ? new Set(await p.listUsers(PREFIX)) : null;
    const toDelete = listed ? ids.filter((id) => listed.has(id)) : ids;
    const notListed = listed ? ids.filter((id) => !listed.has(id)) : [];
    await pool(toDelete, CONCURRENCY, async (userId) => {
      try {
        await p.deleteAll({ userId });
      } catch (err) {
        failed.push({ userId, error: err.message });
      }
    });
    if (p.listUsers) {
      let left = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        left = await p.listUsers(PREFIX);
        if (left.length === 0) break;
        await pool(left, CONCURRENCY, (userId) => p.deleteAll({ userId }).catch(() => {}));
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      const recheck = [...notListed, ...failed.map((f) => f.userId)];
      const counts = await pool(recheck, CONCURRENCY, async (userId) => ({ userId, count: await p.count({ userId }) }));
      proof[p.name] = {
        usersCreated: ids.length,
        lateWritesSettled: settled,
        deletedAtCleanup: toDelete.length,
        alreadyGoneBeforeCleanup: notListed.length,
        deleteErrors: failed,
        m0evalUsersLeft: left.length,
        memoriesLeftForUnlistedOrFailed: counts.reduce((n, c) => n + c.count, 0),
      };
    } else {
      const counts = await pool(ids, CONCURRENCY, async (userId) => (await p.getAll({ userId })).length);
      const client = createQdrantClient();
      const { exists } = await client.collectionExists(ENGINE_COLLECTION);
      if (exists) await client.deleteCollection(ENGINE_COLLECTION);
      const after = (await client.getCollections()).collections.map((c) => c.name);
      proof[p.name] = {
        usersCreated: ids.length,
        deleteErrors: failed,
        memoriesLeftAfterDeleteAll: counts.reduce((a, b) => a + b, 0),
        collectionDropped: !after.includes(ENGINE_COLLECTION),
        collectionsAfter: after,
      };
    }
  }
  return proof;
}

// ---- report ------------------------------------------------------------------------------
function printRun(run, name, s) {
  const e = s.extraction.all;
  console.log(
    `run ${run} ${name.padEnd(6)} scenarios ${s.scenariosPassed}/${s.scenariosTotal} (+extra ${s.extraPassed}/${s.extraTotal})` +
      ` | precision ${pct(e.precision)} (${e.correct}/${e.memories}) | recall ${pct(e.recall)} (${e.expectedFound}/${e.expectedTotal})` +
      ` | ended asserted ${e.endedAsserted} | forbidden asserted ${e.forbiddenAsserted} | mem/case ${e.avgMemories?.toFixed(2)}` +
      ` | add p50 ${ms(s.addLatency.p50)} p95 ${ms(s.addLatency.p95)} | search p50 ${ms(s.searchLatency.p50)} p95 ${ms(s.searchLatency.p95)}` +
      ` | errors ${s.scenarioErrors + e.errors}`
  );
}

function printDetails(run, name, j) {
  console.log(`\n--- run ${run} ${name}: update scenario failures ---`);
  for (const s of j.scenarios.filter((x) => !x.pass)) {
    const counts = s.checks.map((c) => `${c.user}=${c.memories.length}`).join(', ');
    console.log(`FAIL ${s.id}. ${s.name}  [final memories: ${counts}]${s.error ? `  ERROR: ${s.error}` : ''}`);
    for (const c of s.checks.filter((x) => x.verdict !== 'pass')) {
      console.log(`     judge: ${c.reason}`);
      for (const m of c.memories) console.log(`       - ${oneLine(m)}`);
    }
  }
  console.log(`\n--- run ${run} ${name}: extraction problems ---`);
  for (const c of j.cases) {
    const wrong = c.judged.filter((m) => m.verdict !== 'correct' && !m.allowed);
    const missed = c.recall.filter((x) => !x.found);
    const bad = [...c.ended, ...c.forbidden].filter((x) => x.hits.length);
    if (!wrong.length && !missed.length && !bad.length && !c.error) continue;
    console.log(`${c.name} (${c.suite})${c.error ? `  ERROR: ${c.error}` : ''}`);
    for (const m of wrong) console.log(`     wrong: ${oneLine(m.text)}  <- ${m.reason}`);
    for (const m of missed) console.log(`     missed: ${JSON.stringify(m.spec)}`);
    for (const b of bad) for (const h of b.hits) console.log(`     asserts "${b.claim}": ${oneLine(h.text)}`);
  }
}

// ---- main ----------------------------------------------------------------------------------
async function main() {
  console.log(`eval-mem0-compare: set=${SET}, runs=${RUNS}, providers=${PROVIDERS.join(',')}, scenarios=${SCENARIOS.length}, cases=${CASES.length}, judge=${NEUTRAL_JUDGE_MODEL}, tag=${TAG}`);
  const qdrant = createQdrantClient();
  if ((await qdrant.collectionExists(ENGINE_COLLECTION)).exists) await qdrant.deleteCollection(ENGINE_COLLECTION);

  const providers = [];
  if (PROVIDERS.includes('engine')) providers.push(createEngineProvider({ collection: ENGINE_COLLECTION }));
  if (PROVIDERS.includes('mem0')) providers.push(await createMem0Provider({ apiKey: process.env.MEM0_API_KEY }));
  if (PROVIDERS.includes('mem0-latest')) providers.push(await createMem0Provider({ apiKey: process.env.MEM0_API_KEY, latestOnly: true }));
  const used = Object.fromEntries(providers.map((p) => [p.name, new Set()]));

  const runs = [];
  let fatal = null;
  try {
    for (let run = 1; run <= RUNS; run++) {
      const started = Date.now();
      // Both providers are fed at the same time; they share no infrastructure except OpenAI
      // (the engine's own calls; Mem0 runs its LLM calls on its side).
      const collected = await Promise.all(providers.map((p) => collect(p, run, used[p.name])));
      const judged = [];
      for (const c of collected) judged.push(await judgeRun(c));
      const perProvider = providers.map((p, i) => ({ provider: p.name, summary: summarize(judged[i]), ...judged[i] }));
      runs.push({ run, seconds: Math.round((Date.now() - started) / 1000), providers: perProvider });
      console.log(`\n=== run ${run} done in ${runs.at(-1).seconds}s ===`);
      for (const p of perProvider) printRun(run, p.provider, p.summary);
      for (const p of perProvider) printDetails(run, p.provider, p);
    }
  } catch (err) {
    fatal = err.stack ?? err.message;
    console.error('eval-mem0-compare failed:', fatal);
  }

  console.log('\nCleaning up every m0eval_ user...');
  const cleanupProof = await cleanup(providers, used);
  console.log(`Cleanup proof: ${JSON.stringify(cleanupProof, null, 2)}`);

  console.log('\n=== summary ===');
  for (const r of runs) for (const p of r.providers) printRun(r.run, p.provider, p.summary);
  const mem0Stats = Object.fromEntries(providers.filter((p) => p.stats).map((p) => [p.name, p.stats]));
  if (mem0Stats) console.log(`Mem0 wait stats: ${JSON.stringify(mem0Stats)}`);

  const file = await saveResult(SET === 'heldout' ? 'heldout-compare' : 'mem0-compare', {
    set: SET,
    runAt: new Date().toISOString(),
    tag: TAG,
    judgeModel: NEUTRAL_JUDGE_MODEL,
    engineModels: { chat: config.openai.chatModel, embedding: config.openai.embeddingModel },
    concurrency: CONCURRENCY,
    runsRequested: RUNS,
    runsCompleted: runs.length,
    fatal,
    mem0Stats,
    cleanupProof,
    runs,
  });
  console.log(`\nSaved to ${file}`);
  const clean = Object.values(cleanupProof).every((c) =>
    'm0evalUsersLeft' in c
      ? c.m0evalUsersLeft === 0 && c.memoriesLeftForUnlistedOrFailed === 0 && c.lateWritesSettled.every((x) => !x.status.startsWith('unsettled'))
      : c.memoriesLeftAfterDeleteAll === 0 && c.collectionDropped
  );
  console.log(`Runs completed: ${runs.length}/${RUNS}. Cleanup proven: ${clean}`);
  if (fatal || runs.length < RUNS || !clean) process.exitCode = 1;
}

await main();
