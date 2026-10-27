/**
 * Audit (round 2) of the BROWSER algo runner (browserAlgos.ts): one runner tab
 * per wallet elected with a Web Lock, the others standby, commands over a
 * BroadcastChannel, the books in the shared store (algoStore.ts).
 *
 * Two "tabs" are two instances of the module (imported with a different query
 * string): they share algoStore.ts (no IndexedDB under node, so its in-memory
 * store - shared exactly as IndexedDB is), Node's real navigator.locks and its
 * real BroadcastChannel. The network is faked (fetch answers SoDEX's market
 * list; WebSocket never opens), so nothing leaves this process.
 *
 * Every test asserts the intended behaviour; a failing test named "BUG ..." is
 * a bug.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

type Role = 'off' | 'starting' | 'runner' | 'standby';
interface Tab {
  role: Role;
  owner: string | null;
  views: Array<{ algo: { id: string; status: string; spec: Record<string, unknown> } }>;
  follow(owner: string | null): Promise<void>;
  start(spec: unknown, seed?: number): Promise<string | undefined>;
  pause(id: string): Promise<string | undefined>;
  resume(id: string): Promise<string | undefined>;
  cancel(id: string): Promise<string | undefined>;
  cancelAll(): Promise<string | undefined>;
  update(id: string, patch: Record<string, unknown>): Promise<string | undefined>;
}

const OWNER = '0x00000000000000000000000000000000000000aa';
const realFetch = globalThis.fetch;
const realWs = (globalThis as { WebSocket?: unknown }).WebSocket;

const MARKETS = [
  { id: 1, name: 'BTC-USD', baseCoin: 'BTC', tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '1000', minNotional: 10, maxNotional: 5_000_000, maxLeverage: 50, status: 'TRADING' },
];

class FakeWs {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor(_url: string) {}
  send(): void {}
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

before(() => {
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    const data = u.includes('/markets/symbols') ? MARKETS : [];
    return new Response(JSON.stringify({ code: 0, data, timestamp: Date.now() }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWs;
});
after(() => {
  globalThis.fetch = realFetch;
  (globalThis as { WebSocket?: unknown }).WebSocket = realWs;
});

let n = 0;
async function tab(): Promise<Tab> {
  const m = (await import(`./browserAlgos.ts?tab=${++n}`)) as { browserAlgos: Tab };
  return m.browserAlgos;
}

const wait = async (cond: () => boolean, ms = 3_000): Promise<boolean> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
};

const paperTwap = (over: Record<string, unknown> = {}) => ({ kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', durationMs: 3_600_000, slices: 10, paper: true, ...over });

/** Each test gets its own wallet: the store is shared by the whole file. */
let w = 0;
const wallet = () => `${OWNER.slice(0, -4)}${(++w).toString(16).padStart(4, '0')}`;

/* ============================================================ election ===== */

test('two tabs with live algos: exactly one runs them (the Web Lock), the other is standby', async () => {
  const owner = wallet();
  const a = await tab();
  await a.follow(owner);
  const id = await a.start(paperTwap());
  assert.ok(id);
  assert.equal(a.role, 'runner');
  const b = await tab();
  await b.follow(owner);
  await wait(() => b.role === 'standby');
  assert.equal(b.role, 'standby');
  await a.follow(null);
  await b.follow(null);
});

test('a standby tab\'s command is applied by the runner tab and answered', async () => {
  const owner = wallet();
  const a = await tab();
  await a.follow(owner);
  const id = (await a.start(paperTwap()))!;
  const b = await tab();
  await b.follow(owner);
  await wait(() => b.role === 'standby');
  await b.pause(id);
  await wait(() => a.views.some((v) => v.algo.id === id && v.algo.status === 'paused'));
  assert.equal(a.views.find((v) => v.algo.id === id)?.algo.status, 'paused');
  await a.follow(null);
  await b.follow(null);
});

test('when the runner tab closes, the standby tab takes over the algos', async () => {
  const owner = wallet();
  const a = await tab();
  await a.follow(owner);
  await a.start(paperTwap());
  const b = await tab();
  await b.follow(owner);
  await wait(() => b.role === 'standby');
  await a.follow(null); // the runner tab closes (its lock is released)
  assert.ok(await wait(() => b.role === 'runner'), `the standby tab is still ${b.role}`);
  await b.follow(null);
});

test('a paper algo starts with no wallet (the paper book); a live one is refused there', async () => {
  const a = await tab();
  await a.follow('paper');
  const id = await a.start(paperTwap());
  assert.ok(id);
  await assert.rejects(a.start(paperTwap({ paper: false })), /off for now|Practice run|Connect your wallet/);
  await a.cancelAll();
  await a.follow(null);
});

