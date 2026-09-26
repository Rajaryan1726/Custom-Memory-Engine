import { randomUUID } from 'node:crypto';
import { QdrantClient } from '@qdrant/js-client-rest';

const SCROLL_PAGE_SIZE = 256;
const HISTORY_LIMIT = 20;
const ARCHIVED = 'archived';

/** Appends an entry to a payload's history array, keeping the last HISTORY_LIMIT entries. */
function withHistory(oldHistory, entry) {
  const history = Array.isArray(oldHistory) ? oldHistory : [];
  return entry ? [...history, entry].slice(-HISTORY_LIMIT) : history;
}

function assertUserId(userId) {
  if (typeof userId !== 'string' || !userId.trim()) {
    throw new Error('vectorStore: userId is required and must be a non-empty string.');
  }
}

function assertId(id) {
  if ((typeof id !== 'string' || !id.trim()) && !Number.isInteger(id)) {
    throw new Error('vectorStore: id is required.');
  }
}

function assertVector(vector, dim, label) {
  if (!Array.isArray(vector) || vector.length !== dim) {
    throw new Error(`${label}: vector must be an array of length ${dim} (EMBEDDING_DIM).`);
  }
}

function assertText(text, label) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(`${label}: text must be a non-empty string.`);
  }
}

/**
 * Filter that every read, update and delete goes through.
 * category: a string, or an array meaning "any of".
 * Archived points are excluded unless includeArchived is true. must_not is used so
 * points written before the state field existed still count as active.
 */
function userFilter(userId, { id, category, includeArchived = false } = {}) {
  const must = [{ key: 'userId', match: { value: userId } }];
  if (id !== undefined) must.push({ has_id: [id] });
  if (Array.isArray(category)) {
    if (category.length) must.push({ key: 'category', match: { any: category } });
  } else if (category !== undefined && category !== null) {
    must.push({ key: 'category', match: { value: category } });
  }
  const filter = { must };
  if (!includeArchived) filter.must_not = [{ key: 'state', match: { value: ARCHIVED } }];
  return filter;
}

function toMemory(point, score) {
  const p = point.payload ?? {};
  const memory = {
    id: point.id,
    text: p.text,
    category: p.category ?? null,
    metadata: p.metadata ?? {},
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    state: p.state ?? 'active',
  };
  if (p.state === ARCHIVED) {
    memory.archivedAt = p.archivedAt ?? null;
    memory.archivedReason = p.archivedReason ?? null;
  }
  if (score !== undefined) memory.score = score;
  return memory;
}

/**
 * Creates a store for one collection. Everything comes from the arguments:
 * qdrant: { url, apiKey? }, embeddingDim, collection.
 */
