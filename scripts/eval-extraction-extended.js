import { runExtractionEval } from './eval-extraction-core.js';

runExtractionEval({
  casesUrl: new URL('../tests/extraction-cases-extended.json', import.meta.url),
  label: 'extended',
  resultPrefix: 'extraction-extended',
}).catch((err) => {
  console.error('eval-extraction-extended failed:', err.message);
  process.exitCode = 1;
});
