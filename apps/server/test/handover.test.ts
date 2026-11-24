/**
 * A restart with no gap (indexer/handover.ts): two real indexer processes on a scratch index, both fed by one fake venue
 * (handover.child.ts) broadcasting prints the whole time. The running one hands over to a standby; every print must be in
 * the index exactly once - fills, activity counts (with the "one trade per account and block" rule across the boundary)
 * and who traded - and the writer lock must refuse a second writer. Plus the pieces on their own.
 *
 * The timings it prints (HANDOVER-MEASURE lines) are this machine's, on a scratch index: what a handover costs in itself,
 * not what production's 50 GB index costs.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { IndexStore } from '../src/indexer/store.js';
import { Dedup, type Print } from '../src/indexer/streams.js';
import { BoundaryFilter, PrintBuffer, handoverPaths, watchForStandby, withdrawRequest, writeJsonAtomic, readJson, type Accepted, type Boundary } from '../src/indexer/handover.js';
import { lockHolder, tryWriterLock } from '../src/indexer/writerLock.js';
import { handoverRow } from '../src/indexer/worker.js';
import { decodeChunk, chunkPrints } from '../src/flow/codec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- the pieces ----------------------------------------------------------------------------------------------------

test('dedup: ids with their times, what it took since a time, and up to when it can no longer say', () => {
  const d = new Dedup(10);
  for (let i = 0; i < 10; i++) assert.ok(d.add(`p${i}`, 1_000 + i));
  assert.equal(d.add('p3', 1_003), false, 'a repeat');
  assert.deepEqual(d.since(1_007), ['p7', 'p8', 'p9']);
  assert.equal(d.forgotThrough, 0);
  d.add('p10', 1_010);
  assert.equal(d.forgotThrough, 1_000, 'the oldest dropped for the cap');
  d.keepAtLeast(1_000);
  for (let i = 11; i < 200; i++) d.add(`p${i}`, 1_000 + i);
  assert.equal(d.forgotThrough, 1_000, 'a standby said hello: nothing more dropped');
  assert.equal(d.size, 199);
});

test('boundary filter: what the old process took is skipped, older than it can name counts as taken, the rest applied', () => {
  const b: Boundary = {
    pid: 1, to: 2, at: 0, stoppedAt: 0, lastOrder: [],
    venues: { hyperliquid: { from: 1_000_000, ids: ['a', 'b'], forgotThrough: 500_000 } },
  };
  const f = new BoundaryFilter(b, 100);
  const p = (venue: Print['venue'], id: string, t: number): Print => ({ venue, id, t, symbol: 'BTC', px: 1, sz: 1, buyer: 'x', seller: 'y' });
  assert.equal(f.admit(p('hyperliquid', 'a', 1_000_100)), false, 'taken by the old');
  assert.equal(f.admit(p('hyperliquid', 'c', 1_000_100)), true, 'not taken: applied');
  assert.equal(f.admit(p('hyperliquid', 'd', 1_000_000 - 3 * 60_000)), false, 'before from less the margin: the old one\'s span');
  assert.equal(f.admit(p('sodex', 'e', 200)), true, 'a venue the old one had no socket for: from the floor on');
  assert.equal(f.admit(p('sodex', 'f', 50)), false, 'older than the floor: a snapshot');
  assert.match(f.line(), /hyperliquid applied 1, taken by the old process 1, older 1/);
});

test('buffer: per venue from its oldest print, never before the floor; over the cap it counts what it dropped', () => {
  const b = new PrintBuffer(2);
  const p = (id: string, t: number): Print => ({ venue: 'hyperliquid', id, t, symbol: 'BTC', px: 1, sz: 1, buyer: 'x', seller: 'y' });
  b.push(p('1', 500));
  b.push(p('2', 300));
  b.push(p('3', 900));
  assert.equal(b.size, 2);
  assert.equal(b.dropped, 1);
  assert.deepEqual(b.from(400, ['hyperliquid', 'sodex'], 10_000), { hyperliquid: 400, sodex: 10_000 });
});

test('writer lock: one process at a time, kept by the kernel, freed by release or by the end of the holder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-lock-'));
  const db = join(dir, 'index.db');
  try {
    const hold = spawn(process.execPath, ['--input-type=module', '-e', `
      const { DatabaseSync } = await import('node:sqlite');
      const d = new DatabaseSync(${JSON.stringify(`${db}.writer-lock`)});
      d.exec('PRAGMA locking_mode = EXCLUSIVE'); d.exec('CREATE TABLE IF NOT EXISTS holder (k INTEGER PRIMARY KEY, pid INTEGER, at INTEGER, role TEXT)');
      d.prepare('INSERT OR REPLACE INTO holder (k, pid, at, role) VALUES (1, ?, ?, ?)').run(process.pid, Date.now(), 'test');
      console.log('held'); setTimeout(() => {}, 60000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((r) => hold.stdout!.on('data', (d) => { if (String(d).includes('held')) r(); }));
    assert.equal(tryWriterLock(db), null, 'held by another process');
    hold.kill();
    await new Promise((r) => hold.on('exit', r));
    const mine = tryWriterLock(db, 'test');
    assert.ok(mine, 'the kernel let go when the holder ended (killed, no cleanup)');
    assert.equal(lockHolder(db)?.pid, process.pid);
    mine!.release();
    assert.equal(lockHolder(db), null, 'the record goes with the release');
    const again = tryWriterLock(db);
    assert.ok(again);
    again!.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handover files: a request is taken by one rename, a withdrawal by the other; a dead standby gives its markets back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-hofiles-'));
  const p = handoverPaths(join(dir, 'index.db'));
  try {
    const seen: string[] = [];
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    writeJsonAtomic(p.hello, { pid: child.pid, at: 1 });
    let took: Accepted | null = null;
    const stop = watchForStandby(p, {
      onHello: () => seen.push('hello'),
      onLend: (c) => seen.push(`lend ${c.join(',')}`),
      onGone: () => seen.push('gone'),
      onRequest: (a) => { took = a; },
      everyMs: 20,
    });
    await sleep(100);
    writeJsonAtomic(p.hlLend, { seq: 1, pid: child.pid, coins: ['BTC', 'ETH'] });
    await sleep(100);
    assert.equal(readJson<{ seq: number }>(p.hlLent)?.seq, 1, 'answered');
    child.kill();
    await new Promise((r) => child.on('exit', r));
    await sleep(150);
    assert.deepEqual(seen, ['hello', 'lend BTC,ETH', 'gone'], 'the standby died: its markets come back');
    // A live one asks, and withdraws too late: the running side's rename won.
    const child2 = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    writeJsonAtomic(p.hello, { pid: child2.pid, at: 2 });
    await sleep(100);
    writeJsonAtomic(p.request, { pid: child2.pid, at: 3, helloAt: 2, from: { hyperliquid: 1 }, up: { hyperliquid: true } });
    await sleep(150);
    assert.equal((took as Accepted | null)?.pid, child2.pid);
    assert.equal(withdrawRequest(p), false, 'taken already: the standby must take over');
    stop();
    child2.kill();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status row while handing over: the last status, no `stopping`, a socket the standby lacks shown down', () => {
  const row = JSON.parse(handoverRow({ streams: { hyperliquid: 5, tradexyz: 5, sodex: 6, lighter: 7 }, lastBuildAt: 9 }, 100, 42, { to: 43, since: 90 }, { hyperliquid: true, sodex: true, lighter: false }));
  assert.deepEqual(row.streams, { hyperliquid: 5, tradexyz: 5, sodex: 6, lighter: null });
  assert.equal(row.stopping, undefined);
  assert.deepEqual(row.handover, { to: 43, since: 90 });
  assert.equal(row.lastBuildAt, 9);
});

/**
 * A run again, up to twice, on Windows only, when a child died of SQLite's 1546 (SQLITE_IOERR_TRUNCATE): Windows refuses
 * to shorten a file the process that is just ending still has mapped; Linux, where the indexer runs, allows it. Any other
 * failure stands.
 */
