import { QdrantClient } from '@qdrant/js-client-rest';
import config from '../src/config/index.js';
import { createMemoryEngine } from '../src/memory/MemoryEngine.js';

const PLAYGROUND_COLLECTION = 'custom_user_memories_playground';
const EXTRACTION = process.argv.includes('--naive') ? 'naive' : 'llm';

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function printAddResults({ results }) {
  if (results.length === 0) console.log('  (nothing stored)');
  for (const r of results) console.log(`  ${r.event}  ${r.text}`);
}

async function main() {
  console.log(`Extraction mode: ${EXTRACTION}${EXTRACTION === 'llm' ? ' (use --naive for naive mode)' : ''}`);
  const memory = createMemoryEngine({ collection: PLAYGROUND_COLLECTION, extraction: EXTRACTION });
  const student2Ids = new Set();
  const student1ResultIds = [];

  section('a. Add conversation for student_1');
  printAddResults(
    await memory.add(
      [
        { role: 'user', content: 'Hi, main Raj hoon aur main recursion samajhne mein struggle kar raha hoon' },
        { role: 'assistant', content: 'Koi baat nahi, chalo step by step samajhte hain' },
        { role: 'user', content: 'Main abhi Module 2 pe hoon' },
        { role: 'user', content: 'Mujhe code examples se jaldi samajh aata hai' },
        { role: 'user', content: 'thanks!' },
      ],
      { userId: 'student_1', metadata: { sessionId: 'session_1' } }
    )
  );

  section('b. Add follow-up for student_1');
  printAddResults(
    await memory.add([{ role: 'user', content: 'Ab main Module 3 pe aa gaya hoon' }], {
      userId: 'student_1',
      metadata: { sessionId: 'session_2' },
    })
  );

  section('c. Add memory for student_2');
  const added2 = await memory.add([{ role: 'user', content: 'Mujhe cricket pasand hai' }], {
    userId: 'student_2',
  });
  added2.results.forEach((r) => student2Ids.add(r.id));
  printAddResults(added2);

  section('d. Searches for student_1');
  const queries = [
    'which module is the student on?',
    'how does the student like to learn?',
    'what sport does the student like?',
  ];
  for (const q of queries) {
    console.log(`\n  Q: ${q}`);
    const { results } = await memory.search(q, { userId: 'student_1', limit: 3 });
    for (const r of results) {
      student1ResultIds.push(r.id);
      console.log(`    ${r.score.toFixed(3)}  ${r.text}`);
    }
  }

  section('e. getAll for student_1');
  const all = await memory.getAll({ userId: 'student_1' });
  console.log(`  count: ${all.results.length}`);
  for (const r of all.results) {
    console.log(`  ${r.createdAt}  [${r.category ?? '-'}] ${r.text}  ${JSON.stringify(r.metadata)}`);
  }
  all.results.forEach((r) => student1ResultIds.push(r.id));

  section('f. Isolation check');
  const leaked = student1ResultIds.filter((id) => student2Ids.has(id));
  const ok = student2Ids.size > 0 && leaked.length === 0;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  no student_2 memory in any student_1 result ` +
      `(${student1ResultIds.length} ids checked, ${leaked.length} leaked)`
  );
  return ok;
}

async function cleanup() {
  const client = new QdrantClient({ ...config.qdrant, checkCompatibility: false });
  try {
    const { exists } = await client.collectionExists(PLAYGROUND_COLLECTION);
    if (exists) await client.deleteCollection(PLAYGROUND_COLLECTION);
    console.log(`\nCleaned up playground collection "${PLAYGROUND_COLLECTION}".`);
  } catch (err) {
    console.error(`\nCould not delete playground collection: ${err.message}`);
  }
}

let ok = false;
try {
  ok = await main();
} catch (err) {
  console.error('\nPlayground aborted:', err.message);
} finally {
  await cleanup();
}
process.exitCode = ok ? 0 : 1;
