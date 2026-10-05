// Config handling. Library code never reads process.env or loads .env files:
// - validateConfig() normalises the explicit config object passed to createMemoryEngine().
// - loadConfigFromEnv() builds that object from environment variables. It only runs when
//   called (scripts call it after loading .env themselves); nothing here runs at import time.

const DEFAULT_SCORE_THRESHOLD = 0.22; // from the Phase 4 retrieval eval

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Validates and normalises an engine config:
 *   { openai: { apiKey, chatModel, embeddingModel, embeddingDim, judgeModel? },
 *     qdrant: { url, apiKey? }, collection, scoreThreshold? }
 * `collection` may be given separately (it overrides config.collection).
 * `injected` says which clients the caller passed in, so the matching fields are optional:
 *   chat: a chat function was injected -> chatModel not required
 *   embed: an embed function was injected -> embeddingModel not required
 *   openai: an OpenAI SDK client was injected -> apiKey not required
 *   (apiKey is also not required when both chat and embed are injected)
 * embeddingDim is always required (it sizes the Qdrant collection).
 * Throws one error naming every missing or invalid field. Returns a new frozen object.
 */
export function validateConfig(config, { collection, label = 'createMemoryEngine', injected = {} } = {}) {
  if (!config || typeof config !== 'object') {
    throw new Error(`${label}: "config" is required: { openai: { apiKey, chatModel, embeddingModel, embeddingDim }, qdrant: { url }, collection }.`);
  }
  const openai = config.openai ?? {};
  const qdrant = config.qdrant ?? {};
  const problems = [];

  const required = {
    apiKey: !injected.openai && !(injected.chat && injected.embed),
    chatModel: !injected.chat,
    embeddingModel: !injected.embed,
  };
  for (const [field, isRequired] of Object.entries(required)) {
    const value = openai[field];
    if (isRequired ? !isNonEmptyString(value) : value !== undefined && value !== null && typeof value !== 'string') {
      problems.push(`config.openai.${field} is ${isRequired ? 'required (non-empty string)' : 'optional but must be a string when set'}`);
    }
  }
  if (!Number.isInteger(openai.embeddingDim) || openai.embeddingDim <= 0) {
    problems.push(`config.openai.embeddingDim is required (positive integer, got ${JSON.stringify(openai.embeddingDim)})`);
  }
  if (!isNonEmptyString(qdrant.url)) problems.push('config.qdrant.url is required (non-empty string)');
  if (qdrant.apiKey !== undefined && qdrant.apiKey !== null && typeof qdrant.apiKey !== 'string') {
    problems.push('config.qdrant.apiKey must be a string when set');
  }

  const finalCollection = collection ?? config.collection;
  if (!isNonEmptyString(finalCollection)) problems.push('config.collection is required (non-empty string), or pass { collection }');

  const scoreThreshold = config.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  if (typeof scoreThreshold !== 'number' || !Number.isFinite(scoreThreshold) || scoreThreshold < -1 || scoreThreshold > 1) {
    problems.push(`config.scoreThreshold must be a number between -1 and 1 (got ${JSON.stringify(config.scoreThreshold)})`);
  }

  if (problems.length > 0) throw new Error(`${label}: invalid config: ${problems.join('; ')}.`);

  const qdrantApiKey = isNonEmptyString(qdrant.apiKey) ? qdrant.apiKey.trim() : undefined;
  return Object.freeze({
    openai: Object.freeze({
      // Only present when set (they are optional when clients are injected).
      ...(isNonEmptyString(openai.apiKey) ? { apiKey: openai.apiKey.trim() } : {}),
      ...(isNonEmptyString(openai.chatModel) ? { chatModel: openai.chatModel.trim() } : {}),
      ...(isNonEmptyString(openai.embeddingModel) ? { embeddingModel: openai.embeddingModel.trim() } : {}),
      embeddingDim: openai.embeddingDim,
      ...(isNonEmptyString(openai.judgeModel) ? { judgeModel: openai.judgeModel.trim() } : {}),
    }),
    qdrant: Object.freeze({
      url: qdrant.url.trim(),
      // Only present when set, so it can be spread straight into the client options.
      ...(qdrantApiKey ? { apiKey: qdrantApiKey } : {}),
    }),
    collection: finalCollection.trim(),
    scoreThreshold,
  });
}

const REQUIRED_ENV = ['QDRANT_URL', 'OPENAI_API_KEY', 'CHAT_MODEL', 'EMBEDDING_MODEL', 'EMBEDDING_DIM', 'MEMORY_COLLECTION'];

/**
 * Builds an engine config from environment variables (this repo's variable names).
 * Does not load .env itself: call dotenv first if you need it (the scripts do).
 * `env` defaults to process.env and is only read when this function is called.
 */
export function loadConfigFromEnv(env = process.env) {
  const missing = REQUIRED_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. Copy .env.example to .env and fill them in.`
    );
  }

  const embeddingDim = Number.parseInt(env.EMBEDDING_DIM, 10);
  if (!Number.isInteger(embeddingDim) || embeddingDim <= 0) {
    throw new Error(`EMBEDDING_DIM must be a positive integer, got "${env.EMBEDDING_DIM}".`);
  }

  const rawThreshold = env.MEMORY_SCORE_THRESHOLD?.trim();
  const scoreThreshold = rawThreshold ? Number.parseFloat(rawThreshold) : DEFAULT_SCORE_THRESHOLD;
  if (!Number.isFinite(scoreThreshold) || scoreThreshold < -1 || scoreThreshold > 1) {
    throw new Error(`MEMORY_SCORE_THRESHOLD must be a number between -1 and 1, got "${rawThreshold}".`);
  }

  return validateConfig(
    {
      openai: {
        apiKey: env.OPENAI_API_KEY,
        chatModel: env.CHAT_MODEL,
        embeddingModel: env.EMBEDDING_MODEL,
        embeddingDim,
        // Used only by the eval judge. Optional, defaults to gpt-4o-mini.
        judgeModel: env.JUDGE_MODEL?.trim() || 'gpt-4o-mini',
      },
      qdrant: { url: env.QDRANT_URL, apiKey: env.QDRANT_API_KEY },
      collection: env.MEMORY_COLLECTION,
      scoreThreshold,
    },
    { label: 'loadConfigFromEnv' }
  );
}