async function windowsAgain(run: () => Promise<void>): Promise<void> {
  for (let i = 0; ; i++) {
    try { return await run(); } catch (e) {
      if (process.platform !== 'win32' || i >= 2 || !/errcode: 1546/.test(String((e as Error)?.message))) throw e;
      console.log('HANDOVER-WINDOWS a truncate was refused (1546): once more');
    }
  }
}

// --- two real processes --------------------------------------------------------------------------------------------

const TRACKED = Array.from({ length: 6 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
const HL_PARTIES = [...TRACKED, ...Array.from({ length: 24 }, (_, i) => `0x${(i + 100).toString(16).padStart(40, '0')}`)];
const SODEX_PARTIES = Array.from({ length: 30 }, (_, i) => String(1000 + i));

/** The fake venue: every print of both venues to every connection, the last 40 of a venue first (a subscribe's snapshot). */
class FakeVenue {
  readonly prints: Print[] = [];
  /** Each subscriber: its venue and how many of that venue's prints were out before it (more than 40: it missed some). */
  readonly joins: string[] = [];
  private server: net.Server;
  private clients = new Map<net.Socket, string>();
  private timer?: NodeJS.Timeout;
  private seq = 0;
  private t = Date.now() - 1_000;
  port = 0;
  constructor() {
    this.server = net.createServer((sock) => {
      sock.setEncoding('utf8');
      sock.on('error', () => {});
      let rest = '';
      sock.on('data', (c: string) => {
        rest += c;
        const i = rest.indexOf('\n');
        if (i < 0 || this.clients.has(sock)) return;
        const venue = (JSON.parse(rest.slice(0, i)) as { venue: string }).venue;
        this.clients.set(sock, venue);
        const mine = this.prints.filter((p) => p.venue === venue);
        this.joins.push(`${venue}@${mine.length}`);
        const snap = mine.slice(-40);
        if (snap.length) sock.write(snap.map((p) => JSON.stringify(p)).join('\n') + '\n');
      });
      sock.on('close', () => this.clients.delete(sock));
    });
  }
  async listen(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as net.AddressInfo).port;
  }
  /** `perTick` prints every 20 ms per venue; every 4th repeats the last print's time, market and buyer (one order, two makers). */
  run(perTick = 3): void {
    let last: Record<string, Print | null> = { hyperliquid: null, sodex: null };
    this.timer = setInterval(() => {
      const out: Print[] = [];
      for (const venue of ['hyperliquid', 'sodex'] as const) {
        for (let k = 0; k < perTick; k++) {
          this.seq++;
          const parties = venue === 'hyperliquid' ? HL_PARTIES : SODEX_PARTIES;
          const prev = last[venue];
          const sweep = prev && this.seq % 4 === 0;
          this.t = Math.max(this.t + 1, Date.now() - 500);
          const symbol = sweep ? prev!.symbol : ['BTC', 'ETH', 'SOL'][this.seq % 3]!;
          const buyer = sweep ? prev!.buyer : parties[(this.seq * 7) % parties.length]!;
          let seller = parties[(this.seq * 11 + 3) % parties.length]!;
          if (seller === buyer) seller = parties[(this.seq * 11 + 4) % parties.length]!;
          const p: Print = {
            venue, id: venue === 'sodex' ? `${symbol}-USD:${this.seq}` : String(this.seq), t: sweep ? prev!.t : this.t,
            symbol: venue === 'sodex' ? `${symbol}-USD` : symbol, px: 100 + (this.seq % 50), sz: 1 + (this.seq % 7) / 10, buyer, seller,
          };
          last[venue] = p;
          out.push(p);
        }
      }
      this.prints.push(...out);
      for (const [sock, venue] of this.clients) {
        const mine = out.filter((p) => p.venue === venue);
        if (mine.length) sock.write(mine.map((p) => JSON.stringify(p)).join('\n') + '\n');
      }
    }, 20);
  }
  stopPrints(): void {
    if (this.timer) clearInterval(this.timer);
  }
  close(): void {
    this.stopPrints();
    for (const s of this.clients.keys()) s.destroy();
    this.server.close();
  }
}

/** What the index must hold for these prints: engine.ts onPrint's rules, run over every print once. */
function expected(prints: readonly Print[]) {
  const lastOrder = new Map<string, string>();
  const act = new Map<string, { trades: number; volume: number }>();
  let fills = 0;
  const tracked = new Set(TRACKED);
  for (const p of prints) {
    for (const acct of [p.buyer, p.seller]) {
      const k = `${p.venue}|${acct}`;
      const r = act.get(k) ?? { trades: 0, volume: 0 };
      const tag = `${p.t}|${p.symbol}`;
      if (lastOrder.get(k) !== tag) { r.trades++; lastOrder.set(k, tag); }
      r.volume += p.px * p.sz;
      act.set(k, r);
      if (p.venue === 'hyperliquid' && tracked.has(acct)) fills++;
    }
  }
  return { act, fills };
}

interface Child { proc: ChildProcess; lines: Array<{ at: number; line: string }>; msgs: Array<{ at: number; m: Record<string, unknown> }>; exit: Promise<number | null> }

function startIndexer(db: string, port: number, env: Record<string, string> = {}): Child {
  const e: Record<string, string | undefined> = {
    ...process.env, VALUESCAN_INDEX_DB: db, VALUESCAN_FAKE_VENUE: String(port), VALUESCAN_INDEX_BUILD: '0', VALUESCAN_INDEX_COHORTS: '0',
    VALUESCAN_SODEX_CATCHUP: '0', VALUESCAN_ARCUS_CATCHUP: '0', VALUESCAN_SODEX_LEDGER: '0', VALUESCAN_STALL_PROFILE: '0',
    VALUESCAN_WRITER_THREAD: '1', VALUESCAN_INDEX_STREAMS: '0', ...env,
  };
  delete e.NODE_TEST_CONTEXT;
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(HERE, 'handover.child.ts')], {
    cwd: SERVER, env: e, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const c: Child = { proc, lines: [], msgs: [], exit: new Promise((r) => proc.on('exit', (code) => r(code))) };
  const take = (d: Buffer) => { for (const line of String(d).split('\n')) if (line.trim()) c.lines.push({ at: Date.now(), line }); };
  proc.stdout!.on('data', take);
  proc.stderr!.on('data', take);
  proc.on('message', (m) => c.msgs.push({ at: Date.now(), m: m as Record<string, unknown> }));
  return c;
}

async function waitFor(what: string, ok: () => boolean, ms: number, c?: Child[]): Promise<number> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out: ${what}\n${(c ?? []).map((x, i) => `--- child ${i}\n${x.lines.slice(-30).map((l) => l.line).join('\n')}`).join('\n')}`);
    await sleep(20);
  }
  return Date.now();
}
const said = (c: Child, re: RegExp) => c.lines.find((l) => re.test(l.line));
const phase = (c: Child, name: string) => c.msgs.find((x) => x.m.handover === name);

function readIndex(db: string, flowDb: string) {
  const d = new DatabaseSync(db, { readOnly: true });
  const act = new Map<string, { trades: number; volume: number }>();
  for (const r of d.prepare('SELECT venue, acct, SUM(trades) AS t, SUM(volume) AS v FROM activity_hour GROUP BY venue, acct').all() as Array<{ venue: string; acct: string; t: number; v: number }>) {
    act.set(`${r.venue}|${r.acct}`, { trades: r.t, volume: r.v });
  }
  const fills = (d.prepare("SELECT COUNT(*) AS n FROM fills WHERE venue = 'hyperliquid'").get() as { n: number }).n;
  const spill = (() => { try { return (d.prepare('SELECT COUNT(*) AS n FROM write_spill').get() as { n: number }).n; } catch { return 0; } })();
  d.close();
  const f = new DatabaseSync(flowDb, { readOnly: true });
  let flow = 0;
  for (const r of f.prepare('SELECT data FROM flow_chunk').all() as Array<{ data: Uint8Array }>) flow += chunkPrints(decodeChunk(r.data)).length;
  f.close();
  return { act, fills, spill, flow };
}

function seed(db: string): void {
  const s = new IndexStore(db, { aggRefreshMs: 0 });
  const t = Date.now() - 60_000;
  const ins = s.db.prepare('INSERT OR REPLACE INTO coverage (venue, address, kind, from_t, to_t, exhausted, capped, rest_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0)');
  for (const a of TRACKED) ins.run('hyperliquid', a, 'fills', t, t);
  s.close();
}

test('handover between two indexer processes: every print exactly once (fills, activity, who traded), no long gap, the lock refuses a third writer', { timeout: 360_000 }, () => windowsAgain(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-handover-'));
  const db = join(dir, 'index.db');
  const venue = new FakeVenue();
  const kids: Child[] = [];
  try {
    seed(db);
    await venue.listen();
    const a = startIndexer(db, venue.port, { VALUESCAN_HANDOVER_TEST_HOLD_MS: '3000' });
    kids.push(a);
    const aWriting = await waitFor('A writes', () => !!said(a, /\[indexer\] writing /), 60_000, kids);
    // Prints only once A's sockets are on: one it never saw would be missing for a reason that is not the handover's.
    await waitFor('A subscribed', () => venue.joins.length >= 2, 10_000, kids);
    venue.run(5);
    await sleep(4_000);
    const t0 = Date.now();
    const b = startIndexer(db, venue.port, { VALUESCAN_INDEXER_STANDBY: '1' });
    kids.push(b);
    await waitFor('B stands by', () => !!phase(b, 'standby'), 60_000, kids);
    await waitFor('B asks', () => !!phase(b, 'requested'), 60_000, kids);
    // Memory while both run (B buffering, A writing): what each process holds.
    b.proc.send('rss');
    a.proc.send('rss');
    await waitFor('B took over', () => !!phase(b, 'promoted'), 60_000, kids);
    const rssOf = (c2: Child) => (c2.msgs.find((x) => typeof x.m.rss === 'number')?.m.rss as number | undefined) ?? NaN;
    const aCode = await Promise.race([a.exit, sleep(30_000).then(() => 'timeout')]);
    assert.equal(aCode, 0, `A ends after handing over\n${a.lines.map((l) => l.line).join('\n')}`);
    await waitFor('B applied its buffer', () => !!said(b, /handover: \d+ buffered prints through the boundary/), 30_000, kids);
    // A third writer, by mistake: refused.
    const c = startIndexer(db, venue.port);
    kids.push(c);
    const cCode = await Promise.race([c.exit, sleep(60_000).then(() => 'timeout')]);
    assert.equal(cCode, 73, `a second writer is refused\n${c.lines.map((l) => l.line).join('\n')}`);
    assert.ok(said(c, /writer lock .* is held by pid \d+/), 'and says who holds it');
    await sleep(3_000);
    venue.stopPrints();
    await sleep(1_500);
    b.proc.send('stop');
    const bCode = await Promise.race([b.exit, sleep(60_000).then(() => 'timeout')]);
    assert.equal(bCode, 0, 'B stops');
    // B's stop put its last rows in the spill, as every stop does (engine.ts spillUnwritten): one more start writes them.
    venue.close();
    const d = startIndexer(db, venue.port);
    kids.push(d);
    await waitFor('the last start replayed the spill', () => !!said(d, /\[indexer\] writing /), 60_000, kids);
    await sleep(3_000);
    d.proc.send('stop');
    assert.equal(await d.exit, 0);

    const got = readIndex(db, join(dir, 'valuescan-flow.db'));
    const want = expected(venue.prints);
    const wantTradesAll = [...want.act.values()].reduce((n, w) => n + w.trades, 0);
    const gotTradesAll = [...got.act.values()].reduce((n, w) => n + w.trades, 0);
    console.log(`HANDOVER-COUNTS fills ${got.fills}/${want.fills}, trades ${gotTradesAll}/${wantTradesAll}, accounts ${got.act.size}/${want.act.size}, who traded ${got.flow}/${venue.prints.length}, spill ${got.spill}; joins ${venue.joins.join(' ')}`);
    assert.equal(got.spill, 0, 'the spill is written');
    assert.equal(got.fills, want.fills, `fills: every tracked party's print once (${want.fills})`);
    let trades = 0;
    let wantTrades = 0;
    const off: string[] = [];
    for (const [k, w] of want.act) {
      const g = got.act.get(k);
      wantTrades += w.trades;
      trades += g?.trades ?? 0;
      if (!g || g.trades !== w.trades || Math.abs(g.volume - w.volume) > 1e-6 * w.volume) off.push(`${k}: got ${g?.trades}/${g?.volume?.toFixed(2)} want ${w.trades}/${w.volume.toFixed(2)}`);
    }
    assert.equal(got.act.size, want.act.size, 'every account');
    assert.deepEqual(off, [], `activity per account exactly (${wantTrades} trades)`);
    assert.equal(trades, wantTrades);
    assert.equal(got.flow, venue.prints.length, `who traded: every print once (${venue.prints.length})`);

    // The timings of this run.
    const at = (c2: Child, n: string) => phase(c2, n)?.at ?? NaN;
    const hello = at(b, 'standby');
    const requested = at(b, 'requested');
    const accepted = at(a, 'accepted');
    const released = at(a, 'released');
    const promoted = at(b, 'promoted');
    const applied = said(b, /handover: \d+ buffered prints through the boundary/)!;
    const stopLine = said(a, /\[indexer\] stopped in \d+ ms/)?.line ?? '';
    const drain = /through the boundary in (\d+) ms/.exec(applied.line)?.[1];
    console.log(`HANDOVER-MEASURE prints ${venue.prints.length} (fills ${want.fills}, trades ${wantTrades}); B started ${t0 - aWriting} ms after A wrote; A's stop held 3,000 ms on purpose`);
    console.log(`HANDOVER-MEASURE B start -> hello ${hello - t0} ms; hello -> request ${requested - hello} ms; request -> A accepts ${accepted - requested} ms`);
    console.log(`HANDOVER-MEASURE A accepts -> lock released ${released - accepted} ms; lock released -> B writing ${promoted - released} ms; buffer through the boundary ${drain} ms`);
    console.log(`HANDOVER-MEASURE whole handover (request -> B writing) ${promoted - requested} ms; A's stop line: ${stopLine.replace(/^.*\[indexer\] /, '')}`);
    console.log(`HANDOVER-MEASURE ${applied.line.replace(/^.*\[indexer\] /, '')}`);
    console.log(`HANDOVER-MEASURE RSS while both ran: standby ${Math.round(rssOf(b) / 1e6)} MB, running indexer ${Math.round(rssOf(a) / 1e6)} MB (scratch index)`);
  } finally {
    venue.close();
    for (const k of kids) if (k.proc.exitCode === null) k.proc.kill();
    await sleep(300);
    rmSync(dir, { recursive: true, force: true });
  }
}));

