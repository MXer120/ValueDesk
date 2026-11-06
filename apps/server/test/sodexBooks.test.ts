/**
 * SoDEX's books and trade check (2026-11-06): a read does not lose or repeat the prints around it, spot stays out of the perps
 * books, every holder has a schedule, a break the catch-up has covered is no break, and the check still means what it meant.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CohortTracker, SODEX_BOOK_MAX_MS, bookable, printInRead, sodexBookPrio, sodexBookTtl, type CohortDeps } from '../src/indexer/cohortTracker.js';
import { sodexPositionsOf, type BookRead, type PositionRead } from '../src/indexer/cohortSource.js';
import { Indexer } from '../src/indexer/engine.js';
import { Lane } from '../src/indexer/lanes.js';
import { overOiRows } from '../src/indexer/read.js';
import { SodexCatchup, WATCH_MS, CATCHUP_LIMIT } from '../src/indexer/sodexCatchup.js';
import { IndexStore, type FillRow } from '../src/indexer/store.js';
import type { Print } from '../src/indexer/streams.js';

const T = 1_800_000_000_000;
const read = (sent: number, got: number, ut: Record<string, number>): BookRead => ({ sent, got, ut: new Map(Object.entries(ut)) });

test('a read holds a print up to the position\'s last change, and only that', () => {
  const r = read(T, T + 300, { 'BTC-USD': T + 100 });
  assert.equal(printInRead(r, 'BTC-USD', T + 100), true, 'the same millisecond is the change itself');
  assert.equal(printInRead(r, 'BTC-USD', T + 101), false);
  assert.equal(printInRead(r, 'BTC-USD', T + 50), true);
  assert.equal(printInRead(r, 'BTC-USD', T - 60_000), true);
});

test('a market flat in the read: before the ask yes, after the answer no, between them unknown', () => {
  const r = read(T, T + 300, {});
  assert.equal(printInRead(r, 'ETH-USD', T - 2_001), true);
  assert.equal(printInRead(r, 'ETH-USD', T + 2_301), false);
  assert.equal(printInRead(r, 'ETH-USD', T + 100), 'unknown');
});

test('spot pairs move no perps book', () => {
  assert.equal(bookable('sodex', 'vETH_vUSDC'), false);
  assert.equal(bookable('sodex', 'WSOSO_vUSDC'), false);
  assert.equal(bookable('sodex', 'BTC-USD'), true);
  assert.equal(bookable('lighter', 'BTC'), true);
});

test('the read keeps each position\'s last change and the reader\'s clock', () => {
  const r = sodexPositionsOf({ aid: 7, av: '100', P: [{ s: 'BTC-USD', sz: '1', ep: '10', ur: '0', ut: T + 5 }] }, { sent: T, got: T + 1 });
  assert.deepEqual(r.positions.map((p) => p.szi), [1]);
  assert.equal(r.read?.ut.get('BTC-USD'), T + 5);
  assert.equal(r.read?.sent, T);
  assert.equal(sodexPositionsOf({ aid: 0 }, { sent: T, got: T }).read?.ut.size, 0, 'no account: an empty book as of the read');
  assert.equal(sodexPositionsOf({ aid: 7, P: [] }).read, undefined, 'no timing given: none claimed');
});

test('the schedule: largest soonest, a wallet that traded within the hour, nobody past the maximum', () => {
  assert.equal(sodexBookTtl(100_000, false), 15 * 60_000);
  assert.equal(sodexBookTtl(10_000, false), 30 * 60_000);
  assert.equal(sodexBookTtl(1_000, false), 60 * 60_000);
  assert.equal(sodexBookTtl(5, true), 60 * 60_000);
  assert.equal(sodexBookTtl(5, false), SODEX_BOOK_MAX_MS);
  assert.ok(sodexBookPrio(1e6) > sodexBookPrio(1e3));
  assert.ok(sodexBookPrio(2e8) < 870, 'below the open interest check');
  assert.ok(sodexBookPrio(0) > 460, 'above the routine reconciles');
});

// --- a read and the prints around it ------------------------------------------------------

const ADDR = '0xabc';
const print = (t: number, sz: number, symbol = 'BTC-USD', buyer = '1', seller = '2'): Print => ({ venue: 'sodex', id: `${symbol}:${t}`, t, symbol, px: 100, sz, buyer, seller });
const addressOf = (a: string): string | null => (a === '1' ? ADDR : null);
const lane = () => new Lane({ name: 'x', perMin: 1e6 });

function rig(answer: () => Promise<PositionRead>) {
  const deps = {
    store: {}, now: () => Date.now(), hlSnapshot: async () => null, streamSince: () => 1,
    lighter: { lane: lane(), pacer: {} }, arcus: { lane: lane(), pacer: {} }, sodexGate: () => 0, sodexState: answer,
  } as unknown as CohortDeps;
  const t = new CohortTracker(deps) as unknown as {
    books: Map<string, Map<string, { pos: Map<string, { szi: number }>; opened?: boolean; at: number }>>;
    onPrint: (p: Print, a: (x: string) => string | null) => void;
    queueRead: (v: 'sodex', a: string, prio: number, total: null) => void;
    scoh: Lane;
    stop?: unknown;
  };
  t.books.set('sodex', new Map());
  return t;
}
const size = (t: ReturnType<typeof rig>, symbol = 'BTC-USD'): number => t.books.get('sodex')!.get(ADDR)?.pos.get(symbol)?.szi ?? 0;
const answerWith = (ut: number, szi: number, sent: number, got: number): PositionRead => ({
  equity: 100, marks: [], positions: szi ? [{ symbol: 'BTC-USD', szi, entry: 100 }] : [], read: read(sent, got, szi ? { 'BTC-USD': ut } : {}),
});
async function readDone(t: ReturnType<typeof rig>): Promise<void> {
  for (let i = 0; i < 200 && t.scoh.done + t.scoh.failed === 0; i++) await new Promise((r) => setTimeout(r, 5));
  t.scoh.stop();
}

test('a print during a slow read that the answer does not hold survives the read', async () => {
  const now = Date.now();
  let answer!: (r: PositionRead) => void;
  const t = rig(() => new Promise((r) => { answer = r; }));
  t.books.get('sodex')!.set(ADDR, { pos: new Map([['BTC-USD', { szi: 10 }]]), at: now - 3_600_000 } as never);
  t.queueRead('sodex', ADDR, 900, null);
  t.scoh.start();
  await new Promise((r) => setTimeout(r, 20));
  // SoDEX took its picture at `now + 1000` (size 5); the print at +5 s came in while the answer was on its way.
  t.onPrint(print(now + 5_000, 1), addressOf);
  answer(answerWith(now + 1_000, 5, now, now + 6_000));
  await readDone(t);
  assert.equal(size(t), 6, 'the read\'s 5 and the print after it');
});

test('a print the answer holds is not applied twice, whenever it arrives', async () => {
  const now = Date.now();
  let answer!: (r: PositionRead) => void;
  const t = rig(() => new Promise((r) => { answer = r; }));
  t.books.get('sodex')!.set(ADDR, { pos: new Map([['BTC-USD', { szi: 4 }]]), at: now - 3_600_000 } as never);
  t.queueRead('sodex', ADDR, 900, null);
  t.scoh.start();
  await new Promise((r) => setTimeout(r, 20));
  t.onPrint(print(now + 500, 1), addressOf); // Before the answer.
  answer(answerWith(now + 1_000, 6, now, now + 2_000));
  await readDone(t);
  assert.equal(size(t), 6);
  t.onPrint(print(now + 1_000, 1), addressOf); // After it, late, from a slow socket or the catch-up.
  assert.equal(size(t), 6);
  t.onPrint(print(now + 1_001, 1), addressOf);
  assert.equal(size(t), 7, 'a later print moves the book as ever');
});

test('a print on a market flat in the read, too close to tell: left out, and the book is read again soon', async () => {
  const now = Date.now();
  let answer!: (r: PositionRead) => void;
  const t = rig(() => new Promise((r) => { answer = r; }));
  t.books.get('sodex')!.set(ADDR, { pos: new Map([['BTC-USD', { szi: 2 }]]), at: now - 3_600_000 } as never);
  t.queueRead('sodex', ADDR, 900, null);
  t.scoh.start();
  await new Promise((r) => setTimeout(r, 20));
  t.onPrint(print(now + 100, 2), addressOf);
  answer(answerWith(0, 0, now, now + 300));
  await readDone(t);
  assert.equal(size(t), 0, 'no phantom position');
  assert.equal(t.books.get('sodex')!.get(ADDR)!.opened, true);
});

test('a wallet\'s first read keeps the prints that came while it was read', async () => {
  const now = Date.now();
  let answer!: (r: PositionRead) => void;
  const t = rig(() => new Promise((r) => { answer = r; }));
  t.queueRead('sodex', ADDR, 900, null);
  t.scoh.start();
  await new Promise((r) => setTimeout(r, 20));
  t.onPrint(print(now + 5_000, 1), addressOf);
  answer(answerWith(now + 1_000, 5, now, now + 6_000));
  await readDone(t);
  assert.equal(size(t), 6);
});

test('a read that fails leaves the book and its prints as they were', async () => {
  const now = Date.now();
  let fail!: (e: Error) => void;
  const t = rig(() => new Promise((_, no) => { fail = no; }));
  t.books.get('sodex')!.set(ADDR, { pos: new Map([['BTC-USD', { szi: 3 }]]), at: now - 3_600_000 } as never);
  t.queueRead('sodex', ADDR, 900, null);
  t.scoh.start();
  await new Promise((r) => setTimeout(r, 20));
  t.onPrint(print(now + 500, 1), addressOf);
  fail(new Error('HTTP 400'));
  await readDone(t);
  assert.equal(size(t), 4);
  t.onPrint(print(now + 600, 1), addressOf);
  assert.equal(size(t), 5);
});

// --- the catch-up answers for a break --------------------------------------------------------

const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ t: i + 1, T: from + i, s: 'BTC-USD', S: 'BUY', p: '1', q: '1', bi: 1, si: 2 }));
function catchup(answer: (symbol: string) => ReturnType<typeof rows>, nowAt: { t: number }, add: (r: never[]) => never[] = () => []) {
  return new SodexCatchup(add as never, () => {}, async (_e, symbol) => ({ rows: answer(symbol) }), async (e) => (e === 'perps' ? ['BTC-USD', 'ETH-USD'] : []), () => nowAt.t);
}
const tickAll = async (c: SodexCatchup, now: { t: number }) => { for (let i = 0; i < 4; i++) { await c.tick(); now.t += 1; } };

test('a break is covered once every market was read after it, back to its start', async () => {
  const now = { t: T + 60_000 };
  const c = catchup(() => rows(T - 1_000, 10), now);
  assert.equal(c.watch(T - 500, T), 'waiting');
  await tickAll(c, now);
  assert.equal(c.watch(T - 500, T), 'covered', 'few rows: SoDEX showed all it has');
});

test('a market that cannot show back to the start loses the break', async () => {
  const now = { t: T + 60_000 };
  const c = catchup((s) => (s === 'BTC-USD' ? rows(T - 100, CATCHUP_LIMIT) : rows(T - 9_000, 3)), now);
  c.watch(T - 5_000, T);
  await tickAll(c, now);
  assert.equal(c.watch(T - 5_000, T), 'lost');
});

test('a full page reaching back far enough covers it', async () => {
  const now = { t: T + 60_000 };
  const c = catchup(() => rows(T - 9_000, CATCHUP_LIMIT), now);
  c.watch(T - 5_000, T);
  await tickAll(c, now);
  assert.equal(c.watch(T - 5_000, T), 'covered');
});

test('a read too soon after the break, or one that could not tell what is held, proves nothing', async () => {
  const now = { t: T + 1_000 };
  const early = catchup(() => rows(T - 1_000, 3), now);
  early.watch(T - 500, T);
  await tickAll(early, now);
  assert.equal(early.watch(T - 500, T), 'waiting');

  const later = { t: T + 60_000 };
  const failing = catchup(() => rows(T - 1_000, 3), later, () => { throw new Error('missing: unreadable chunk'); });
  failing.watch(T - 500, T);
  await tickAll(failing, later);
  assert.equal(failing.watch(T - 500, T), 'waiting');
  later.t += WATCH_MS + 1;
  assert.equal(failing.watch(T - 500, T), 'lost', 'and the wait has an end');
});

// --- the engine: the span, and the check --------------------------------------------------

interface Engine {
  sodexStream: { since: number } | null;
  sodexCatchup: { watch: (a: number, b: number) => string; forget: () => void } | null;
  streamState: Record<string, { since: number | null; lastUp: number }>;
  sodexBreaks: unknown[];
  gaps: Record<string, Array<{ to: number; broke: boolean; covered?: boolean }>>;
  trackStreams: (now: number) => void;
  streamSince: (v: string) => number | null;
  check: (v: string, a: string, w: string, from: number, now: number) => string;
  queueCheck: (v: string, a: string, from: number, prio: number) => void;
  scheck: Lane;
  sgw: Lane;
}
const clock = { t: T };
const engine = (): { e: Engine; store: IndexStore } => {
  const store = new IndexStore(':memory:');
  return { e: new Indexer(store, () => clock.t) as unknown as Engine, store };
};
const UP_BEFORE = T - 400_000;
const SINCE = T - 40 * 3_600_000;

test('a break the catch-up covered leaves the span where it was; until then it counts', () => {
  const { e } = engine();
  let state = 'waiting';
  e.sodexCatchup = { watch: () => state, forget: () => {} };
  e.sodexStream = { since: T };
  e.streamState.sodex = { since: SINCE, lastUp: UP_BEFORE };
  e.trackStreams(T + 1_000);
  assert.equal(e.streamSince('sodex'), T, 'a break until it is answered');
  assert.equal(e.gaps.sodex!.at(-1)!.broke, true);
  assert.equal(e.sodexBreaks.length, 1);
  state = 'covered';
  e.trackStreams(T + 2_000);
  assert.equal(e.streamSince('sodex'), SINCE);
  assert.equal(e.gaps.sodex!.at(-1)!.broke, false);
  assert.equal(e.gaps.sodex!.at(-1)!.covered, true);
  assert.equal(e.sodexBreaks.length, 0);
});

test('a break that is lost stands', () => {
  const { e } = engine();
  e.sodexCatchup = { watch: () => 'lost', forget: () => {} };
  e.sodexStream = { since: T };
  e.streamState.sodex = { since: SINCE, lastUp: UP_BEFORE };
  e.trackStreams(T + 1_000);
  assert.equal(e.streamSince('sodex'), T);
  assert.equal(e.gaps.sodex!.at(-1)!.broke, true);
  assert.equal(e.sodexBreaks.length, 0);
});

test('two breaks in a row: the span goes back only as far as both are covered', () => {
  const { e } = engine();
  const answers = new Map<number, string>([[T, 'waiting'], [T + 900_000, 'covered']]);
  e.sodexCatchup = { watch: (_a, to) => answers.get(to)!, forget: () => {} };
  e.sodexStream = { since: T };
  e.streamState.sodex = { since: SINCE, lastUp: UP_BEFORE };
  e.trackStreams(T + 1_000);
  e.sodexStream = { since: T + 900_000 };
  e.streamState.sodex!.lastUp = T + 400_000;
  e.trackStreams(T + 901_000);
  assert.equal(e.streamSince('sodex'), T, 'the newer one is covered, the older one is not answered yet');
  answers.set(T, 'lost');
  e.trackStreams(T + 902_000);
  assert.equal(e.streamSince('sodex'), T, 'the older one is lost: the span starts after it');
  assert.equal(e.sodexBreaks.length, 0);
});

test('without a catch-up a break is a break, as before', () => {
  const { e } = engine();
  e.sodexStream = { since: T };
  e.streamState.sodex = { since: SINCE, lastUp: UP_BEFORE };
  e.trackStreams(T + 1_000);
  assert.equal(e.streamSince('sodex'), T);
  assert.equal(e.sodexBreaks.length, 0);
});

const fill = (t: number, side: 1 | -1 = 1): FillRow => ({ venue: 'sodex', address: ADDR, id: `BTC-USD:${t}`, t, symbol: 'BTC-USD', side, px: 1, sz: 1, fee: null, closedPnl: null, oid: String(t), src: 1 });

test('the check: a wallet passes on two real trades, fails only when both engines were seen whole, else stays open', () => {
  const { e, store } = engine();
  // The store refuses fills from the future: this test runs on the real clock.
  const N = Date.now();
  clock.t = N;
  const from = N - 86_400_000;
  e.streamState.sodex = { since: N - 300_000, lastUp: N };
  assert.equal(e.check('sodex', ADDR, '1d', from, N), 'unknown', 'nothing read: not a no');

  const one = '0xone';
  store.putFills([{ ...fill(N - 5_000), address: one }]);
  store.addCoverage('sodex', one, 'perps', { fromT: from, toT: N }, N);
  assert.equal(e.check('sodex', one, '1d', from, N), 'unknown', 'one trade does not pass, and spot was not seen: not a no either');

  const two = '0xtwo';
  store.putFills([{ ...fill(N - 4_000, -1), address: two }, { ...fill(N - 3_000), address: two }]);
  assert.equal(e.check('sodex', two, '1d', from, N), 'yes');

  const none = '0xnone';
  store.addCoverage('sodex', none, 'perps', { fromT: from, toT: N }, N);
  store.addCoverage('sodex', none, 'spot', { fromT: from, toT: N }, N);
  assert.equal(e.check('sodex', none, '1d', from, N), 'no', 'a short page on both engines: it really has not traded');
});

test('a pending wallet gets one account-trades read per window, on the slow lane', () => {
  const { e } = engine();
  clock.t = T;
  const from = T - 86_400_000;
  e.queueCheck('sodex', ADDR, from, 900);
  e.queueCheck('sodex', ADDR, from + 1_000, 950);
  assert.equal(e.scheck.size, 1);
  assert.equal(e.sgw.size, 1, 'the closes read as before');
  e.queueCheck('sodex', ADDR, from - 7 * 86_400_000, 800);
  assert.equal(e.scheck.size, 2, 'another window is another read');
});

test('the surfaces get the coins over open interest only from a recent check', () => {
  const status = { cohorts: { liq: { oi: { at: T, venues: { sodex: { coins: [{ coin: 'AAVE', ratio: 6.9 }] } } } } } };
  assert.deepEqual(overOiRows(status, T + 60_000), [{ venue: 'sodex', coin: 'AAVE', ratio: 6.9, at: T }]);
  assert.deepEqual(overOiRows(status, T + 3_600_000), [], 'an old check says nothing about now');
  assert.deepEqual(overOiRows(null, T), []);
});
