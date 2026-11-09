/**
 * Run: npx tsx --test test/flowThread.test.ts   (from apps/server)
 *
 * The trade flow on its own thread (flow/thread.ts): it writes the same rows as the recorder on the caller's thread; a
 * restart's snapshot of held prints is still told apart; a thread killed inside a batch, or after a write it did not
 * confirm, loses nothing and doubles nothing (twin prints included); it keeps writing while the caller's thread is
 * stalled; and a print is readable through the API's read within 2 s.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(join(tmpdir(), 'vs-flowthread-'));
process.env.VALUESCAN_INDEX_DB = join(dir, 'index.db');
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ } });

const { CHUNK_MS, DAY_MS, HOUR_MS, chunkPrints, decodeChunk } = await import('../src/flow/codec.js');
const { FlowStore, closeFlowReader } = await import('../src/flow/store.js');
const { FlowRecorder, READY_MS } = await import('../src/flow/recorder.js');
const { FlowThread, InlineFlow, startFlow } = await import('../src/flow/thread.js');
const { flowWindow, clearFlowCaches } = await import('../src/flow/read.js');
const { setCandleRead } = await import('../src/flow/venueCheck.js');
type Print = import('../src/indexer/streams.js').Print;

setCandleRead(async () => null);

const A = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
const addressOf = (_v: string, acct: string) => (acct === '77' ? A(77) : null);
const quiet = { log: () => {} };

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

/** `n` prints over [from, to): Hyperliquid BTC/ETH by address, SoDEX by account id, every 10th a twin of the one before. */
function prints(seed: number, n: number, from: number, to: number): Print[] {
  const r = rng(seed);
  const out: Print[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 10 === 9) { out.push({ ...out[i - 1]!, id: `${seed}-${i}` }); continue; }
    const sodex = r() < 0.3;
    const b = 1 + Math.floor(r() * 40);
    const s = 1 + ((b + 1 + Math.floor(r() * 38)) % 40);
    out.push({
      venue: sodex ? 'sodex' : 'hyperliquid', id: `${seed}-${i}`, t: Math.floor(from + r() * (to - from)),
      symbol: sodex ? 'BTC-USD' : r() < 0.5 ? 'BTC' : 'ETH',
      px: 60_000 + Math.round(r() * 1000) / 10, sz: Math.round(r() * 1000) / 1000 + 0.001,
      buyer: sodex ? String(70 + (b % 10)) : A(b), seller: sodex ? String(70 + (s % 10)) : A(s), taker: r() < 0.5 ? 'buyer' : 'seller',
    });
  }
  return out;
}

async function until(ok: () => boolean, ms = 15_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Every row of every table, as text (a blob as hex). */
function dump(path: string): Record<string, string[]> {
  const db = new DatabaseSync(path, { readOnly: true });
  const out: Record<string, string[]> = {};
  for (const [t, order] of [['flow_market', 'id'], ['flow_party', 'id'], ['flow_chunk', 'mid, t'], ['flow_hour', 'mid, t'], ['flow_day', 'mid, t'], ['flow_tail', 'mid, t']] as const) {
    out[t] = (db.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all() as Array<Record<string, unknown>>).map((row) =>
      JSON.stringify(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v])));
  }
  db.close();
  return out;
}

/** Every print on disk (chunks and tails) as venue|symbol|t|px|sz|buyer key|seller key, counted. */
function heldMultiset(path: string): Map<string, number> {
  const s = new FlowStore(path, { readOnly: true });
  const markets = new Map(s.markets().map((m) => [m.id, `${m.venue}|${m.symbol}`]));
  const parties = new Map(s.parties().map((p) => [p.id, p.key]));
  const out = new Map<string, number>();
  const rows = [
    ...(s.db.prepare('SELECT mid, data FROM flow_chunk').all() as Array<{ mid: number; data: Uint8Array }>),
    ...(s.db.prepare('SELECT mid, data FROM flow_tail').all() as Array<{ mid: number; data: Uint8Array }>),
  ];
  for (const row of rows) {
    for (const f of chunkPrints(decodeChunk(row.data))) {
      const k = `${markets.get(row.mid)}|${f.t}|${f.px}|${f.sz}|${parties.get(f.buyer)}|${parties.get(f.seller)}`;
      out.set(k, (out.get(k) ?? 0) + 1);
    }
  }
  s.close();
  return out;
}

