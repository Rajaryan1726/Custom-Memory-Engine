// Shared runtime for the scripts in this repo (not part of the library).
// Loads .env, builds the config with loadConfigFromEnv(), and creates ONE OpenAI client
// that every script-created engine shares, so eval scripts can instrument its calls.
import 'dotenv/config';
import { QdrantClient } from '@qdrant/js-client-rest';
import { createMemoryEngine as createEngine, loadConfigFromEnv } from '../src/index.js';
import { createLlmClient } from '../src/llm/client.js';
import { createEmbedder } from '../src/llm/embed.js';
import { extractFacts as extract } from '../src/memory/extractor.js';
import { createVectorStore as createStore } from '../src/stores/vectorStore.js';

export const config = loadConfigFromEnv();

export const llm = createLlmClient({ apiKey: config.openai.apiKey, chatModel: config.openai.chatModel });
export const { openai, chat } = llm;
export const { embed, embedMany } = createEmbedder({
  openai,
  embeddingModel: config.openai.embeddingModel,
  embeddingDim: config.openai.embeddingDim,
});

/** extractFacts with this runtime's chat client. */
export const extractFacts = (messages) => extract(messages, { chat });

/** A vector store on this runtime's Qdrant; collection defaults to MEMORY_COLLECTION. */
export function createVectorStore({ collection = config.collection } = {}) {
  return createStore({ qdrant: config.qdrant, embeddingDim: config.openai.embeddingDim, collection });
}

/** An engine using this runtime's config and shared LLM client. */
export function createMemoryEngine(options = {}) {
  return createEngine({ config, llm, ...options });
}

/** A raw Qdrant client, for collection admin in scripts (create/drop/list). */
export function createQdrantClient() {
  return new QdrantClient({ ...config.qdrant, checkCompatibility: false });
}
