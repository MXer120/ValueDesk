/**
 * The bots sign-in of 2026-11-28 (wallet 0xF80D…FaBD, Tanzania): 26 sign-ins in a row refused, 2-10 s apart, all signed
 * by the same day key of the browser - a phone whose clock is behind keeps a day key "fresh" that the executor has long
 * found expired, and signs every request hours in the past. Replayed against a stand-in executor that checks with the
 * real verifyCopyRequest on ITS clock: the sign-in goes through on the first try, and a refused day key is replaced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyCopyRequest } from '@copy-engine';
import { bytesToHex, generateTradingKey, hexToBytes, signTypedDataWithKey } from '@sodex-core';
import { COPY_TERMS_EXECUTOR } from '@copy-engine';
import { ExecutorClient, _resetServerClockForTests, forgetDayKeys, signTermsWithDayKey } from './executor';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
// IndexedDB that cannot open (as in a private window): the day key lives in memory only, which is all the test needs.
(globalThis as { indexedDB?: unknown }).indexedDB = { open() { const r: { onerror?: () => void } = {}; setTimeout(() => r.onerror?.()); return r; } };

function wallet() {
  const key = generateTradingKey();
  let signatures = 0;
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      if (method === 'eth_chainId') return '0xa4b1';
      if (method === 'eth_accounts') return [key.address];
      if (method === 'eth_signTypedData_v4') {
        signatures += 1;
        const raw = hexToBytes(signTypedDataWithKey(JSON.parse((params as [string, string])[1]), key.privateKey)).slice(1);
        raw[64] = raw[64]! + 27;
        return bytesToHex(raw);
      }
      throw new Error(`unexpected wallet call ${method}`);
    },
  };
  return { provider, owner: key.address.toLowerCase(), prompts: () => signatures };
}

/** A stand-in executor on a clock `skewMs` ahead of this device, refusing the first `refuseDayKeys` day-key sign-ins. */
function executor(id: string, skewMs: number, refuseDayKeys = 0) {
  const seen: string[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', date: new Date(Date.now() + skewMs).toUTCString() } });
  const fetch: typeof globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://site.test').pathname.replace('/api/copy/v1', '');
    if (path === '/info') return json(200, { executorId: id, kind: 'hosted', features: ['day-key'], network: 'mainnet' });
    if (path === '/session') {
      const req = (JSON.parse(String(init?.body)) as { request: { delegation?: unknown } }).request;
      const v = verifyCopyRequest(req, { executor: id, now: Date.now() + skewMs });
      if (!v.ok) { seen.push(`refused: ${v.error}`); return json(401, { ok: false, code: 'signature', error: v.error }); }
      if (req.delegation && refuseDayKeys > 0) { refuseDayKeys -= 1; seen.push('refused: day key'); return json(401, { ok: false, code: 'signature', error: "the day key's approval does not hold: expired" }); }
      seen.push(req.delegation ? 'ok: day key' : 'ok: wallet');
      return json(200, { token: `t-${seen.length}`, expiresAt: Date.now() + skewMs + 3_600_000 });
    }
    return json(404, { ok: false, code: 'path', error: 'not found' });
  }) as typeof fetch;
  return { fetch, seen };
}

async function signIn(skewMs: number, refuseDayKeys: number) {
  const id = `ex-${Math.random().toString(36).slice(2)}`;
  const ex = executor(id, skewMs, refuseDayKeys);
  const real = globalThis.fetch;
  globalThis.fetch = ex.fetch;
  const w = wallet();
  try {
    _resetServerClockForTests();
    const client = new ExecutorClient('http://executor.test/api/copy/v1', 'hosted');
    const info = await client.info();
    const token = await client.session(w.provider, w.owner, info.executorId);
    return { token, seen: ex.seen, prompts: w.prompts() };
  } finally {
    globalThis.fetch = real;
    await forgetDayKeys(w.owner);
  }
}

test('a phone 3 hours behind signs in on the first try (its requests carry the executor\'s time)', async () => {
  const r = await signIn(3 * 3_600_000, 0);
  assert.ok(r.token, 'signed in');
  assert.deepEqual(r.seen, ['ok: day key']);
  assert.equal(r.prompts, 1, 'one wallet prompt: the day key\'s approval');
});

test('a phone 3 hours ahead too', async () => {
  const r = await signIn(-3 * 3_600_000, 0);
  assert.deepEqual(r.seen, ['ok: day key']);
});

test('a day key the executor refuses is dropped: the sign-in goes through with a new one, never the refused one again', async () => {
  const r = await signIn(0, 1);
  assert.ok(r.token, 'signed in');
  assert.deepEqual(r.seen, ['refused: day key', 'ok: day key']);
  assert.equal(r.prompts, 2, 'the wallet approves the new day key');
});

test("the terms step signed first thing on a page, on a phone 3 hours behind: the terms carry the executor's time (the second screenshot, 2026-11-28)", async () => {
  _resetServerClockForTests();
  const skew = 3 * 3_600_000;
  const ex = executor('ex-terms', skew);
  const real = globalThis.fetch;
  globalThis.fetch = ex.fetch;
  const w = wallet();
  try {
    const req = await signTermsWithDayKey(w.provider, w.owner, COPY_TERMS_EXECUTOR, { termsVersion: 'x' }, null);
    const v = verifyCopyRequest(req, { executor: COPY_TERMS_EXECUTOR, now: Date.now() + skew });
    assert.ok(v.ok, v.ok ? '' : v.error);
  } finally {
    globalThis.fetch = real;
    _resetServerClockForTests();
  }
});
