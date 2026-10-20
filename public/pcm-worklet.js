// AudioWorkletProcessor: downsample mic input to 24kHz, convert to Int16, post ~100ms frames.
const TARGET_RATE = 24000;
const FRAME_SAMPLES = 2400; // 100ms at 24kHz = 4800 bytes

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.pos = 0; // fractional read position relative to the start of `buf`
    this.buf = new Float32Array(0);
    this.out = new Int16Array(FRAME_SAMPLES);
    this.outLen = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this.flushOut();
        this.port.postMessage({ flushed: true });
      }
    };
  }

  flushOut() {
    if (this.outLen > 0) {
      const frame = this.out.slice(0, this.outLen);
      this.port.postMessage({ pcm: frame.buffer }, [frame.buffer]);
      this.outLen = 0;
    }
  }

  push(sample) {
    const s = Math.max(-1, Math.min(1, sample));
    this.out[this.outLen++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.outLen >= FRAME_SAMPLES) this.flushOut();
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input || input.length === 0) return true;

    // Append new samples to leftover buffer.
    const merged = new Float32Array(this.buf.length + input.length);
    merged.set(this.buf, 0);
    merged.set(input, this.buf.length);

    if (this.ratio === 1) {
      for (let i = 0; i < merged.length; i++) this.push(merged[i]);
      this.buf = new Float32Array(0);
      return true;
    }

    // Linear interpolation.
    let pos = this.pos;
    while (pos + 1 < merged.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      this.push(merged[i] * (1 - frac) + merged[i + 1] * frac);
      pos += this.ratio;
    }
    const keepFrom = Math.floor(pos);
    this.buf = merged.slice(keepFrom);
    this.pos = pos - keepFrom;
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
