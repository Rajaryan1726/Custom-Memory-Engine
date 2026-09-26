import { withRetry } from './client.js';

function assertText(text, label) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(`${label}: text must be a non-empty, non-whitespace string.`);
  }
}

/**
 * Creates embed functions for one engine instance.
 * `openai` is the SDK client from createLlmClient(). Returns { embed, embedMany }.
 */
export function createEmbedder({ openai, embeddingModel, embeddingDim }) {
  function assertDimensions(vectors) {
    for (const vector of vectors) {
      if (vector.length !== embeddingDim) {
        throw new Error(
          `Embedding model "${embeddingModel}" returned ${vector.length}-dim vectors, ` +
            `but EMBEDDING_DIM is ${embeddingDim}. The embedding model and EMBEDDING_DIM do not match.`
        );
      }
    }
  }

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
    assertDimensions(vectors);
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
