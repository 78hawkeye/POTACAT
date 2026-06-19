// Voice push-to-talk controller for operating a REMOTE shack
// (remote-desktop Phase 2 audio leg). Pure state machine — no DOM, no IPC —
// so it's unit-testable. The renderer (app.js) injects `sendPtt` (->
// window.api.remoteClientAudioPtt, which keys the remote rig AND opens our
// mic in the answerer) and drives it from the press-and-hold button.
//
// Safety is the whole point: a ham rig must never transmit by accident.
//   - PTT is GATED on remote audio actually being active.
//   - down()/up() are idempotent (no duplicate key/unkey on the wire).
//   - if audio drops while keyed, we force-release (no stuck carrier).
(function (global) {
  'use strict';

  class RemotePttController {
    constructor(opts) {
      opts = opts || {};
      this._send = opts.sendPtt || function () {}; // (bool) -> key/unkey + mic
      this._onChange = opts.onChange || function () {}; // (keyed:bool) -> UI
      this._active = false; // remote rig audio session up?
      this._keyed = false;  // currently transmitting?
    }

    // Remote audio came up / went away. Going away while keyed force-releases
    // so we can't leave the remote rig stuck in TX.
    setActive(on) {
      this._active = !!on;
      if (!this._active && this._keyed) this.up();
    }

    isActive() { return this._active; }
    isKeyed() { return this._keyed; }

    // Begin transmit. No-op (returns false) if audio isn't up or already keyed.
    down() {
      if (!this._active || this._keyed) return false;
      this._keyed = true;
      this._send(true);
      this._onChange(true);
      return true;
    }

    // End transmit. No-op if not keyed.
    up() {
      if (!this._keyed) return false;
      this._keyed = false;
      this._send(false);
      this._onChange(false);
      return true;
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { RemotePttController };
  global.RemotePttController = RemotePttController;
})(typeof window !== 'undefined' ? window : globalThis);