export function createVectorStore({ qdrant, embeddingDim, collection } = {}) {
  if (!qdrant?.url) throw new Error('createVectorStore: qdrant.url is required.');
  if (!Number.isInteger(embeddingDim) || embeddingDim <= 0) throw new Error('createVectorStore: embeddingDim must be a positive integer.');
  if (typeof collection !== 'string' || !collection.trim()) throw new Error('createVectorStore: collection is required.');
  const dim = embeddingDim;
  const client = new QdrantClient({
    url: qdrant.url,
    ...(qdrant.apiKey ? { apiKey: qdrant.apiKey } : {}),
    checkCompatibility: false,
  });

  /**
   * Returns the raw point (payload, optionally vector) if it belongs to userId, else null.
   * Archived points are only found with includeArchived.
   */
  async function findOwnedPoint(userId, id, { withVector = false, includeArchived = false } = {}) {
    const { points } = await client.scroll(collection, {
      filter: userFilter(userId, { id, includeArchived }),
      limit: 1,
      with_payload: true,
      with_vector: withVector,
    });
    return points[0] ?? null;
  }

  async function ensureCollection() {
    const { exists } = await client.collectionExists(collection);

    if (!exists) {
      try {
        await client.createCollection(collection, {
          vectors: { size: dim, distance: 'Cosine' },
        });
      } catch (err) {
        // Another caller may have created it between the check and the create.
        if (err?.status !== 409) throw err;
      }
    }

    const info = await client.getCollection(collection);
    const vectors = info.config?.params?.vectors;
    const size = vectors?.size;
    if (size !== dim) {
      throw new Error(
        `Collection "${collection}" has vector size ${size ?? '(named/unknown vectors)'}, ` +
          `but EMBEDDING_DIM is ${dim}. Use a different MEMORY_COLLECTION or fix EMBEDDING_DIM. ` +
          'Nothing was deleted or recreated.'
      );
    }

    // Creating an index that already exists is a no-op in Qdrant.
    for (const field of ['userId', 'category', 'state']) {
      await client.createPayloadIndex(collection, {
        field_name: field,
        field_schema: 'keyword',
        wait: true,
      });
    }
  }

  async function addMemories(userId, items) {
    assertUserId(userId);
    if (!Array.isArray(items)) throw new Error('addMemories: items must be an array.');
    if (items.length === 0) return [];

    const now = new Date().toISOString();
    const points = items.map((item, i) => {
      assertText(item?.text, `addMemories item ${i}`);
      assertVector(item.vector, dim, `addMemories item ${i}`);
      return {
        id: randomUUID(),
        vector: item.vector,
        payload: {
          userId,
          text: item.text,
          category: item.category ?? null,
          metadata: item.metadata ?? {},
          createdAt: now,
          updatedAt: now,
          state: 'active',
          history: withHistory([], item.historyEntry),
        },
      };
    });

    await client.upsert(collection, { points, wait: true });
    return points.map((p) => p.id);
  }

  async function search(userId, vector, { limit = 5, category, scoreThreshold, includeArchived = false } = {}) {
    assertUserId(userId);
    assertVector(vector, dim, 'search');

    const { points } = await client.query(collection, {
      query: vector,
      filter: userFilter(userId, { category, includeArchived }),
      limit,
      with_payload: true,
      ...(scoreThreshold !== undefined ? { score_threshold: scoreThreshold } : {}),
    });
    return points.map((p) => toMemory(p, p.score));
  }

  async function getById(userId, id, { includeArchived = false } = {}) {
    assertUserId(userId);
    assertId(id);
    const point = await findOwnedPoint(userId, id, { includeArchived });
    return point ? toMemory(point) : null;
  }

  /** History entries of a memory (archived or not), or null if it is not this user's. */
  async function getHistory(userId, id) {
    assertUserId(userId);
    assertId(id);
    const point = await findOwnedPoint(userId, id, { includeArchived: true });
    if (!point) return null;
    return Array.isArray(point.payload.history) ? point.payload.history : [];
  }

  async function getAll(userId, { category, includeArchived = false } = {}) {
    assertUserId(userId);

    const all = [];
    let offset;
    do {
      const page = await client.scroll(collection, {
        filter: userFilter(userId, { category, includeArchived }),
        limit: SCROLL_PAGE_SIZE,
        with_payload: true,
        with_vector: false,
        ...(offset !== undefined ? { offset } : {}),
      });
      all.push(...page.points.map((p) => toMemory(p)));
      offset = page.next_page_offset ?? undefined;
    } while (offset !== undefined);

    // ISO timestamps sort correctly as strings.
    return all.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }

  async function updateMemory(userId, id, { text, vector, category, metadata, historyEntry } = {}) {
    assertUserId(userId);
    assertId(id);
    if (text !== undefined) assertText(text, 'updateMemory');
    if (vector !== undefined) assertVector(vector, dim, 'updateMemory');
    if (text !== undefined && vector === undefined) {
      throw new Error(
        'updateMemory: changing text requires a new vector too, so the text and its embedding stay in sync.'
      );
    }

    const existing = await findOwnedPoint(userId, id);
    if (!existing) {
      throw new Error(`updateMemory: memory ${id} not found for user "${userId}".`);
    }

    const old = existing.payload;
    const payload = {
      ...old, // keep fields such as state and history
      userId,
      text: text ?? old.text,
      category: category !== undefined ? category : old.category ?? null,
      metadata: metadata !== undefined ? metadata : old.metadata ?? {},
      createdAt: old.createdAt,
      updatedAt: new Date().toISOString(),
      history: withHistory(old.history, historyEntry),
    };

    if (vector !== undefined) {
      // One upsert replaces vector and payload together, so they can't drift apart.
      // Upsert has no filter option; ownership was verified above.
      await client.upsert(collection, { points: [{ id, vector, payload }], wait: true });
    } else {
      // Filtered by userId + id, so it can only ever touch this user's point.
      await client.overwritePayload(collection, {
        payload,
        filter: userFilter(userId, { id }),
        wait: true,
      });
    }

    return toMemory({ id, payload });
  }

  /**
   * Sets a memory's state ("active" or "archived") without touching its vector.
   * archived: records archivedAt and archivedReason. active: clears them.
   */
  async function setState(userId, id, { state, reason = null, historyEntry } = {}) {
    assertUserId(userId);
    assertId(id);
    if (state !== 'active' && state !== ARCHIVED) throw new Error(`setState: unknown state "${state}".`);

    const existing = await findOwnedPoint(userId, id, { includeArchived: true });
    if (!existing) {
      throw new Error(`setState: memory ${id} not found for user "${userId}".`);
    }

    const { archivedAt: _at, archivedReason: _reason, ...rest } = existing.payload;
    const now = new Date().toISOString();
    const payload = {
      ...rest,
      state,
      ...(state === ARCHIVED ? { archivedAt: now, archivedReason: reason } : {}),
      updatedAt: now,
      history: withHistory(rest.history, historyEntry),
    };
    await client.overwritePayload(collection, {
      payload,
      filter: userFilter(userId, { id, includeArchived: true }),
      wait: true,
    });
    return toMemory({ id, payload });
  }

  /** Hard delete: removes the point completely, archived or not, including its history. */
  async function deleteMemory(userId, id) {
    assertUserId(userId);
    assertId(id);

    const existing = await findOwnedPoint(userId, id, { includeArchived: true });
    if (!existing) {
      throw new Error(`deleteMemory: memory ${id} not found for user "${userId}".`);
    }

    await client.delete(collection, { filter: userFilter(userId, { id, includeArchived: true }), wait: true });
  }

  /** Hard delete of every point of the user, archived ones included. */
  async function deleteAllForUser(userId) {
    assertUserId(userId);
    await client.delete(collection, { filter: userFilter(userId, { includeArchived: true }), wait: true });
  }

  return {
    collection,
    ensureCollection,
    addMemories,
    search,
    getById,
    getHistory,
    getAll,
    updateMemory,
    setState,
    deleteMemory,
    deleteAllForUser,
  };
}
