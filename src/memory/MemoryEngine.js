import config from '../config/index.js';
import { embed, embedMany } from '../llm/embed.js';
import { createVectorStore } from '../stores/vectorStore.js';
import { decide } from './decider.js';
import { extractFacts } from './extractor.js';
import { contentToText } from './messages.js';

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
// select (naive or LLM) -> embed -> find related memories -> decide -> apply.
// With dedupe: false the find/decide steps are skipped and every active fact is ADDed.

const EXTRACTION_MODES = ['llm', 'naive'];

/**
 * Naive selection: every non-blank "user" message becomes one memory.
 * Returns [{ text, category, status }].
 */
function selectTextsNaive(messages) {
  return messages
    .filter((m) => m?.role === 'user')
    .map((m) => contentToText(m.content).trim())
    .filter(Boolean)
    .map((text) => ({ text, category: null, status: 'active' }));
}

/** LLM selection: extracted facts about the user. Returns [{ text, category, status }]. */
async function selectTextsLlm(messages) {
  return extractFacts(messages);
}

/** Embeds all candidate texts in one call. Returns candidates with a vector attached. */
async function embedCandidates(candidates) {
  const vectors = await embedMany(candidates.map((c) => c.text));
  return candidates.map((c, i) => ({ ...c, vector: vectors[i] }));
}

/** Stores embedded candidates. Returns [{ id, text, event }]. */
async function storeCandidates(store, userId, embedded, metadata, source) {
  const ids = await store.addMemories(
    userId,
    embedded.map((c) => ({
      text: c.text,
      vector: c.vector,
      category: c.category,
      metadata: { ...metadata, source },
    }))
  );
  return embedded.map((c, i) => ({ id: ids[i], text: c.text, event: 'ADD' }));
}

const CANDIDATES_PER_FACT = 5;

const sameText = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Finds existing memories related to each fact: same category, top CANDIDATES_PER_FACT.
 * Returns one candidate list per fact.
 */
async function findCandidates(store, userId, facts) {
  return Promise.all(
    facts.map((f) =>
      store.search(userId, f.vector, { limit: CANDIDATES_PER_FACT, category: f.category ?? undefined })
    )
  );
}

/**
 * Decides one action per fact: { action, memoryId, text, previousText }.
 * Exact-text matches are NOOP without an LLM call; the decider is skipped
 * entirely when no remaining fact has a related memory.
 */
async function planActions(facts, candidateLists) {
  const plan = new Array(facts.length);
  const pending = [];

  facts.forEach((fact, i) => {
    const exact = fact.status === 'active' && candidateLists[i].find((m) => sameText(m.text, fact.text));
    if (exact) plan[i] = { action: 'NOOP', memoryId: exact.id, text: fact.text };
    else pending.push(i);
  });

  if (pending.length === 0) return plan;

  if (pending.every((i) => candidateLists[i].length === 0)) {
    for (const i of pending) {
      plan[i] = facts[i].status === 'ended'
        ? { action: 'NOOP', memoryId: null, text: facts[i].text }
        : { action: 'ADD', memoryId: null, text: facts[i].text };
    }
    return plan;
  }

  // One decider call for all remaining facts, with the union of their candidates.
  const memoriesById = new Map();
  for (const i of pending) for (const m of candidateLists[i]) memoriesById.set(m.id, m);
  const decisions = await decide(
    pending.map((i) => facts[i]),
    [...memoriesById.values()].map(({ id, text, category }) => ({ id, text, category }))
  );
  decisions.forEach((d, k) => {
    plan[pending[k]] = { ...d, previousText: d.memoryId ? memoriesById.get(d.memoryId)?.text : undefined };
  });
  return plan;
}

// ---- engine ---------------------------------------------------------------

