/** The terms popup's one signature covers ValueDesk's own terms and the copy and bot terms (owner 2026-11-23). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COPY_TERMS_EXECUTOR, COPY_TERMS_VERSION, verifyCopyRequest, type AcceptTermsPayload } from '@copy-engine';
import { bytesToHex, generateTradingKey, hexToBytes, signTypedDataWithKey } from '@sodex-core';
import { SITE_TERMS_VERSION, _resetAcceptanceForTests, signedTerms } from '../legal/acceptance';
import { localTerms, signAllTerms } from './terms';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };

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
  return { provider, owner: key.address.toLowerCase(), count: () => signatures };
}

test('one signature accepts everything, approves no day key', async () => {
  _resetAcceptanceForTests();
  const real = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  try {
    const w = wallet();
    await signAllTerms({ provider: w.provider, owner: w.owner, country: 'DE' });
    assert.equal(w.count(), 1, 'one wallet prompt');
    const copy = localTerms(w.owner);
    const site = signedTerms(w.owner);
    assert.equal(copy?.termsVersion, COPY_TERMS_VERSION);
    assert.equal(site?.termsVersion, SITE_TERMS_VERSION);
    const v = verifyCopyRequest(copy!.request!, { executor: COPY_TERMS_EXECUTOR });
    assert.ok(v.ok, v.ok ? '' : v.error);
    const p = JSON.parse(copy!.request!.payload) as AcceptTermsPayload;
    assert.equal(p.dayKey, undefined, 'no day key is approved by accepting terms');
    assert.equal(p.siteTerms?.termsVersion, SITE_TERMS_VERSION);
    assert.equal(copy!.recorded, false, 'not recorded yet: sent again later');
  } finally {
    globalThis.fetch = real;
    _resetAcceptanceForTests();
  }
});

test('a refused signature accepts neither of the two', async () => {
  _resetAcceptanceForTests();
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'no', code: 'region' }), { status: 451, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    const w = wallet();
    await assert.rejects(signAllTerms({ provider: w.provider, owner: w.owner, country: 'DE' }));
    assert.equal(localTerms(w.owner), null);
    assert.equal(signedTerms(w.owner), null);
  } finally {
    globalThis.fetch = real;
    _resetAcceptanceForTests();
  }
});
