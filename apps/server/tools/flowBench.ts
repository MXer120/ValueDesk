/**
 * The trade flow recorder on the indexer's thread (InlineFlow) against its own thread (FlowThread, flow/thread.ts):
 * what each costs the indexer's thread, how many prints a second it takes, and how long a print takes to be readable in
 * the flow file. Synthetic prints (Zipf over the markets, a pool of wallets), into a fresh file in the temp folder.
 *
 *   npx tsx tools/flowBench.ts                         both modes, 1,000 prints/s for 40 s
 *   npx tsx tools/flowBench.ts --rate=0 --seconds=10    capacity: as fast as the indexer's thread can hand them in
 *   npx tsx tools/flowBench.ts --stall=10000@30000      the indexer's thread busy 10 s every 30 s (2026-11-08 nights)
 *   --mode=inline|thread  --markets=200  --wallets=20000
 *
 * Busy % is the indexer's thread's event-loop utilisation over the run (perf_hooks), the busy-wait of a simulated stall
 * left out. Latency: a probe print every 100 ms on its own market; a reader on another thread looks at the file every
 * 20 ms (chunks and tails, as the API reads them) and notes when each probe first shows.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Print } from '../src/indexer/streams.js';

const PROBE = 'PROBE';

// --- the reader thread -------------------------------------------------------------------------------
if (!isMainThread && (workerData as { poller?: string })?.poller) {
  const { chunkPrints, decodeChunk } = await import('../src/flow/codec.js');
  const path = (workerData as { poller: string }).poller;
  const seen = new Map<number, number>();
  let db: DatabaseSync | null = null;
  let stop = false;
  parentPort!.on('message', () => { stop = true; });
  const look = () => {
    if (stop) { parentPort!.postMessage([...seen]); return; }
    try {
      db ??= new DatabaseSync(path, { readOnly: true });
      const m = db.prepare(`SELECT id FROM flow_market WHERE symbol = ?`).get(PROBE) as { id: number } | undefined;
      if (m) {
        const since = Date.now() - 20 * 60_000;
        const rows = [
          ...(db.prepare('SELECT data FROM flow_chunk WHERE mid = ? AND t >= ?').all(m.id, since) as Array<{ data: Uint8Array }>),
          ...(db.prepare('SELECT data FROM flow_tail WHERE mid = ? AND t >= ?').all(m.id, since) as Array<{ data: Uint8Array }>),
        ];
        const now = Date.now();
        for (const r of rows) for (const f of chunkPrints(decodeChunk(r.data))) if (!seen.has(f.sz)) seen.set(f.sz, now);
      }
    } catch { /* not there yet */ }
    setTimeout(look, 20);
  };
  look();
}

