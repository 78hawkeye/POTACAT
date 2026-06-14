// Rotor-EZ / DCU-1 serial rotator client.
//
// Drives Idiom Press / Ham Supply Rotor-EZ and RotorCard control boards
// (retrofits for Hy-Gain Ham-IV/Ham-V/T2X/CD-45-II and Yaesu rotators)
// plus genuine Hy-Gain DCU-1 boxes. Protocol per the official Idiom
// Press "Rotor-EZ Rotator Control Protocol" doc (© 2006, hamsupply.com)
// cross-checked against Hamlib rotators/rotorez/rotorez.c:
//
//   serial      4800 baud, 8 data bits, no parity, 1 stop bit, no flow ctl
//   AP1xxx;     set target bearing (ALWAYS three digits, zero-padded)
//   AM1;        execute rotation to the AP1 target
//   AI1;        bearing inquiry — response is exactly ";xxx" (no other
//               delimiters; ERC clones answer "xxx;" so we accept both)
//   ;           stop rotation immediately
//
// We send "AP1xxx;" + "AM1;" (not the "AP1xxx<CR>" one-shot) because the
// two-command form is the one a genuine DCU-1 also understands — one
// backend covers Rotor-EZ, RotorCard and DCU-1.
//
// THE QUIRK THAT SHAPES THIS FILE (Idiom Press FAQ, page 2): sending a
// new bearing while the rotator is turning STOPS it — it does NOT
// re-target. The board then waits ~5 s of brake delay, during which any
// command is silently IGNORED. So rapid QSYs must not be forwarded
// verbatim: while a rotation is in flight we hold the newest requested
// bearing in _pendingTarget and only send it after AI1 polling shows the
// rotator has stopped AND the brake-delay window has passed.
//
// Position readback jitters a few degrees (wire-wound pot) — "stopped"
// means N consecutive reads within moveToleranceDeg, and "arrived" means
// within arriveToleranceDeg of the target, per the vendor's own advice.

'use strict';

const { EventEmitter } = require('events');

const DEFAULTS = {
  pollIntervalMs: 1000,       // AI1; cadence while a rotation is in flight
  idlePollIntervalMs: 15000,  // AI1; cadence at rest (keeps `bearing` fresh for UI)
  brakeDelayMs: 6000,         // vendor says ~5 s; commands inside it are ignored
  stableReads: 3,             // consecutive within-tolerance reads = stopped
  moveToleranceDeg: 2,        // pot jitter — reads within this are "not moving"
  arriveToleranceDeg: 6,      // within this of target = arrived
  maxTurnMs: 120000,          // watchdog — a full 360° on a T2X is ~1 min
  reconnectDelayMs: 5000,
};

function defaultPortFactory(path) {
  // Lazy require so unit tests (which inject a fake) never touch the
  // native serialport binding.
  const { SerialPort } = require('serialport');
  return new SerialPort({
    path,
    baudRate: 4800,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    rtscts: false,
  });
}

class RotorEzClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._opts = { ...DEFAULTS, ...opts };
    this._portFactory = opts.portFactory || defaultPortFactory;
    this._path = null;
    this._port = null;
    this.connected = false;

    this.bearing = null;        // last AI1 reading (degrees) or null
    this.state = 'idle';        // 'idle' | 'turning' | 'braking'
    this._target = null;        // bearing of the rotation in flight
    this._pendingTarget = null; // newest bearing requested while busy
    this._brakeUntil = 0;
    this._turnStartedAt = 0;

    this._buf = '';
    this._lastRead = null;
    this._stableCount = 0;

    this._pollTimer = null;
    this._reconnectTimer = null;
    this._closing = false;
  }

  connect(path) {
    this.disconnect();
    this._closing = false;
    this._path = path;
    this._openPort();
  }

  disconnect() {
    this._closing = true;
    this._stopPolling();
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._port) {
      try { this._port.removeAllListeners(); } catch {}
      try { if (this._port.isOpen) this._port.close(); } catch {}
      this._port = null;
    }
    this.connected = false;
    this.state = 'idle';
    this._target = null;
    this._pendingTarget = null;
    this._buf = '';
  }

  _openPort() {
    let port;
    try {
      port = this._portFactory(this._path);
    } catch (err) {
      this.emit('log', `Rotor-EZ: failed to open ${this._path}: ${err.message}`);
      this._scheduleReconnect();
      return;
    }
    this._port = port;

    port.on('open', () => this._onOpen());
    port.on('data', (chunk) => this._onData(chunk));
    port.on('error', (err) => this.emit('log', `Rotor-EZ serial error: ${err.message}`));
    port.on('close', () => this._onClose());
    // Fake ports in tests are synchronously open; serialport opens async
    // and fires 'open'. Cover both.
    if (port.isOpen) this._onOpen();
  }

  _onOpen() {
    if (this.connected) return;
    this.connected = true;
    this.emit('status', { connected: true, path: this._path });
    this.emit('log', `Rotor-EZ connected on ${this._path} (4800 8N1)`);
    this._startPolling();
  }

  _onClose() {
    const wasConnected = this.connected;
    this.connected = false;
    this._stopPolling();
    this.state = 'idle';
    if (wasConnected) this.emit('status', { connected: false, path: this._path });
    if (!this._closing) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._closing || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._closing) this._openPort();
    }, this._opts.reconnectDelayMs);
  }

  _write(s) {
    if (!this._port || !this.connected) return false;
    try { this._port.write(s); return true; }
    catch (err) { this.emit('log', `Rotor-EZ write failed: ${err.message}`); return false; }
  }

  /**
   * Point the rotator at `azimuth` degrees. Returns true if the command
   * was sent or queued. If a rotation is already in flight the bearing is
   * held as the pending target and sent once the rotator has stopped and
   * the brake delay has elapsed (see header comment — sending it
   * immediately would stop the rotator and then be ignored).
   */
  rotate(azimuth) {
    const az = this._normalize(azimuth);
    if (az == null) return false;
    if (!this.connected) {
      this.emit('log', 'Rotor-EZ: rotate ignored — not connected');
      return false;
    }
    if (this.state === 'idle' && Date.now() >= this._brakeUntil) {
      return this._sendRotate(az);
    }
    this._pendingTarget = az;
    this.emit('log', `Rotor-EZ: busy (${this.state}) — queued ${String(az).padStart(3, '0')}°`);
    this._startPolling(); // make sure we notice when it stops
    return true;
  }

  /** Stop rotation immediately. Clears any queued bearing. */
  stop() {
    this._pendingTarget = null;
    if (!this._write(';')) return false;
    // Stopping mid-turn still incurs the brake delay before the board
    // accepts another command.
    if (this.state === 'turning') {
      this.state = 'braking';
      this._brakeUntil = Date.now() + this._opts.brakeDelayMs;
    }
    this.emit('log', 'Rotor-EZ: stop');
    return true;
  }

  _normalize(azimuth) {
    const n = Math.round(Number(azimuth));
    if (!isFinite(n)) return null;
    return ((n % 360) + 360) % 360;
  }

  _sendRotate(az) {
    const cmd = `AP1${String(az).padStart(3, '0')};AM1;`;
    if (!this._write(cmd)) return false;
    this._target = az;
    this.state = 'turning';
    this._turnStartedAt = Date.now();
    this._stableCount = 0;
    this._lastRead = null;
    this.emit('log', `Rotor-EZ -> ${String(az).padStart(3, '0')}° (${cmd})`);
    this._startPolling();
    return true;
  }

  // ── AI1 polling / motion tracking ─────────────────────────────────

  _startPolling() {
    this._stopPolling();
    const active = this.state !== 'idle' || this._pendingTarget != null;
    const interval = active ? this._opts.pollIntervalMs : this._opts.idlePollIntervalMs;
    this._pollTimer = setInterval(() => this._pollTick(), interval);
  }

  _stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  _pollTick() {
    if (!this.connected) return;
    // Watchdog: a turn that never settles (cable fault, operator grabbed
    // the front panel) must not wedge the queue forever.
    if (this.state === 'turning' && Date.now() - this._turnStartedAt > this._opts.maxTurnMs) {
      this.emit('log', 'Rotor-EZ: turn watchdog expired — assuming stopped');
      this._enterBraking();
    }
    if (this.state === 'braking' && Date.now() >= this._brakeUntil) {
      this._finishBraking();
    }
    this._write('AI1;');
  }

  _onData(chunk) {
    this._buf += chunk.toString('latin1');
    if (this._buf.length > 64) this._buf = this._buf.slice(-64); // V-string or junk — keep tail
    // Idiom Press format: ";xxx" back-to-back with no other delimiters.
    // ERC clones answer "xxx;". Scan for any 3-digit group adjacent to a
    // ';' and consume every complete reading.
    let consumedTo = 0;
    const matches = [...this._buf.matchAll(/;(\d{3})|(\d{3});/g)];
    for (const m of matches) {
      const deg = parseInt(m[1] || m[2], 10);
      if (deg <= 360) this._onBearingRead(deg % 360);
      consumedTo = m.index + m[0].length;
    }
    if (consumedTo > 0) this._buf = this._buf.slice(consumedTo);
  }

  _onBearingRead(deg) {
    this.bearing = deg;
    this.emit('bearing', deg);

    if (this.state === 'idle') return;

    if (this._lastRead != null && this._angleDiff(deg, this._lastRead) <= this._opts.moveToleranceDeg) {
      this._stableCount++;
    } else {
      this._stableCount = 0;
    }
    this._lastRead = deg;

    if (this.state === 'turning' && this._stableCount >= this._opts.stableReads) {
      this._enterBraking();
    }
  }

  _enterBraking() {
    this.state = 'braking';
    this._brakeUntil = Date.now() + this._opts.brakeDelayMs;
  }

  _finishBraking() {
    this.state = 'idle';
    const target = this._target;
    this._target = null;
    if (target != null && this.bearing != null) {
      const arrived = this._angleDiff(this.bearing, target) <= this._opts.arriveToleranceDeg;
      this.emit('settled', { bearing: this.bearing, target, arrived });
    }
    if (this._pendingTarget != null) {
      const next = this._pendingTarget;
      this._pendingTarget = null;
      this._sendRotate(next);
      return;
    }
    this._startPolling(); // drop back to the slow idle cadence
  }

  _angleDiff(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }
}

module.exports = { RotorEzClient };
