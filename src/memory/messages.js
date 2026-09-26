/**
 * Turns a chat message's content into plain text.
 * - string: returned as is
 * - array (OpenAI multi-part format): only { type: "text" } parts, joined with "\n"
 * - anything else: ""
 */
export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}
