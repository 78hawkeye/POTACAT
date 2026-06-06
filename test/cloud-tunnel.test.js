#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CloudTunnelManager } = require('../lib/cloud-tunnel');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
  }
}

function makeManager(configPath) {
  return new CloudTunnelManager({
    userDataPath: path.dirname(configPath),
    configPath,
    getCloudSync: () => null,
    getCloudflaredPath: () => null,
    log: () => {},
  });
}

test('CloudTunnelManager persists to explicit profile-scoped configPath', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-cloud-tunnel-'));
  const sharedPath = path.join(root, 'cloud-tunnel.json');
  const profilePath = path.join(root, 'profiles', 'W4LAB', 'cloud-tunnel.json');
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });

  const mgr = makeManager(profilePath);
  mgr._enabled = true;
  mgr._cloudHost = 'w4lab.potacat.com';
  mgr._tunnelId = 'tunnel-1';
  mgr._tunnelToken = 'secret-token';
  mgr._createdAt = '2026-06-06T00:00:00.000Z';
  mgr._persist();

  assert.ok(fs.existsSync(profilePath), 'profile cloud-tunnel.json should be written');
  assert.ok(!fs.existsSync(sharedPath), 'shared cloud-tunnel.json should not be written');

  const loaded = makeManager(profilePath);
  const enabled = loaded.loadFromDisk();
  const state = loaded.getState();
  assert.strictEqual(enabled, true);
  assert.strictEqual(state.cloudHost, 'w4lab.potacat.com');
  assert.strictEqual(state.tunnelId, 'tunnel-1');
});

if (failed) {
  console.error(`cloud-tunnel tests failed: ${failed}`);
  process.exit(1);
}
console.log(`cloud-tunnel tests passed: ${passed}`);
