// scripts/probe-flex-audio.js — discover the Flex audio-output mute commands.
//
// Casey's Flex 8600M plays slice 0 RX through the FRONT-PANEL SPEAKER when
// POTACAT registers as a new GUI client (Flex Direct). `mixer headphone
// mute=1` + `mixer lineout mute=1` are accepted by the radio (no error)
// but don't silence the front-panel speaker. The 8000-series has at least
// three outputs (speaker + headphone + lineout) and we don't know which
// commands actually map to which.
//
// This script: connect, `sub mixer all`, dump every mixer status line for
// 2 seconds, then try a panel of candidate mute commands and log each
// reply's status code. The output identifies (a) what properties the
// radio exposes on each output, and (b) which command syntax it accepts.
//
// Usage:   node scripts/probe-flex-audio.js [radioIP]
//          (default IP: 192.168.10.64)
//
// SAFE: read-only on the mixer subscription. The candidate mute commands
// SET mute=1 then SET mute=0, so the radio ends up where it started. Run
// with SmartSDR CLOSED so POTACAT can register as a GUI client.

const net = require('net');

const HOST = process.argv[2] || '192.168.10.64';
const PORT = 4992;

let seq = 1;
const pending = {};               // seq -> { cmd, label, sentAt }
const replies = [];               // { seq, cmd, label, status, payload, ms }
const mixerStatusLines = [];      // every S-line that mentions mixer
let guiId = null;
let guiSeq = null;

const t0 = Date.now();
const stamp = () => `[+${((Date.now() - t0) / 1000).toFixed(2)}s]`;

function send(cmd, label) {
  const s = seq++;
  pending[s] = { cmd, label: label || cmd, sentAt: Date.now() };
  console.log(`${stamp()} >> C${s}|${cmd}` + (label ? `      // ${label}` : ''));
  sock.write(`C${s}|${cmd}\n`);
  return s;
}

const sock = new net.Socket();
sock.setNoDelay(true);

let buf = '';
sock.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handleLine(line);
  }
});

function handleLine(line) {
  // Reply
  const r = line.match(/^R(\d+)\|([0-9A-Fa-f]+)\|?(.*)$/);
  if (r) {
    const rs = parseInt(r[1], 10);
    const status = parseInt(r[2], 16);
    const payload = r[3] || '';
    const p = pending[rs];
    const ms = p ? (Date.now() - p.sentAt) : 0;
    delete pending[rs];
    replies.push({ seq: rs, cmd: p ? p.cmd : '?', label: p ? p.label : '?', status, payload, ms });
    const tag = status === 0 ? 'OK' : `ERR 0x${status.toString(16)}`;
    console.log(`${stamp()} << R${rs}|${tag}${payload ? '|' + payload : ''}      // ${p ? p.label : 'unknown'}`);
    // After our `client gui` returns, kick off the probe.
    if (rs === guiSeq && status === 0) {
      guiId = payload.split('|')[0];
      console.log(`${stamp()} -- registered as GUI client ${guiId}`);
      setTimeout(probeMixer, 500);
    }
    return;
  }
  // Status
  if (line.startsWith('S')) {
    // S<handle>|<key>=<val> <key>=<val>...
    if (/mixer/i.test(line) || /headphone|lineout|speaker/i.test(line)) {
      mixerStatusLines.push(line);
      console.log(`${stamp()} ?? ${line}`);
    }
    return;
  }
  // Version / handshake
  console.log(`${stamp()} -- ${line}`);
}

sock.on('connect', () => {
  console.log(`${stamp()} connected to ${HOST}:${PORT}`);
  // Register as a GUI client so the radio replies for mixer commands.
  send('client program POTACAT-PROBE', 'identify');
  send('sub mixer all', 'sub mixer all');
  guiSeq = send('client gui', 'register as GUI client');
});

sock.on('error', (e) => {
  console.error(`${stamp()} socket error: ${e.message}`);
  process.exit(1);
});

sock.on('close', () => {
  console.log(`${stamp()} socket closed`);
  printSummary();
  process.exit(0);
});

sock.connect(PORT, HOST);
console.log(`${stamp()} dialing ${HOST}:${PORT}...`);

