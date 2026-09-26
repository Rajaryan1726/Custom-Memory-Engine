import 'dotenv/config';

const REQUIRED = [
  'QDRANT_URL',
  'OPENAI_API_KEY',
  'CHAT_MODEL',
  'EMBEDDING_MODEL',
  'EMBEDDING_DIM',
  'MEMORY_COLLECTION',
];

const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(', ')}. ` +
      'Copy .env.example to .env and fill them in.'
  );
}

const embeddingDim = Number.parseInt(process.env.EMBEDDING_DIM, 10);
if (!Number.isInteger(embeddingDim) || embeddingDim <= 0) {
  throw new Error(
    `EMBEDDING_DIM must be a positive integer, got "${process.env.EMBEDDING_DIM}".`
  );
}

const qdrantApiKey = process.env.QDRANT_API_KEY?.trim();

// Optional. Minimum similarity for memories injected by getContext(); default from the Phase 4 retrieval eval.
const rawThreshold = process.env.MEMORY_SCORE_THRESHOLD?.trim();
const scoreThreshold = rawThreshold ? Number.parseFloat(rawThreshold) : 0.22;
if (!Number.isFinite(scoreThreshold) || scoreThreshold < -1 || scoreThreshold > 1) {
  throw new Error(`MEMORY_SCORE_THRESHOLD must be a number between -1 and 1, got "${rawThreshold}".`);
}

const config = Object.freeze({
  qdrant: Object.freeze({
    url: process.env.QDRANT_URL.trim(),
    // Only present when set, so it can be spread straight into the client options.
    ...(qdrantApiKey ? { apiKey: qdrantApiKey } : {}),
  }),
  openai: Object.freeze({
    apiKey: process.env.OPENAI_API_KEY.trim(),
    chatModel: process.env.CHAT_MODEL.trim(),
    // Used only by the eval judge. Optional, defaults to gpt-4o-mini.
    judgeModel: process.env.JUDGE_MODEL?.trim() || 'gpt-4o-mini',
    embeddingModel: process.env.EMBEDDING_MODEL.trim(),
    embeddingDim,
  }),
  memory: Object.freeze({
    collection: process.env.MEMORY_COLLECTION.trim(),
    scoreThreshold,
  }),
});

export default config;