// --- the bench -------------------------------------------------------------------------------------------
if (isMainThread) {
  const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
  const rate = Number(arg('rate', '1000'));
  const seconds = Number(arg('seconds', '40'));
  const nMarkets = Number(arg('markets', '200'));
  const nWallets = Number(arg('wallets', '20000'));
  const [stallMs, stallEvery] = arg('stall', '0@0').split('@').map(Number) as [number, number];
  const modes = arg('mode', 'both') === 'both' ? ['inline', 'thread'] : [arg('mode', 'both')];

  const { FlowRecorder } = await import('../src/flow/recorder.js');
  const { FlowStore } = await import('../src/flow/store.js');
  const { FlowThread, InlineFlow } = await import('../src/flow/thread.js');

  const wallets = Array.from({ length: nWallets }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
  // Zipf-ish: market k gets weight 1/(k+1).
  const cum: number[] = [];
  let acc = 0;
  for (let k = 0; k < nMarkets; k++) { acc += 1 / (k + 1); cum.push(acc); }
  const pickMarket = (r: number) => { const x = r * acc; let lo = 0; let hi = nMarkets - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid]! < x) lo = mid + 1; else hi = mid; } return lo; };
  let id = 0;
  const print = (): Print => {
    const m = pickMarket(Math.random());
    const b = (Math.random() * nWallets) | 0;
    const s = (b + 1 + ((Math.random() * (nWallets - 1)) | 0)) % nWallets;
    return { venue: 'hyperliquid', id: String(id++), t: Date.now(), symbol: `M${m}`, px: 100 + m + Math.round(Math.random() * 100) / 100, sz: Math.round(Math.random() * 1e4) / 1e3 + 0.001, buyer: wallets[b]!, seller: wallets[s]!, taker: Math.random() < 0.5 ? 'buyer' : 'seller' };
  };
  const pct = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : NaN; };

  for (const mode of modes) {
    const dir = mkdtempSync(join(tmpdir(), 'vs-flowbench-'));
    const path = join(dir, 'flow.db');
    const feed = mode === 'thread' ? new FlowThread(path, () => null, { log: () => {} }) : new InlineFlow(new FlowRecorder(new FlowStore(path), () => null));
    const poller = new Worker(new URL(import.meta.url), { workerData: { poller: path } });
    await new Promise((r) => setTimeout(r, 500));
    const tick = mode === 'inline' ? setInterval(() => feed.tick(), 1_000) : null;
    const sentAt = new Map<number, number>();
    let probeN = 0;
    const probe = setInterval(() => {
      const n = ++probeN;
      sentAt.set(n, Date.now());
      feed.add({ venue: 'hyperliquid', id: `p${n}`, t: Date.now(), symbol: PROBE, px: 1, sz: n, buyer: wallets[0]!, seller: wallets[1]!, taker: 'buyer' });
    }, 100);
    let stalledMs = 0;
    const stall = stallMs > 0 ? setInterval(() => { const t = Date.now(); while (Date.now() - t < stallMs) { /* stalled */ } stalledMs += Date.now() - t; }, stallEvery) : null;

    const elu0 = performance.eventLoopUtilization();
    const t0 = Date.now();
    let added = 0;
    await new Promise<void>((done) => {
      if (rate > 0) {
        // One turn every 10 ms, as stream frames arrive.
        let owed = 0;
        let last = Date.now();
        const gen = setInterval(() => {
          const now = Date.now();
          owed += (rate * (now - last)) / 1000;
          last = now;
          for (; owed >= 1; owed--) { const p = print(); feed.repeatOfHeld(p); feed.add(p); added++; }
          if (now - t0 >= seconds * 1000) { clearInterval(gen); done(); }
        }, 10);
      } else {
        const turn = () => {
          for (let i = 0; i < 2_000; i++) { const p = print(); feed.repeatOfHeld(p); feed.add(p); added++; }
          if (Date.now() - t0 >= seconds * 1000) done();
          else setImmediate(turn);
        };
        turn();
      }
    });
    const genMs = Date.now() - t0;
    const elu = performance.eventLoopUtilization(elu0);
    clearInterval(probe);
    if (stall) clearInterval(stall);
    // Until everything is on disk: the thread's confirmations, or the inline recorder's last flush.
    const settleAt = Date.now();
    if (feed instanceof FlowThread) { while (!feed.settled) await new Promise((r) => setTimeout(r, 10)); }
    else { if (tick) clearInterval(tick); (feed as InstanceType<typeof InlineFlow>).rec.flush(); }
    const allMs = Date.now() - t0;
    const settleMs = Date.now() - settleAt;
    await new Promise((r) => setTimeout(r, 200));
    const seen = await new Promise<Array<[number, number]>>((r) => { poller.once('message', r); poller.postMessage('stop'); });
    await poller.terminate();
    const lat: number[] = [];
    const seenMap = new Map(seen);
    for (const [n, at] of sentAt) { const s = seenMap.get(n); if (s !== undefined) lat.push(s - at); }
    // The stall's busy-wait counts as busy in the utilisation: taken out, so what remains is the recorder's (and the generator's) share.
    const busy = (elu.active - stalledMs) / (elu.idle + elu.active - stalledMs);
    const stopT = Date.now();
    feed.stop();
    const stopMs = Date.now() - stopT;
    console.log(JSON.stringify({
      mode, rate: rate || 'max', seconds, stall: stallMs ? `${stallMs}@${stallEvery}` : null,
      printsAdded: added, addedPerSec: Math.round(added / (genMs / 1000)), onDiskPerSec: Math.round(added / (allMs / 1000)), settleMs,
      mainBusyPct: +(busy * 100).toFixed(1),
      latencyMs: { probes: sentAt.size, seen: lat.length, p50: pct(lat, 0.5), p90: pct(lat, 0.9), p99: pct(lat, 0.99), max: Math.max(...lat) },
      stopMs,
    }));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }
  }
  process.exit(0);
}
