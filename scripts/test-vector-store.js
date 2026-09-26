import { QdrantClient } from '@qdrant/js-client-rest';
import config from '../src/config/index.js';
import { embed, embedMany } from '../src/llm/embed.js';
import { createVectorStore } from '../src/stores/vectorStore.js';

const TEST_COLLECTION = 'custom_user_memories_test';

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function rejects(fn) {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const store = createVectorStore({ collection: TEST_COLLECTION });

  // a. ensureCollection is idempotent
  try {
    await store.ensureCollection();
    await store.ensureCollection();
    check('a. ensureCollection twice', true);
  } catch (err) {
    check('a. ensureCollection twice', false, err.message);
    throw err;
  }

  // b. add memories with real embeddings
  const userA = [
    { text: 'The user is learning recursion.', category: 'learning' },
    { text: 'The user is currently on Module 3 of the course.', category: 'progress' },
    { text: 'The user prefers explanations with code examples.', category: 'preference' },
  ];
  const userB = [
    { text: 'The user loves playing and watching cricket.', category: 'hobby' },
    { text: 'The user enjoys cooking Indian food on weekends.', category: 'hobby' },
  ];
  const vectors = await embedMany([...userA, ...userB].map((m) => m.text));
  userA.forEach((m, i) => (m.vector = vectors[i]));
  userB.forEach((m, i) => (m.vector = vectors[userA.length + i]));

  const idsA = await store.addMemories('user_a', userA);
  const idsB = await store.addMemories('user_b', userB);
  check('b. add 3 for user_a and 2 for user_b', idsA.length === 3 && idsB.length === 2);

  // c. user isolation in search
  const sportVector = await embed('what sport does the user like?');
  const resultsA = await store.search('user_a', sportVector, { limit: 10 });
  const leaked = resultsA.filter((r) => idsB.includes(r.id));
  check(
    'c. user_a search returns no user_b memories',
    resultsA.length > 0 && leaked.length === 0,
    `${resultsA.length} results, ${leaked.length} leaked`
  );

  // d. getAll counts
  const allA = await store.getAll('user_a');
  const allB = await store.getAll('user_b');
  check('d. getAll: 3 for user_a, 2 for user_b', allA.length === 3 && allB.length === 2,
    `user_a=${allA.length}, user_b=${allB.length}`);

  // e. update keeps createdAt, changes updatedAt and text
  const target = idsA[1];
  const before = await store.getById('user_a', target);
  await sleep(20); // make sure the new timestamp differs
  const newText = 'The user is currently on Module 4 of the course.';
  await store.updateMemory('user_a', target, { text: newText, vector: await embed(newText) });
  const after = await store.getById('user_a', target);
  check(
    'e. updateMemory keeps createdAt, changes updatedAt and text',
    after.createdAt === before.createdAt &&
      after.updatedAt !== before.updatedAt &&
      after.text === newText &&
      before.text !== newText
  );

  // e2. text change without a vector is rejected, and nothing is written
  const textOnlyRejected = await rejects(() =>
    store.updateMemory('user_a', target, { text: 'Text without a vector.' })
  );
  const unchanged = await store.getById('user_a', target);
  check(
    'e2. updateMemory with text but no vector throws',
    textOnlyRejected && unchanged.text === newText
  );

  // f. cross-user access is blocked
  const victim = idsA[0];
  const crossGet = await store.getById('user_b', victim);
  // Both update paths: upsert (text + vector) and payload-only (category).
  const crossUpdate =
    (await rejects(() =>
      store.updateMemory('user_b', victim, { text: 'hacked', vector: sportVector })
    )) && (await rejects(() => store.updateMemory('user_b', victim, { category: 'hacked' })));
  const crossDelete = await rejects(() => store.deleteMemory('user_b', victim));
  const stillIntact = await store.getById('user_a', victim);
  check(
    'f. user_b cannot get/update/delete a user_a memory',
    crossGet === null &&
      crossUpdate &&
      crossDelete &&
      stillIntact?.text === userA[0].text &&
      stillIntact?.category === userA[0].category
  );

  // g. category filter in search
  const byCategory = await store.search('user_a', sportVector, { limit: 10, category: 'preference' });
  check(
    'g. search category filter',
    byCategory.length === 1 && byCategory.every((r) => r.category === 'preference'),
    `${byCategory.length} results`
  );

  // h. deleteAllForUser only affects that user
  await store.deleteAllForUser('user_a');
  const afterA = await store.getAll('user_a');
  const afterB = await store.getAll('user_b');
  check(
    'h. deleteAllForUser(user_a) leaves user_b untouched',
    afterA.length === 0 && afterB.length === 2,
    `user_a=${afterA.length}, user_b=${afterB.length}`
  );
}

async function cleanup() {
  const client = new QdrantClient({ ...config.qdrant, checkCompatibility: false });
  try {
    const { exists } = await client.collectionExists(TEST_COLLECTION);
    if (exists) await client.deleteCollection(TEST_COLLECTION);
    console.log(`Cleaned up test collection "${TEST_COLLECTION}".`);
  } catch (err) {
    console.error(`Could not delete test collection: ${err.message}`);
  }
}

try {
  await main();
} catch (err) {
  failures++;
  console.error('Test run aborted:', err.message);
} finally {
  await cleanup();
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
