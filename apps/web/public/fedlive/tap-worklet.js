// The Fed live widget's audio tap (components/fedlive/audioTap.ts): hands the
// main thread the raw samples of the silent transcription feed, in blocks of
// ~0.25 s at the AudioContext's rate (16 kHz there), with the context time of
// the block's first sample.
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.t0 = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      if (this.n === 0) this.t0 = currentTime;
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage({ t0: this.t0, samples: this.buf.slice(0) });
          this.n = 0;
          this.t0 = currentTime + (i + 1) / sampleRate;
        }
      }
    }
    return true;
  }
}
registerProcessor('fedlive-tap', Tap);
