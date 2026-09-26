import config from '../config/index.js';
import { openai, withRetry } from './client.js';

function assertText(text, label) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(`${label}: text must be a non-empty, non-whitespace string.`);
  }
}

function assertDimensions(vectors) {
  const expected = config.openai.embeddingDim;
  for (const vector of vectors) {
    if (vector.length !== expected) {
      throw new Error(
        `Embedding model "${config.openai.embeddingModel}" returned ${vector.length}-dim vectors, ` +
          `but EMBEDDING_DIM is ${expected}. The embedding model and EMBEDDING_DIM do not match.`
      );
    }
  }
}

/**
 * Embeds all texts in a single API call.
 * Returns one vector per input, in the same order as the input.
 */
export async function embedMany(texts) {
  if (!Array.isArray(texts)) throw new Error('embedMany(): texts must be an array.');
  if (texts.length === 0) return [];
  texts.forEach((t, i) => assertText(t, `embedMany() item ${i}`));

  const response = await withRetry(() =>
    openai.embeddings.create({ model: config.openai.embeddingModel, input: texts })
  );

  // Sort by index so the output order is guaranteed to match the input.
  const vectors = [...response.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  if (vectors.length !== texts.length) {
    throw new Error(`embedMany(): expected ${texts.length} vectors, got ${vectors.length}.`);
  }
  assertDimensions(vectors);
  return vectors;
}

/** Embeds a single text and returns its vector. */
export async function embed(text) {
  assertText(text, 'embed()');
  const [vector] = await embedMany([text]);
  return vector;
}
