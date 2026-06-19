// Tests for lib/wwbota.js — the pure pieces of the SSE-backed spot client:
// SSE frame parsing (chunk-boundary safe), the multi-band-safe spot key, and
// the age-pruning store. Network (https GET + the live SSE) isn't exercised
// here; this guards the logic that the PR-review flagged: multi-band dedup,
// pruning by the real `time` field, and partial-frame buffering.
// Run: node test/wwbota-test.js
'use strict';

const wb = require('../lib/wwbota');

let passed = 0, failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log(`  ✗ FAIL: ${label} (got ${a}, expected ${e})`); }
}
function ok(cond, label) { eq(!!cond, true, label); }

console.log('=== parseSseFrames ===');
{
  // Two complete events + a trailing partial carried over as `rest`.
  const r = wb._parseSseFrames('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"');
  eq(r.events, ['{"a":1}', '{"b":2}'], 'splits complete events on blank line');
  eq(r.rest, 'data: {"c"', 'keeps the trailing partial frame for the next chunk');

  // CRLF + comment keepalive lines are handled/ignored.
  const r2 = wb._parseSseFrames(':keepalive\r\n\r\ndata: {"x":1}\r\n\r\n');
  eq(r2.events, ['{"x":1}'], 'CRLF normalized; ":" comment frame yields no event');

  // Multi-line data fields join with newline (SSE spec).
  const r3 = wb._parseSseFrames('data: line1\ndata: line2\n\n');
  eq(r3.events, ['line1\nline2'], 'multiple data: lines join with \\n');

  // A frame with no data: line (e.g. only event:) produces nothing.
  const r4 = wb._parseSseFrames('event: ping\n\n');
  eq(r4.events, [], 'frame with no data: line emits no event');

  // Reassembly across chunk boundaries.
  let buf = 'data: {"call":"G';
  let acc = wb._parseSseFrames(buf);
  eq(acc.events, [], 'partial first chunk → no event yet');
  acc = wb._parseSseFrames(acc.rest + '0ABC"}\n\n');
  eq(acc.events, ['{"call":"G0ABC"}'], 'event completes once the rest of the bytes arrive');
}

console.log('\n=== spotKey (multi-band safe) ===');
{
  eq(wb._spotKey({ id: 'abc', call: 'G0ABC' }), 'id:abc', 'prefers server id when present');
  // Same call, two bands → DIFFERENT keys (the multi-band regression we fixed).
  const k40 = wb._spotKey({ call: 'g0abc', freq: 7.144, mode: 'ssb' });
  const k20 = wb._spotKey({ call: 'g0abc', freq: 14.244, mode: 'ssb' });
  ok(k40 !== k20, 'same call on two freqs → distinct keys (multi-band preserved)');
  eq(wb._spotKey({ call: 'g0abc', freq: 7.144, mode: 'ssb' }), k40, 'key is stable + case-normalized');
}

console.log('\n=== store: dedup, multi-band, prune by time ===');
{
  const store = wb._makeSpotStore();
  const T = Date.parse('2026-06-16T12:00:00Z');

  // Re-spot of the same call+freq overwrites in place (1 entry, latest wins).
  store.upsert({ call: 'G0ABC', freq: 7.144, mode: 'SSB', time: '2026-06-16T11:59:00Z', comment: 'first' }, T);
  store.upsert({ call: 'G0ABC', freq: 7.144, mode: 'SSB', time: '2026-06-16T11:59:30Z', comment: 'updated' }, T);
  eq(store.size, 1, 're-spot on same freq overwrites (no duplicate)');
  eq(store.values()[0].comment, 'updated', 'latest spot wins');

  // Same op on a second band → kept as a separate spot.
  store.upsert({ call: 'G0ABC', freq: 14.244, mode: 'SSB', time: '2026-06-16T11:59:30Z' }, T);
  eq(store.size, 2, 'second band kept (multi-band activation survives)');

  // Prune by the spot's own `time`, 3h window.
  store.upsert({ call: 'OLD1', freq: 7.1, mode: 'CW', time: '2026-06-16T08:00:00Z' }, T); // 4h old
  store.prune(T, 3 * 60 * 60 * 1000);
  ok(!store.values().some((s) => s.call === 'OLD1'), 'spot older than the window is pruned (by time)');
  eq(store.size, 2, 'in-window spots retained');

  // Missing/unparseable time → pruned by receivedAt so the store can't grow forever.
  const store2 = wb._makeSpotStore();
  store2.upsert({ call: 'NOTIME', freq: 7.2, mode: 'CW' }, T - 4 * 60 * 60 * 1000); // received 4h ago
  store2.prune(T, 3 * 60 * 60 * 1000);
  eq(store2.size, 0, 'no-time spot pruned via receivedAt fallback');

  // upsert ignores junk (no call).
  const store3 = wb._makeSpotStore();
  store3.upsert({ freq: 7.1 }, T);
  store3.upsert(null, T);
  eq(store3.size, 0, 'spots without a call are ignored');
}

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
