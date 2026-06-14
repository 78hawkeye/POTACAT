// Cloud Tunnel DNS-degraded detection (tunnel-dns-degraded-notice).
// KE4EST 2026-06-12: cloudflared lost its local DNS resolver mid-QSO
// (region1.v2.argotunnel.com: i/o timeout), the tunnel decayed, but
// cloudflared never exited so the app showed no change. We now flip a
// `degraded` modifier (on top of status) so the UI can warn + advise.
// Run: node test/cloud-tunnel-degraded-test.js

'use strict';

const { CloudTunnelManager } = require('../lib/cloud-tunnel');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}

// ── Pure line classifier ──────────────────────────────────────────
console.log('=== _classifyCloudflaredLine ===');
const C = CloudTunnelManager._classifyCloudflaredLine;
check(C('2026-06-13T01:24:31Z ERR Failed to refresh DNS local resolver error="lookup region1.v2.argotunnel.com: i/o timeout"') === 'dns-error',
  "KE4EST's exact line → dns-error");
check(C('ERR lookup region2.v2.argotunnel.com: no such host') === 'dns-error', 'no such host on the edge → dns-error');
check(C('INF Registered tunnel connection connIndex=0') === 'registered', 'registered tunnel connection → registered');
check(C('INF Connection registered connIndex=1') === 'registered', 'connection registered → registered');
check(C('INF Initial protocol http2') === null, 'ordinary info line → null');
check(C('ERR failed to dial to edge') === null, 'a non-DNS edge error → null (not our signal)');
check(C('') === null && C(null) === null, 'empty / null → null');
check(C('lookup example.com: i/o timeout') === null, 'i/o timeout on a NON-argotunnel host → null (not us)');

// ── Windowed degrade + recovery ───────────────────────────────────
console.log('\n=== degrade window + recovery ===');
function makeMgr() {
  const logs = [];
  const m = new CloudTunnelManager({
    userDataPath: require('os').tmpdir(),
    getCloudSync: () => null,
    getCloudflaredPath: () => null,
    log: (s) => logs.push(s),
  });
  const changes = [];
  m.on('change', (st) => changes.push(st));
  return { m, logs, changes };
}
const DNS = 'ERR Failed to refresh DNS local resolver error="lookup region1.v2.argotunnel.com: i/o timeout"';

// One error is not enough; two within the window trips it.
{
  const { m, changes } = makeMgr();
  const t = 1_000_000;
  m._recordDnsError(t);
  check(m.getState().degraded === false, 'a single DNS error does NOT degrade');
  m._recordDnsError(t + 30_000);
  check(m.getState().degraded === true, 'second DNS error within the window degrades');
  check(typeof m.getState().degradedReason === 'string' && /DNS/.test(m.getState().degradedReason),
    'degradedReason carries the actionable hint');
  check(changes.length === 1 && changes[0].degraded === true, "exactly one 'change' emitted on the transition");
}

// Errors spread beyond the window never accumulate to the threshold.
{
  const { m } = makeMgr();
  m._recordDnsError(1_000_000);
  m._recordDnsError(1_000_000 + 6 * 60 * 1000); // 6 min later — first has aged out
  check(m.getState().degraded === false, 'errors spaced beyond the 5-min window do not degrade');
}

// A 'registered' line clears degraded immediately.
{
  const { m, changes } = makeMgr();
  m._recordDnsError(1_000_000);
  m._recordDnsError(1_000_000 + 1000);
  check(m.getState().degraded === true, 'degraded after two errors');
  changes.length = 0;
  m._clearDnsDegraded();
  check(m.getState().degraded === false && m.getState().degradedReason === '', 'recovery clears degraded + reason');
  check(changes.length === 1 && changes[0].degraded === false, "one 'change' emitted on recovery");
}

// Stopping the tunnel (status → off) clears degraded in the same emit.
{
  const { m, changes } = makeMgr();
  m._recordDnsError(1_000_000);
  m._recordDnsError(1_000_000 + 1000);
  check(m.getState().degraded === true, 'degraded before stop');
  m._status = 'live'; // pretend it was up
  changes.length = 0;
  m._setStatus('off');
  const st = m.getState();
  check(st.status === 'off' && st.degraded === false, "status 'off' also clears degraded");
  check(changes.length === 1, 'a single change event carries both status=off and degraded=false');
}

// getState always exposes the two new fields (renderer relies on them).
{
  const { m } = makeMgr();
  const st = m.getState();
  check('degraded' in st && 'degradedReason' in st, 'getState always includes degraded + degradedReason');
  check(st.degraded === false && st.degradedReason === '', 'defaults are false / empty');
}

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