test('handover fallback: a running indexer that does not answer leaves the standby to give up (exit 75), and it carries on writing', { timeout: 120_000 }, () => windowsAgain(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-handover-fb-'));
  const db = join(dir, 'index.db');
  const venue = new FakeVenue();
  const kids: Child[] = [];
  try {
    seed(db);
    await venue.listen();
    venue.run(1);
    // An older indexer, as on the first release of this code: it does not watch for a standby.
    const a = startIndexer(db, venue.port, { VALUESCAN_HANDOVER: '0' });
    kids.push(a);
    await waitFor('A writes', () => !!said(a, /\[indexer\] writing /), 60_000, kids);
    const b = startIndexer(db, venue.port, { VALUESCAN_INDEXER_STANDBY: '1', VALUESCAN_HANDOVER_REQUEST_MS: '2000' });
    kids.push(b);
    const code = await Promise.race([b.exit, sleep(60_000).then(() => 'timeout')]);
    assert.equal(code, 75, `the standby gives up\n${b.lines.map((l) => l.line).join('\n')}`);
    assert.ok(phase(b, 'failed'), 'and tells the supervisor');
    assert.ok(said(b, /did not take the request/));
    const p = handoverPaths(db);
    assert.equal(readJson(p.hello), null, 'its files are gone');
    assert.equal(readJson(p.request), null);
    assert.equal(a.proc.exitCode, null, 'A still runs');
    assert.equal(tryWriterLock(db), null, 'and still holds the lock');
    a.proc.send('stop');
    assert.equal(await a.exit, 0);
  } finally {
    venue.close();
    for (const k of kids) if (k.proc.exitCode === null) k.proc.kill();
    await sleep(300);
    rmSync(dir, { recursive: true, force: true });
  }
}));

