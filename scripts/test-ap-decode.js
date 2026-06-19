'use strict';
/**
 * Empirical check of native AP (a priori) FT8 decoding.
 *
 * Scenario: a station replies LATE to our CQ. Their waveform is truncated
 * (leading Costas dropped) and weak. We (K3SBP) receive it. AP-mycall should
 * recover decodes that the plain no-AP decoder misses — the receive-side
 * mirror of the late-start TX feature.
 *
 * Run: node scripts/test-ap-decode.js
 */
const path = require('path');
const native = require(path.join(__dirname, '..', 'lib', 'ft8_native', 'build', 'Release', 'ft8_native.node'));

const SR = 12000;
const CYCLE = 15 * SR;

// Deterministic PRNG so the result is repeatable across runs/machines.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng) { // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function addNoiseTruncate(clean, { cutSec, sigma, seed }) {
  const rng = mulberry32(seed);
  const out = new Float32Array(CYCLE);
  const cut = Math.round(cutSec * SR);
  for (let i = 0; i < CYCLE; i++) {
    const sig = (i >= cut && i < clean.length) ? clean[i] : 0; // drop leading symbols
    out[i] = sig + sigma * gauss(rng);
  }
  return out;
}

function hasReply(results, theirCall, myCall) {
  return results.some((r) => r.text.includes(myCall) && r.text.includes(theirCall));
}

(async () => {
  const ft8 = await import('ft8js');
  const MY = 'K3SBP';
  const THEIR = 'W1ABC';
  const msg = `${MY} ${THEIR} FN42`; // a reply addressed to us
  const clean = await ft8.encode(msg, 1200);

  console.log(`\nReply under test: "${msg}"  (we are ${MY}, AP target)\n`);
  console.log('cutSec  sigma  seed | plain(noAP)  AP-mycall  AP-both | verdict');
  console.log('-------------------- + -------------------------------- + -------');

  let apWins = 0, total = 0;
  for (const cutSec of [0, 3, 5]) {
    for (const sigma of [0.18, 0.24, 0.30]) {
      for (const seed of [1, 2, 3]) {
        total++;
        const samples = addNoiseTruncate(clean, { cutSec, sigma, seed });

        const plain = native.decode(samples, 'FT8', '', '');
        const ap1 = native.decode(samples, 'FT8', MY, '');
        const ap2 = native.decode(samples, 'FT8', MY, THEIR);

        const pOk = hasReply(plain, THEIR, MY);
        const a1Ok = hasReply(ap1, THEIR, MY);
        const a2Ok = hasReply(ap2, THEIR, MY);
        const apRescue = !pOk && (a1Ok || a2Ok);
        if (apRescue) apWins++;
        const verdict = apRescue ? 'AP RESCUE' : (pOk ? 'both' : (a1Ok || a2Ok ? 'AP' : '—'));

        const apTagged = [...ap1, ...ap2].some((r) => r.ap && r.text.includes(MY));
        console.log(
          `${String(cutSec).padStart(5)}  ${sigma.toFixed(2)}   ${seed}  | ` +
          `${pOk ? 'YES' : ' no'}          ${a1Ok ? 'YES' : ' no'}       ${a2Ok ? 'YES' : ' no'}     | ${verdict}` +
          (apRescue && apTagged ? ' (ap-flagged)' : '')
        );
      }
    }
  }
  console.log(`\nAP rescued ${apWins}/${total} marginal cases the plain decoder missed.`);

  // Sanity: a clean signal still decodes plain and is NOT ap-flagged.
  const cleanIn = addNoiseTruncate(clean, { cutSec: 0, sigma: 0.02, seed: 9 });
  const cleanRes = native.decode(cleanIn, 'FT8', MY, THEIR);
  const cr = cleanRes.find((r) => r.text.includes(MY) && r.text.includes(THEIR));
  console.log(`\nClean-signal sanity: decoded="${cr ? cr.text : 'MISS'}" ap=${cr ? cr.ap : 'n/a'} (expect ap=false)`);
})();
