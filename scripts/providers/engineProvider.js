// This repo's engine behind the provider-neutral harness interface (scripts only, not src/).
// Returns plain memory texts; getAll and search see active memories only (archived ones are
// hidden, which is what the RAG app would see).
import { createMemoryEngine } from '../runtime.js';

export function createEngineProvider({ collection }) {
  const engine = createMemoryEngine({ collection });
  return {
    name: 'engine',
    async add(messages, { userId }) {
      const { results } = await engine.add(messages, { userId });
      return { events: results.map((r) => ({ event: r.event, text: r.text })) };
    },
    async getAll({ userId }) {
      return (await engine.getAll({ userId })).results.map((m) => m.text);
    },
    async search(query, { userId, limit }) {
      return (await engine.search(query, { userId, limit })).results.map((m) => m.text);
    },
    async deleteAll({ userId }) {
      await engine.deleteAll({ userId });
    },
  };
}
