// Unit tests for the remote-shack voice PTT controller
// (renderer/remote-ptt.js). A ham rig must never transmit by accident, so
// these pin the safety invariants: PTT gated on audio being active, idempotent
// key/unkey (no duplicate frames), and force-release if audio drops mid-TX.
// Run: node test/remote-ptt-test.js
'use strict';

const { RemotePttController } = require('../renderer/remote-ptt.js');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}

function make() {
  const sent = [];
  const changes = [];
  const ptt = new RemotePttController({
    sendPtt: (on) => sent.push(on),
    onChange: (keyed) => changes.push(keyed),
  });
  return { ptt, sent, changes };
}

console.log('=== gating: no TX unless audio is active ===');
{
  const { ptt, sent } = make();
  check(ptt.down() === false, 'down() is a no-op when audio is not active');
  check(sent.length === 0, '...and nothing is sent to the rig');
  check(ptt.isKeyed() === false, '...and we are not keyed');
}

console.log('\n=== normal key / unkey ===');
{
  const { ptt, sent, changes } = make();
  ptt.setActive(true);
  check(ptt.down() === true, 'down() keys when active');
  check(sent.length === 1 && sent[0] === true, 'sends ptt=true once');
  check(ptt.isKeyed() === true, 'isKeyed() true');
  check(changes[0] === true, 'onChange(true) fired');
  check(ptt.up() === true, 'up() unkeys');
  check(sent.length === 2 && sent[1] === false, 'sends ptt=false');
  check(changes[1] === false, 'onChange(false) fired');
}

console.log('\n=== idempotency: no duplicate frames ===');
{
  const { ptt, sent } = make();
  ptt.setActive(true);
  ptt.down(); ptt.down(); ptt.down();
  check(sent.filter(x => x === true).length === 1, 'repeated down() sends ptt=true only once');
  ptt.up(); ptt.up();
  check(sent.filter(x => x === false).length === 1, 'repeated up() sends ptt=false only once');
}

console.log('\n=== safety: audio dropping mid-TX force-releases ===');
{
  const { ptt, sent } = make();
  ptt.setActive(true);
  ptt.down();
  check(ptt.isKeyed() === true, 'keyed while active');
  ptt.setActive(false); // link dropped
  check(ptt.isKeyed() === false, 'setActive(false) force-releases TX');
  check(sent[sent.length - 1] === false, '...and sends ptt=false so the rig can never stick keyed');
}

console.log('\n=== up() with nothing keyed is harmless ===');
{
  const { ptt, sent } = make();
  ptt.setActive(true);
  check(ptt.up() === false, 'up() when not keyed is a no-op');
  check(sent.length === 0, '...sends nothing');
}

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
