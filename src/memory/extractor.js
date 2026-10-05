import { contentToText } from './messages.js';
import { CATEGORIES, EXTRACTION_PROMPT, STATUSES } from './prompts.js';

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

    const rawStatus = typeof item.status === 'string' ? item.status.trim().toLowerCase() : '';
    const status = STATUSES.includes(rawStatus) ? rawStatus : 'active';

    // The same text can legitimately appear once as active and once as ended.
    const key = `${text.toLowerCase()}|${status}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const category = typeof item.category === 'string' ? item.category.trim().toLowerCase() : '';
    result.push({ text, category: CATEGORIES.includes(category) ? category : 'other', status });
  }
  return result;
}

/** True for a message marked as context only ({ role, content, context: true }). */
export const isContextMessage = (m) => m?.context === true;

/**
 * Extracts durable facts about the user from a conversation.
 * deps.chat is the chat function of the engine's LLM client.
 * messages: [{ role, content, context? }]. Returns [{ text, category, status }],
 * where status is "active" (true now) or "ended" (the user said it is no longer true).
 *
 * Context-only messages are shown to the model so it can understand the new messages, but
 * facts are never extracted from them. A message is context-only when it has `context: true`
 * or is passed in deps.contextMessages (placed before `messages`). Without context messages
 * the prompt is exactly the same as before this option existed.
 */
export async function extractFacts(messages, { chat, contextMessages = [] } = {}) {
  if (typeof chat !== 'function') throw new Error('extractFacts: a chat function is required ({ chat }).');
  if (!Array.isArray(messages)) {
    throw new Error('extractFacts: messages must be an array of { role, content }.');
  }
  if (!Array.isArray(contextMessages)) {
    throw new Error('extractFacts: contextMessages must be an array of { role, content }.');
  }

  const context = [...contextMessages, ...messages.filter(isContextMessage)];
  const fresh = messages.filter((m) => !isContextMessage(m));

  // Facts only come from new user messages; without one there is nothing to extract.
  const hasUserText = fresh.some((m) => m?.role === 'user' && contentToText(m.content).trim());
  if (!hasUserText) return [];

  const contextText = toTranscript(context);
  const conversation = `Conversation:\n${toTranscript(fresh)}\nOutput:`;
  const user = contextText
    ? `Earlier conversation (context only: already processed; NEVER extract facts from it, use it only to understand the conversation below):\n${contextText}\n\n${conversation}`
    : conversation;

  const response = await chat({ system: EXTRACTION_PROMPT, user, json: true, temperature: 0 });

  if (!response || typeof response !== 'object' || !Array.isArray(response.facts)) {
    throw new Error(
      `extractFacts: expected {"facts": [...]}, got: ${JSON.stringify(response)}`
    );
  }

  return normalizeFacts(response.facts);
}
