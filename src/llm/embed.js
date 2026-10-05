import { withRetry } from './client.js';

function assertText(text, label) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(`${label}: text must be a non-empty, non-whitespace string.`);
  }
}

function assertDimensions(vectors, embeddingDim, source) {
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== embeddingDim) {
      throw new Error(
        `${source} returned ${Array.isArray(vector) ? `${vector.length}-dim vectors` : 'a non-array vector'}, ` +
          `but embeddingDim is ${embeddingDim}. The embedding model and embeddingDim do not match.`
      );
    }
  }
}

/**
 * Creates embed functions for one engine instance.
 * `openai` is the SDK client from createLlmClient(). Returns { embed, embedMany }.
 */
export function createEmbedder({ openai, embeddingModel, embeddingDim }) {
  /**
   * Embeds all texts in a single API call.
   * Returns one vector per input, in the same order as the input.
   */
  async function embedMany(texts) {
    if (!Array.isArray(texts)) throw new Error('embedMany(): texts must be an array.');
    if (texts.length === 0) return [];
    texts.forEach((t, i) => assertText(t, `embedMany() item ${i}`));

    const response = await withRetry(() => openai.embeddings.create({ model: embeddingModel, input: texts }));

    // Sort by index so the output order is guaranteed to match the input.
    const vectors = [...response.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (vectors.length !== texts.length) {
      throw new Error(`embedMany(): expected ${texts.length} vectors, got ${vectors.length}.`);
    }
    assertDimensions(vectors, embeddingDim, `Embedding model "${embeddingModel}"`);
    return vectors;
  }

  /** Embeds a single text and returns its vector. */
  async function embed(text) {
    assertText(text, 'embed()');
    const [vector] = await embedMany([text]);
    return vector;
  }

  return { embed, embedMany };
}

/**
 * Creates embed functions around a caller-supplied embed(texts) -> number[][] (one vector per
 * text, same order). Same interface and checks as createEmbedder(). Returns { embed, embedMany }.
 */
export function createInjectedEmbedder({ embed: embedTexts, embeddingDim }) {
  async function embedMany(texts) {
    if (!Array.isArray(texts)) throw new Error('embedMany(): texts must be an array.');
    if (texts.length === 0) return [];
    texts.forEach((t, i) => assertText(t, `embedMany() item ${i}`));

    const vectors = await embedTexts(texts);
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      throw new Error(`embedMany(): injected embed returned ${Array.isArray(vectors) ? vectors.length : 'no'} vectors for ${texts.length} texts.`);
    }
    assertDimensions(vectors, embeddingDim, 'Injected embed');
    return vectors;
  }

  async function embed(text) {
    assertText(text, 'embed()');
    const [vector] = await embedMany([text]);
    return vector;
  }

  return { embed, embedMany };
}
