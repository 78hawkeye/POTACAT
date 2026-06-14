// POTACAT Cloud — runtime helper for the bundled cloudflared binary.
//
// electron-builder ships the platform-appropriate binary as an
// extraResource so it lands at `process.resourcesPath/cloudflared(.exe)`
// in packaged builds. In dev (electron .) the binary lives under
// `resources/cloudflared/<platform>/cloudflared(.exe)` and is fetched
// on demand via `node scripts/fetch-cloudflared.js`.
//
// `resolveCloudflaredPath()` is the only thing other modules should
// call — it handles packaged-vs-dev and the .exe suffix.

const fs = require('fs');
const path = require('path');

const EXE = process.platform === 'win32' ? '.exe' : '';

function devVendorPath() {
  // Source tree layout written by scripts/fetch-cloudflared.js.
  const platDir =
    process.platform === 'win32'  ? 'win'   :
    process.platform === 'darwin' ? 'mac'   :
                                    'linux';
  return path.join(__dirname, '..', 'resources', 'cloudflared', platDir, `cloudflared${EXE}`);
}

function packagedPath() {
  // process.resourcesPath is undefined in non-Electron contexts; the
  // packaged extraResource entry puts the binary flat at that root.
  if (!process.resourcesPath) return null;
  return path.join(process.resourcesPath, `cloudflared${EXE}`);
}

function resolveCloudflaredPath() {
  const candidates = [packagedPath(), devVendorPath()].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function isAvailable() {
  return resolveCloudflaredPath() !== null;
}

/**
 * Is this spawn() failure an architecture/exec mismatch — i.e. the
 * cloudflared binary's CPU type doesn't match this machine? macOS
 * surfaces it as errno -86 (EBADARCH, "Bad CPU type in executable");
 * Linux as ENOEXEC ("Exec format error"). N3VD hit -86 on a Mac
 * (2026-06-12) running an arch that didn't match the bundled binary —
 * the raw "spawn Unknown system error -86" is meaningless to a user.
 */
function isArchSpawnError(err) {
  if (!err) return false;
  const code = String(err.code || '');
  const msg = String(err.message || '');
  return code === 'EBADARCH' || code === 'ENOEXEC'
    || err.errno === -86 || err.errno === -8
    || /\b-86\b/.test(msg)
    || /bad cpu type|exec format error/i.test(msg);
}

/**
 * Find a system-installed cloudflared to fall back on when the bundled
 * one is the wrong architecture (e.g. Apple-Silicon Mac that ended up
 * with the x64 build, or vice-versa). Returns an absolute path or null.
 * Checks the common Homebrew / manual install locations, then PATH.
 */
function findSystemCloudflared() {
  if (process.platform === 'win32') return null; // bundled .exe is the only path on Windows
  const candidates = [
    '/opt/homebrew/bin/cloudflared', // Apple Silicon Homebrew
    '/usr/local/bin/cloudflared',    // Intel Homebrew / manual
    '/usr/bin/cloudflared',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('which', ['cloudflared'], { encoding: 'utf8', timeout: 3000 }).trim();
    if (out && fs.existsSync(out)) return out;
  } catch { /* not on PATH */ }
  return null;
}

module.exports = { resolveCloudflaredPath, isAvailable, isArchSpawnError, findSystemCloudflared };
