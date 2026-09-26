// Cost and latency eval. Calls are sequential so latencies are not distorted by concurrency.
// Token usage is captured by wrapping the shared OpenAI client from src/llm/client.js
// at runtime (no source change).
import { readFile } from 'node:fs/promises';
import { EXTRACTION_PROMPT } from '../src/memory/prompts.js';
import { EVAL_COLLECTION, dropEvalCollection, listCollections, round, saveResult, stats, timed } from './eval-utils.js';
import { config, createMemoryEngine, createVectorStore, embed, embedMany, extractFacts, openai } from './runtime.js';

// Prices per 1M tokens, checked on https://developers.openai.com/api/docs/pricing on 2026-09-26 (standard tier).
const PRICING = {
  source: 'https://developers.openai.com/api/docs/pricing',
  checkedOn: '2026-09-26',
  'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.6 },
  'text-embedding-3-small': { input: 0.02 },
};

const usage = { chat: [], embeddings: [] };
const origChat = openai.chat.completions.create.bind(openai.chat.completions);
openai.chat.completions.create = async (...args) => {
  const res = await origChat(...args);
  usage.chat.push({
    prompt: res.usage?.prompt_tokens ?? 0,
    cached: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    completion: res.usage?.completion_tokens ?? 0,
    temperature: args[0]?.temperature,
  });
  return res;
};
const origEmb = openai.embeddings.create.bind(openai.embeddings);
openai.embeddings.create = async (...args) => {
  const res = await origEmb(...args);
  usage.embeddings.push({ tokens: res.usage?.total_tokens ?? 0, inputs: [].concat(args[0]?.input).length });
  return res;
};

const fmt = (s) => `p50=${s.p50.toFixed(0)}ms p95=${s.p95.toFixed(0)}ms (min ${s.min.toFixed(0)}, max ${s.max.toFixed(0)}, n=${s.n})`;

