// Provider-neutral LLM judge for the engine-vs-Mem0 comparison (Phase 7c-1).
// It only ever sees plain memory texts: never categories, status, events, scores or which
// provider produced them. Same model (gpt-4o), temperature 0 and prompts for both providers.
// Shares the concurrency limiter and 429 retry of scripts/judge.js.
import { limited, transcript, withRateLimitRetry } from './judge.js';
import { chat } from './runtime.js';

export const NEUTRAL_JUDGE_MODEL = 'gpt-4o';
const MAX_MEMORY_CHARS = 1500; // very long memory texts are cut the same way for both providers

// Mem0 stamps memories with dates ("as of 2026-09-27"); without today's date the judge calls them future dates.
const TODAY = new Date().toISOString().slice(0, 10);
const DATE_NOTE = `Today's date is ${TODAY}. Dates or "as of" notes in a memory are fine and are not a reason to mark it wrong.`;

const clip = (text) =>
  text.length > MAX_MEMORY_CHARS ? `${text.slice(0, MAX_MEMORY_CHARS)} [...cut, ${text.length} characters in total]` : text;

const MEMORY_CHECK_PROMPT = `You evaluate a long-term memory system for an online coding course.
The system read a conversation between a student ("user") and a tutor ("assistant") and stored memories about the student.

You receive the conversation and ONE stored memory. Decide whether it is a correct long-term memory about the student.

The memory is "wrong" if ANY of these is true:
1. Wrong person: it is about someone other than the student (a friend, sibling, classmate, the tutor).
2. Past as current: it states something the student says is in the past or has changed as if it were true now.
3. Negation or sarcasm read literally: it states the opposite of what the student means.
4. Hypothetical as real: it records something the student only imagined or asked about.
5. Not durable: it is small talk, a greeting, a one-off request for the current answer, or a course question, not a lasting fact about the student.
6. Not supported: the conversation does not say or clearly imply it.
7. Garbled: the text is corrupted, heavily repeated or unreadable.

A memory that correctly says something is no longer true (e.g. "Student no longer struggles with DP") is correct if the student said so.
Otherwise the memory is "correct". Wording does not matter.
${DATE_NOTE}

Return ONLY JSON: {"verdict": "correct" | "wrong", "reason": "short reason"}`;

const SCENARIO_CHECK_PROMPT = `You evaluate a long-term memory system for an online coding course.
You receive the final list of memories the system holds about one student, and the expected state in plain English.
Decide whether the memory list satisfies the expected state.

- Judge by meaning, not wording.
- Memories that are not mentioned in the expected state are fine unless they contradict it.
- If the expected state says something must not be stored or must not be said, any memory saying it makes the check fail.
- If the list is described as search results in rank order, "first result" means item 1.
- ${DATE_NOTE}

Return ONLY JSON: {"verdict": "pass" | "fail", "reason": "short reason"}`;

const ASSERTION_CHECK_PROMPT = `You evaluate a long-term memory system for an online coding course.
You receive ONE stored memory about a student and a claim.
Decide whether the memory states that the claim is true about the student right now.

- "yes" only if the memory presents the claim as currently true about the student.
- "no" if the memory says the opposite, says it is no longer true, puts it in the past, attributes it to someone else, or does not mention it.

Return ONLY JSON: {"asserts": "yes" | "no", "reason": "short reason"}`;

async function ask(system, user) {
  return limited(() => withRateLimitRetry(() => chat({ model: NEUTRAL_JUDGE_MODEL, system, user, json: true, temperature: 0 })));
}

const numbered = (memories) => (memories.length ? memories.map((m, i) => `${i + 1}. ${clip(m)}`).join('\n') : '(no memories)');

/** Is this stored memory correct for this conversation? -> { verdict: correct|wrong|unjudged, reason } */
export async function checkMemory(messages, memory) {
  const r = await ask(MEMORY_CHECK_PROMPT, `Conversation:\n${transcript(messages)}\n\nStored memory:\n${clip(memory)}`);
  const verdict = r?.verdict === 'correct' || r?.verdict === 'wrong' ? r.verdict : 'unjudged';
  return { verdict, reason: typeof r?.reason === 'string' ? r.reason : JSON.stringify(r) };
}

/** Does the final memory list satisfy the expected state? -> { verdict: pass|fail|unjudged, reason } */
export async function checkScenario(memories, expected, { label = 'Memories about the student' } = {}) {
  const r = await ask(SCENARIO_CHECK_PROMPT, `${label}:\n${numbered(memories)}\n\nExpected state:\n${expected}`);
  const verdict = r?.verdict === 'pass' || r?.verdict === 'fail' ? r.verdict : 'unjudged';
  return { verdict, reason: typeof r?.reason === 'string' ? r.reason : JSON.stringify(r) };
}

/** Does this memory assert the claim as currently true? -> { asserts: boolean|null, reason } */
export async function checkAssertion(memory, claim) {
  const r = await ask(ASSERTION_CHECK_PROMPT, `Stored memory:\n${clip(memory)}\n\nClaim:\n${claim}`);
  const asserts = r?.asserts === 'yes' ? true : r?.asserts === 'no' ? false : null;
  return { asserts, reason: typeof r?.reason === 'string' ? r.reason : JSON.stringify(r) };
}
