/**
 * Speech to text in the visitor's own browser (FedLive.tsx): Moonshine tiny, a
 * small model made for live speech, 8-bit, through transformers.js on the CPU
 * (WebAssembly, one thread: the site is not cross-origin isolated). Nothing
 * leaves the machine. The model (~30 MB, kept in the browser's cache after the
 * first start) and the ONNX runtime are both served from this site's own origin
 * (deploy/vercel/fetch-model.sh puts the model under /models/), never a CDN's.
 */
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

export type SttIn =
  | { type: 'load'; model: string; wasm: string; mjs: string }
  | { type: 'chunk'; id: number; samples: Float32Array };
export type SttOut =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready'; device: 'wasm' }
  | { type: 'text'; id: number; text: string; ms: number }
  | { type: 'error'; message: string };

let asr: AutomaticSpeechRecognitionPipeline | null = null;
const post = (m: SttOut) => (self as unknown as Worker).postMessage(m);

async function load(m: Extract<SttIn, { type: 'load' }>) {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = '/models/';
  const wasm = env.backends.onnx.wasm as unknown as { wasmPaths: unknown; numThreads: number; proxy: boolean };
  wasm.wasmPaths = { wasm: m.wasm, mjs: m.mjs };
  wasm.numThreads = 1;
  wasm.proxy = false;
  const files = new Map<string, { loaded: number; total: number }>();
  const progress = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status !== 'progress' || !p.file) return;
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    post({ type: 'progress', loaded, total });
  };
  asr = (await pipeline('automatic-speech-recognition', m.model, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: progress,
  } as never)) as unknown as AutomaticSpeechRecognitionPipeline;
  post({ type: 'ready', device: 'wasm' });
}

self.onmessage = async (ev: MessageEvent<SttIn>) => {
  const m = ev.data;
  try {
    if (m.type === 'load') await load(m);
    else if (m.type === 'chunk' && asr) {
      const t = performance.now();
      const out = (await asr(m.samples)) as { text?: string } | Array<{ text?: string }>;
      const text = (Array.isArray(out) ? out.map((o) => o.text ?? '').join(' ') : out.text ?? '').trim();
      post({ type: 'text', id: m.id, text, ms: Math.round(performance.now() - t) });
    }
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