async function main() {
  if (config.openai.chatModel !== 'gpt-4o-mini') {
    console.log(`NOTE: CHAT_MODEL is ${config.openai.chatModel}; cost estimate below uses gpt-4o-mini prices.`);
  }
  const original = JSON.parse(await readFile(new URL('../tests/extraction-cases.json', import.meta.url), 'utf8'));
  const extended = JSON.parse(await readFile(new URL('../tests/extraction-cases-extended.json', import.meta.url), 'utf8'));
  const conversations = [...original, ...extended].map((c) => c.messages);

  // 1. extraction latency + tokens
  const extractionMs = [];
  const factsPerCall = [];
  for (const messages of conversations) {
    const { value, ms } = await timed(() => extractFacts(messages));
    extractionMs.push(ms);
    factsPerCall.push(value.length);
  }
  const chatCalls = usage.chat.splice(0);

  // 2. embedding latency: single query-sized text, and a batch of 3 facts (typical add)
  const embedSingleMs = [];
  for (let i = 0; i < 20; i++) embedSingleMs.push((await timed(() => embed(`which module is the student on? ${i}`))).ms);
  const embedBatchMs = [];
  for (let i = 0; i < 10; i++) {
    embedBatchMs.push((await timed(() => embedMany([`User is on Module ${i}`, 'User struggles with recursion', 'User prefers code examples']))).ms);
  }

  // 3. search latency: Qdrant only (precomputed vector) and end-to-end engine.search (embed + Qdrant)
  await dropEvalCollection();
  const store = createVectorStore({ collection: EVAL_COLLECTION });
  await store.ensureCollection();
  const texts = Array.from({ length: 10 }, (_, i) => `User memory number ${i} about topic ${i}`);
  const vecs = await embedMany(texts);
  await store.addMemories('perf_user', texts.map((text, i) => ({ text, vector: vecs[i], category: 'other' })));
  const qVec = await embed('what does the user struggle with?');
  const qdrantSearchMs = [];
  for (let i = 0; i < 30; i++) qdrantSearchMs.push((await timed(() => store.search('perf_user', qVec, { limit: 5 }))).ms);
  const engine = createMemoryEngine({ collection: EVAL_COLLECTION });
  await engine.getAll({ userId: 'perf_user' }); // warm up lazy ensureCollection
  const engineSearchMs = [];
  for (let i = 0; i < 20; i++) engineSearchMs.push((await timed(() => engine.search(`what does the user struggle with ${i}?`, { userId: 'perf_user' }))).ms);

  // 4. end-to-end add() latency on a typical 1-message input
  const addMs = [];
  for (let i = 0; i < 10; i++) {
    addMs.push((await timed(() => engine.add([{ role: 'user', content: `Main abhi Module ${i + 1} pe hoon aur mujhe graphs mein dikkat hai` }], { userId: 'perf_add_user' }))).ms);
  }
  const addEmbeddingCalls = usage.embeddings.slice(-10);

  // tokens + cost
  const promptTokens = chatCalls.map((c) => c.prompt);
  const completionTokens = chatCalls.map((c) => c.completion);
  const cachedTokens = chatCalls.map((c) => c.cached);
  const p = PRICING['gpt-4o-mini'];
  const e = PRICING['text-embedding-3-small'];
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

  const avgPrompt = avg(promptTokens);
  const avgCached = avg(cachedTokens);
  const avgCompletion = avg(completionTokens);
  const extractionCost = ((avgPrompt - avgCached) * p.input + avgCached * p.cachedInput + avgCompletion * p.output) / 1e6;
  const avgFactEmbedTokens = avg(addEmbeddingCalls.map((c) => c.tokens));
  const factEmbedCost = (avgFactEmbedTokens * e.input) / 1e6;
  const queryEmbedTokens = 12; // a typical short query, see embed usage above
  const queryEmbedCost = (queryEmbedTokens * e.input) / 1e6;
  const perMessage = extractionCost + factEmbedCost + queryEmbedCost;

  // Scenario B: the app sends the last 6 messages as context on every add (a common pattern).
  const multiTurn = conversations.filter((m) => m.length >= 6);
  const perMsgTokensInMultiTurn = chatCalls
    .filter((_, i) => conversations[i].length >= 6)
    .map((c) => c.prompt);

  const systemPromptChars = EXTRACTION_PROMPT.length;

  const result = {
    runAt: new Date().toISOString(),
    model: config.openai.chatModel,
    extraction: {
      calls: chatCalls.length,
      temperatureSent: [...new Set(chatCalls.map((c) => c.temperature))],
      latencyMs: stats(extractionMs),
      promptTokens: stats(promptTokens),
      completionTokens: stats(completionTokens),
      cachedTokens: stats(cachedTokens),
      factsPerCall: stats(factsPerCall),
      systemPromptChars,
      multiTurnPromptTokens: stats(perMsgTokensInMultiTurn),
      multiTurnConversations: multiTurn.length,
    },
    embedding: { singleMs: stats(embedSingleMs), batchOf3Ms: stats(embedBatchMs), avgTokensPerAddBatch: avgFactEmbedTokens },
    search: { qdrantOnlyMs: stats(qdrantSearchMs), engineSearchMs: stats(engineSearchMs) },
    add: { endToEndMs: stats(addMs) },
    pricing: PRICING,
    cost: {
      assumptions:
        'One add() per user message (1 extraction call + 1 embedding batch for its facts) and one search() per user message (1 query embedding). Token averages from this run.',
      perMessageUsd: perMessage,
      per1000MessagesUsd: perMessage * 1000,
      breakdownPer1000Usd: { extraction: extractionCost * 1000, factEmbedding: factEmbedCost * 1000, queryEmbedding: queryEmbedCost * 1000 },
    },
  };

  console.log(`Model: ${result.model}; extraction temperature sent: ${JSON.stringify(result.extraction.temperatureSent)}`);
  console.log(`\nExtraction latency (${chatCalls.length} calls):   ${fmt(result.extraction.latencyMs)}`);
  console.log(`Embedding latency, 1 text:          ${fmt(result.embedding.singleMs)}`);
  console.log(`Embedding latency, batch of 3:      ${fmt(result.embedding.batchOf3Ms)}`);
  console.log(`Search latency, Qdrant only:        ${fmt(result.search.qdrantOnlyMs)}`);
  console.log(`Search latency, engine (embed+Qdrant): ${fmt(result.search.engineSearchMs)}`);
  console.log(`add() end-to-end, 1 message:        ${fmt(result.add.endToEndMs)}`);
  console.log(`\nTokens per extraction: prompt p50=${result.extraction.promptTokens.p50} (min ${result.extraction.promptTokens.min}, max ${result.extraction.promptTokens.max}), completion p50=${result.extraction.completionTokens.p50}, cached p50=${result.extraction.cachedTokens.p50}`);
  console.log(`  multi-turn (6+ msgs) prompt tokens: p50=${result.extraction.multiTurnPromptTokens.p50} max=${result.extraction.multiTurnPromptTokens.max}`);
  console.log(`  facts per call: mean=${result.extraction.factsPerCall.mean.toFixed(2)}`);
  console.log(`\nCost per 1,000 user messages: $${result.cost.per1000MessagesUsd.toFixed(4)}`);
  for (const [k, v] of Object.entries(result.cost.breakdownPer1000Usd)) console.log(`  ${k}: $${v.toFixed(4)}`);
  console.log(`  (prices: ${PRICING.source}, checked ${PRICING.checkedOn})`);

  const file = await saveResult('perf', result);
  console.log(`\nSaved to ${file}`);
}

try {
  await main();
} catch (err) {
  console.error('eval-perf failed:', err.message);
  process.exitCode = 1;
} finally {
  await dropEvalCollection();
  console.log(`Collections after cleanup: ${JSON.stringify(await listCollections())}`);
}
