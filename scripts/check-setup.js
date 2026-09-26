import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from './runtime.js';

function isConnectionRefused(err) {
  // fetch() wraps the socket error, so look through the cause chain.
  for (let e = err; e; e = e.cause) {
    if (e.code === 'ECONNREFUSED') return true;
    if (Array.isArray(e.errors) && e.errors.some((x) => x?.code === 'ECONNREFUSED')) return true;
  }
  return false;
}

async function main() {
  const client = new QdrantClient({ ...config.qdrant, checkCompatibility: false });

  try {
    const { collections } = await client.getCollections();
    console.log(`Connected to Qdrant at ${config.qdrant.url}`);
    if (collections.length === 0) {
      console.log('Collections: (none)');
    } else {
      console.log('Collections:');
      for (const c of collections) console.log(`  - ${c.name}`);
    }
    console.log('Setup OK');
  } catch (err) {
    if (isConnectionRefused(err)) {
      console.error(
        `Qdrant is not reachable at ${config.qdrant.url}. Is Docker Desktop running? Try: npm run db:up`
      );
    } else {
      console.error('Setup check failed:', err.message ?? err);
    }
    process.exitCode = 1;
  }
}

main();
