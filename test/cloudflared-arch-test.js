// cloudflared arch-mismatch handling (N3VD 2026-06-12: "spawn failed:
// spawn Unknown system error -86" turning on the Cloud Tunnel). -86 is
// macOS EBADARCH — the bundled cloudflared's CPU type doesn't match the
// machine. Verify the error classifier and the system-binary finder,
// then drive CloudTunnelManager with a binary that errors EBADARCH and
// confirm: (a) it falls back to a system cloudflared if present, and
// (b) otherwise surfaces a clear message, not "-86".
// Run: node test/cloudflared-arch-test.js

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const cf = require('../lib/cloudflared');
const { CloudTunnelManager } = require('../lib/cloud-tunnel');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── isArchSpawnError ───────────────────────────────────────────────
console.log('=== isArchSpawnError ===');
check(cf.isArchSpawnError({ errno: -86, message: 'spawn Unknown system error -86' }) === true, 'macOS errno -86 (EBADARCH) → true');
check(cf.isArchSpawnError({ code: 'EBADARCH' }) === true, 'code EBADARCH → true');
check(cf.isArchSpawnError({ code: 'ENOEXEC', message: 'spawn ... exec format error' }) === true, 'Linux ENOEXEC / exec format error → true');
check(cf.isArchSpawnError({ code: 'ENOENT', message: 'spawn ENOENT' }) === false, 'ENOENT (missing) → false (not an arch problem)');
check(cf.isArchSpawnError({ code: 'EACCES' }) === false, 'EACCES (perms) → false');
check(cf.isArchSpawnError(null) === false, 'null → false');

// ── findSystemCloudflared shape ────────────────────────────────────
console.log('\n=== findSystemCloudflared ===');
const sys = cf.findSystemCloudflared();
check(sys === null || (typeof sys === 'string' && path.isAbsolute(sys)), 'returns null or an absolute path (got ' + JSON.stringify(sys) + ')');
if (process.platform === 'win32') check(sys === null, 'Windows → null (bundled .exe only)');

// ── Manager: arch-failing bundled binary, via the opts.spawn seam ──
(async () => {
  console.log('\n=== manager spawn fallback ===');
  const { EventEmitter } = require('events');
  const BUNDLED = path.join(os.tmpdir(), 'fake-bundled-cloudflared');
  const SYS = path.join(os.tmpdir(), 'fake-system-cloudflared');
  const realFind = cf.findSystemCloudflared;
  const fakeChild = () => {
    const c = new EventEmitter();
    c.stderr = new EventEmitter();
    c.stdout = new EventEmitter();
    c.kill = () => {};
    return c;
  };
  const archThrow = (file) => {
    if (file === BUNDLED) { const e = new Error('spawn Unknown system error -86'); e.errno = -86; throw e; }
    throw new Error('unexpected spawn of ' + file);
  };

  // 1. No system fallback available → clear arch message, status error.
  cf.findSystemCloudflared = () => null;
  const m1 = new CloudTunnelManager({
    userDataPath: os.tmpdir(), getCloudSync: () => null,
    getCloudflaredPath: () => BUNDLED, log: () => {}, spawn: archThrow,
  });
  m1._tunnelToken = 'tok';
  m1._spawnCloudflared();
  check(m1.getState().status === 'error', 'arch failure with no system binary → status error');
  check(/processor|brew install cloudflared/i.test(m1._lastError) && !/-86/.test(m1._lastError),
    'error message is human-readable (no raw -86): ' + JSON.stringify(m1._lastError.slice(0, 55) + '…'));

  // 2. System fallback present → spawns the system binary, no error.
  cf.findSystemCloudflared = () => SYS;
  let spawnedSystem = false;
  const spawnWithSys = (file) => {
    if (file === BUNDLED) { const e = new Error('spawn Unknown system error -86'); e.errno = -86; throw e; }
    if (file === SYS) { spawnedSystem = true; return fakeChild(); }
    throw new Error('unexpected spawn of ' + file);
  };
  const m2 = new CloudTunnelManager({
    userDataPath: os.tmpdir(), getCloudSync: () => null,
    getCloudflaredPath: () => BUNDLED, log: () => {}, spawn: spawnWithSys,
  });
  m2._tunnelToken = 'tok';
  m2._spawnCloudflared();
  check(spawnedSystem === true, 'falls back to the system cloudflared on arch mismatch');
  check(m2.getState().status !== 'error', 'no error status once the system binary spawns');

  // 3. A non-arch spawn failure keeps the plain message (no false arch claim).
  cf.findSystemCloudflared = () => null;
  const m3 = new CloudTunnelManager({
    userDataPath: os.tmpdir(), getCloudSync: () => null,
    getCloudflaredPath: () => BUNDLED, log: () => {},
    spawn: () => { const e = new Error('spawn ENOENT'); e.code = 'ENOENT'; throw e; },
  });
  m3._tunnelToken = 'tok';
  m3._spawnCloudflared();
  check(/spawn failed/.test(m3._lastError) && !/processor/.test(m3._lastError),
    'non-arch failure keeps the generic "spawn failed" message');

  cf.findSystemCloudflared = realFind;
  m1.shutdown(); m2.shutdown(); m3.shutdown();

  await sleep(50);
  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
