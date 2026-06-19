// PSKReporter poll-outcome decision (2026-06-13). retrieve.pskreporter.info
// 502s constantly; a single transient gateway error used to blank the map
// for 5 minutes and raise an operator-facing error. decidePollOutcome now
// retries transient 5xx quickly + quietly, only failing for real after a
// run of them. This pins that policy.
// Run: node test/pskreporter-test.js

'use strict';

const { PskrClient } = require('../lib/pskreporter');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}

const D = (code, retries) => PskrClient.decidePollOutcome(code, retries);

console.log('=== decidePollOutcome ===');

// Success resets everything.
check(D(200, 0).kind === 'ok', '200 → ok');
check(D(200, 3).kind === 'ok', '200 → ok even mid-retry-streak');

// 503 = rate limit: back off hard, but stay connected (service is up).
const rl = D(503, 0);
check(rl.kind === 'rate-limited', '503 → rate-limited');
check(rl.delay === 600000, '503 backs off 10 min');
check(rl.markDisconnected === false, '503 does NOT drop the connection');

// 502/500/504 = transient gateway: quick retry, stay connected.
for (const code of [500, 502, 504]) {
  const o = D(code, 0);
  check(o.kind === 'transient-retry', `${code} (1st) → transient-retry`);
  check(o.markDisconnected === false, `${code} keeps the map connected`);
}

// Escalating backoff: 30s, 60s, 120s, 240s, then capped.
check(D(502, 0).delay === 30000, '502 retry #1 delay = 30s');
check(D(502, 1).delay === 60000, '502 retry #2 delay = 60s');
check(D(502, 2).delay === 120000, '502 retry #3 delay = 120s');
check(D(502, 3).delay === 240000, '502 retry #4 delay = 240s (cap)');
check(D(502, 3).delay <= 300000, 'transient delay always stays under the 5-min poll');

// After MAX_TRANSIENT_RETRIES (4) consecutive transients → real failure.
const exhausted = D(502, 4);
check(exhausted.kind === 'fail', '502 after 4 retries → fail');
check(exhausted.markDisconnected === true, 'exhausted transient run drops the connection');
check(exhausted.delay === 300000, 'failure resumes the normal 5-min poll');

// Genuine client/other errors fail immediately (no transient grace).
const notFound = D(404, 0);
check(notFound.kind === 'fail', '404 → fail (not transient)');
check(notFound.markDisconnected === true, '404 drops the connection');
check(D(400, 0).kind === 'fail', '400 → fail');
check(D(403, 0).kind === 'fail', '403 → fail');

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