test('standby with no writer running: it simply starts as the writer', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-handover-solo-'));
  const db = join(dir, 'index.db');
  const venue = new FakeVenue();
  const kids: Child[] = [];
  try {
    seed(db);
    await venue.listen();
    venue.run(1);
    const b = startIndexer(db, venue.port, { VALUESCAN_INDEXER_STANDBY: '1' });
    kids.push(b);
    await waitFor('B writes', () => !!said(b, /\[indexer\] writing /), 60_000, kids);
    assert.ok(said(b, /nothing to take over: starting as the writer/));
    assert.equal((phase(b, 'promoted')?.m as { takeover?: boolean } | undefined)?.takeover, false);
    b.proc.send('stop');
    assert.equal(await b.exit, 0);
  } finally {
    venue.close();
    for (const k of kids) if (k.proc.exitCode === null) k.proc.kill();
    await sleep(300);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supervisor: a reload hands over to a standby from the same unit, the state file says so, a second reload meanwhile is ignored; every print once', { timeout: 360_000 }, () => windowsAgain(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-supervisor-'));
  const db = join(dir, 'index.db');
  const stateFile = join(dir, 'state', 'indexer-handover.json');
  const venue = new FakeVenue();
  const kids: Child[] = [];
  try {
    seed(db);
    await venue.listen();
    const e: Record<string, string | undefined> = {
      ...process.env, VALUESCAN_INDEX_DB: db, VALUESCAN_FAKE_VENUE: String(venue.port), VALUESCAN_INDEX_BUILD: '0', VALUESCAN_INDEX_COHORTS: '0',
      VALUESCAN_SODEX_CATCHUP: '0', VALUESCAN_ARCUS_CATCHUP: '0', VALUESCAN_SODEX_LEDGER: '0', VALUESCAN_STALL_PROFILE: '0',
      VALUESCAN_WRITER_THREAD: '1', VALUESCAN_INDEX_STREAMS: '0', VS_INDEXER_DIR: SERVER, VS_INDEXER_STATE: stateFile,
    };
    delete e.NODE_TEST_CONTEXT;
    const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(SERVER, 'src', 'indexer', 'supervisor.ts'),
      '--disable-warning=ExperimentalWarning', '--import', 'tsx', join(HERE, 'handover.child.ts')], { cwd: SERVER, env: e, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const sup: Child = { proc, lines: [], msgs: [], exit: new Promise((r) => proc.on('exit', (code) => r(code))) };
    const take = (d: Buffer) => { for (const line of String(d).split('\n')) if (line.trim()) sup.lines.push({ at: Date.now(), line }); };
    proc.stdout!.on('data', take);
    proc.stderr!.on('data', take);
    kids.push(sup);
    const st = () => readJson<{ seq: number; phase: string; activePid: number; timings?: Record<string, number>; reason?: string }>(stateFile);
    await waitFor('the first indexer writes', () => !!said(sup, /\[indexer\] writing /), 60_000, kids);
    await waitFor('it subscribed', () => venue.joins.length >= 2, 10_000, kids);
    venue.run(3);
    const first = st()!;
    assert.equal(first.phase, 'running');
    await sleep(2_000);
    const reloadAt = Date.now();
    proc.send('reload');
    await sleep(50);
    proc.send('reload');
    await waitFor('promoted', () => st()?.phase === 'promoted', 60_000, kids);
    const done = Date.now();
    const after = st()!;
    assert.equal(after.seq, first.seq + 1, 'one handover');
    assert.notEqual(after.activePid, first.activePid, 'another process writes now');
    assert.ok(said(sup, /reload ignored: a handover is under way/), 'the second reload was ignored');
    await waitFor('the old one ended', () => !!said(sup, /handed over and ended \(code 0\)/), 30_000, kids);
    await sleep(2_000);
    venue.stopPrints();
    await sleep(1_500);
    proc.send('stop');
    assert.equal(await Promise.race([sup.exit, sleep(60_000).then(() => 'timeout')]), 0, 'the supervisor ends after its child');
    venue.close();
    const d = startIndexer(db, venue.port);
    kids.push(d);
    await waitFor('the last start replayed the spill', () => !!said(d, /\[indexer\] writing /), 60_000, kids);
    await sleep(3_000);
    d.proc.send('stop');
    assert.equal(await d.exit, 0);
    const got = readIndex(db, join(dir, 'valuescan-flow.db'));
    const want = expected(venue.prints);
    assert.equal(got.fills, want.fills);
    let off = 0;
    for (const [k, w] of want.act) { const g = got.act.get(k); if (!g || g.trades !== w.trades) off++; }
    assert.equal(off, 0, 'activity exactly');
    assert.equal(got.flow, venue.prints.length, 'who traded exactly');
    console.log(`HANDOVER-MEASURE supervisor: reload -> promoted ${done - reloadAt} ms (state file: ${JSON.stringify(after.timings)}), ${venue.prints.length} prints exactly once`);
  } finally {
    venue.close();
    for (const k of kids) if (k.proc.exitCode === null) k.proc.kill();
    await sleep(300);
    rmSync(dir, { recursive: true, force: true });
  }
}));