const expectMultiset = (ps: readonly Print[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const p of ps) {
    const k = `${p.venue}|${p.symbol}|${p.t}|${p.px}|${p.sz}|${p.venue === 'sodex' ? p.buyer : p.buyer.toLowerCase()}|${p.venue === 'sodex' ? p.seller : p.seller.toLowerCase()}`;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
};

test('the thread writes the same rows as the recorder on the caller\'s thread: chunks, parties, hour sums', async () => {
  const now = Date.now();
  const h0 = Math.floor(now / HOUR_MS) * HOUR_MS - 3 * HOUR_MS;
  // Up to the hour that is ready to be summed, so both sum exactly the same hours.
  const ready = Math.floor((now - READY_MS) / HOUR_MS) * HOUR_MS;
  const ps = prints(1, 6_000, h0, now - 60_000);
  const paths = { inline: join(dir, 'eq-inline.db'), thread: join(dir, 'eq-thread.db') };
  for (const p of Object.values(paths)) {
    const s = new FlowStore(p);
    s.setMeta('hour_through', String(h0));
    s.setMeta('day_through', String(Math.floor(now / DAY_MS) * DAY_MS));
    s.setMeta('since', String(h0));
    s.close();
  }

  const rec = new FlowRecorder(new FlowStore(paths.inline), addressOf);
  for (const p of ps) rec.add(p);
  for (let i = 0; i < 400 && rec.status().hourThrough < ready; i++) rec.tick();
  assert.equal(rec.status().hourThrough, ready);
  rec.stop();
  rec.store.close();

  const th = new FlowThread(paths.thread, addressOf, { ...quiet, tickMs: 20 });
  for (let i = 0; i < ps.length; i += 500) {
    for (const p of ps.slice(i, i + 500)) th.add(p);
    await new Promise((r) => setImmediate(r));
  }
  await until(() => th.settled && th.status().hourThrough === ready, 30_000, 'the thread to sum the hours');
  assert.equal(th.status().thread?.restarts, 0);
  th.stop();

  const a = dump(paths.inline);
  const b = dump(paths.thread);
  assert.ok(a.flow_chunk!.length > 30 && a.flow_hour!.length >= 6, `rows to compare: ${a.flow_chunk!.length} chunks, ${a.flow_hour!.length} hours`);
  for (const t of Object.keys(a)) assert.deepEqual(b[t], a[t], t);
  assert.equal(b.flow_tail!.length, 0, 'stop folds every tail into its chunk');
  // The SoDEX account the index knows has its address on the thread's side too.
  assert.ok(b.flow_party!.some((r) => r.includes(A(77))));
});

test('a restart\'s snapshot of what the last run held is told apart through the thread, as the recorder does', async () => {
  const path = join(dir, 'restart.db');
  const now = Date.now();
  const t0 = Math.floor((now - 30 * 60_000) / CHUNK_MS) * CHUNK_MS;
  const ps = prints(2, 400, t0, now - 1_000);
  const first = new FlowThread(path, addressOf, { ...quiet, tickMs: 20 });
  for (const p of ps) first.add(p);
  await until(() => first.settled, 15_000, 'the first run to write');
  first.stop();

  await new Promise((r) => setTimeout(r, 5));
  const second = new FlowThread(path, addressOf, { ...quiet, tickMs: 20 });
  const inline = new FlowRecorder(new FlowStore(join(dir, 'restart.db')), addressOf);
  const asked: Print[] = [
    ...ps, // all held, twins as often as they are held
    ps[8]!, ps[9]!, // a third of a twin pair: not held
    { ...ps[0]!, sz: 99 }, // held by nobody
    { ...ps[0]!, t: Date.now() + 1_000 }, // newer than the run
    { venue: 'hyperliquid', id: 'x', t: ps[0]!.t, symbol: 'xyz:TSLA', px: 1, sz: 1, buyer: A(1), seller: A(2) },
  ];
  const got = asked.map((p) => second.repeatOfHeld(p));
  const want = asked.map((p) => inline.repeatOfHeld(p));
  assert.deepEqual(got, want);
  assert.deepEqual(got.slice(0, ps.length), ps.map(() => true));
  assert.deepEqual(got.slice(ps.length), [false, false, false, false, false]);
  inline.store.close();

  // `missing` sees a print handed over this very turn (not yet on the thread), then the same from disk.
  const fresh: Print = { ...ps[3]!, id: 'fresh', t: Date.now() - 2_000, sz: 7.25 };
  second.add(fresh);
  assert.deepEqual(second.missing([fresh, { ...fresh, sz: 7.5 }]).map((p) => p.sz), [7.5]);
  await until(() => second.settled, 15_000, 'the print to be written');
  assert.deepEqual(second.missing([fresh, { ...fresh, sz: 7.5 }]).map((p) => p.sz), [7.5]);
  assert.deepEqual(second.missingNear([{ ...fresh, t: fresh.t + 3 }], 16), []);
  second.stop();
});

test('a thread killed inside a batch, and one killed after a write it did not confirm, lose nothing and double nothing', async () => {
  const path = join(dir, 'crash.db');
  const now = Date.now();
  const th = new FlowThread(path, addressOf, { ...quiet, tickMs: 20, hooks: true });
  const one = prints(3, 1_000, now - 20 * 60_000, now - 1_000);
  for (const p of one) th.add(p);
  await until(() => th.settled, 15_000, 'batch one');

  // Killed at its 300th print of the next batch: the 300 were in memory only.
  th.crash('midBatch', 300);
  const two = prints(4, 1_000, now - 20 * 60_000, now - 1_000);
  for (const p of two) th.add(p);
  await until(() => th.status().thread!.restarts === 1 && th.settled, 20_000, 'batch two after the restart');

  // Killed after writing the next batch, before saying so: handed over again, it must not go in twice. Its twins of batch
  // one's prints are real trades (a wallet filling one counterparty twice at one price in one millisecond) and must count.
  th.crash('afterFlush');
  const three = [...prints(5, 1_000, now - 20 * 60_000, now - 1_000), ...one.slice(0, 50).map((p) => ({ ...p, id: `${p.id}-again` }))];
  for (const p of three) th.add(p);
  await until(() => th.status().thread!.restarts === 2 && th.settled, 20_000, 'batch three after the restart');
  assert.equal(th.status().thread!.dropped, 0);
  th.stop();

  const got = heldMultiset(path);
  const want = expectMultiset([...one, ...two, ...three]);
  assert.equal([...got.values()].reduce((a, b) => a + b, 0), one.length + two.length + three.length, 'every print once');
  assert.deepEqual([...got.entries()].sort(), [...want.entries()].sort());
});

test('while the caller\'s thread is stalled, the flow thread keeps writing', async () => {
  const path = join(dir, 'stall.db');
  const th = new FlowThread(path, addressOf, { ...quiet, tickMs: 50 });
  await new Promise((r) => setTimeout(r, 300));
  const now = Date.now();
  const ps = prints(6, 500, now - 2_000, now);
  for (const p of ps) th.add(p);
  // Handed over at the end of this turn; then this thread is busy for 3 s and reads nothing the thread says.
  await new Promise((r) => setImmediate(r));
  const end = Date.now() + 3_000;
  while (Date.now() < end) { /* the indexer's thread, stalled */ }
  const onDisk = [...heldMultiset(path).values()].reduce((a, b) => a + b, 0);
  assert.equal(onDisk, ps.length, 'written during the stall');
  assert.equal(th.status().thread!.acked, 0, 'no confirmation was read during the stall');
  // On disk and still unconfirmed here: counted once, not once from the file and once from what this thread kept.
  assert.deepEqual(th.missing([ps[0]!, { ...ps[0]!, id: 'twin' }]).map((p) => p.id), ['twin']);
  th.stop();
});

test('a print is readable through the API\'s read within 2 s; the inline recorder stays the default under tests', async () => {
  const path = join(dir, 'live.db');
  process.env.VALUESCAN_FLOW_DB = path;
  assert.ok(startFlow(join(dir, 'inline-default.db'), addressOf) instanceof InlineFlow);
  const th = new FlowThread(path, addressOf, quiet);
  await new Promise((r) => setTimeout(r, 500));
  closeFlowReader();
  const t = Date.now();
  const p: Print = { venue: 'hyperliquid', id: 'live', t, symbol: 'BTC', px: 70_000, sz: 2, buyer: A(1), seller: A(2), taker: 'buyer' };
  th.add(p);
  const from = Math.floor(t / CHUNK_MS) * CHUNK_MS;
  let seenAt = 0;
  while (!seenAt && Date.now() - t < 5_000) {
    clearFlowCaches();
    const w = await flowWindow({ coin: 'BTC', venues: ['hyperliquid'], kind: 'perp', from, to: from + CHUNK_MS, role: 'all', side: 'all', sort: 'volume', limit: 5 });
    if (w && w.summary.total === 140_000) seenAt = Date.now();
    else await new Promise((r) => setTimeout(r, 25));
  }
  th.stop();
  closeFlowReader();
  assert.ok(seenAt, 'seen');
  assert.ok(seenAt - t < 2_000, `readable after ${seenAt - t} ms`);
});
