import { DECIDER_ACTIONS, DECIDER_PROMPT } from './prompts.js';


/** Action used when the model's answer for a fact cannot be used. */
function fallbackFor(fact) {
  return fact.status === 'ended' ? { action: 'NOOP', memoryId: null } : { action: 'ADD', memoryId: null };
}

function buildInput(facts, shortIds) {
  const factLines = facts.map((f, i) => `${i}. [${f.category}] (${f.status}) ${f.text}`);
  const memoryLines = [...shortIds.entries()].map(([shortId, m]) => `${shortId}. [${m.category}] ${m.text}`);
  return `New facts:\n${factLines.join('\n')}\nExisting memories:\n${memoryLines.join('\n') || '(none)'}\nOutput:`;
}

/**
 * Decides what to do with each new fact given related existing memories.
 *
 * facts:      [{ text, category, status }]
 * candidates: [{ id, text, category }] existing memories (real ids), deduplicated
 *
 * Returns one action per fact, in fact order:
 *   [{ action: 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP', memoryId: <real id or null>, text }]
 * text is the final memory text for UPDATE, otherwise the fact text.
 * Invalid model output never throws; it falls back (see fallbackFor) and is logged.
 * Exception: DELETE of an existing memory for an active fact becomes an UPDATE of that memory
 * with the fact text (also logged as a fallback).
 * deps.chat is the engine's chat function. deps.logger: { warn(message, details) }; messages
 * never contain fact or memory text (that goes in details), defaults to console.warn.
 */
export async function decide(facts, candidates, { chat, logger = { warn: (message) => console.warn(message) } } = {}) {
  if (typeof chat !== 'function') throw new Error('decide: a chat function is required ({ chat }).');
  const warn = (reason, details) => logger.warn(`[decider fallback] ${reason}`, details);
  // Short ids keep the prompt small and stop the model from mangling UUIDs.
  const shortIds = new Map(candidates.map((m, i) => [`m${i + 1}`, m]));

  const response = await chat({
    system: DECIDER_PROMPT,
    user: buildInput(facts, shortIds),
    json: true,
    temperature: 0,
  });

  const raw = Array.isArray(response?.actions) ? response.actions : [];
  if (!Array.isArray(response?.actions)) {
    warn('response has no "actions" array', { response });
  }

  // First answer per fact index wins.
  const byFact = new Map();
  for (const a of raw) {
    const idx = Number(a?.fact);
    if (!Number.isInteger(idx) || idx < 0 || idx >= facts.length) {
      warn(`action for unknown fact index ${JSON.stringify(a?.fact)}`, { action: a });
      continue;
    }
    if (byFact.has(idx)) {
      warn(`fact ${idx} has more than one action, keeping the first`, { action: a });
      continue;
    }
    byFact.set(idx, a);
  }

  const targeted = new Set(); // real memory ids already targeted by UPDATE/DELETE
  return facts.map((fact, i) => {
    const a = byFact.get(i);
    const fallback = (reason) => {
      warn(`fact ${i} (${fact.status}): ${reason}; using ${fallbackFor(fact).action}`, { factIndex: i, factText: fact.text, action: a });
      return { ...fallbackFor(fact), text: fact.text };
    };

    if (!a) return fallback('no action returned');
    const action = typeof a.action === 'string' ? a.action.trim().toUpperCase() : '';
    if (!DECIDER_ACTIONS.includes(action)) return fallback(`unknown action ${JSON.stringify(a.action)}`);

    const shortId = typeof a.memory === 'string' && a.memory.trim() ? a.memory.trim() : null;
    if (shortId && !shortIds.has(shortId)) return fallback(`memory id ${JSON.stringify(shortId)} was not in the input`);
    const memoryId = shortId ? shortIds.get(shortId).id : null;

    if (fact.status === 'ended' && (action === 'ADD' || action === 'UPDATE')) {
      return fallback(`${action} is not allowed for an ended fact`);
    }
    if (action === 'DELETE' && fact.status !== 'ended') {
      // The model wants the target gone because this active fact replaces it (e.g. "User has
      // completed stacks" vs "User is studying stacks"). Falling back to ADD would keep the stale
      // memory, so the target is updated to the fact's text instead; the old text stays in its history.
      if (!memoryId) return fallback('DELETE is only allowed for an ended fact');
      if (targeted.has(memoryId)) return fallback(`memory ${shortId} is already targeted by another action`);
      targeted.add(memoryId);
      warn(`fact ${i} (${fact.status}): DELETE is only allowed for an ended fact; using UPDATE of ${shortId} with the fact text`, {
        factIndex: i,
        factText: fact.text,
        action: a,
      });
      return { action: 'UPDATE', memoryId, text: fact.text };
    }

    if (action === 'ADD') return { action, memoryId: null, text: fact.text };
    if (action === 'NOOP') return { action, memoryId, text: fact.text };

    // UPDATE / DELETE need a target that no other fact has claimed.
    if (!memoryId) return fallback(`${action} without a memory id`);
    if (targeted.has(memoryId)) return fallback(`memory ${shortId} is already targeted by another action`);
    targeted.add(memoryId);

    if (action === 'DELETE') return { action, memoryId, text: fact.text };

    let text = typeof a.text === 'string' ? a.text.trim() : '';
    if (!text) {
      warn(`fact ${i}: UPDATE without text; using the fact text`, { factIndex: i, factText: fact.text, action: a });
      text = fact.text;
    }
    return { action, memoryId, text };
  });
}
