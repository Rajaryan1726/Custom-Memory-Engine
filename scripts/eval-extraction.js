import { runExtractionEval } from './eval-extraction-core.js';

runExtractionEval({
  casesUrl: new URL('../tests/extraction-cases.json', import.meta.url),
  label: 'original',
  resultPrefix: 'extraction',
}).catch((err) => {
  console.error('eval-extraction failed:', err.message);
  process.exitCode = 1;
});
