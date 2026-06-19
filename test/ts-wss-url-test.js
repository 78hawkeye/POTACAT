// Tests for tsWssUrl() in lib/remote-client.js — builds the Tailscale leg's
// wss URL and guards against the malformed `wss://host:7300:7300` that showed
// up in KE4WLE's log when the stored tsHost already carried a :port.
//
// Run: node test/ts-wss-url-test.js
'use strict';

const { tsWssUrl } = require('../lib/remote-client');

let passed = 0, failed = 0;
function eq(actual, expected, label) {
  if (actual === expected) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log(`  ✗ FAIL: ${label} (got ${actual}, expected ${expected})`); }
}

const H = 'flexradio.tail7b91e5.ts.net';
eq(tsWssUrl(H), `wss://${H}:7300`, 'bare MagicDNS host → :7300');
eq(tsWssUrl(`${H}:7300`), `wss://${H}:7300`, 'host already carrying :7300 → not doubled (the bug)');
eq(tsWssUrl(`${H}:9999`), `wss://${H}:7300`, 'wrong stored port normalized to :7300');
eq(tsWssUrl(`wss://${H}:7300`), `wss://${H}:7300`, 'full wss:// URL with port → cleaned');
eq(tsWssUrl(`wss://${H}`), `wss://${H}:7300`, 'wss:// scheme stripped then :7300 added');
eq(tsWssUrl('100.64.0.1'), 'wss://100.64.0.1:7300', 'Tailscale IPv4 → :7300');
eq(tsWssUrl('100.64.0.1:7300'), 'wss://100.64.0.1:7300', 'IPv4 host:port not doubled');
eq(tsWssUrl(' host.ts.net ', 7300), 'wss://host.ts.net:7300', 'trims whitespace');

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
