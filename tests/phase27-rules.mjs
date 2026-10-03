import { runRulePropertySuite } from '../js/testing.js';

const result = runRulePropertySuite({ iterations: 10000, seed: 0xD3A0C4 });
if (!result.ok) {
  console.error('FAIL Phase 27 rule property suite');
  console.error(result.failures);
  process.exit(1);
}
console.log(`PASS Phase 27 rule property suite — ${result.iterations.toLocaleString()} scenarios, ${result.assertions.toLocaleString()} assertions, ${result.durationMs.toFixed(1)} ms`);
