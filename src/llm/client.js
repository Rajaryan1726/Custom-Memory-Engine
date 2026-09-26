import OpenAI from 'openai';

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;

function isRetryable(err) {
  const status = err?.status;
  return status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs fn, retrying up to MAX_RETRIES times with exponential backoff
 * (500ms, 1000ms) on 429 and 5xx errors only. Anything else is thrown at once.
 */
export async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= MAX_RETRIES || !isRetryable(err)) throw err;
      await sleep(BASE_DELAY_MS * 2 ** attempt);
    }
  }
}

/**
 * Creates an OpenAI-backed chat client for one engine instance.
 * Returns { openai, chat }: `openai` is the raw SDK client (also used for embeddings),
 * `chat` sends one system + user message.
 */
export function createLlmClient({ apiKey, chatModel }) {
  // SDK retries are disabled so that withRetry() alone decides what is retried.
  const openai = new OpenAI({ apiKey, maxRetries: 0 });

  /**
   * Returns the reply text, or the parsed object when json is true.
   * temperature is optional; when omitted the model's default is used.
   * model is optional; defaults to this client's chatModel.
   */
  async function chat({ system, user, json = false, temperature, model = chatModel }) {
    if (typeof user !== 'string' || !user.trim()) {
      throw new Error('chat(): "user" must be a non-empty string.');
    }

    // OpenAI rejects json_object mode unless the prompt mentions JSON.
    let systemText = system ?? '';
    if (json && !/json/i.test(`${systemText} ${user}`)) {
      systemText = `${systemText}\nRespond with a single JSON object.`.trim();
    }

    const messages = [];
    if (systemText) messages.push({ role: 'system', content: systemText });
    messages.push({ role: 'user', content: user });

    const response = await withRetry(() =>
      openai.chat.completions.create({
        model,
        messages,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
      })
    );

    const text = response.choices[0]?.message?.content ?? '';
    if (!json) return text;

    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`chat(): model returned invalid JSON (${err.message}). Raw text: ${text}`);
    }
  }

  return { openai, chat };
}