async function probeMixer() {
  console.log(`${stamp()} -- SERIALIZED probe — listen between each test`);
  // Round 5: only the candidates that returned OK in round 4. Fire each
  // one IN ISOLATION, hold for 2 s so Casey can hear if the radio went
  // silent, then UN-mute and pause 2 s so audio resumes audibly before
  // the next test. The console prints the test letter before firing.
  const tests = [
    // Round 6: the per-slice monitor mute. This sits UPSTREAM of all three
    // onboard outputs (speaker + headphone + lineout) and the remote-audio
    // stream, and is independent of the DAX tap — the SmartSDR "MUT" button.
    // If this silences the 8600 front-panel speaker, it confirms the
    // setOnboardAudioMute() fix in lib/smartsdr.js. Tests slice 0 (index A),
    // the slice Flex Direct restores; change the index if yours differs.
    {
      label: 'M: slice set 0 audio_mute=1   (vs   audio_mute=0)  <-- the fix',
      mute:    'slice set 0 audio_mute=1',
      unmute:  'slice set 0 audio_mute=0',
    },
    {
      label: 'A: mixer headphone mute 1   (vs   mixer headphone mute 0)',
      mute:    'mixer headphone mute 1',
      unmute:  'mixer headphone mute 0',
    },
    {
      label: 'B: mixer headphone gain 0   (vs   mixer headphone gain 52)',
      mute:    'mixer headphone gain 0',
      unmute:  'mixer headphone gain 52',
    },
    {
      label: 'C: mixer lineout mute 1   (vs   mixer lineout mute 0)',
      mute:    'mixer lineout mute 1',
      unmute:  'mixer lineout mute 0',
    },
    {
      label: 'D: mixer lineout gain 0   (vs   mixer lineout gain 46)',
      mute:    'mixer lineout gain 0',
      unmute:  'mixer lineout gain 46',
    },
    {
      label: 'F: mixer headphones (plural) mute=1   (vs   mute=0)',
      mute:    'mixer headphones mute=1',
      unmute:  'mixer headphones mute=0',
    },
    {
      label: 'G: mixer headphones (plural) mute 1   (vs   mute 0)',
      mute:    'mixer headphones mute 1',
      unmute:  'mixer headphones mute 0',
    },
    // Front-speaker is the most likely culprit on the 8600 — try a few
    // shapes for it inline with the working `mixer` verb syntax.
    {
      label: 'S1: mixer front_speaker mute 1 (8000-series guess)',
      mute:    'mixer front_speaker mute 1',
      unmute:  'mixer front_speaker mute 0',
    },
    {
      label: 'S2: mixer front_speaker mute=1',
      mute:    'mixer front_speaker mute=1',
      unmute:  'mixer front_speaker mute=0',
    },
    {
      label: 'S3: mixer fs mute 1 (short name)',
      mute:    'mixer fs mute 1',
      unmute:  'mixer fs mute 0',
    },
  ];
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    console.log(`\n${stamp()} ========== TEST ${i + 1}/${tests.length}: ${t.label} ==========`);
    console.log(`${stamp()} >>> MUTING with: ${t.mute}`);
    send(t.mute, `MUTE ${t.label}`);
    await sleep(2000);
    console.log(`${stamp()} >>> UNMUTING with: ${t.unmute}`);
    send(t.unmute, `UNMUTE ${t.label}`);
    await sleep(2000);
  }
  console.log(`\n${stamp()} -- all tests done. Closing.`);
  sock.end();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function printSummary() {
  console.log('\n========================================');
  console.log('Mixer status lines (look for property names):');
  console.log('========================================');
  if (mixerStatusLines.length === 0) {
    console.log('  (none — radio did not emit any mixer status, or sub mixer all is wrong syntax)');
  } else {
    for (const s of mixerStatusLines) console.log('  ' + s);
  }
  console.log('\n========================================');
  console.log('Probe results (which mute syntaxes the radio accepted):');
  console.log('========================================');
  const probeReplies = replies.filter(r => /mute=1|level .+=0|source=none/i.test(r.cmd) && r.label !== 'restore');
  if (probeReplies.length === 0) {
    console.log('  (no probe replies captured)');
  } else {
    for (const r of probeReplies) {
      const tag = r.status === 0 ? 'OK    ' : `ERR ${r.status.toString(16).padStart(4, '0')}`;
      console.log(`  ${tag}  ${r.label.padEnd(50)}  cmd: ${r.cmd}`);
    }
  }
  console.log('\nInterpretation:');
  console.log('  - "OK" replies = radio accepted the syntax (does not prove it muted anything).');
  console.log('  - Cross-reference against what you HEARD: whichever syntax silenced the 8600\'s');
  console.log('    front-panel speaker is the one to keep in lib/smartsdr.js setOnboardAudioMute.');
}
