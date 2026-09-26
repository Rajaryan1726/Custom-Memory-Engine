// Checks that the engine can be imported and used safely as a library (Phase 7a).
//   1. Importing src/index.js with an EMPTY environment does not throw and does not
//      read .env (process.env stays empty in the child).
//   2. No library file imports dotenv or reads process.env (static scan).
//   3. createMemoryEngine with missing config fields throws a clear error naming them.
//   4. Two engines with different collections in one process do not see each other's data.
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createMemoryEngine as createEngineFromLibrary } from '../src/index.js';
import { config, createQdrantClient } from './runtime.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const COLLECTIONS = ['custom_user_memories_libcheck_a', 'custom_user_memories_libcheck_b'];
let failures = 0;

function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

// 1. Import in a child process with an empty environment. The child runs in the repo
// root, where .env exists, so an import that loaded dotenv would fill process.env.
// Names (not values) of the variables in this repo's .env, used to detect a hidden dotenv load.
const DOTENV_KEYS = new Set(
  (await readFile(`${ROOT}.env`, 'utf8').catch(() => ''))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => l.slice(0, l.indexOf('=')).trim())
);

function importWithEmptyEnv() {
  const code = `
    const m = await import('./src/index.js');
    console.log(JSON.stringify({ exports: Object.keys(m).sort(), envKeys: Object.keys(process.env) }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env: {}, encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, detail: `exit ${r.status}: ${(r.stderr || '').trim().split('\n')[0]}` };
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  const expected = ['CATEGORIES', 'createMemoryEngine', 'formatContext', 'isSmallTalk', 'loadConfigFromEnv'];
  const exportsOk = JSON.stringify(out.exports) === JSON.stringify(expected);
  // Windows adds its own system variables (PATH, SYSTEMROOT, TEMP, ...) to every child
  // process even with env: {}. What matters is that nothing from this repo's .env appears.
  const leakedFromDotenv = out.envKeys.filter((k) => DOTENV_KEYS.has(k));
  return {
    ok: exportsOk && leakedFromDotenv.length === 0,
    detail:
      `exports: ${out.exports.join(', ')}; .env variables present after import: ${leakedFromDotenv.length ? leakedFromDotenv.join(', ') : '(none)'}` +
      `; OS-provided variables in the child: ${out.envKeys.filter((k) => !DOTENV_KEYS.has(k)).length}`,
  };
}

// 2. Static scan: dotenv or process.env anywhere in src/ except the opt-in loadConfigFromEnv().
async function scanSources() {
  const offenders = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.js')) {
        const lines = (await readFile(path, 'utf8')).split('\n');
        lines.forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return; // comments
          const rel = path.slice(ROOT.length).replace(/\\/g, '/');
          const allowed = rel === 'src/config/index.js' && /export function loadConfigFromEnv\(env = process\.env\)/.test(line);
          if ((/dotenv/.test(line) || /process\.env/.test(line)) && !allowed) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
      }
    }
  }
  await walk(`${ROOT}src`.replace(/\\/g, '/'));
  return offenders;
}

async function dropCollections() {
  const client = createQdrantClient();
  for (const c of COLLECTIONS) {
    const { exists } = await client.collectionExists(c);
    if (exists) await client.deleteCollection(c);
  }
}

async function main() {
  const imported = importWithEmptyEnv();
  check('1. import src/index.js with an empty environment', imported.ok, imported.detail);

  const offenders = await scanSources();
  check('2. no dotenv / process.env in library code (except opt-in loadConfigFromEnv)', offenders.length === 0,
    offenders.length ? offenders.join('\n        ') : 'clean');

  // 3. Missing fields -> one clear error naming them. No network calls happen here.
  const broken = { openai: { chatModel: 'gpt-4o-mini', embeddingModel: 'text-embedding-3-small', embeddingDim: 1536 }, collection: 'x' };
  let message = '';
  try {
    createEngineFromLibrary({ config: broken });
  } catch (err) {
    message = err.message;
  }
  check(
    '3. createMemoryEngine with missing fields throws a clear error',
    /config\.openai\.apiKey/.test(message) && /config\.qdrant\.url/.test(message),
    message || '(no error thrown)'
  );
  let noConfigMessage = '';
  try {
    createEngineFromLibrary({});
  } catch (err) {
    noConfigMessage = err.message;
  }
  check('3b. createMemoryEngine without config throws', /"config" is required/.test(noConfigMessage), noConfigMessage || '(no error thrown)');

  // 4. Two independent engines (separate clients, built straight from the library) in one process.
  await dropCollections();
  const engineA = createEngineFromLibrary({ config, collection: COLLECTIONS[0] });
  const engineB = createEngineFromLibrary({ config, collection: COLLECTIONS[1] });
  const userId = 'libcheck_user';
  const added = await engineA.add([{ role: 'user', content: 'Main Module 4 pe hoon aur mujhe graphs samajh nahi aate' }], { userId });
  const inA = (await engineA.getAll({ userId })).results;
  const inB = (await engineB.getAll({ userId })).results;
  const searchB = (await engineB.search('which module is the student on?', { userId })).results;
  const ctxB = await engineB.getContext('graphs samjhao', { userId });
  check(
    '4. two engines, different collections: B sees nothing A stored',
    added.results.length > 0 && inA.length > 0 && inB.length === 0 && searchB.length === 0 &&
      ctxB.profile.length === 0 && ctxB.relevant.length === 0,
    `A stored ${inA.length} (${inA.map((m) => m.text).join('; ')}); B getAll ${inB.length}, search ${searchB.length}, getContext ${ctxB.profile.length + ctxB.relevant.length}; ` +
      `A.collection=${engineA.collection}, B.collection=${engineB.collection}`
  );
}

try {
  await main();
} catch (err) {
  failures++;
  console.error('check-library aborted:', err.message);
} finally {
  await dropCollections();
  const left = (await createQdrantClient().getCollections()).collections.map((c) => c.name);
  console.log(`\nCollections after cleanup: ${JSON.stringify(left)}`);
  console.log(failures === 0 ? 'Library check: all passed.' : `Library check: ${failures} failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}
