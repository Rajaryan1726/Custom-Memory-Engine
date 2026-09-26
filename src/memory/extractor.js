import { chat } from '../llm/client.js';
import { contentToText } from './messages.js';
import { CATEGORIES, EXTRACTION_PROMPT } from './prompts.js';

function toTranscript(messages) {
  return messages
    .filter((m) => m?.role === 'user' || m?.role === 'assistant')
    .map((m) => ({ role: m.role, text: contentToText(m.content).trim() }))
    .filter((m) => m.text)
    .map((m) => `${m.role}: ${m.text}`)
    .join('\n');
}

function normalizeFacts(facts) {
  const seen = new Set();
  const result = [];
  for (const item of facts) {
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    if (!text) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const category = typeof item.category === 'string' ? item.category.trim().toLowerCase() : '';
    result.push({ text, category: CATEGORIES.includes(category) ? category : 'other' });
  }
  return result;
}

/**
 * Extracts durable facts about the user from a conversation.
 * messages: [{ role, content }]. Returns [{ text, category }].
 */
export async function extractFacts(messages) {
  if (!Array.isArray(messages)) {
    throw new Error('extractFacts: messages must be an array of { role, content }.');
  }

  // Facts only come from the user; without a user message there is nothing to extract.
  const hasUserText = messages.some(
    (m) => m?.role === 'user' && contentToText(m.content).trim()
  );
  if (!hasUserText) return [];

  const response = await chat({
    system: EXTRACTION_PROMPT,
    user: `Conversation:\n${toTranscript(messages)}\nOutput:`,
    json: true,
    temperature: 0,
  });

  if (!response || typeof response !== 'object' || !Array.isArray(response.facts)) {
    throw new Error(
      `extractFacts: expected {"facts": [...]}, got: ${JSON.stringify(response)}`
    );
  }

  return normalizeFacts(response.facts);
}
