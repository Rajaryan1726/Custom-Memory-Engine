// Retrieval-layer helpers for the tutor: small-talk detection and prompt formatting.

// Words that, on their own, make a message small talk (English + Hinglish).
const SMALL_TALK_WORDS = new Set([
  // thanks
  'thanks', 'thank', 'thankyou', 'thx', 'ty', 'tysm', 'shukriya', 'dhanyavad', 'dhanyawad',
  // acknowledgement
  'ok', 'okay', 'okk', 'okie', 'k', 'kk', 'hmm', 'hm', 'hmmm', 'mm', 'haan', 'han', 'haa', 'ha', 'hn',
  'ji', 'yes', 'yeah', 'yep', 'sure', 'cool', 'nice', 'great', 'good', 'done', 'got', 'it',
  'theek', 'thik', 'thk', 'hai', 'h', 'accha', 'acha', 'achha', 'achcha', 'sahi', 'samajh', 'gaya', 'gayi', 'aa',
  // greetings / goodbyes
  'hi', 'hii', 'hello', 'hey', 'namaste', 'bye', 'byee', 'goodnight', 'night', 'morning', 'gm', 'gn', 'tc',
  // fillers
  'you', 'so', 'much', 'bhai', 'sir', 'mam', 'maam', 'bro', 'yaar', 'very', 'bahut', 'bohot', 'lol',
]);
const SMALL_TALK_MAX_WORDS = 5;

/**
 * True when a message is only short small talk ("thanks", "ok bhai", "theek hai", "bye").
 * Pure word-list check, no LLM call. Emoji- or punctuation-only messages also count.
 */
export function isSmallTalk(text) {
  if (typeof text !== 'string') return false;
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return true;
  if (words.length > SMALL_TALK_MAX_WORDS) return false;
  return words.every((w) => SMALL_TALK_WORDS.has(w));
}

/**
 * Formats getContext() output as a plain-text block for an LLM prompt.
 * Empty sections are left out; returns "" when there is nothing to say.
 */
export function formatContext({ profile = [], relevant = [] } = {}) {
  const sections = [];
  if (profile.length) sections.push(['Profile:', ...profile.map((m) => `- ${m.text}`)].join('\n'));
  if (relevant.length) sections.push(['Relevant:', ...relevant.map((m) => `- ${m.text}`)].join('\n'));
  if (sections.length === 0) return '';
  return ['Student context (do not cite)', ...sections].join('\n');
}
