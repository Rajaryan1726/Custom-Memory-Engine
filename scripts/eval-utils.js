// Shared helpers for the eval scripts. Not used by src/.
import { mkdir, writeFile } from 'node:fs/promises';
import { QdrantClient } from '@qdrant/js-client-rest';
import config from '../src/config/index.js';

export const EVAL_COLLECTION = 'custom_user_memories_eval';
export const RESULTS_DIR = new URL('../tests/results/', import.meta.url);

export function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export async function saveResult(prefix, data) {
  await mkdir(RESULTS_DIR, { recursive: true });
  const fileName = `${prefix}-${timestampForFile()}.json`;
  await writeFile(new URL(fileName, RESULTS_DIR), JSON.stringify(data, null, 2));
  return `tests/results/${fileName}`;
}

export async function dropEvalCollection() {
  const client = new QdrantClient({ ...config.qdrant, checkCompatibility: false });
  const { exists } = await client.collectionExists(EVAL_COLLECTION);
  if (exists) await client.deleteCollection(EVAL_COLLECTION);
  return exists;
}

export async function listCollections() {
  const client = new QdrantClient({ ...config.qdrant, checkCompatibility: false });
  const { collections } = await client.getCollections();
  return collections.map((c) => c.name);
}

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function stats(values) {
  if (values.length === 0) return { n: 0 };
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    n: values.length,
    min: Math.min(...values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values),
    mean: sum / values.length,
  };
}

export const round = (x, d = 3) => (x === null || x === undefined ? x : Number(x.toFixed(d)));

export async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}
