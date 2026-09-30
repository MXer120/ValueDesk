/**
 * Starts the indexer on a worker thread inside the API process (dev and
 * single-box setups). Restarts it after a crash, backing off to a minute.
 * Relays the SoDEX rate-limit cooldown both ways: each thread has its own
 * gateway client, and a 1015 on one IP must quiet both.
 */
import type { BoardWindow, Venue } from '../valuescan/types.js';
import { Worker } from 'node:worker_threads';
import { cooldownLeftMs, noteRateLimited } from '../valuescan/sodex/util.js';

let worker: Worker | null = null;
let attempt = 0;
let stopping = false;

export function startIndexerWorker(): void {
  if (worker || stopping) return;
  const w = new Worker(new URL('./worker.ts', import.meta.url));
  worker = w;
  let told = 0;
  const relay = setInterval(() => {
    const left = cooldownLeftMs();
    if (left > 0 && Date.now() - told > left) {
      told = Date.now();
      w.postMessage({ type: 'cooldown' });
    }
  }, 2_000);
  relay.unref();
  w.on('message', (m: { type?: string }) => {
    if (m?.type === 'cooldown') noteRateLimited();
  });
  w.on('online', () => {
    attempt = 0;
  });
  w.on('error', (e) => console.error('[indexer] worker error:', e instanceof Error ? e.message : e));
  w.on('exit', (code) => {
    clearInterval(relay);
    worker = null;
    if (stopping) return;
    const delay = Math.min(60_000, 2_000 * 2 ** attempt++);
    console.error(`[indexer] worker exited (${code}); restarting in ${Math.round(delay / 1000)} s`);
    setTimeout(startIndexerWorker, delay).unref();
  });
  w.unref();
}

/** Screen hints: wallets someone is looking at get indexed too. */
export function watchAddresses(venue: Venue, addresses: readonly string[], window: BoardWindow = '30d'): void {
  if (worker && addresses.length) worker.postMessage({ type: 'watch', venue, addresses: addresses.slice(0, 100), window });
}

export function stopIndexerWorker(): void {
  stopping = true;
  worker?.postMessage({ type: 'stop' });
}
