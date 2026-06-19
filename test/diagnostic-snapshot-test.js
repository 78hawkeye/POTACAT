// Desktop diagnostic-snapshot responder (Unified Bug Report).
// Canonical contract: status/brief-bug-report-{desktop,mobile}.md — the mobile
// app already ships a BugReportAssembler that consumes EXACTLY this sections
// shape, so these tests lock the desktop to the brief's wire schema.
//
// Layers:
//   - lib/diagnostic-snapshot.js  — pure section assembly + redaction
//   - lib/echocat-protocol.js     — request-diagnostic / diagnostic-snapshot (Dir.BOTH)
//   - lib/remote-server.js        — inbound handler: owner emits, guest refused
//
// Run: node test/diagnostic-snapshot-test.js

'use strict';

const {
  assembleSections, buildDiagnosticSnapshot,
  maskEmail, redactIpTo24, redactLogLines, REDACTED,
} = require('../lib/diagnostic-snapshot');
const protocol = require('../lib/echocat-protocol');
const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
function eq(actual, expected, label) {
  check(JSON.stringify(actual) === JSON.stringify(expected),
    `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

const rawFull = {
  account: { signedIn: true, callsign: 'K3SBP', email: 'casey@cmox.co', subscriptionStatus: 'active', subscriptionSource: 'app_store', subscriptionExpiresAt: '2026-07-15' },
  connection: { role: 'host', pathTried: ['lan', 'cloud'], pathActive: 'cloud', remoteAddress: '192.168.1.50', latencyMs: 47, reconnectsLastHour: 1, passSession: false },
  pairedDevices: [{ id: '878b', name: 'iPhone 16 Pro', platform: 'ios', lastSeen: '2026-06-16T13:00:00Z' }],
  rig: { configured: true, profile: 'Flex 8600M', catTransport: 'TCP 192.168.1.50:4992', catStatus: 'connected', catLastPollAgeMs: 180, vfo: '14074.0 kHz DIGU', audioBridge: 'Flex Direct' },
  tailscale: { installed: true, connected: true, hostname: 'shack.taile1234.ts.net', peerCount: 3 },
  cloudTunnel: { enabled: true, status: 'live', cloudHost: 'k3sbp.potacat.com', lastHealthCheckAt: '2026-06-16T13:00:00Z' },
  logLines: ['[Echo CAT] hello', 'token eyJabc.def.ghi here', 'Authorization: Bearer sk_live_DEADBEEFtoken', 'blob ' + 'A'.repeat(40)],
};

// ───────────────────────────────────────────────────────────────────────────
console.log('=== assembleSections: brief shape (redact=false) ===');

{
  const s = assembleSections(rawFull, { redact: false });
  eq(Object.keys(s).sort(), ['account', 'cloudTunnel', 'connection', 'logLines', 'pairedDevices', 'rig', 'tailscale'], 'seven desktop sections');
  check(!('network' in s), 'no network section on desktop (mobile-only)');
  eq(s.account.callsign, 'K3SBP', 'account.callsign');
  eq(s.account.emailRedacted, 'casey@cmox.co', 'email raw when redact=false');
  eq(s.connection.pathActive, 'cloud', 'connection.pathActive');
  eq(s.pairedDevices[0].lastSeenAt, '2026-06-16T13:00:00Z', 'pairedDevices maps lastSeen -> lastSeenAt');
  eq(s.rig.profile, 'Flex 8600M', 'rig.profile');
  eq(s.rig.catStatus, 'connected', 'rig.catStatus');
  eq(s.tailscale.hostname, 'shack.taile1234.ts.net', 'tailscale.hostname');
  eq(s.cloudTunnel.cloudHost, 'k3sbp.potacat.com', 'cloudTunnel.cloudHost');
  check(Array.isArray(s.logLines) && s.logLines.length === 4, 'logLines is an array (string[])');
}

{
  // Empty raw → every section present with safe defaults (partial gather ships).
  const s = assembleSections({}, {});
  eq(s.account.signedIn, false, 'account defaults signedIn=false');
  eq(s.rig.catStatus, 'not_configured', 'rig defaults not_configured');
  eq(s.cloudTunnel.status, 'off', 'cloudTunnel defaults off');
  eq(s.logLines, [], 'logLines defaults to []');
}

{
  // One malformed section is isolated.
  const evil = {};
  Object.defineProperty(evil, 'configured', { enumerable: true, get() { throw new Error('boom'); } });
  const s = assembleSections({ rig: evil }, {});
  check(s.rig && typeof s.rig.error === 'string', 'throwing rig section -> per-section error');
  eq(s.account.signedIn, false, 'other sections still built after one fails');
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n=== redaction (redact=true) ===');

{
  const s = assembleSections(rawFull, { redact: true });
  check(s.account.emailRedacted !== 'casey@cmox.co' && s.account.emailRedacted.includes('@'), 'email masked');
  eq(s.connection.remoteAddress, '192.168.1.0/24', 'remoteAddress redacted to /24');
  check(s.rig.catTransport.includes('192.168.1.0/24'), 'rig.catTransport IP redacted to /24');
  check(!s.rig.catTransport.includes('192.168.1.50'), 'raw rig IP gone');
  const joined = s.logLines.join('\n');
  check(!joined.includes('eyJabc.def.ghi'), 'JWT stripped from logLines');
  check(!/Bearer sk_live/.test(joined), 'Bearer token stripped from logLines');
  check(!joined.includes('A'.repeat(40)), '32+ char blob stripped from logLines');
  // Identity-bearing structural fields the report still needs:
  eq(s.account.callsign, 'K3SBP', 'callsign NOT redacted (report needs it)');
}

console.log('\n=== redaction helpers ===');
eq(redactIpTo24('192.168.1.50:4992'), '192.168.1.0/24:4992', 'redactIpTo24 host:port');
eq(redactIpTo24('127.0.0.1'), '127.0.0.1', 'loopback preserved');
check(maskEmail('casey@cmox.co').endsWith('.co'), 'maskEmail preserves TLD');
check(!maskEmail('casey@cmox.co').includes('casey'), 'maskEmail hides local part');
eq(redactLogLines(['x eyJaa.bb.cc y']), ['x <redacted-jwt> y'], 'redactLogLines JWT');

// ───────────────────────────────────────────────────────────────────────────
console.log('\n=== buildDiagnosticSnapshot: envelope ===');

{
  const msg = buildDiagnosticSnapshot(
    { requestId: 'r1', source: 'desktop', appVersion: '1.8.13', platform: { os: 'win32', osVersion: '10.0', deviceModel: null }, timestamp: '2026-06-16T13:00:00.000Z' },
    rawFull, { redact: true });
  eq(msg.type, 'diagnostic-snapshot', 'message type');
  eq(msg.requestId, 'r1', 'requestId echoed');
  eq(msg.source, 'desktop', 'source desktop');
  eq(msg.platform, { os: 'win32', osVersion: '10.0', deviceModel: null }, 'platform is an object');
  eq(msg.timestamp, '2026-06-16T13:00:00.000Z', 'timestamp is ISO string');
  check(msg.sections && msg.sections.rig, 'sections embedded');
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n=== protocol: wire schema (Dir.BOTH) ===');

check(protocol.isKnownType('request-diagnostic') && protocol.isKnownType('diagnostic-snapshot'), 'both types registered');
eq(protocol.describe('request-diagnostic').dir, protocol.Dir.BOTH, 'request-diagnostic is Dir.BOTH');
eq(protocol.describe('diagnostic-snapshot').dir, protocol.Dir.BOTH, 'diagnostic-snapshot is Dir.BOTH');
// Bidirectional → valid in BOTH directions (either side can request/respond).
check(protocol.validate({ type: 'request-diagnostic', requestId: 'x', redact: true }, protocol.Dir.C2S).ok, 'request-diagnostic valid c2s');
check(protocol.validate({ type: 'request-diagnostic', requestId: 'x' }, protocol.Dir.S2C).ok, 'request-diagnostic valid s2c (bidirectional)');
check(!protocol.validate({ type: 'request-diagnostic' }, protocol.Dir.C2S).ok, 'request-diagnostic without requestId rejected');
{
  const msg = { type: 'diagnostic-snapshot', requestId: 'x', source: 'desktop', appVersion: '1.8.13', platform: { os: 'win32', osVersion: '10', deviceModel: null }, timestamp: '2026-06-16T13:00:00Z', sections: { rig: { configured: false } } };
  const parsed = protocol.parse(protocol.encode(msg), protocol.Dir.S2C);
  check(parsed.ok, 'full snapshot encodes + parses (object platform, string timestamp)');
}
check(protocol.validate({ type: 'diagnostic-snapshot', requestId: 'x', source: 'desktop', error: 'not-authorized' }).ok, 'error-only snapshot validates');
{
  // platform must be an object now, not a string.
  const v = protocol.validate({ type: 'diagnostic-snapshot', requestId: 'x', platform: 'win32' });
  check(!v.ok && v.field === 'platform', 'string platform rejected (must be object)');
}
{
  const hello = protocol.buildServerHello({ capabilities: ['diagnostic-snapshot'] });
  check(hello.capabilities.includes('diagnostic-snapshot'), 'server hello carries diagnostic-snapshot capability');
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n=== server handler: owner emits, guest refused ===');

function fakeWs() {
  const sent = [];
  return { _authenticated: true, readyState: 1, send: (w) => { try { sent.push(JSON.parse(w)); } catch {} }, _sent: sent };
}

{
  const rs = new RemoteServer();
  const ws = fakeWs();
  rs._client = ws;
  const events = [];
  rs.on('request-diagnostic', (e) => events.push(e));
  rs._handleMessage(ws, { type: 'request-diagnostic', requestId: 'abc', redact: true }, {});
  eq(events.length, 1, 'owner request emits request-diagnostic');
  eq(events[0], { requestId: 'abc', redact: true }, 'event carries requestId + redact');
  eq(ws._sent.length, 0, 'owner path sends no immediate reply (main.js replies)');
}

{
  // Guest Pass session must NOT be able to pull host diagnostics (security
  // deviation from the brief, intentional — see handoff note). Refused with an
  // error snapshot so the requester never strands on its 5s timeout.
  const rs = new RemoteServer();
  const ws = fakeWs();
  ws._passSession = { code: 'GUEST1' };
  rs._client = ws;
  let emitted = 0;
  rs.on('request-diagnostic', () => { emitted++; });
  rs._handleMessage(ws, { type: 'request-diagnostic', requestId: 'g1' }, {});
  eq(emitted, 0, 'guest request does NOT emit');
  eq(ws._sent.length, 1, 'guest gets an immediate reply');
  eq(ws._sent[0].type, 'diagnostic-snapshot', 'guest reply is a diagnostic-snapshot');
  eq(ws._sent[0].error, 'not-authorized', 'guest reply carries not-authorized error');
  eq(ws._sent[0].requestId, 'g1', 'guest reply echoes requestId');
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
