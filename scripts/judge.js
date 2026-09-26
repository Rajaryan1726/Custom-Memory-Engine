// LLM judge for extraction evals. Grades ONE extracted fact per call against the
// conversation, so facts cannot influence each other's verdicts. The judge only
// decides precision (correct / wrong); recall comes from the keyword scorer.
import { contentToText } from '../src/memory/messages.js';
import { chat, config } from './runtime.js';

const MAX_CONCURRENT = 3;

const JUDGE_PROMPT = `You are a strict evaluator of a memory-extraction system for an online coding course.
The system reads a conversation between a student ("user") and a tutor ("assistant") and extracts long-term facts about the student.

You receive the conversation and ONE extracted fact with its category and status. Decide whether the fact is correct.

Status:
- "active": the fact is claimed to be true now.
- "ended": the fact is claimed to be NO LONGER true. The text describes what used to be true (e.g. "User struggles with dynamic programming (DP)"), with the category it had while it was true. An "ended" fact is correct if the user said that thing is no longer true. It is wrong if the user did not say it ended.

The fact is "wrong" if ANY of these is true:
1. Wrong polarity: it states the opposite of what the user means. This includes negations read wrongly (e.g. the user says they no longer struggle with a topic, but the fact is filed as a current weak topic) and sarcasm or jokes read literally.
2. Wrong person: it is about someone other than the user (a friend, sibling, classmate, the tutor), even if it is phrased as "User's sister ...".
3. Past as current: it records a state the user says is in the past or has changed (e.g. "was on Module 2 last week", "initially wanted ...") as a fact to remember.
4. Hypothetical as real: it records something the user only imagined or asked about ("if I were on Module 5 ...").
5. Wrong category. Categories:
   - identity: who the user is (name, nickname, year, college, background)
   - progress: where the user currently is in the course, or what they have completed or are studying
   - weak_topic: a course or technical topic the user currently struggles with. Difficulty with a human language (e.g. English) is NOT a weak_topic.
   - preference: how the user likes to learn (language, explanation style, format, examples, pace)
   - goal: what the user currently wants to achieve
   - other: any other durable fact about the user. A language difficulty stored under category other (e.g. "User finds technical terms in English hard to understand") is correct.
6. Not supported: the conversation does not say or clearly imply it.

Otherwise the fact is "correct". Minor wording differences are fine.

Return ONLY JSON of this form:
{"verdict": "correct" | "wrong", "reason": "short reason"}`;

// Global limiter: at most MAX_CONCURRENT judge calls in flight across all cases.
let active = 0;
const waiting = [];
async function limited(fn) {
  if (active >= MAX_CONCURRENT) {
    await new Promise((resolve) => waiting.push(resolve)); // slot is handed over on release
  } else {
    active++;
  }
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

// The judge model often has a low tokens-per-minute limit (e.g. 30k TPM for gpt-4o on
// lower tiers). chat() only retries briefly, so the judge adds its own patient 429 retry
// that honours the server's retry-after hint. Other errors are thrown at once.
const RATE_LIMIT_ATTEMPTS = 6;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(err, attempt) {
  const h = err?.headers;
  const get = (name) => (typeof h?.get === 'function' ? h.get(name) : h?.[name]);
  const ms = Number(get('retry-after-ms')) || Number(get('retry-after')) * 1000;
  return (Number.isFinite(ms) && ms > 0 ? ms : 2000 * 2 ** attempt) + 250;
}

async function withRateLimitRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err?.status !== 429 || attempt >= RATE_LIMIT_ATTEMPTS - 1) throw err;
      await sleep(retryAfterMs(err, attempt));
    }
  }
}

function transcript(messages) {
  return messages
    .map((m) => ({ role: m?.role, text: contentToText(m?.content).trim() }))
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text)
    .map((m) => `${m.role}: ${m.text}`)
    .join('\n');
}

/** Judges one fact. Returns { verdict: "correct" | "wrong" | "unjudged", reason }. */
export async function judgeFact(messages, fact) {
  const response = await limited(() =>
    withRateLimitRetry(() =>
      chat({
        model: config.openai.judgeModel,
        system: JUDGE_PROMPT,
        user: `Conversation:\n${transcript(messages)}\n\nExtracted fact:\n[${fact.category}] (status: ${fact.status ?? 'active'}) ${fact.text}`,
        json: true,
        temperature: 0,
      })
    )
  );
  const verdict = response?.verdict === 'correct' || response?.verdict === 'wrong' ? response.verdict : 'unjudged';
  const reason = typeof response?.reason === 'string' ? response.reason : JSON.stringify(response);
  return { verdict, reason };
}

/** Judges every extracted fact of a case, one call per fact. Returns [{ text, category, verdict, reason }]. */
export async function judgeFacts(messages, extracted) {
  return Promise.all(extracted.map(async (f) => ({ ...f, ...(await judgeFact(messages, f)) })));
}
