// parkStatesFromLocation — regression for WG9I's multi-state park bug
// (2026-06-12): logging a hunter QSO at a park spanning states wrote
// garbage like "WI,US-MI" into the ADIF STATE field because the old
// parse split on '-' before splitting on ','.
// Run: node test/park-state-test.js

'use strict';

const { parkStatesFromLocation } = require('../lib/pota');

let passed = 0, failed = 0;
function checkEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log(`  ✗ FAIL: ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`); }
}

console.log('=== parkStatesFromLocation ===');

checkEq(parkStatesFromLocation('US-ME'), ['ME'], 'single US state');
checkEq(parkStatesFromLocation('VE-ON'), ['ON'], 'Canadian province');
checkEq(parkStatesFromLocation('US-WI,US-MI'), ['WI', 'MI'], 'two-state park (WG9I repro)');
checkEq(parkStatesFromLocation('US-WI, US-MI'), ['WI', 'MI'], 'tolerates space after comma');
checkEq(parkStatesFromLocation('US-CT,US-MA,US-NH,US-NJ,US-NY,US-PA,US-VT'),
  ['CT', 'MA', 'NH', 'NJ', 'NY', 'PA', 'VT'], 'long trail park (7 states)');
checkEq(parkStatesFromLocation('US-DC,US-MD,US-DC'), ['DC', 'MD'], 'duplicates collapse');
checkEq(parkStatesFromLocation(''), [], 'empty string');
checkEq(parkStatesFromLocation(null), [], 'null');
checkEq(parkStatesFromLocation(undefined), [], 'undefined');
checkEq(parkStatesFromLocation('XYZ'), [], 'designator without a dash yields nothing');

// The actual WG9I symptom: no result may ever contain a comma or prefix.
{
  const states = parkStatesFromLocation('US-WI,US-MI');
  const clean = states.every(s => !s.includes(',') && !s.includes('-'));
  if (clean) { passed++; console.log('  ✓ no state code carries comma/prefix garbage'); }
  else { failed++; console.log('  ✗ FAIL: garbage in state codes: ' + JSON.stringify(states)); }
}

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