export function createMemoryEngine({
  collection = config.memory.collection,
  extraction = 'llm',
  dedupe = true,
} = {}) {
  if (!EXTRACTION_MODES.includes(extraction)) {
    throw new Error(
      `createMemoryEngine: extraction must be one of ${EXTRACTION_MODES.join(', ')}, got "${extraction}".`
    );
  }
  const selectTexts = extraction === 'llm' ? selectTextsLlm : selectTextsNaive;
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

  // Per-user queue: add() calls for one user run one after another, so two
  // parallel calls cannot both ADD the same fact. Different users run in parallel.
  const userQueues = new Map();
  async function runExclusive(userId, fn) {
    const previous = userQueues.get(userId);
    const mine = (async () => {
      await previous; // `previous` never rejects, see `settled` below
      return fn();
    })();
    const settled = (async () => {
      try {
        await mine;
      } catch {
        // the caller of `mine` gets the error; the queue just moves on
      }
    })();
    userQueues.set(userId, settled);
    try {
      return await mine;
    } finally {
      if (userQueues.get(userId) === settled) userQueues.delete(userId);
    }
  }

  /** Phase 5a behaviour (dedupe: false): store active facts, skip ended ones. */
  async function addWithoutDedupe(facts, userId, metadata) {
    const active = facts.filter((c) => c.status !== 'ended');
    const skipped = facts
      .filter((c) => c.status === 'ended')
      .map((c) => ({ id: null, text: c.text, event: 'SKIPPED_ENDED' }));
    if (active.length === 0) return { results: skipped };

    await ready();
    const embedded = await embedCandidates(active);
    const stored = await storeCandidates(store, userId, embedded, metadata, extraction);
    return { results: [...stored, ...skipped] };
  }

  async function addWithDedupe(facts, userId, metadata) {
    await ready();
    const embedded = await embedCandidates(facts);
    const candidateLists = await findCandidates(store, userId, embedded);
    const plan = await planActions(embedded, candidateLists);
    const results = new Array(facts.length);

    // Apply in order: DELETE, then UPDATE, then ADD.
    for (const [i, p] of plan.entries()) {
      if (p.action !== 'DELETE') continue;
      await store.deleteMemory(userId, p.memoryId);
      results[i] = { id: p.memoryId, text: p.text, event: 'DELETE', previousText: p.previousText };
    }

    const updates = [...plan.entries()].filter(([, p]) => p.action === 'UPDATE');
    const needVector = updates.filter(([i, p]) => !sameText(p.text, embedded[i].text));
    const newVectors = needVector.length ? await embedMany(needVector.map(([, p]) => p.text)) : [];
    const vectorFor = new Map(needVector.map(([i], k) => [i, newVectors[k]]));
    for (const [i, p] of updates) {
      await store.updateMemory(userId, p.memoryId, {
        text: p.text,
        vector: vectorFor.get(i) ?? embedded[i].vector,
        category: embedded[i].category,
      });
      results[i] = { id: p.memoryId, text: p.text, event: 'UPDATE', previousText: p.previousText };
    }

    const adds = [...plan.entries()].filter(([, p]) => p.action === 'ADD');
    if (adds.length) {
      const stored = await storeCandidates(store, userId, adds.map(([i]) => embedded[i]), metadata, extraction);
      adds.forEach(([i], k) => (results[i] = stored[k]));
    }

    for (const [i, p] of plan.entries()) {
      if (p.action === 'NOOP') results[i] = { id: p.memoryId ?? null, text: p.text, event: 'NOOP' };
    }
    return { results };
  }

  async function add(messages, { userId, metadata = {} } = {}) {
    requireUserId(userId, 'add');
    if (!Array.isArray(messages)) {
      throw new Error('MemoryEngine.add: messages must be an array of { role, content }.');
    }

    // Extraction does not touch storage, so it runs outside the per-user queue.
    const facts = await selectTexts(messages);
    if (facts.length === 0) return { results: [] };

    return runExclusive(userId, () =>
      dedupe ? addWithDedupe(facts, userId, metadata) : addWithoutDedupe(facts, userId, metadata)
    );
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
