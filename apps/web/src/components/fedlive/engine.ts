/**
 * The Fed live widget's engine (FedLive.tsx): the Federal Reserve's own broadcast
 * (Brightcove HLS, open to any site), played twice.
 *
 *   The picture: the full stream with a player's usual buffer, three segments
 *   behind the live edge - where any viewer of the broadcast is.
 *   The ear: the audio-only rendition, silent, as close to the live edge as a
 *   player gets (one segment). Its samples go to a speech model in a worker
 *   (stt.worker.ts) in chunks cut at pauses, or - without the model - the
 *   Fed's own captions are read from the same position.
 *
 * Both follow one media timeline, so each line of text knows the moment the
 * picture will reach it: the widget counts down to it and marks it said when the
 * picture gets there. A recording (no broadcast on air) is replayed the same way
 * with the picture held `REPLAY_LEAD_S` behind the ear.
 */
import type HlsPlayer from 'hls.js';
import type { SttIn, SttOut } from './stt.worker';

export interface FedSource {
  videoId: string;
  name: string;
  live: boolean;
  hls: string;
  audioOnly?: string | null;
  captions?: string | null;
  poster?: string | null;
}

export type TextMode = 'model' | 'captions';

export interface Line {
  id: number;
  /** Where on the media timeline it was said (s). */
  at: number;
  text: string;
  source: TextMode;
  /** performance.now() when the text arrived. */
  arrived: number;
}

export interface EngineState {
  phase: 'idle' | 'loading' | 'running' | 'error';
  device: 'wasm' | null;
  /** Model download, 0..1 (null: none running). */
  download: number | null;
  error: string | null;
  /** How far the ear is ahead of the picture (s). */
  lead: number | null;
}

/*
 * hls.js (about 500 kB minified, a third of the Trade page's code) is fetched
 * when a broadcast is started, not with the page: most visits never press
 * play, and start() is already in its loading phase while the player arrives.
 */
type HlsClass = typeof HlsPlayer;
let hlsLib: Promise<HlsClass> | null = null;
const loadHls = (): Promise<HlsClass> => {
  hlsLib ??= import('hls.js').then(
    (m) => m.default,
    (e: unknown) => {
      hlsLib = null; // a failed fetch is tried again on the next start
      throw e;
    },
  );
  return hlsLib;
};

export const MODEL = 'onnx-community/moonshine-tiny-ONNX';
const RATE = 16_000;
/** A recording: the picture this far behind the ear. */
export const REPLAY_LEAD_S = 15;
const MIN_CHUNK_S = 1.6;
const MAX_CHUNK_S = 7;
const SILENT_BLOCKS = 2;

