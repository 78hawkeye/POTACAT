// JTCAT VITA-49 source AudioWorkletProcessor — replaces the
// per-frame createBuffer + createBufferSource pattern that was
// allocating ~190 Web Audio nodes/sec on SmartSDR Direct. Each
// VITA-49 PCM frame from main arrives via port.postMessage and lands
// in a ring buffer; process() drains the ring buffer with linear
// interpolation from the source rate (24 kHz dax_rx) up/down to the
// AudioContext's native rate. One node, allocated once, fed forever.
//
// K3SBP 2026-06-02 — replaces the BufferSource churn that caused
// "[Audio] Backpressure on jtcat-vita49-audio" to spiral as soon as
// the renderer fell behind on Web Audio node scheduling.

class Vita49SourceProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.sourceRate = opts.sourceRate || 24000;
    // sampleRate is a global in the worklet scope — the AudioContext's
    // native rate (typically 48000 on desktop).
    this.targetRate = sampleRate;
    this.step = this.sourceRate / this.targetRate; // 0.5 for 24k→48k

    this.bufferMs = Math.max(100, opts.bufferMs || 500);
    this.startBufferMs = Math.max(0, Math.min(this.bufferMs, opts.startBufferMs || 0));
    this.resumeBufferMs = Math.max(0, Math.min(this.bufferMs, opts.resumeBufferMs || this.startBufferMs || 0));
    this.startBufferSamples = Math.ceil(this.sourceRate * this.startBufferMs / 1000);
    this.resumeBufferSamples = Math.ceil(this.sourceRate * this.resumeBufferMs / 1000);

    // Configurable source-rate jitter buffer. SmartSDR can run almost
    // immediately, but Icom RS-BA1/WFVIEW-style UDP audio may arrive in
    // 200-1000 ms bursts even when packet sequence is mostly intact. wfview
    // hides that with an audio-output latency buffer; we do the same here
    // before the synthetic MediaStream reaches JTCAT's normal audio chain.
    this.bufSize = Math.ceil(this.sourceRate * this.bufferMs / 1000);
    this.buf = new Float32Array(this.bufSize);
    this.bufRead = 0;
    this.bufWrite = 0;
    this.bufAvailable = 0;
    this.buffering = this.startBufferSamples > 0;
    this.bufferTarget = this.startBufferSamples;

    // Sub-sample read cursor for linear interpolation.
    this.fracPos = 0;

    // Diagnostics counters (read via port.postMessage on demand).
    this.underruns = 0;
    this.overflows = 0;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg && msg.cmd === 'reset') {
        this.bufRead = 0;
        this.bufWrite = 0;
        this.bufAvailable = 0;
        this.fracPos = 0;
        this.buffering = this.startBufferSamples > 0;
        this.bufferTarget = this.startBufferSamples;
        return;
      }
      const pcm = msg;
      if (!pcm || !pcm.length) return;

      // If an IPC/radio burst overfills the jitter window, drop oldest
      // audio down near the configured target. Brief catch-up beats drifting
      // multiple seconds behind real time.
      if (this.bufAvailable + pcm.length > this.bufSize) {
        const target = Math.max(this.startBufferSamples, this.resumeBufferSamples, Math.floor(this.bufSize * 0.5));
        const drop = Math.min(this.bufAvailable, (this.bufAvailable + pcm.length) - target);
        this.bufRead = (this.bufRead + drop) % this.bufSize;
        this.bufAvailable -= drop;
        this.overflows++;
      }
      for (let i = 0; i < pcm.length; i++) {
        this.buf[this.bufWrite] = pcm[i];
        this.bufWrite = (this.bufWrite + 1) % this.bufSize;
      }
      this.bufAvailable += pcm.length;
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const len = out.length;
    const bufSize = this.bufSize;
    const buf = this.buf;
    const step = this.step;

    for (let i = 0; i < len; i++) {
      if (this.buffering) {
        if (this.bufAvailable >= this.bufferTarget) {
          this.buffering = false;
        } else {
          out[i] = 0;
          continue;
        }
      }
      if (this.bufAvailable < 2) {
        out[i] = 0;
        if (this.bufAvailable === 0) {
          this.underruns++;
          if (this.resumeBufferSamples > 0) {
            this.buffering = true;
            this.bufferTarget = this.resumeBufferSamples;
            this.fracPos = 0;
          }
        }
        continue;
      }
      const a = buf[this.bufRead];
      const nextIdx = (this.bufRead + 1) % bufSize;
      const b = buf[nextIdx];
      out[i] = a + (b - a) * this.fracPos;
      this.fracPos += step;
      while (this.fracPos >= 1) {
        this.fracPos -= 1;
        this.bufRead = (this.bufRead + 1) % bufSize;
        this.bufAvailable--;
        if (this.bufAvailable < 1) break;
      }
    }
    return true;
  }
}

registerProcessor('jtcat-vita49-source', Vita49SourceProcessor);
