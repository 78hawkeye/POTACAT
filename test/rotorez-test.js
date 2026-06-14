// RotorEzClient unit tests — fake serial port, fast timers, no hardware.
// Covers the wire format (AP1xxx;AM1; / AI1; / ;), the ";xxx" + "xxx;"
// response parser, and the brake-delay state machine that queues a new
// bearing while a rotation is in flight (sending it immediately would
// stop the rotator and then be silently ignored — Idiom Press FAQ).
// Run: node test/rotorez-test.js

'use strict';

const { EventEmitter } = require('events');
const { RotorEzClient } = require('../lib/rotorez');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

class FakePort extends EventEmitter {
  constructor() {
    super();
    this.isOpen = true;
    this.writes = [];
    this.onWrite = null;
  }
  write(s) {
    this.writes.push(String(s));
    if (this.onWrite) this.onWrite(String(s));
  }
  close() {
    this.isOpen = false;
    this.emit('close');
  }
}

const FAST = {
  pollIntervalMs: 15,
  idlePollIntervalMs: 40,
  brakeDelayMs: 90,
  stableReads: 2,
  moveToleranceDeg: 2,
  arriveToleranceDeg: 6,
  maxTurnMs: 1500,
  reconnectDelayMs: 40,
};

function makeClient(extra = {}) {
  const ports = [];
  const client = new RotorEzClient({
    ...FAST,
    ...extra,
    portFactory: () => { const p = new FakePort(); ports.push(p); return p; },
  });
  return { client, ports, port: () => ports[ports.length - 1] };
}

// Wire a scripted AI1 responder: each AI1; poll gets the next bearing
// from the script (last value repeats once the script is exhausted).
function respondToPolls(port, script) {
  let i = 0;
  port.onWrite = (s) => {
    if (!s.includes('AI1;')) return;
    const v = script[Math.min(i, script.length - 1)];
    i++;
    setImmediate(() => port.emit('data', Buffer.from(v)));
  };
}

