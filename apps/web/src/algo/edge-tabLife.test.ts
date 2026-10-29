/**
 * Browser algos and their tab, end to end through the page's storage (tabLife.ts): the running
 * tab's note, a reload within RELOAD_MS, a close for longer, another wallet's note, storage that
 * is garbled or refuses writes. Each "page load" is a fresh copy of the module (its boot note is
 * per page), on one shared localStorage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RELOAD_MS } from './tabLife';

type TabLife = typeof import('./tabLife');

class MemoryStorage {
  m = new Map<string, string>();
  refuseWrites = false;
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.refuseWrites) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

const storage = new MemoryStorage();
(globalThis as { localStorage?: unknown }).localStorage = storage;
let page = 0;
/** A page load at `at`: a fresh module that captures the notes as it found them. */
async function load(at: number): Promise<TabLife> {
  const mod = (await import(new URL(`./tabLife.ts?page=${++page}`, import.meta.url).href)) as TabLife;
  mod.captureBoot(at);
  return mod;
}

const W = '0x00000000000000000000000000000000000000aa';
const V = '0x00000000000000000000000000000000000000bb';
const T = 1_800_000_000_000;

test('reload vs close, end to end: the running tab notes itself; a page back within 20 s goes on, one back later stops them', async () => {
  storage.m.clear();
  const first = await load(T);
  assert.equal(first.closedBeforeBoot(W), false, 'never run in this browser');
  const stop = first.keepAlive(W, () => T + 60_000);
  stop();
  const reload = await load(T + 60_000 + 3_000);
  assert.equal(reload.closedBeforeBoot(W), false, 'a reload: they go on');
  const later = await load(T + 60_000 + RELOAD_MS + 1_000);
  assert.equal(later.closedBeforeBoot(W), true, 'the tab was closed: they stop');
});

test('two wallets: each keeps its own note; a wallet whose algos never ran here is never stopped', async () => {
  storage.m.clear();
  const p = await load(T);
  p.keepAlive(W, () => T)();
  p.keepAlive(V, () => T + 50_000)();
  const next = await load(T + 55_000);
  assert.equal(next.closedBeforeBoot(W), true, 'W last noted 55 s before: closed');
  assert.equal(next.closedBeforeBoot(V), false, 'V noted 5 s before: a reload');
  assert.equal(next.closedBeforeBoot('0x00000000000000000000000000000000000000cc'), false);
});

test('a runner that starts a minute after the page loaded (the wallet reconnected late) still knows it was a reload', async () => {
  storage.m.clear();
  const p = await load(T);
  p.keepAlive(W, () => T)();
  const reload = await load(T + 2_000);
  // The note gets older while the wallet reconnects; what counts is the note as the page found it.
  storage.m.set('vd-algo-alive', JSON.stringify({ [W]: T }));
  assert.equal(reload.closedBeforeBoot(W), false);
});

test('garbled storage reads as no note (nothing stopped, nothing thrown); storage refusing writes keeps the old note, so a reload counts as a close', async () => {
  storage.m.clear();
  storage.m.set('vd-algo-alive', '{not json');
  const p = await load(T);
  assert.equal(p.closedBeforeBoot(W), false);
  storage.m.set('vd-algo-alive', JSON.stringify({ [W]: T - 10 * 60_000 }));
  storage.refuseWrites = true;
  try {
    const q = await load(T);
    assert.doesNotThrow(() => q.keepAlive(W, () => T)(), 'a note that cannot be written never throws');
    const reload = await load(T + 3_000);
    assert.equal(reload.closedBeforeBoot(W), true, 'the note stayed ten minutes old: read as a closed tab (the algos stop rather than run unwatched)');
  } finally {
    storage.refuseWrites = false;
  }
});