/* ============================================================ the bugs ===== */

test('BUG browser: a tab opened before any algo existed can pause / cancel / kill-switch the algos another tab runs', async () => {
  const owner = wallet();
  // Tab A opens first: this wallet has no algo yet, so A follows it as 'off'.
  const a = await tab();
  await a.follow(owner);
  assert.equal(a.role, 'off');
  // Tab B starts one: B takes the lock and runs it.
  const b = await tab();
  await b.follow(owner);
  const id = (await b.start(paperTwap()))!;
  assert.equal(b.role, 'runner');
  // A is told something changed and shows it ...
  await wait(() => a.views.some((v) => v.algo.id === id));
  assert.ok(a.views.some((v) => v.algo.id === id), 'tab A lists the algo');
  // ... but its buttons do not work: every command but "add" throws "No algo runs in this browser." in an 'off' tab.
  let err: unknown = null;
  try {
    await a.cancelAll();
  } catch (e) {
    err = e;
  }
  const status = b.views.find((v) => v.algo.id === id)?.algo.status;
  await b.follow(null);
  await a.follow(null);
  assert.equal(err, null, `the kill switch in tab A failed: ${err instanceof Error ? err.message : String(err)}`);
  assert.equal(status, 'cancelled', 'the algo was not cancelled from tab A');
});

test('BUG browser: when the runner tab closes, a tab that opened before the algo existed takes over (the algo is not orphaned)', async () => {
  const owner = wallet();
  const a = await tab();
  await a.follow(owner); // 'off': nothing to run yet
  const b = await tab();
  await b.follow(owner);
  await b.start(paperTwap());
  assert.equal(b.role, 'runner');
  await b.follow(null); // the runner tab closes; tab A is still open on the same wallet
  const took = await wait(() => a.role === 'runner' || a.role === 'standby', 2_000);
  const role = a.role;
  await a.follow(null);
  assert.ok(took, `tab A stays '${role}': the running algo is worked by no tab while a tab of this wallet is open`);
});

test('BUG browser: update() cannot turn a practice run into a live algo (it bypasses the live gate requirePaperAlgo)', async () => {
  const owner = wallet();
  const a = await tab();
  await a.follow(owner);
  const id = (await a.start(paperTwap()))!;
  let threw = false;
  try {
    await a.update(id, { paper: false });
  } catch {
    threw = true;
  }
  const v = a.views.find((x) => x.algo.id === id)!;
  await a.cancelAll().catch(() => {});
  await a.follow(null);
  assert.ok(threw || v.algo.spec.paper === true, 'the practice run is now a LIVE algo (spec.paper false) signed by the trading key, though real algos are off');
});

test('BUG browser: update() cannot change what an algo is (its side or kind), only its limit, bounds, spread guard, label and size', async () => {
  const owner = wallet();
  const a = await tab();
  await a.follow(owner);
  const id = (await a.start(paperTwap()))!;
  let threw = false;
  try {
    await a.update(id, { side: 'sell' });
  } catch {
    threw = true;
  }
  const v = a.views.find((x) => x.algo.id === id)!;
  await a.cancelAll().catch(() => {});
  await a.follow(null);
  assert.ok(threw || v.algo.spec.side === 'buy', `a running buy was turned into a ${String(v.algo.spec.side)}`);
});

test('BUG browser: without Web Locks (Safari < 15.4), two tabs of one wallet do not both run its algos (every child would be sent twice)', async () => {
  const owner = wallet();
  const nav = navigator as unknown as { locks?: unknown };
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(nav), 'locks') ?? Object.getOwnPropertyDescriptor(nav, 'locks');
  let removed = false;
  try {
    Object.defineProperty(nav, 'locks', { value: undefined, configurable: true });
    removed = nav.locks === undefined;
  } catch {
    /* not removable here */
  }
  if (!removed) return; // cannot simulate on this Node
  try {
    const a = await tab();
    await a.follow(owner);
    await a.start(paperTwap());
    const b = await tab();
    await b.follow(owner);
    await wait(() => b.role === 'runner', 1_000);
    const roles = [a.role, b.role];
    await a.follow(null);
    await b.follow(null);
    assert.ok(roles.filter((r) => r === 'runner').length <= 1, `both tabs run the same algos: ${roles.join(', ')}`);
  } finally {
    delete (nav as { locks?: unknown }).locks;
    if (desc && !Object.getOwnPropertyDescriptor(Object.getPrototypeOf(nav), 'locks')) Object.defineProperty(nav, 'locks', desc);
  }
});
