#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// Guest Pass desktop intake — regression suite.
//   1. extractGuestPassCode: all three intake forms + rejects
//   2. RemoteClient pass-mode auth: sends {mode:'pass', passCode, sessionId}
//      on auth-mode (never the deviceToken), and pass-ended stops reconnects
//
// Run:  node test/guest-pass-test.js
// =====================================================================

const { extractGuestPassCode } = require('../lib/guest-pass');
const { RemoteClient } = require('../lib/remote-client');

let pass = 0, fail = 0;
function eq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; }
  else { fail++; console.log(`  ✗ ${msg}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
function section(n) { console.log('\n=== ' + n + ' ==='); }

// ---------------------------------------------------------------------
section('extractGuestPassCode — accepted forms');
eq(extractGuestPassCode('otter-newt-mosaic-rooster'), 'otter-newt-mosaic-rooster', 'bare 4-word code');
eq(extractGuestPassCode('journal-kettle-fox'), 'journal-kettle-fox', 'legacy 3-word code');
eq(extractGuestPassCode('  Otter-Newt-Mosaic-Rooster  '), 'otter-newt-mosaic-rooster', 'trims + lowercases');
eq(extractGuestPassCode('potacat://pass/otter-newt-mosaic-rooster'), 'otter-newt-mosaic-rooster', 'potacat://pass/ deep link');
eq(extractGuestPassCode('potacat:pass/otter-newt-mosaic-rooster'), 'otter-newt-mosaic-rooster', 'no-slashes scheme variant');
eq(extractGuestPassCode('potacat://pass/otter-newt-mosaic-rooster?src=qr'), 'otter-newt-mosaic-rooster', 'deep link with query');
eq(extractGuestPassCode('https://api.potacat.com/guest-pass.html?code=otter-newt-mosaic-rooster'), 'otter-newt-mosaic-rooster', 'share URL');
eq(extractGuestPassCode('https://api.potacat.com/guest-pass.html?utm=x&code=journal-kettle-fox-idaho'), 'journal-kettle-fox-idaho', 'share URL, code not first param');

section('extractGuestPassCode — rejects');
eq(extractGuestPassCode(''), '', 'empty');
eq(extractGuestPassCode(null), '', 'null');
eq(extractGuestPassCode('one-word'), '', 'too few words');
eq(extractGuestPassCode('a-b-c-d-e'), '', 'too many words');
eq(extractGuestPassCode('otter-newt-mosaic-r00ster'), '', 'digits not allowed');
eq(extractGuestPassCode('potacat://pair?host=x&token=y'), '', 'pair link is NOT a pass');
eq(extractGuestPassCode('https://api.potacat.com/guest-pass.html'), '', 'share URL without code');
eq(extractGuestPassCode('K3SBP'), '', 'callsign is not a code');

// ---------------------------------------------------------------------
section('RemoteClient — pass-mode auth message');
{
  // Drive _handleMessage directly with a stubbed socket; no network.
  const sent = [];
  const passTarget = {
    id: 'gp-otter-newt-mosaic-rooster', kind: 'pass', name: 'K3SBP (Guest Pass)',
    passCode: 'otter-newt-mosaic-rooster',
    passSessionId: 'a'.repeat(64),
    cloudHost: 'k3sbp.potacat.com',
  };
  const c = new RemoteClient(passTarget, { clientVersion: 'test' });
  c._ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)), close: () => {} };
  // WebSocket.OPEN === 1 — the stub satisfies _send's readyState check.
  c._handleMessage(JSON.stringify({ type: 'auth-mode', mode: 'token' }));
  eq(sent.length, 1, 'one auth message sent');
  eq(sent[0].type, 'auth', 'message type is auth');
  eq(sent[0].mode, 'pass', 'mode=pass even though server advertised token');
  eq(sent[0].passCode, 'otter-newt-mosaic-rooster', 'passCode present');
  eq(sent[0].sessionId, 'a'.repeat(64), '64-hex sessionId present');
  eq(sent[0].token, undefined, 'NO deviceToken on a pass target');
}

section('RemoteClient — paired-target auth unchanged');
{
  const sent = [];
  const pairedTarget = { id: 'ct_x', name: 'Shack', deviceToken: 'DEV-TOKEN-123', cloudHost: 'x.potacat.com' };
  const c = new RemoteClient(pairedTarget, { clientVersion: 'test' });
  c._ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)), close: () => {} };
  c._handleMessage(JSON.stringify({ type: 'auth-mode', mode: 'token' }));
  eq(sent.length, 1, 'one auth message sent');
  eq(sent[0].token, 'DEV-TOKEN-123', 'deviceToken presented');
  eq(sent[0].passCode, undefined, 'no passCode on a paired target');
}

section('RemoteClient — sendTune wire contract (Hz in, freqKhz string out)');
{
  // Regression pin for the 1000x QSY bug: tuneRadio passes kHz around
  // internally, but sendTune takes Hz and emits the wire's freqKhz itself.
  // The call site must convert. (K3SBP 2026-06-11: laptop sent "7.026 kHz",
  // shack PassEnforcement blocked everything as out-of-band.)
  const sent = [];
  const c = new RemoteClient({ id: 'ct_t', name: 'Shack', deviceToken: 'x', cloudHost: 'x' }, {});
  c._ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)), close: () => {} };
  c.sendTune({ frequency: 7026000, mode: 'CW' });          // 7026 kHz in Hz
  eq(sent.length, 1, 'tune frame sent');
  eq(sent[0].type, 'tune', 'frame type');
  eq(sent[0].freqKhz, '7026.000', 'freqKhz is a kHz STRING — 7026.000, not 7.026');
  eq(sent[0].mode, 'CW', 'mode rides along');
  c.sendTune({ frequency: 14074000 });
  eq(sent[1].freqKhz, '14074.000', '14074 kHz survives the round trip');
}

section('RemoteClient — pass-ended stops the session');
{
  const events = [];
  const c = new RemoteClient({ id: 'gp-x', kind: 'pass', passCode: 'a-b-c', passSessionId: 'a'.repeat(64), cloudHost: 'x' }, {});
  c._ws = { readyState: 1, send: () => {}, close: () => { events.push('ws-closed'); } };
  c.on('pass-ended', (e) => events.push('pass-ended:' + e.reason));
  c._handleMessage(JSON.stringify({ type: 'pass-ended', reason: 'expired', code: 'a-b-c' }));
  eq(events.includes('pass-ended:expired'), true, 'pass-ended event emitted with reason');
  eq(events.includes('ws-closed'), true, 'socket closed');
  eq(c._closed, true, 'client marked closed — no reconnect loop against a dead pass');
}

// ---------------------------------------------------------------------
section('RemoteServer — tap-to-pair LAN source classifier');
{
  // Pin for the tunnel-gate refinement: tunnel traffic reaches the desktop
  // from LOOPBACK (cloudflared local proxy), so RFC1918 sources are genuine
  // same-LAN peers and may tap-to-pair even while the tunnel is exposed.
  const { RemoteServer } = require('../lib/remote-server');
  const lan = (ip) => RemoteServer._isPrivateLanAddress(ip);
  eq(lan('192.168.0.233'), true, '192.168/16 is LAN');
  eq(lan('::ffff:192.168.1.5'), true, 'IPv6-mapped IPv4 unwrapped');
  eq(lan('10.0.0.7'), true, '10/8 is LAN');
  eq(lan('172.16.4.2'), true, '172.16/12 low edge');
  eq(lan('172.31.255.1'), true, '172.16/12 high edge');
  eq(lan('127.0.0.1'), false, 'loopback is NOT LAN (tunnel arrives here)');
  eq(lan('::ffff:127.0.0.1'), false, 'mapped loopback blocked');
  eq(lan('::1'), false, 'IPv6 loopback blocked');
  eq(lan('100.104.53.76'), false, 'CGNAT/Tailscale excluded');
  eq(lan('172.32.0.1'), false, 'just outside 172.16/12');
  eq(lan('8.8.8.8'), false, 'public IP blocked');
  eq(lan(''), false, 'empty blocked');
}

// ---------------------------------------------------------------------
console.log('\n============================================================');
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('FAILURES PRESENT'); process.exit(1); }
console.log('All guest-pass tests passed.');
