/**
 * The copy fee of the browser copier (browserCopier.ts browserCopyFee): the
 * ladder's step of a verified 14-day volume is not known in a browser, so it
 * is the top step - and the volume the signed fee terms only DISPLAY (not
 * signed, the server's own window) never lowers it.
 *
 * A fake terms server signs with a real Ed25519 key generated here, as in
 * trading/terms.test.ts, so the terms below are verified ones.
 *   npx tsx --test src/copy/browserCopier.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COPY_FEE_LADDER, COPY_FEE_MAX, COPY_FEE_WINDOW_DAYS, copyFeeFor } from '@copy-engine';
import { setTradingConfig } from '../trading/config';
import { TERMS_PATH, _resetTermsForTests, configureTerms, currentTerms, refreshTerms } from '../trading/terms';
import { browserCopyFee } from './browserCopier';

const subtle = globalThis.crypto.subtle;
const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as ArrayBuffer).toString('base64url');
const SODEX = 286623;
const BID = 234812;
const WALLET = '0x' + 'ab'.repeat(20);

test('the browser copier charges the copy ladder\'s top step: no verified 14-day volume reaches a browser', () => {
  assert.equal(browserCopyFee(), COPY_FEE_MAX);
  assert.equal(browserCopyFee(), COPY_FEE_LADDER[0]!.fee);
  assert.equal(browserCopyFee(), 25);
});

test('a volume the verified fee terms display - even over 14 days, past the last step - does not lower it', async () => {
  const pair = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const keyId = Buffer.from(await subtle.digest('SHA-256', raw)).toString('hex').slice(0, 8);
  const serve = async (url: string): Promise<Response> => {
    const u = new URL(url);
    const f = { chain: SODEX, builderId: BID, address: u.searchParams.get('address') ?? '', perps: 20, spot: 20, nonce: u.searchParams.get('nonce') ?? '', issued: 1_790_000_000_000, ttl: 600_000 };
    const msg = `valuescan-builder-terms/1\nchain:${f.chain}\nbuilder:${f.builderId}\naddress:${f.address.toLowerCase()}\nperps:${f.perps}\nspot:${f.spot}\nnonce:${f.nonce}\nissued:${f.issued}\nttl:${f.ttl}`;
    const sig = b64url(await subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(msg)));
    const body = {
      ok: true, chain: f.chain, builderId: f.builderId, address: f.address, fee: { perps: f.perps, spot: f.spot }, nonce: f.nonce, issued: f.issued, ttl: f.ttl, keyId, sig,
      default: { perps: 20, spot: 20 },
      // Unsigned display data: $50M over exactly the ladder's 14 days.
      volume: { perpsUsd: 50_000_000, spotUsd: 0, totalUsd: 50_000_000, days: COPY_FEE_WINDOW_DAYS, verifiedAt: 1_790_000_000_000, pending: false },
      tier: { index: 0, next: null },
      flags: [],
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  _resetTermsForTests();
  setTradingConfig({ network: 'mainnet', chainId: SODEX, gateway: 'https://gw.test', writesAllowed: true, disabled: false, keyTtlMs: 7 * 86_400_000, builder: { id: BID, fee: { perps: 20, spot: 20 }, maxFeeRate: 25, required: true } });
  configureTerms({ keys: [b64url(raw)], endpoint: 'https://vs.test' + TERMS_PATH, fetch: serve, monotonicNow: () => 5_000, wallNow: () => 1_790_000_000_000 });
  try {
    assert.ok(await refreshTerms(WALLET), 'the terms verify');
    const shown = currentTerms(WALLET)?.display;
    assert.deepEqual([shown?.volumeUsd, shown?.volumeDays], [50_000_000, COPY_FEE_WINDOW_DAYS]);
    assert.equal(copyFeeFor(shown!.volumeUsd), 10, 'read as a fee, that number would be the last step');
    assert.equal(browserCopyFee(), COPY_FEE_MAX, 'display data decides no fee');
  } finally {
    _resetTermsForTests();
  }
});