(async () => {
  console.log('=== rotorez ===');

  // ── connect / status ─────────────────────────────────────────────
  {
    const { client, port } = makeClient();
    const statuses = [];
    client.on('status', s => statuses.push(s));
    client.connect('COM7');
    check(client.connected === true, 'connect opens the port and sets connected');
    check(statuses.length === 1 && statuses[0].connected === true && statuses[0].path === 'COM7',
      'status event carries connected:true + path');
    await sleep(60);
    check(port().writes.some(w => w.includes('AI1;')), 'idle polling sends AI1;');
    client.disconnect();
  }

  // ── rotate wire format + normalization ───────────────────────────
  {
    const { client, port } = makeClient();
    client.connect('COM7');
    client.rotate(80);
    check(port().writes.includes('AP1080;AM1;'), 'rotate(80) writes AP1080;AM1;');
    client.disconnect();
  }
  {
    const { client, port } = makeClient();
    client.connect('COM7');
    client.rotate(9);
    check(port().writes.includes('AP1009;AM1;'), 'rotate(9) zero-pads to AP1009');
    client.disconnect();
  }
  {
    const { client, port } = makeClient();
    client.connect('COM7');
    client.rotate(365.4);
    check(port().writes.includes('AP1005;AM1;'), 'rotate(365.4) normalizes to 005');
    client.disconnect();
  }
  {
    const { client, port } = makeClient();
    client.connect('COM7');
    client.rotate(-10);
    check(port().writes.includes('AP1350;AM1;'), 'rotate(-10) normalizes to 350');
    client.disconnect();
  }
  {
    const { client, port } = makeClient();
    client.connect('COM7');
    check(client.rotate('garbage') === false, 'rotate(non-numeric) returns false');
    check(!port().writes.some(w => w.startsWith('AP1')), '…and writes nothing');
    client.disconnect();
  }
  {
    const { client } = makeClient();
    check(client.rotate(90) === false, 'rotate while disconnected returns false');
  }

  // ── AI1 response parsing ─────────────────────────────────────────
  {
    const { client, port } = makeClient();
    const seen = [];
    client.on('bearing', b => seen.push(b));
    client.connect('COM7');
    port().emit('data', Buffer.from(';210'));
    check(seen.length === 1 && seen[0] === 210 && client.bearing === 210,
      'parses Idiom ";xxx" response');
    port().emit('data', Buffer.from(';2'));
    check(seen.length === 1, 'partial response held in buffer');
    port().emit('data', Buffer.from('15'));
    check(seen.length === 2 && seen[1] === 215, 'split chunks reassemble (;2 + 15 = 215)');
    port().emit('data', Buffer.from(';100;105'));
    check(seen.length === 4 && seen[2] === 100 && seen[3] === 105,
      'back-to-back undelimited responses both parse');
    port().emit('data', Buffer.from('120;'));
    check(seen[seen.length - 1] === 120, 'parses ERC "xxx;" variant');
    port().emit('data', Buffer.from(';999'));
    check(!seen.includes(999), 'out-of-range reading (>360) is rejected');
    port().emit('data', Buffer.from('no digits here'));
    check(seen.length === 5, 'junk text produces no bearing events');
    client.disconnect();
  }

  // ── busy queueing: new bearing while turning is held, then sent ──
  {
    const { client, port } = makeClient();
    client.connect('COM7');
    // moving: 100 → 120 → 140, then stable at 150
    respondToPolls(port(), [';100', ';120', ';140', ';150', ';150', ';150', ';150', ';150', ';150', ';150']);
    client.rotate(150);
    check(client.state === 'turning', 'state is turning after rotate');
    await sleep(25);
    client.rotate(270); // QSY while turning
    check(!port().writes.includes('AP1270;AM1;'), 'new bearing while turning is NOT sent immediately');
    // wait for: stable reads (~4 polls) + brake delay (90ms) + next poll
    let sentAt = -1;
    for (let waited = 0; waited < 600; waited += 10) {
      if (port().writes.includes('AP1270;AM1;')) { sentAt = waited; break; }
      await sleep(10);
    }
    check(sentAt >= 0, 'queued bearing sent after stop + brake delay');
    check(client.state === 'turning', 'client is turning toward the queued bearing');
    client.disconnect();
  }

  // ── latest-wins queueing ─────────────────────────────────────────
  {
    const { client, port } = makeClient();
    client.connect('COM7');
    respondToPolls(port(), [';100', ';120', ';150', ';150', ';150', ';150', ';150', ';150']);
    client.rotate(150);
    await sleep(20);
    client.rotate(200);
    client.rotate(310); // newer QSY overrides the queued one
    await sleep(450);
    check(!port().writes.includes('AP1200;AM1;'), 'superseded queued bearing never sent');
    check(port().writes.includes('AP1310;AM1;'), 'latest queued bearing wins');
    client.disconnect();
  }

  // ── arrival → settled + back to idle ─────────────────────────────
  {
    const { client, port } = makeClient();
    client.connect('COM7');
    let settled = null;
    client.on('settled', s => { settled = s; });
    respondToPolls(port(), [';100', ';130', ';148', ';148', ';148', ';148', ';148']);
    client.rotate(150);
    await sleep(450);
    check(settled && settled.arrived === true && settled.target === 150 && settled.bearing === 148,
      'settled fires with arrived:true within tolerance');
    check(client.state === 'idle', 'state returns to idle after settling');
    client.disconnect();
  }

  // ── cancelled rotation (operator grabbed the knob) ───────────────
  {
    const { client, port } = makeClient();
    client.connect('COM7');
    let settled = null;
    client.on('settled', s => { settled = s; });
    respondToPolls(port(), [';100', ';101', ';100', ';101', ';100', ';101']);
    client.rotate(290); // never gets there — bearing stays ~100
    await sleep(450);
    check(settled && settled.arrived === false, 'settled fires with arrived:false when rotation never reached target');
    client.disconnect();
  }

  // ── stop ─────────────────────────────────────────────────────────
  {
    const { client, port } = makeClient();
    client.connect('COM7');
    respondToPolls(port(), [';100', ';120', ';140', ';140', ';140', ';140']);
    client.rotate(250);
    await sleep(20);
    client.rotate(300);          // queue something
    client.stop();
    check(port().writes.includes(';'), 'stop() writes a bare semicolon');
    check(client.state === 'braking', 'stop() during turn enters braking');
    await sleep(450);
    check(!port().writes.includes('AP1300;AM1;'), 'stop() clears the queued bearing');
    client.disconnect();
  }

  // ── 0–360 wrap-around in arrival math ────────────────────────────
  {
    const { client, port } = makeClient();
    client.connect('COM7');
    let settled = null;
    client.on('settled', s => { settled = s; });
    respondToPolls(port(), [';010', ';359', ';358', ';358', ';358', ';358']);
    client.rotate(0);
    await sleep(450);
    check(settled && settled.arrived === true, 'arrival tolerance wraps across north (358 vs 000)');
    client.disconnect();
  }

  // ── reconnect after port loss ────────────────────────────────────
  {
    const { client, ports, port } = makeClient();
    client.connect('COM7');
    check(ports.length === 1, 'one port opened initially');
    port().close();
    check(client.connected === false, 'close marks disconnected');
    await sleep(120);
    check(ports.length === 2 && client.connected === true, 'auto-reconnect opens a new port');
    client.disconnect();
    await sleep(120);
    check(ports.length === 2, 'disconnect() stops the reconnect loop');
  }

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
