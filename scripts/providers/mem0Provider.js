// Hosted Mem0 (mem0ai MemoryClient, the same client the RAG app uses) behind the
// provider-neutral harness interface. Scripts only: the library never imports mem0ai.
//
// Hosted add() is asynchronous: POST /v3/memories/add/ answers { eventId, status: "PENDING" }
// and the memories are written later (asyncMode: false is ignored by the v3 endpoint).
// So add() here does not return until the write is really done:
//   1. poll GET /v1/event/{eventId}/ until status is SUCCEEDED (or FAILED -> throw);
//   2. then poll getAll until every memory id the event ADDed/UPDATEd is visible and every
//      id it DELETEd is gone (read-after-write check).
// Only then does add() resolve, so no scenario can read Mem0 before its writes are finished.
// deleteAll() waits for its DELETE_ALL event the same way, then deletes the user entity.
// An add whose event is still running after EVENT_TIMEOUT_MS fails, but its event id is kept:
// settlePending() waits for those writes to finish so cleanup cannot race a late write.
//
// latestOnly: true passes Mem0's v3 latestOnly option to getAll and search, which hides
// memories that a newer one superseded. The RAG app does not pass it today (default false).

const POLL_MS = 1000;
const EVENT_TIMEOUT_MS = 180_000;
const SETTLE_TIMEOUT_MS = 900_000;
const VISIBLE_ATTEMPTS = 15;
const RETRY_ATTEMPTS = 5;
const PAGE_SIZE = 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryable = (err) => /HTTP_(429|5\d\d)/.test(err?.errorCode ?? '') || /fetch failed|ECONNRESET|ETIMEDOUT/i.test(err?.message ?? '');

/** Retries on 429 / 5xx / network errors only. A 429 or 5xx on add means it was not accepted. */
async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= RETRY_ATTEMPTS - 1) throw err;
      await sleep(2000 * 2 ** attempt);
    }
  }
}

export async function createMem0Provider({ apiKey, latestOnly = false }) {
  if (!apiKey) throw new Error('MEM0_API_KEY is not set in .env');
  process.env.MEM0_TELEMETRY ??= 'false'; // read by mem0ai at import time
  const { MemoryClient } = await import('mem0ai');
  const client = new MemoryClient({ apiKey });
  const stats = { eventPolls: 0, visibilityRetries: 0, maxEventWaitMs: 0 };
  const pending = new Set(); // add events we stopped waiting for

  async function getEvent(eventId) {
    const res = await fetch(`${client.host}/v1/event/${encodeURIComponent(eventId)}/`, {
      headers: { Authorization: `Token ${apiKey}` },
    });
    if (!res.ok) throw Object.assign(new Error(`GET event ${res.status}`), { errorCode: `HTTP_${res.status}` });
    return res.json();
  }

  async function waitForEvent(eventId, timeoutMs = EVENT_TIMEOUT_MS) {
    const start = Date.now();
    for (;;) {
      const ev = await withRetry(() => getEvent(eventId));
      stats.eventPolls++;
      if (ev.status === 'SUCCEEDED' || ev.status === 'FAILED') {
        stats.maxEventWaitMs = Math.max(stats.maxEventWaitMs, Date.now() - start);
        return ev;
      }
      if (Date.now() - start > timeoutMs) throw new Error(`Mem0 event ${eventId} still ${ev.status} after ${timeoutMs} ms`);
      await sleep(POLL_MS);
    }
  }

  const latest = latestOnly ? { latestOnly: true } : {};

  async function getAllRaw(userId, { onlyLatest = false } = {}) {
    const all = [];
    for (let page = 1; ; page++) {
      const opts = { filters: { user_id: userId }, page, pageSize: PAGE_SIZE, ...(onlyLatest ? latest : {}) };
      const res = await withRetry(() => client.getAll(opts));
      all.push(...(res.results ?? []));
      if (!res.next) return all;
    }
  }

  async function waitVisible(userId, results) {
    const present = results.filter((r) => r.event === 'ADD' || r.event === 'UPDATE').map((r) => r.id);
    const absent = results.filter((r) => r.event === 'DELETE').map((r) => r.id);
    for (let attempt = 0; attempt < VISIBLE_ATTEMPTS; attempt++) {
      const ids = new Set((await getAllRaw(userId)).map((m) => m.id));
      if (present.every((id) => ids.has(id)) && absent.every((id) => !ids.has(id))) return;
      stats.visibilityRetries++;
      await sleep(POLL_MS);
    }
    throw new Error(`Mem0 writes for ${userId} not visible after ${VISIBLE_ATTEMPTS} checks`);
  }

  return {
    name: latestOnly ? 'mem0-latest' : 'mem0',
    stats,
    async add(messages, { userId }) {
      const res = await withRetry(() => client.add(messages, { userId }));
      if (!res?.eventId) {
        throw new Error(`Mem0 add returned no eventId: ${JSON.stringify(res).slice(0, 200)}`);
      }
      let ev;
      try {
        ev = await waitForEvent(res.eventId);
      } catch (err) {
        pending.add(res.eventId);
        throw err;
      }
      if (ev.status !== 'SUCCEEDED') throw new Error(`Mem0 add event ${ev.status}: ${ev.error ?? ''}`);
      const results = ev.results ?? [];
      await waitVisible(userId, results);
      return { events: results.map((r) => ({ event: r.event, text: r.data?.memory ?? '' })) };
    },
    async getAll({ userId }) {
      return (await getAllRaw(userId, { onlyLatest: true })).map((m) => m.memory);
    },
    async search(query, { userId, limit }) {
      const res = await withRetry(() => client.search(query, { filters: { user_id: userId }, topK: limit, ...latest }));
      return (res.results ?? []).map((m) => m.memory);
    },
    async deleteAll({ userId }) {
      const res = await withRetry(() => client.deleteAll({ userId }));
      if (res?.eventId) {
        const ev = await waitForEvent(res.eventId);
        if (ev.status !== 'SUCCEEDED') throw new Error(`Mem0 deleteAll event ${ev.status}: ${ev.error ?? ''}`);
      }
      await withRetry(() => client.deleteUsers({ userId })).catch((err) => {
        if (!/HTTP_404/.test(err?.errorCode ?? '')) throw err; // no entity left is fine
      });
    },
    /** Waits for add events that timed out earlier. Returns [{ eventId, status, userId }]. */
    async settlePending() {
      const out = [];
      for (const eventId of pending) {
        try {
          const ev = await waitForEvent(eventId, SETTLE_TIMEOUT_MS);
          out.push({ eventId, status: ev.status, userId: ev.payload?.user_id ?? null });
        } catch (err) {
          out.push({ eventId, status: `unsettled: ${err.message}`, userId: null });
        }
      }
      return out;
    },
    /** All user entity names on the Mem0 project starting with `prefix` (for cleanup proof). */
    async listUsers(prefix) {
      const names = [];
      for (let page = 1; ; page++) {
        const res = await withRetry(() => client.users({ page, pageSize: PAGE_SIZE }));
        names.push(...(res.results ?? []).filter((e) => e.type === 'user').map((e) => e.name));
        if (!res.next) break;
      }
      return names.filter((n) => n.startsWith(prefix));
    },
    /** Memory count for a user, superseded ones included (for cleanup proof). */
    async count({ userId }) {
      return (await getAllRaw(userId)).length;
    },
  };
}