export class FedEngine {
  private ear: HTMLAudioElement | null = null;
  private earHls: HlsPlayer | null = null;
  private picHls: HlsPlayer | null = null;
  private ctx: AudioContext | null = null;
  private worker: Worker | null = null;
  private chunk: Float32Array[] = [];
  private chunkAt = 0;
  private silent = 0;
  private noise = 0.004;
  private nextId = 1;
  private pending = new Map<number, number>();
  private cueSeen = new Set<string>();
  private state: EngineState = { phase: 'idle', device: null, download: null, error: null, lead: null };

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onLine: (l: Line) => void,
    private readonly onState: (s: EngineState) => void,
  ) {}

  private set(p: Partial<EngineState>) {
    this.state = { ...this.state, ...p };
    this.onState(this.state);
  }

  /** Starts both players; `mode` picks the model or the Fed's captions. Call from a click (audio needs a gesture). */
  async start(src: FedSource, mode: TextMode): Promise<void> {
    this.stop();
    this.set({ phase: 'loading', error: null, download: null });
    let Hls: HlsClass;
    try {
      Hls = await loadHls();
    } catch (e) {
      this.set({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (!Hls.isSupported()) {
      this.set({ phase: 'error', error: 'This browser cannot play the stream (no Media Source Extensions).' });
      return;
    }
    try {
      if (mode === 'model') await this.loadModel();
      this.startPicture(Hls, src);
      await this.startEar(Hls, src, mode);
      this.set({ phase: 'running' });
    } catch (e) {
      this.set({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  stop(): void {
    this.earHls?.destroy();
    this.picHls?.destroy();
    this.earHls = null;
    this.picHls = null;
    if (this.ear) { this.ear.pause(); this.ear.removeAttribute('src'); this.ear = null; }
    this.video.pause();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.chunk = [];
    this.silent = 0;
    this.cueSeen.clear();
    this.pending.clear();
    this.set({ phase: 'idle', lead: null });
  }

  dispose(): void {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
  }

  /** Media time of the picture (s). */
  get pictureTime(): number {
    return this.video.currentTime;
  }

  private loadModel(): Promise<void> {
    if (this.worker && this.state.device) return Promise.resolve();
    this.worker?.terminate();
    const w = new Worker(new URL('./stt.worker.ts', import.meta.url), { type: 'module' });
    this.worker = w;
    return new Promise((resolve, reject) => {
      w.onmessage = (ev: MessageEvent<SttOut>) => {
        const m = ev.data;
        if (m.type === 'progress') this.set({ download: m.total > 0 ? m.loaded / m.total : null });
        else if (m.type === 'ready') { this.set({ device: m.device, download: null }); resolve(); }
        else if (m.type === 'error') {
          if (!this.state.device) reject(new Error(`The speech model did not load: ${m.message}`));
          else this.set({ error: m.message });
        } else if (m.type === 'text') {
          const at = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (at !== undefined && m.text) this.onLine({ id: m.id, at, text: m.text, source: 'model', arrived: performance.now() });
        }
      };
      w.onerror = (e) => reject(new Error(e.message || 'The speech worker failed'));
      w.postMessage({ type: 'load', model: MODEL } satisfies SttIn);
    });
  }

  private startPicture(Hls: HlsClass, src: FedSource) {
    const hls = new Hls({ liveSyncDurationCount: 3, enableWebVTT: false, capLevelToPlayerSize: true });
    this.picHls = hls;
    hls.loadSource(src.hls);
    hls.attachMedia(this.video);
    this.video.muted = false;
    if (!src.live) {
      // A recording: the picture waits until the ear is REPLAY_LEAD_S in.
      this.video.pause();
      hls.once(Hls.Events.MANIFEST_PARSED, () => { this.video.currentTime = 0; });
    } else {
      hls.once(Hls.Events.MANIFEST_PARSED, () => { void this.video.play().catch(() => undefined); });
    }
  }

  private async startEar(Hls: HlsClass, src: FedSource, mode: TextMode) {
    const ear = new Audio();
    ear.crossOrigin = 'anonymous';
    this.ear = ear;
    const hls = new Hls({
      liveSyncDurationCount: 1,
      liveMaxLatencyDurationCount: 3,
      enableWebVTT: mode === 'captions',
      renderTextTracksNatively: true,
    });
    this.earHls = hls;
    hls.loadSource(src.audioOnly || src.hls);
    hls.attachMedia(ear);

    // Only the captions are wanted from it then: the ear stays silent.
    if (mode === 'captions') { ear.muted = true; this.readCaptions(Hls, ear, hls); }
    else await this.tap(ear);

    await new Promise<void>((resolve) => hls.once(Hls.Events.MANIFEST_PARSED, () => resolve()));
    await ear.play();
    if (!src.live) {
      const startPicture = () => {
        if (ear.currentTime >= REPLAY_LEAD_S) {
          ear.removeEventListener('timeupdate', startPicture);
          this.video.currentTime = Math.max(0, ear.currentTime - REPLAY_LEAD_S);
          void this.video.play().catch(() => undefined);
        }
      };
      ear.addEventListener('timeupdate', startPicture);
    }
    ear.addEventListener('timeupdate', () => {
      if (!this.video.paused) this.set({ lead: Math.max(0, ear.currentTime - this.video.currentTime) });
    });
  }

  /** The ear's samples at 16 kHz into the segmenter. */
  private async tap(ear: HTMLAudioElement) {
    const ctx = new AudioContext({ sampleRate: RATE });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule('/fedlive/tap-worklet.js');
    const node = new AudioWorkletNode(ctx, 'fedlive-tap');
    // Not connected to the speakers: the ear is silent.
    ctx.createMediaElementSource(ear).connect(node);
    node.port.onmessage = (ev: MessageEvent<{ t0: number; samples: Float32Array }>) => {
      const mediaAt = ear.currentTime - (ctx.currentTime - ev.data.t0);
      this.block(ev.data.samples, mediaAt);
    };
  }

  /** One ~0.25 s block: grow the chunk, close it at a pause or at its longest. */
  private block(samples: Float32Array, mediaAt: number) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
    const rms = Math.sqrt(sum / samples.length);
    const speech = rms > this.noise * 3;
    if (!speech) this.noise = this.noise * 0.95 + rms * 0.05;
    if (!this.chunk.length) {
      if (!speech) return;
      this.chunkAt = mediaAt;
    }
    this.chunk.push(samples);
    this.silent = speech ? 0 : this.silent + 1;
    const secs = (this.chunk.length * samples.length) / RATE;
    if ((secs >= MIN_CHUNK_S && this.silent >= SILENT_BLOCKS) || secs >= MAX_CHUNK_S) this.flush();
  }

  private flush() {
    const len = this.chunk.reduce((n, c) => n + c.length, 0);
    const all = new Float32Array(len);
    let o = 0;
    for (const c of this.chunk) { all.set(c, o); o += c.length; }
    this.chunk = [];
    this.silent = 0;
    if (!this.worker) return;
    const id = this.nextId++;
    this.pending.set(id, this.chunkAt);
    this.worker.postMessage({ type: 'chunk', id, samples: all } satisfies SttIn, [all.buffer]);
  }

  /** The Fed's captions, as the ear's player loads them. */
  private readCaptions(Hls: HlsClass, ear: HTMLAudioElement, hls: HlsPlayer) {
    const watch = () => {
      for (let i = 0; i < ear.textTracks.length; i++) {
        const t = ear.textTracks[i]!;
        if (t.mode === 'disabled') t.mode = 'hidden';
        const cues = t.cues;
        if (!cues) continue;
        for (let j = 0; j < cues.length; j++) {
          const c = cues[j] as VTTCue;
          const key = `${c.startTime.toFixed(2)}|${c.text}`;
          if (this.cueSeen.has(key)) continue;
          this.cueSeen.add(key);
          this.onLine({ id: this.nextId++, at: c.startTime, text: c.text.replace(/\s+/g, ' ').trim(), source: 'captions', arrived: performance.now() });
        }
      }
    };
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => { hls.subtitleTrack = 0; hls.subtitleDisplay = false; });
    hls.on(Hls.Events.SUBTITLE_FRAG_PROCESSED, watch);
    const timer = window.setInterval(watch, 1000);
    hls.on(Hls.Events.DESTROYING, () => window.clearInterval(timer));
  }
}
