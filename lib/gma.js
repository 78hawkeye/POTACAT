// GMA (Global Mountain Activity) spot client — https://www.cqgma.org
//
// GMA is an umbrella program: its feed re-publishes WWFF and other spots
// alongside its own summit/hut/castle references. We ingest the whole feed
// and let main.js's cross-source dedupe collapse overlaps with the dedicated
// WWFF/SOTA sources (gma is added to _DEDUPE_PRIORITY). (OneLD/Luk request
// 2026-06-13.)
//
// RX: a polled JSON feed, NOT a telnet cluster (despite the "cluster"
// phrasing in the request). GET /api/spots/N/ returns the last N spots:
//   { SOURCE, TIMESTAMP, RECORDS: "last N spots", RCD: [ {DATE,TIME,SPOTTER,
//     ACTIVATOR,QRG,MODE,REF,TEXT,LAT,LON,NAME}, ... ] }
// GMA serves a CURATED set of fixed counts — /10/ and /25/ return data,
// /5//50//100/ 404 — so we use /25/ (the largest confirmed-good value) and
// fail soft on anything else. There is no per-spot id, so dedupe upstream
// keys on call+freq+ref.
//
// TX (re-spot): GMA runs a DXSpider cluster at cqgma.org:7300, so re-spots
// go out as a `DX` line over telnet — the SAME mechanism POTACAT already
// uses for WWFF Spotline (lib/wwff-respot.js), no HTTP API/auth needed.
const https = require('https');
const net = require('net');

const API_HOST = 'www.cqgma.org';
const SPOT_COUNT = 25;                       // known-good fixed endpoint
const SPOT_PATH = `/api/spots/${SPOT_COUNT}/`;

const CLUSTER_HOST = 'cqgma.org';            // GMA DXSpider cluster (re-spot)
const CLUSTER_PORT = 7300;
const RESPOT_TIMEOUT = 10000;

// Optional logger (main wires this to sendCatLog). No-op by default.
let _log = () => {};
function setLogger(fn) { if (typeof fn === 'function') _log = fn; }

// ── Pure helpers (unit-tested in test/gma-test.js) ──────────────────────────

// GMA DATE (YYYYMMDD) + TIME (HHMM), both UTC, → unix SECONDS — matching the
// spot_time field WWFF returns so processGmaSpots can mirror processWwffSpots.
// Returns 0 when unparseable.
function gmaTimeToUnix(date, time) {
  const d = String(date == null ? '' : date);
  const t = String(time == null ? '' : time).padStart(4, '0');
  if (!/^\d{8}$/.test(d) || !/^\d{4}$/.test(t)) return 0;
  const ms = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), 0);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

// Real reference activation? GMA uses "UNDEFINED" (and occasionally blank or
// "?") for general spots with no program reference — skip those; they're not
// a reference chase and would just be noise beside POTA/SOTA/WWFF.
function hasReference(ref) {
  const r = String(ref == null ? '' : ref).trim().toUpperCase();
  return r !== '' && r !== 'UNDEFINED' && r !== '?';
}

// Normalize one RCD record into the WWFF-style shape processGmaSpots consumes.
// Returns null for records to skip (no ref / no call / bad freq).
function normalizeRecord(rec) {
  if (!rec || !hasReference(rec.REF)) return null;
  const activator = String(rec.ACTIVATOR || '').toUpperCase().trim();
  if (!activator) return null;
  const freqKhz = parseFloat(rec.QRG);
  if (!Number.isFinite(freqKhz) || freqKhz <= 0) return null;
  const lat = (rec.LAT !== '' && rec.LAT != null) ? parseFloat(rec.LAT) : null;
  const lon = (rec.LON !== '' && rec.LON != null) ? parseFloat(rec.LON) : null;
  return {
    activator,
    frequency_khz: freqKhz,
    reference: String(rec.REF || '').toUpperCase().trim(),
    reference_name: (rec.NAME && rec.NAME !== '?') ? String(rec.NAME) : '',
    mode: String(rec.MODE || '').toUpperCase().trim(),
    spotter: String(rec.SPOTTER || '').toUpperCase().trim(),
    comments: String(rec.TEXT || '').trim(),
    spot_time: gmaTimeToUnix(rec.DATE, rec.TIME),
    latitude: (lat != null && !Number.isNaN(lat)) ? lat : null,
    longitude: (lon != null && !Number.isNaN(lon)) ? lon : null,
  };
}

// Build the DXSpider "DX" re-spot line. Exported for unit tests.
function buildRespotLine({ activator, frequency, reference, mode, comments }) {
  const freqKhz = Math.round(parseFloat(frequency));
  const comment = [reference, mode, comments].filter(Boolean).join(' ');
  return `DX ${freqKhz} ${String(activator || '').toUpperCase()} ${comment}`.trim();
}

// ── Network ─────────────────────────────────────────────────────────────────

function fetchSpots() {
  return new Promise((resolve, reject) => {
    https.get({
      host: API_HOST,
      path: SPOT_PATH,
      headers: { 'User-Agent': 'POTACAT/1.0', 'Accept': 'application/json' },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`GMA HTTP ${res.statusCode}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const rcd = Array.isArray(parsed && parsed.RCD) ? parsed.RCD : [];
          const out = [];
          for (const rec of rcd) {
            const n = normalizeRecord(rec);
            if (n) out.push(n);
          }
          resolve(out);
        } catch (e) {
          reject(new Error('Failed to parse GMA response'));
        }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('GMA fetch timed out')); });
  });
}

// Post a re-spot to the GMA cluster via telnet — mirrors postWwffRespot.
function postGmaRespot({ activator, spotter, frequency, reference, mode, comments }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      if (err) reject(err); else resolve();
    };

    const sock = net.createConnection({ host: CLUSTER_HOST, port: CLUSTER_PORT });
    const timer = setTimeout(() => finish(new Error('GMA respot timed out')), RESPOT_TIMEOUT);

    let buf = '';
    let state = 'login'; // login -> prompt -> done

    sock.on('data', (chunk) => {
      buf += chunk.toString();
      if (state === 'login' && /login:|call:|please enter your call/i.test(buf)) {
        state = 'prompt';
        buf = '';
        sock.write(String(spotter || '').toUpperCase() + '\r\n');
      } else if (state === 'prompt' && />\s*$/.test(buf)) {
        state = 'done';
        buf = '';
        sock.write(buildRespotLine({ activator, frequency, reference, mode, comments }) + '\r\n');
        // Brief delay to let the node acknowledge, then close.
        setTimeout(() => { clearTimeout(timer); finish(); }, 1500);
      }
    });

    sock.on('error', (err) => { clearTimeout(timer); finish(err); });
    sock.on('close', () => { clearTimeout(timer); finish(); });
  });
}

module.exports = {
  fetchSpots,
  postGmaRespot,
  setLogger,
  // exported for unit tests
  _normalizeRecord: normalizeRecord,
  _gmaTimeToUnix: gmaTimeToUnix,
  _hasReference: hasReference,
  _buildRespotLine: buildRespotLine,
};
