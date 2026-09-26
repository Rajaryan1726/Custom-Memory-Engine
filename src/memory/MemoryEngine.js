import config from '../config/index.js';
import { embed, embedMany } from '../llm/embed.js';
import { createVectorStore } from '../stores/vectorStore.js';

function requireUserId(userId, method) {
  if (typeof userId !== 'string' || !userId.trim()) {
    throw new Error(`MemoryEngine.${method}: userId is required and must be a non-empty string.`);
  }
}

function toResult(memory) {
  return {
    id: memory.id,
    text: memory.text,
    ...(memory.score !== undefined ? { score: memory.score } : {}),
    category: memory.category,
    metadata: memory.metadata,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

// ---- add() pipeline steps -------------------------------------------------
// A later phase replaces selectTexts() with LLM extraction; the other steps stay.

/**
 * Naive selection: every non-blank "user" message becomes one memory.
 * Returns [{ text, category }].
 */
function selectTexts(messages) {
  return messages
    .filter((m) => m?.role === 'user' && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ text: m.content.trim(), category: null }));
}

/** Embeds all candidate texts in one call. Returns candidates with a vector attached. */
async function embedCandidates(candidates) {
  const vectors = await embedMany(candidates.map((c) => c.text));
  return candidates.map((c, i) => ({ ...c, vector: vectors[i] }));
}

/** Stores embedded candidates. Returns [{ id, text, event }]. */
async function storeCandidates(store, userId, embedded, metadata) {
  const ids = await store.addMemories(
    userId,
    embedded.map((c) => ({
      text: c.text,
      vector: c.vector,
      category: c.category,
      metadata: { ...metadata, source: 'naive' },
    }))
  );
  return embedded.map((c, i) => ({ id: ids[i], text: c.text, event: 'ADD' }));
}

// ---- engine ---------------------------------------------------------------

export function createMemoryEngine({ collection = config.memory.collection } = {}) {
  const store = createVectorStore({ collection });

  let readyPromise = null;
  function ready() {
    if (!readyPromise) {
      readyPromise = store.ensureCollection().catch((err) => {
        readyPromise = null; // allow a retry on the next call (e.g. Qdrant was down)
        throw err;
      });
    }
    return readyPromise;
  }

  async function add(messages, { userId, metadata = {} } = {}) {
    requireUserId(userId, 'add');
    if (!Array.isArray(messages)) {
      throw new Error('MemoryEngine.add: messages must be an array of { role, content }.');
    }

    const candidates = selectTexts(messages);
    if (candidates.length === 0) return { results: [] };

    await ready();
    const embedded = await embedCandidates(candidates);
    const results = await storeCandidates(store, userId, embedded, metadata);
    return { results };
  }

  async function search(query, { userId, limit = 5, category, scoreThreshold } = {}) {
    requireUserId(userId, 'search');
    if (typeof query !== 'string' || !query.trim()) {
      throw new Error('MemoryEngine.search: query must be a non-empty string.');
    }

    await ready();
    const vector = await embed(query);
    const memories = await store.search(userId, vector, { limit, category, scoreThreshold });
    return { results: memories.map(toResult) };
  }

  async function getAll({ userId, category } = {}) {
    requireUserId(userId, 'getAll');
    await ready();
    const memories = await store.getAll(userId, { category });
    return { results: memories.map(toResult) };
  }

  async function deleteMemory(id, { userId } = {}) {
    requireUserId(userId, 'delete');
    await ready();
    await store.deleteMemory(userId, id);
  }

  async function deleteAll({ userId } = {}) {
    requireUserId(userId, 'deleteAll');
    await ready();
    await store.deleteAllForUser(userId);
  }

  return { add, search, getAll, delete: deleteMemory, deleteAll };
}
