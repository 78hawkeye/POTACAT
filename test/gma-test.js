// Tests for lib/gma.js — the pure pieces of the GMA spot client: the
// DATE+TIME→unix conversion, the UNDEFINED/blank reference skip, record
// normalization (field mapping + kHz parse + lat/lon), and the DXSpider
// re-spot line builder. Network (the https GET + telnet re-spot) isn't
// exercised here.
// Run: node test/gma-test.js
'use strict';

const gma = require('../lib/gma');

let passed = 0, failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log(`  ✗ FAIL: ${label} (got ${a}, expected ${e})`); }
}
function ok(cond, label) { eq(!!cond, true, label); }

console.log('=== gmaTimeToUnix ===');
{
  // 2026-06-16 21:28 UTC
  const u = gma._gmaTimeToUnix('20260616', '2128');
  eq(new Date(u * 1000).toISOString(), '2026-06-16T21:28:00.000Z', 'YYYYMMDD + HHMM parsed as UTC');
  eq(gma._gmaTimeToUnix('20260101', '07'), Math.floor(Date.UTC(2026, 0, 1, 0, 7, 0) / 1000), 'short TIME left-padded to HHMM');
  eq(gma._gmaTimeToUnix('', ''), 0, 'empty inputs → 0');
  eq(gma._gmaTimeToUnix('2026061', '2128'), 0, 'malformed DATE → 0');
}

console.log('=== hasReference ===');
{
  ok(gma._hasReference('DL/EW-017'), 'GMA summit ref is a reference');
  ok(gma._hasReference('KFF-2112'), 'WWFF ref (in the GMA feed) is a reference');
  ok(!gma._hasReference('UNDEFINED'), 'UNDEFINED is not a reference');
  ok(!gma._hasReference(''), 'blank is not a reference');
  ok(!gma._hasReference('?'), '"?" is not a reference');
  ok(!gma._hasReference('  undefined  '), 'case/space-insensitive UNDEFINED skip');
}

console.log('=== normalizeRecord ===');
{
  const rec = {
    DATE: '20260616', TIME: '2128', SPOTTER: 'dc0la', ACTIVATOR: 'es4/dc0la',
    TEXT: '[smg] QRT', REF: 'dl/ew-017', QRG: '14046.00', MODE: 'cw',
    LAT: '47.5', LON: '8.1', NAME: 'Some Summit',
  };
  const n = gma._normalizeRecord(rec);
  eq(n.activator, 'ES4/DC0LA', 'activator uppercased (prefix + call preserved)');
  eq(n.frequency_khz, 14046, 'QRG parsed to kHz number (decimal ok)');
  eq(n.reference, 'DL/EW-017', 'reference uppercased');
  eq(n.reference_name, 'Some Summit', 'NAME carried as reference_name');
  eq(n.mode, 'CW', 'mode uppercased');
  eq(n.spotter, 'DC0LA', 'spotter uppercased');
  eq(n.comments, '[smg] QRT', 'TEXT carried as comments');
  eq(n.latitude, 47.5, 'lat parsed');
  eq(n.longitude, 8.1, 'lon parsed');
  ok(n.spot_time > 0, 'spot_time populated');

  // Skips
  eq(gma._normalizeRecord({ ...rec, REF: 'UNDEFINED' }), null, 'UNDEFINED ref → skipped');
  eq(gma._normalizeRecord({ ...rec, ACTIVATOR: '' }), null, 'missing activator → skipped');
  eq(gma._normalizeRecord({ ...rec, QRG: 'abc' }), null, 'bad QRG → skipped');

  // Empty lat/lon → null (GMA sends "" when unknown)
  const noLoc = gma._normalizeRecord({ ...rec, LAT: '', LON: '' });
  eq(noLoc.latitude, null, 'empty LAT → null');
  eq(noLoc.longitude, null, 'empty LON → null');
  // NAME "?" → blank reference_name
  eq(gma._normalizeRecord({ ...rec, NAME: '?' }).reference_name, '', 'NAME "?" → blank name');
}

console.log('=== buildRespotLine ===');
{
  eq(
    gma._buildRespotLine({ activator: 'es4/dc0la', frequency: '14046.0', reference: 'DL/EW-017', mode: 'CW', comments: 'tnx qso' }),
    'DX 14046 ES4/DC0LA DL/EW-017 CW tnx qso',
    'DX line: rounded kHz, upper call, ref+mode+comment',
  );
  eq(
    gma._buildRespotLine({ activator: 'g4abc/p', frequency: 7090, reference: 'G/CE-001', mode: 'SSB' }),
    'DX 7090 G4ABC/P G/CE-001 SSB',
    'DX line without optional comment',
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
