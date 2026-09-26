import { chat, embed, embedMany } from './runtime.js';

async function main() {
  const answer = await chat({
    system: 'You are a concise assistant.',
    user: 'What is the capital of France? Answer in one sentence.',
  });
  console.log('chat (text):', answer);

  const parsed = await chat({
    system: 'Reply only with JSON of the form {"city": "..."}.',
    user: 'Which city is the Eiffel Tower in?',
    json: true,
  });
  console.log('chat (json):', parsed);

  const vector = await embed('hello world');
  console.log('embed length:', vector.length);

  const vectors = await embedMany([
    'I love hiking in the mountains.',
    'My favourite food is biryani.',
    'I work as a software engineer.',
  ]);
  console.log('embedMany count:', vectors.length);
}

main().catch((err) => {
  console.error('test-llm failed:', err.message);
  process.exitCode = 1;
});
