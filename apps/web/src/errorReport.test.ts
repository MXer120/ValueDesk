/**
 * Client error reports (errorReport.ts): what a report holds and never holds,
 * one entry per fingerprint, the batch, the session cap and the sampling when a
 * page is noisy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorReporter, FLUSH_MS, MAX_PER_BATCH, MAX_PER_SESSION, NOISY_PER_MINUTE, capture, type ReporterEnv } from './errorReport';

const WALLET = '0x04fb1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

function harness(o: { random?: () => number; route?: string } = {}) {
  const sent: Array<{ body: Record<string, unknown>; beacon: boolean }> = [];
  const timers: Array<() => void> = [];
  let now = 1_800_000_000_000;
  const storage = memoryStorage();
  const env: ReporterEnv = {
    send: (body, beacon) => sent.push({ body: JSON.parse(body), beacon }),
    now: () => now,
    random: o.random ?? (() => 0.5),
    route: () => o.route ?? `/scan/${WALLET}`,
    userAgent: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    session: () => storage,
    setTimer: (fn, ms) => {
      assert.equal(ms, FLUSH_MS);
      timers.push(fn);
      return timers.length;
    },
  };
  const r = new ErrorReporter(env);
  const fire = () => timers.splice(0).forEach((f) => f());
  return { r, sent, fire, storage, tick: (ms: number) => (now += ms) };
}

const boom = (msg: string, name = 'TypeError') => {
  const e = new Error(msg);
  e.name = name;
  e.stack = `${name}: ${msg}\n    at renderRow (https://www.valuedesk.so/assets/Portfolio-AbC123de.js?v=1:10:5)\n    at https://www.valuedesk.so/assets/index-ZZ99yy11.js:1:200`;
  return e;
};

test('a report: scrubbed type, message, frames, page, browser - no address, query or typed text', () => {
  const { r, sent, fire } = harness();
  r.add(capture('error', boom(`cannot load ${WALLET} from https://x.y/a?address=${WALLET} "a note the user typed in the box"`)));
  fire();
  assert.equal(sent.length, 1);
  const b = sent[0]!.body as { build: string; route: string; browser: string; errors: Array<Record<string, unknown>> };
  assert.equal(b.route, '/scan/:address');
  assert.equal(b.browser, 'chrome 130');
  assert.equal(b.build, 'dev');
  assert.deepEqual(b.errors[0]!.frames, ['renderRow /assets/Portfolio-AbC123de.js:10:5', '/assets/index-ZZ99yy11.js:1:200']);
  assert.equal(b.errors[0]!.name, 'TypeError');
  assert.equal(b.errors[0]!.count, 1);
  const text = JSON.stringify(b);
  for (const bad of [WALLET.slice(2), 'address=', 'x.y', 'user typed', 'valuedesk.so', 'Windows']) assert.ok(!text.includes(bad), `${bad} leaked`);
  assert.equal(sent[0]!.beacon, false);
});

test('the same error again raises the count; a boundary keeps its name; anything thrown is captured', () => {
  const { r, sent, fire } = harness();
  for (let i = 0; i < 5; i++) r.add(capture('error', boom('x is undefined')));
  r.add(capture('boundary', boom('panel broke'), { boundary: 'Portfolio' }));
  r.add(capture('rejection', 'plain string reason'));
  r.add(capture('rejection', { some: 'object' }));
  fire();
  const errors = (sent[0]!.body.errors as Array<{ kind: string; count: number; boundary?: string; message: string; name: string }>);
  assert.equal(errors.length, 4);
  assert.equal(errors[0]!.count, 5);
  assert.equal(errors[1]!.boundary, 'Portfolio');
  assert.equal(errors[2]!.message, 'plain string reason');
  assert.equal(errors[2]!.name, 'UnhandledRejection');
  assert.equal(errors[3]!.message, 'non-error object thrown');
});

test('noise is not reported: extensions, the browser\'s own, opaque cross-origin errors', () => {
  const { r, sent, fire } = harness();
  r.add(capture('error', null, { message: 'Script error.' }));
  r.add(capture('error', null, { message: 'ResizeObserver loop completed with undelivered notifications.' }));
  const ext = new Error('boom');
  ext.stack = 'Error: boom\n    at x (chrome-extension://abcdef/content.js:1:1)';
  r.add(capture('error', ext));
  fire();
  assert.equal(sent.length, 0);
});

test('a batch leaves FLUSH_MS after the first error, at most MAX_PER_BATCH entries; page hide sends by beacon', () => {
  const { r, sent, fire } = harness({ random: () => 0 });
  for (let i = 0; i < MAX_PER_BATCH + 3; i++) r.add(capture('error', boom(`distinct error ${'abcdefghijklmnop'[i]}`)));
  fire();
  assert.equal((sent[0]!.body.errors as unknown[]).length, MAX_PER_BATCH);
  r.add(capture('error', boom('one more')));
  r.flush(true);
  assert.equal(sent[1]!.beacon, true);
  assert.equal((sent[1]!.body.errors as unknown[]).length, 4, 'the three that did not fit, and the new one');
  r.flush(true);
  assert.equal(sent.length, 2, 'nothing queued, nothing sent');
});

test("a batch stays under the server's body limit", () => {
  const { r, sent } = harness({ random: () => 0 });
  for (let i = 0; i < 10; i++) {
    const e = boom(`big ${'abcdefghij'[i]}`);
    const frames = Array.from({ length: 10 }, (_, k) => `    at fn${k} (https://a.b/assets/${'p'.repeat(190)}${k}.js:1:1)`);
    e.stack = ['Error: big', ...frames].join('\n');
    r.add(capture('error', e));
  }
  r.flush(true);
  assert.ok(sent.length > 1);
  for (const s of sent) assert.ok(JSON.stringify(s.body).length <= 8 * 1024);
  assert.equal(sent.reduce((n, s) => n + (s.body.errors as unknown[]).length, 0), 10);
});

test('at most MAX_PER_SESSION entries a browser session, across pages', () => {
  const a = harness({ random: () => 0 });
  for (let i = 0; i < MAX_PER_SESSION + 10; i++) {
    a.r.add(capture('error', boom(`error number ${'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP'[i]}`)));
    if (i % 5 === 4) a.fire();
  }
  a.fire();
  const total = a.sent.reduce((n, s) => n + (s.body.errors as unknown[]).length, 0);
  assert.equal(total, MAX_PER_SESSION);
  // A new page in the same session (the same sessionStorage) has nothing left.
  const b = new ErrorReporter({ ...(a.r as unknown as { env: ReporterEnv }).env });
  b.add(capture('error', boom('after the cap')));
  b.flush(false);
  assert.equal(a.sent.length, Math.ceil(MAX_PER_SESSION / 5));
});

test('a noisy page: past NOISY_PER_MINUTE new errors a minute, only one in ten more is kept', () => {
  const kept = (random: () => number, spreadMs = 0) => {
    const h = harness({ random });
    for (let i = 0; i < 25; i++) {
      h.r.add(capture('error', boom(`e${i}`, `E${'abcdefghijklmnopqrstuvwxyz'[i]}`)));
      h.tick(spreadMs);
    }
    h.r.flush(true);
    return h.sent.reduce((k, s) => k + (s.body.errors as unknown[]).length, 0);
  };
  assert.equal(kept(() => 0.5), NOISY_PER_MINUTE, 'the sample drew "drop" for every one past the threshold');
  assert.equal(kept(() => 0.05), 25, 'the sample drew "keep" for every one');
  assert.equal(kept(() => 0.5, 10_000), 25, 'spread over minutes, nothing is noisy');
});
