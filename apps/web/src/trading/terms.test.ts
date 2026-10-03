/**
 * The signed fee terms (docs/BUILDER-TIERS.md sections 2 and 3): the only thing
 * that can lower a wallet's builder fee - and every way of faking, replaying,
 * rewriting, blocking or outliving them ends in the DEFAULT fee.
 *
 * A fake terms server signs with a real Ed25519 key generated here (WebCrypto,
 * the same API the browser uses); the message it signs is written out in this
 * file, line by line, independently of the module under test.
 *   npx tsx --test src/trading/terms.test.ts
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setTradingConfig, type BuilderConfig } from './config';
import {
  TERMS_PATH,
  TERMS_REFRESH_MS,
  TERMS_TTL_CAP_MS,
  _resetTermsForTests,
  configureTerms,
  currentTerms,
  ensureTerms,
  feeNow,
  followTerms,
  hintTerms,
  readTermsAnswer,
  refreshTerms,
  subscribeTerms,
  termsKeyId,
  termsMessage,
  termsPossible,
  termsRevision,
  termsView,
} from './terms';

const subtle = globalThis.crypto.subtle;
const enc = (s: string) => new TextEncoder().encode(s);
const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as ArrayBuffer).toString('base64url');

interface Key {
  pair: CryptoKeyPair;
  /** base64url of the raw 32-byte public key - what a build pins. */
  pub: string;
  id: string;
}
async function newKey(): Promise<Key> {
  const pair = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const id = Buffer.from(await subtle.digest('SHA-256', raw)).toString('hex').slice(0, 8);
  return { pair, pub: b64url(raw), id };
}

const KEY = await newKey();
const OTHER_KEY = await newKey();

const SODEX = 286623;
const BID = 123456;
const WALLET = '0x' + 'ab'.repeat(20);
const WALLET_2 = '0x' + 'cd'.repeat(20);
const API = 'https://vs.test' + TERMS_PATH;
/** The test values of the contract: 2 bp by default on both engines, maximum 20. */
const B: BuilderConfig = { id: BID, fee: { perps: 20, spot: 20 }, maxFeeRate: 20, required: true };

// --- a terms server -----------------------------------------------------------------

interface Signed {
  chain: unknown;
  builderId: unknown;
  address: unknown;
  perps: unknown;
  spot: unknown;
  nonce: unknown;
  issued: unknown;
  ttl: unknown;
}

const server = {
  fee: { perps: 15 as unknown, spot: 20 as unknown },
  ttl: 600_000 as unknown,
  issued: 1_790_000_000_000 as unknown,
  key: KEY,
  /** What the server SIGNS instead of the request's own values (a statement about something else). */
  signs: {} as Partial<Signed>,
  /** Rewrites the finished answer (somebody between the server and the app). */
  rewrite: null as null | ((body: any) => any),
  status: 200,
  /** The request never gets an answer. */
  down: false,
  /** The answer never arrives until this is called. */
  hold: null as null | Promise<void>,
  volume: { perpsUsd: 12.4, spotUsd: 0, totalUsd: 12.4, verifiedAt: 1_790_000_000_000, pending: false } as unknown,
  tier: { index: 1, next: null } as unknown,
  requests: [] as Array<{ url: string; address: string; nonce: string; hint: boolean; init: RequestInit | undefined }>,
};

/** Exactly the bytes the contract says are signed - written out here, not taken from the module. */
const signedBytes = (s: Signed) =>
  `valuescan-builder-terms/1\nchain:${s.chain}\nbuilder:${s.builderId}\naddress:${String(s.address).toLowerCase()}\nperps:${s.perps}\nspot:${s.spot}\nnonce:${s.nonce}\nissued:${s.issued}\nttl:${s.ttl}`;

async function serve(url: string, init?: RequestInit): Promise<Response> {
  const u = new URL(url);
  const address = u.searchParams.get('address') ?? '';
  const nonce = u.searchParams.get('nonce') ?? '';
  server.requests.push({ url, address, nonce, hint: u.searchParams.get('hint') === '1', init });
  if (server.down) throw new TypeError('fetch failed');
  if (server.hold) await server.hold;
  const s: Signed = { chain: SODEX, builderId: BID, address, perps: server.fee.perps, spot: server.fee.spot, nonce, issued: server.issued, ttl: server.ttl, ...server.signs };
  const sig = b64url(await subtle.sign({ name: 'Ed25519' }, server.key.pair.privateKey, enc(signedBytes(s))));
  let body: any = {
    ok: true,
    chain: s.chain,
    builderId: s.builderId,
    address: s.address,
    fee: { perps: s.perps, spot: s.spot },
    nonce: s.nonce,
    issued: s.issued,
    ttl: s.ttl,
    keyId: server.key.id,
    sig,
    default: { perps: 20, spot: 20 },
    volume: server.volume,
    tier: server.tier,
    flags: [],
  };
  if (server.rewrite) body = server.rewrite(body) ?? body;
  return new Response(JSON.stringify(body), { status: server.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

const clock = { mono: 5_000, wall: 1_790_000_000_000 };

function configure(builder: BuilderConfig | null = B, keys: readonly string[] = [KEY.pub]): void {
  setTradingConfig({ network: 'mainnet', chainId: SODEX, gateway: 'https://gw.test', writesAllowed: true, disabled: false, keyTtlMs: 7 * 86_400_000, builder });
  configureTerms({ keys, endpoint: API, fetch: serve, monotonicNow: () => clock.mono, wallNow: () => clock.wall });
}

beforeEach(() => {
  mock.timers.reset();
  server.fee = { perps: 15, spot: 20 };
  server.ttl = 600_000;
  server.issued = 1_790_000_000_000;
  server.key = KEY;
  server.signs = {};
  server.rewrite = null;
  server.status = 200;
  server.down = false;
  server.hold = null;
  server.volume = { perpsUsd: 12.4, spotUsd: 0, totalUsd: 12.4, verifiedAt: 1_790_000_000_000, pending: false };
  server.tier = { index: 1, next: null };
  server.requests = [];
  clock.mono = 5_000;
  clock.wall = 1_790_000_000_000;
  _resetTermsForTests();
  configure();
});

/** Refresh, expect NO terms, and the default fee on both engines. */
async function refused(why: string): Promise<void> {
  assert.equal(await refreshTerms(WALLET), null, why);
  assert.equal(currentTerms(WALLET), null, why);
  assert.equal(feeNow('perps', WALLET), 20, `${why}: perps pays the default`);
  assert.equal(feeNow('spot', WALLET), 20, `${why}: spot pays the default`);
}

// --- the message ------------------------------------------------------------------------

test('the signed message is byte for byte the contract\'s: nine lines, "\\n" between them, none after the last', () => {
  const msg = termsMessage({ chain: 286623, builderId: 123456, address: '0xABCDEF0123456789abcdef0123456789ABCDEF01', perps: 15, spot: 20, nonce: 'n0nce_-AZaz09xxxx', issued: 1790000000000, ttl: 600000 });
  assert.equal(
    msg,
    'valuescan-builder-terms/1\nchain:286623\nbuilder:123456\naddress:0xabcdef0123456789abcdef0123456789abcdef01\nperps:15\nspot:20\nnonce:n0nce_-AZaz09xxxx\nissued:1790000000000\nttl:600000',
  );
  assert.equal(msg.split('\n').length, 9);
  assert.ok(!msg.endsWith('\n'));
});

test('keyId is the first 8 hex characters of SHA-256 of the raw public key', async () => {
  assert.equal(await termsKeyId(KEY.pub), KEY.id);
  assert.match(KEY.id, /^[0-9a-f]{8}$/);
  assert.equal(await termsKeyId('not-a-key'), null);
});

// --- the happy path ------------------------------------------------------------------------

test('verified terms lower the fee: feeNow is the signed fee, per engine, for that wallet only', async () => {
  assert.equal(feeNow('perps', WALLET), 20, 'before any terms: the default');
  const seen: number[] = [];
  const stop = subscribeTerms(() => seen.push(termsRevision()));
  const t = await refreshTerms(WALLET);
  stop();
  assert.ok(t, 'the terms verify');
  assert.deepEqual(t!.fee, { perps: 15, spot: 20 });
  assert.equal(t!.address, WALLET);
  assert.equal(t!.builderId, BID);
  assert.equal(t!.chain, SODEX);
  assert.equal(t!.keyId, KEY.id);
  assert.equal(t!.validForMs, 600_000);
  assert.equal(feeNow('perps', WALLET), 15, 'the lower tier');
  assert.equal(feeNow('spot', WALLET), 20, 'spot stays at the default');
  assert.equal(feeNow('perps', WALLET.toUpperCase().replace('0X', '0x')), 15, 'the address is compared lower-case');
  assert.equal(feeNow('perps', WALLET_2), 20, 'another wallet pays the default');
  assert.equal(feeNow('perps', null), 20);
  assert.ok(seen.length >= 1, 'listeners are told the fee may have changed');
  assert.deepEqual(termsView(WALLET), { fee: { perps: 15, spot: 20 }, default: { perps: 20, spot: 20 }, next: null, volumeUsd: 12.4, volumeDays: null });
  assert.equal(termsView(WALLET_2), null);
});

test('the request: our own API, the wallet, a fresh random nonce each time, hint=1 only when asked, never cached', async () => {
  await refreshTerms(WALLET);
  await refreshTerms(WALLET, { hint: true });
  await refreshTerms(WALLET);
  assert.equal(server.requests.length, 3);
  for (const r of server.requests) {
    assert.ok(r.url.startsWith(`${API}?address=${WALLET}&nonce=`), r.url);
    assert.match(r.nonce, /^[A-Za-z0-9_-]{16,64}$/, 'the nonce the endpoint accepts');
    assert.equal((r.init?.method ?? 'GET').toUpperCase(), 'GET');
    assert.equal(r.init?.cache, 'no-store');
    assert.equal(r.init?.body, undefined, 'a read: nothing is sent but the query');
  }
  assert.deepEqual(server.requests.map((r) => r.hint), [false, true, false]);
  assert.equal(new Set(server.requests.map((r) => r.nonce)).size, 3, 'a nonce is never reused');
  assert.ok(!server.requests.some((r) => /sodex/i.test(new URL(r.url).host)), 'the request never goes to SoDEX');
});

test('identical requests in flight share one; a wallet in another letter case is the same wallet', async () => {
  const [a, b] = await Promise.all([refreshTerms(WALLET), refreshTerms(WALLET.replace('ab', 'AB'))]);
  assert.equal(server.requests.length, 1);
  assert.deepEqual(a, b);
});

// --- G5: no terms, no discount ------------------------------------------------------------------

test('a rewritten answer is worth nothing: change the fee, and the signature no longer verifies', async () => {
  // The server signed 15 / 20. Somebody rewrites the answer to a fee they would like better.
  server.rewrite = (b) => ({ ...b, fee: { perps: 1, spot: 1 } });
  await refused('fee rewritten to 1 / 1');
  server.rewrite = (b) => ({ ...b, fee: { perps: 14, spot: 20 } });
  await refused('fee rewritten to 14');
  server.rewrite = (b) => ({ ...b, fee: { perps: 0, spot: 0 } });
  await refused('fee rewritten to 0');
  // A longer life, a later issue time: both are signed too.
  server.rewrite = (b) => ({ ...b, ttl: 900_000 });
  await refused('ttl rewritten');
  server.rewrite = (b) => ({ ...b, issued: b.issued + 1 });
  await refused('issued rewritten');
  // The real fee was the default (20): rewriting the body down to 15 does not make it 15.
  server.fee = { perps: 20, spot: 20 };
  server.rewrite = (b) => ({ ...b, fee: { perps: 15, spot: 20 } });
  await refused('default terms rewritten to the lower tier');
  // Untouched, the same answer verifies - the checks above failed for the right reason.
  server.rewrite = null;
  assert.deepEqual((await refreshTerms(WALLET))?.fee, { perps: 20, spot: 20 });
});

test('a replayed answer is worth nothing: terms signed for another request (another nonce) are refused', async () => {
  // A genuine, correctly signed statement - but for a nonce this request did not send.
  server.signs = { nonce: 'an-older-request-nonce-0001' };
  await refused('the answer echoes the nonce it was signed for');
  // ...and when the replay also rewrites the nonce field to the one just sent, the signature gives it away.
  server.rewrite = (b) => ({ ...b, nonce: server.requests.at(-1)!.nonce });
  await refused('the nonce field rewritten to the one sent');
});

test('terms for another wallet, another builder or another chain are refused - as stated, and as rewritten', async () => {
  for (const [what, signs, field] of [
    ['another wallet', { address: WALLET_2 }, { address: WALLET }],
    ['another builder', { builderId: 999 }, { builderId: BID }],
    ['another chain', { chain: 138565 }, { chain: SODEX }],
  ] as const) {
    server.signs = signs;
    server.rewrite = null;
    await refused(`${what}, stated honestly`);
    // The same statement with the telling field rewritten to what the app expects: now the signature does not match.
    server.rewrite = (b) => ({ ...b, ...field });
    await refused(`${what}, with the field rewritten`);
  }
});

test('an unknown key signs nothing: terms signed by a key that is not pinned are refused, whatever keyId they claim', async () => {
  server.key = OTHER_KEY;
  await refused('signed by a key this build does not pin');
  server.rewrite = (b) => ({ ...b, keyId: KEY.id });
  await refused('...claiming the pinned key\'s id');
  // Pinned keys can be rotated: with both pinned, either verifies - and a wrong keyId does not stop a pinned key.
  configure(B, [KEY.pub, OTHER_KEY.pub]);
  server.rewrite = null;
  assert.equal((await refreshTerms(WALLET))?.keyId, OTHER_KEY.id);
  server.key = KEY;
  server.rewrite = (b) => ({ ...b, keyId: 'ffffffff' });
  assert.equal((await refreshTerms(WALLET))?.keyId, KEY.id);
});

test('an unsigned or unusable answer: the default fee', async () => {
  server.rewrite = (b) => ({ ...b, sig: null });
  await refused('sig null: the server has no terms key');
  server.rewrite = (b) => {
    const { sig: _sig, ...rest } = b;
    return rest;
  };
  await refused('no sig at all');
  server.rewrite = (b) => ({ ...b, sig: 'AAAA' });
  await refused('a signature of the wrong length');
  server.rewrite = (b) => ({ ...b, sig: `${b.sig.slice(0, -4)}AAAA` });
  await refused('a signature with its last bytes changed');
  server.rewrite = (b) => ({ ...b, sig: 'not base64url !!' });
  await refused('a signature that is not base64url');
  server.rewrite = () => ({ ok: true, builderId: null });
  await refused('fee tiers are off on the server');
  server.rewrite = (b) => ({ ...b, ok: false });
  await refused('ok: false');
  server.rewrite = () => ({ ok: false, error: 'rate limited' });
  await refused('an error answer');
  server.rewrite = () => [];
  await refused('not an object');
  server.rewrite = null;
  server.status = 500;
  await refused('HTTP 500');
  server.status = 200;
  server.down = true;
  await refused('the request is blocked');
});

test('a correctly signed fee the build cannot charge is refused: above the default, not whole, negative', async () => {
  // Signed by the pinned key - and still not usable: the app only ever goes DOWN from its own default.
  for (const fee of [{ perps: 21, spot: 20 }, { perps: 15, spot: 21 }, { perps: 200, spot: 2000 }, { perps: 15.5, spot: 20 }, { perps: -1, spot: 20 }, { perps: '15', spot: 20 }, { perps: null, spot: 20 }]) {
    server.fee = fee as { perps: unknown; spot: unknown };
    await refused(`fee ${JSON.stringify(fee)}`);
  }
  for (const ttl of [0, -5, 1.5, '600000', null]) {
    server.fee = { perps: 15, spot: 20 };
    server.ttl = ttl;
    await refused(`ttl ${JSON.stringify(ttl)}`);
  }
  server.ttl = 600_000;
  server.issued = 'now';
  await refused('issued is not a number');
});

test('readTermsAnswer names what is wrong, and accepts exactly what the app is about to use', () => {
  const x = { chain: SODEX, builderId: BID, address: WALLET, nonce: 'n'.repeat(22), defaults: { perps: 20, spot: 20 } };
  const sig = b64url(new Uint8Array(64));
  const good = { ok: true, chain: SODEX, builderId: BID, address: WALLET.toUpperCase().replace('0X', '0x'), fee: { perps: 15, spot: 20 }, nonce: x.nonce, issued: 1, ttl: 60_000, keyId: 'abcd1234', sig };
  const r = readTermsAnswer(good, x);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.fee, { perps: 15, spot: 20 });
    assert.equal(r.sig.length, 64);
    assert.deepEqual(r.display, { volumeUsd: null, volumeDays: null, pending: false, tierIndex: null, next: null, flags: [] });
  }
  const why = (patch: Record<string, unknown>) => {
    const got = readTermsAnswer({ ...good, ...patch }, x);
    return got.ok ? 'accepted' : got.why;
  };
  assert.match(why({ builderId: 1 }), /builder 1, not the pinned builder 123456/);
  assert.match(why({ chain: 1 }), /chain 1, not 286623/);
  assert.match(why({ address: WALLET_2 }), /another wallet/);
  assert.match(why({ nonce: 'x'.repeat(22) }), /another request/);
  assert.match(why({ fee: { perps: 21, spot: 20 } }), /not a whole number from 0 to this build's default \(20 \/ 20\)/);
  assert.match(why({ sig: null }), /not signed/);
  assert.match(why({ builderId: null }), /off on the server/);
  // Fees of 0 are terms like any other (an account whose fee was set to nothing by hand).
  assert.equal(readTermsAnswer({ ...good, fee: { perps: 0, spot: 0 } }, x).ok, true);
});

// --- how long they hold ---------------------------------------------------------------------------

test('terms run out: counted on the monotonic clock from when the answer arrived; afterwards the default', async () => {
  let ran = 0;
  await refreshTerms(WALLET);
  const stop = subscribeTerms(() => (ran += 1));
  assert.equal(feeNow('perps', WALLET), 15);
  clock.mono += 599_999;
  assert.equal(feeNow('perps', WALLET), 15, 'one millisecond before the end');
  clock.mono += 1;
  assert.equal(feeNow('perps', WALLET), 20, 'at the ttl: the default again');
  assert.equal(currentTerms(WALLET), null);
  assert.equal(termsView(WALLET), null);
  stop();
  assert.equal(ran, 0, 'reading the fee never notifies (it is safe to call while rendering)');
});

test('the ttl is capped at 15 minutes, whatever the server signs', async () => {
  server.ttl = 24 * 3_600_000;
  const t = await refreshTerms(WALLET);
  assert.equal(t!.ttl, 24 * 3_600_000, 'the signed value is kept as signed');
  assert.equal(t!.validForMs, TERMS_TTL_CAP_MS);
  clock.mono += TERMS_TTL_CAP_MS - 1;
  assert.equal(feeNow('perps', WALLET), 15);
  clock.mono += 1;
  assert.equal(feeNow('perps', WALLET), 20);
});

test('the system clock cannot extend terms: set back by a year, they still end on the monotonic clock', async () => {
  await refreshTerms(WALLET);
  clock.wall -= 365 * 86_400_000;
  clock.mono += 599_000;
  assert.equal(feeNow('perps', WALLET), 15);
  clock.mono += 1_000;
  assert.equal(feeNow('perps', WALLET), 20, 'the wall clock says no time has passed; the terms are over all the same');
});

test('...and it can only end them early: a machine that slept (monotonic clock stood still) wakes to the default fee', async () => {
  await refreshTerms(WALLET);
  // The monotonic clock of some browsers stops while the machine sleeps; the wall clock does not.
  clock.wall += 8 * 3_600_000;
  assert.equal(feeNow('perps', WALLET), 20);
  assert.equal(currentTerms(WALLET), null);
});

test('the ttl counts from the moment the answer ARRIVED, not from when the server says it was issued', async () => {
  // An answer whose `issued` is years off (in either direction) holds exactly as long as any other.
  server.issued = 1;
  await refreshTerms(WALLET);
  assert.equal(feeNow('perps', WALLET), 15);
  clock.mono += 600_000;
  assert.equal(feeNow('perps', WALLET), 20);
  server.issued = 9_999_999_999_999;
  await refreshTerms(WALLET);
  clock.mono += 599_999;
  assert.equal(feeNow('perps', WALLET), 15);
  clock.mono += 1;
  assert.equal(feeNow('perps', WALLET), 20);
});

test('blocking the terms request cannot keep a fee: held terms run out on schedule, and nothing replaces them', async () => {
  await refreshTerms(WALLET);
  server.down = true;
  clock.mono += 300_000;
  assert.equal(await refreshTerms(WALLET), null, 'no answer');
  assert.equal(feeNow('perps', WALLET), 15, 'the terms already verified still hold for the rest of their time');
  clock.mono += 300_000;
  assert.equal(feeNow('perps', WALLET), 20, 'and not a millisecond longer');
  assert.equal(await refreshTerms(WALLET), null);
  assert.equal(feeNow('perps', WALLET), 20);
});

test('the newest verified answer wins - also when it is HIGHER (the wallet is back on the default)', async () => {
  await refreshTerms(WALLET);
  assert.equal(feeNow('perps', WALLET), 15);
  server.fee = { perps: 20, spot: 20 };
  await refreshTerms(WALLET);
  assert.equal(feeNow('perps', WALLET), 20);
  server.fee = { perps: 10, spot: 5 };
  await refreshTerms(WALLET);
  assert.equal(feeNow('perps', WALLET), 10);
  assert.equal(feeNow('spot', WALLET), 5);
});

// --- G3: nothing else feeds the fee ----------------------------------------------------------------

test('nothing local feeds the fee: storage and the address bar are never read, not even to look', async () => {
  const touched: string[] = [];
  const trap = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, p) => {
          touched.push(`${name}.${String(p)}`);
          return () => '{"perps":0,"spot":0}';
        },
        has: () => true,
      },
    );
  const g = globalThis as Record<string, unknown>;
  const before = { localStorage: Object.getOwnPropertyDescriptor(g, 'localStorage'), sessionStorage: Object.getOwnPropertyDescriptor(g, 'sessionStorage'), location: Object.getOwnPropertyDescriptor(g, 'location') };
  Object.defineProperty(g, 'localStorage', { value: trap('localStorage'), configurable: true, writable: true });
  Object.defineProperty(g, 'sessionStorage', { value: trap('sessionStorage'), configurable: true, writable: true });
  Object.defineProperty(g, 'location', { value: trap('location'), configurable: true, writable: true });
  try {
    assert.equal(feeNow('perps', WALLET), 20);
    await refreshTerms(WALLET, { hint: true });
    assert.equal(feeNow('perps', WALLET), 15);
    clock.mono += 600_000;
    assert.equal(feeNow('perps', WALLET), 20, 'and nothing was kept anywhere to come back from');
    assert.deepEqual(touched, [], 'the terms module reads neither storage nor the URL');
  } finally {
    for (const [k, d] of Object.entries(before)) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  }
});

test('the unsigned part of an answer decides nothing: a rewritten "default", "volume", "tier" or "flags" changes no fee', async () => {
  server.rewrite = (b) => ({ ...b, default: { perps: 1, spot: 1 }, volume: { totalUsd: 1e12, pending: false }, tier: { index: 99, next: { atUsd: 0, fee: { perps: 0, spot: 0 } } }, flags: ['override'] });
  const t = await refreshTerms(WALLET);
  assert.ok(t, 'the signed part is intact, so the terms verify');
  assert.equal(feeNow('perps', WALLET), 15, 'the signed fee');
  assert.equal(feeNow('spot', WALLET), 20);
  assert.equal(termsView(WALLET)!.default.perps, 20, 'the default shown is the build\'s, not the answer\'s');
  // What IS shown from it is sanitised: the next tier only when it is a whole fee below the current one.
  assert.deepEqual(termsView(WALLET)!.next, { atUsd: 0, fee: { perps: 0, spot: 0 } });
  server.rewrite = (b) => ({ ...b, tier: { index: 0, next: { atUsd: 10, fee: { perps: 25, spot: 20 } } } });
  await refreshTerms(WALLET);
  assert.equal(termsView(WALLET)!.next, null, 'a "next tier" that is no lower is not shown');
  server.rewrite = (b) => ({ ...b, tier: { index: 0, next: { atUsd: -3, fee: { perps: 10, spot: 20 } } }, volume: { totalUsd: 'lots' } });
  await refreshTerms(WALLET);
  assert.equal(termsView(WALLET)!.next, null);
  assert.equal(termsView(WALLET)!.volumeUsd, null);
});

test('the next tier, when the terms name one', async () => {
  server.fee = { perps: 20, spot: 20 };
  server.volume = { perpsUsd: 4.2, spotUsd: 0, totalUsd: 4.2, verifiedAt: 1, pending: false };
  server.tier = { index: 0, next: { atUsd: 10, fee: { perps: 15, spot: 20 } } };
  await refreshTerms(WALLET);
  assert.deepEqual(termsView(WALLET), { fee: { perps: 20, spot: 20 }, default: { perps: 20, spot: 20 }, next: { atUsd: 10, fee: { perps: 15, spot: 20 } }, volumeUsd: 4.2, volumeDays: null });
});

test('the window the volume covers (volumeDays on the server), when the answer names one - shown, never deciding', async () => {
  server.fee = { perps: 15, spot: 15 };
  server.volume = { perpsUsd: 400_000, spotUsd: 0, totalUsd: 400_000, days: 14, verifiedAt: 1, pending: false };
  server.tier = { index: 0, next: { atUsd: 1_000_000, fee: { perps: 12, spot: 12 } } };
  await refreshTerms(WALLET);
  assert.equal(termsView(WALLET)!.volumeDays, 14);
  assert.equal(termsView(WALLET)!.volumeUsd, 400_000);
  // Anything but a whole number of days is not shown.
  server.volume = { ...(server.volume as object), days: 'fourteen' };
  await refreshTerms(WALLET);
  assert.equal(termsView(WALLET)!.volumeDays, null);
});

// --- what needs no terms at all ----------------------------------------------------------------------

test('a build without pinned keys asks for nothing and pays the default', async () => {
  configure(B, []);
  assert.equal(termsPossible(), false);
  assert.equal(await refreshTerms(WALLET, { hint: true }), null);
  await ensureTerms(WALLET);
  followTerms(WALLET);
  hintTerms(WALLET);
  assert.equal(server.requests.length, 0, 'no request is ever sent');
  assert.equal(feeNow('perps', WALLET), 20);
  // The build's own setting is what counts when nothing was configured by hand: none pinned there either.
  _resetTermsForTests();
  assert.equal(termsPossible(), false);
  assert.equal(await refreshTerms(WALLET), null);
  assert.equal(server.requests.length, 0);
});

test('a browser without Ed25519 in WebCrypto pays the default - and does not even ask', async () => {
  const real = subtle.importKey.bind(subtle);
  (subtle as { importKey: unknown }).importKey = async (...a: Parameters<SubtleCrypto['importKey']>) => {
    const alg = a[2] as { name?: string } | string;
    if ((typeof alg === 'string' ? alg : alg.name) === 'Ed25519') throw new DOMException('Unrecognized name.', 'NotSupportedError');
    return real(...a);
  };
  try {
    configure();
    assert.equal(await refreshTerms(WALLET), null);
    assert.equal(server.requests.length, 0);
    assert.equal(feeNow('perps', WALLET), 20);
  } finally {
    (subtle as { importKey: unknown }).importKey = real;
  }
  // With the algorithm back (and the keys imported afresh) the same build verifies terms.
  configure();
  assert.equal((await refreshTerms(WALLET))?.fee.perps, 15);
});

test('no builder, or an engine the build does not charge on: no fee, and terms do not create one', async () => {
  configure(null);
  assert.equal(feeNow('perps', WALLET), 0);
  assert.equal(await refreshTerms(WALLET), null);
  assert.equal(server.requests.length, 0);
  // Perps only: spot carries no builder, and terms that name a spot fee the build cannot charge are refused.
  configure({ ...B, fee: { perps: 20, spot: 0 } });
  assert.equal(feeNow('spot', WALLET), 0);
  server.fee = { perps: 15, spot: 20 };
  assert.equal(await refreshTerms(WALLET), null, 'spot 20 is above this build\'s spot default of 0');
  assert.equal(feeNow('perps', WALLET), 20);
  server.fee = { perps: 15, spot: 0 };
  assert.equal((await refreshTerms(WALLET))?.fee.perps, 15);
  assert.equal(feeNow('perps', WALLET), 15);
  assert.equal(feeNow('spot', WALLET), 0);
});

test('terms are judged against the build AS IT IS NOW: another builder, another chain or a lower default, and they no longer count', async () => {
  await refreshTerms(WALLET);
  assert.equal(feeNow('perps', WALLET), 15);
  setTradingConfig({ builder: { ...B, id: 777 } });
  assert.equal(feeNow('perps', WALLET), 20, 'terms for builder 123456 say nothing about builder 777');
  setTradingConfig({ builder: B, chainId: 138565 });
  assert.equal(feeNow('perps', WALLET), 20, 'another chain');
  setTradingConfig({ chainId: SODEX, builder: { ...B, fee: { perps: 10, spot: 20 } } });
  assert.equal(feeNow('perps', WALLET), 10, 'a default below the signed fee: the default is the ceiling');
  setTradingConfig({ builder: B });
  assert.equal(feeNow('perps', WALLET), 15, 'back as it was: the same verified terms count again');
  // configureTerms forgets what was verified under other settings.
  configure();
  assert.equal(feeNow('perps', WALLET), 20);
});

test('a malformed wallet address is never asked about', async () => {
  for (const a of ['', '0x123', 'not an address', `${WALLET}00`]) assert.equal(await refreshTerms(a), null, a);
  assert.equal(server.requests.length, 0);
});

// --- keeping them current -----------------------------------------------------------------------------

/**
 * Let WebCrypto and the promise chains finish (timers are mocked; setImmediate
 * is not): until `until` holds, then some turns more - a request is SEEN before
 * its answer is verified and the next look is scheduled.
 */
async function settle(until: () => boolean = () => true): Promise<void> {
  const turn = () => new Promise((r) => setImmediate(r));
  // Real time (performance.now is not mocked): WebCrypto answers from another thread, in its own time.
  for (const t0 = performance.now(); !until() && performance.now() - t0 < 3_000; ) await turn();
  for (const t0 = performance.now(); performance.now() - t0 < 20; ) await turn();
}

test('ensureTerms: asks when nothing is held, waits a bounded time, and never throws', async () => {
  await ensureTerms(WALLET);
  assert.equal(server.requests.length, 1);
  assert.equal(feeNow('perps', WALLET), 15);
  await ensureTerms(WALLET);
  assert.equal(server.requests.length, 1, 'terms are held: nothing to ask');
  // A server that gives nothing is not asked again for every order.
  configure();
  server.rewrite = (b) => ({ ...b, sig: null });
  await ensureTerms(WALLET);
  await ensureTerms(WALLET);
  await ensureTerms(WALLET);
  assert.equal(server.requests.length, 2, 'one more request, then none for a minute');
  clock.mono += 60_000;
  await ensureTerms(WALLET);
  assert.equal(server.requests.length, 3);
  // An answer that never comes does not hold an order up.
  configure();
  let release!: () => void;
  server.rewrite = null;
  server.hold = new Promise<void>((r) => (release = r));
  const t0 = Date.now();
  await ensureTerms(WALLET, 40);
  assert.ok(Date.now() - t0 < 1_500, 'returned without the answer');
  assert.equal(feeNow('perps', WALLET), 20, 'no terms yet: the default');
  release();
  await settle(() => feeNow('perps', WALLET) === 15);
  assert.equal(feeNow('perps', WALLET), 15, 'the answer still counts when it arrives');
  // Unreachable: no throw, the default.
  configure();
  server.hold = null;
  server.down = true;
  await ensureTerms(WALLET);
  assert.equal(feeNow('perps', WALLET), 20);
});

test('followTerms: asked at once, then every few minutes; sooner while a verification is pending; stopped with null', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  followTerms(WALLET);
  await settle(() => server.requests.length === 1 && feeNow('perps', WALLET) === 15);
  assert.equal(server.requests.length, 1, 'asked when trading is enabled or restored');
  assert.equal(server.requests[0]!.hint, false);
  followTerms(WALLET);
  await settle();
  assert.equal(server.requests.length, 1, 'following the same wallet again starts nothing new');
  mock.timers.tick(TERMS_REFRESH_MS - 1);
  await settle();
  assert.equal(server.requests.length, 1);
  mock.timers.tick(1);
  await settle(() => server.requests.length === 2);
  assert.equal(server.requests.length, 2, 'again after the refresh interval');
  // The server says a verification is running: look again in 30 s.
  server.volume = { totalUsd: 12.4, pending: true };
  mock.timers.tick(TERMS_REFRESH_MS);
  await settle(() => server.requests.length === 3);
  mock.timers.tick(30_000);
  await settle(() => server.requests.length === 4);
  assert.equal(server.requests.length, 4, 'a pending verification is followed up after 30 s');
  server.volume = { totalUsd: 30, pending: false };
  server.fee = { perps: 10, spot: 20 };
  mock.timers.tick(30_000);
  await settle(() => feeNow('perps', WALLET) === 10);
  assert.equal(feeNow('perps', WALLET), 10, 'the new tier arrives without a reload');
  const n = server.requests.length;
  mock.timers.tick(30_000);
  await settle();
  assert.equal(server.requests.length, n, 'no longer pending: back to the normal pace');
  followTerms(null);
  mock.timers.tick(10 * TERMS_REFRESH_MS);
  await settle();
  assert.equal(server.requests.length, n, 'stopped');
});

test('followTerms: a short ttl is refreshed in time, but never more often than every 30 s; an unreachable server is retried', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  server.ttl = 120_000;
  followTerms(WALLET);
  await settle(() => server.requests.length === 1 && feeNow('perps', WALLET) === 15);
  mock.timers.tick(59_999);
  await settle();
  assert.equal(server.requests.length, 1);
  mock.timers.tick(1);
  await settle(() => server.requests.length === 2);
  assert.equal(server.requests.length, 2, 'at half the ttl');
  server.ttl = 10_000;
  mock.timers.tick(60_000);
  await settle(() => server.requests.length === 3);
  mock.timers.tick(29_999);
  await settle();
  assert.equal(server.requests.length, 3, 'a 10 s ttl is not polled every 5 s');
  mock.timers.tick(1);
  await settle(() => server.requests.length === 4);
  assert.equal(server.requests.length, 4);
  // No answer: three quick retries a minute apart, then the normal pace.
  server.down = true;
  for (let i = 0; i < 3; i++) {
    mock.timers.tick(i === 0 ? 30_000 : 60_000);
    await settle(() => server.requests.length === 5 + i);
    assert.equal(server.requests.length, 5 + i);
  }
  mock.timers.tick(60_000);
  await settle(() => server.requests.length === 8);
  assert.equal(server.requests.length, 8);
  mock.timers.tick(60_000);
  await settle();
  assert.equal(server.requests.length, 8, 'after three failures: every few minutes');
  mock.timers.tick(TERMS_REFRESH_MS - 60_000);
  await settle(() => server.requests.length === 9);
  assert.equal(server.requests.length, 9);
  followTerms(null);
});

test('hintTerms: a burst of fills is ONE request with hint=1, a few seconds later; at most one a minute', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  for (let i = 0; i < 25; i++) hintTerms(WALLET);
  await settle();
  assert.equal(server.requests.length, 0, 'not at once: the fill has to reach SoDEX\'s records first');
  clock.mono += 3_000;
  mock.timers.tick(3_000);
  await settle(() => server.requests.length === 1);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0]!.hint, true);
  // More fills right after: one more request, and not before the minute is over.
  for (let i = 0; i < 10; i++) hintTerms(WALLET);
  clock.mono += 30_000;
  mock.timers.tick(30_000);
  await settle();
  assert.equal(server.requests.length, 1, 'thirty seconds later: still one');
  clock.mono += 30_000;
  mock.timers.tick(30_000);
  await settle(() => server.requests.length === 2);
  assert.equal(server.requests.length, 2, 'one per minute');
  assert.equal(server.requests[1]!.hint, true);
  // No fills: no requests.
  clock.mono += 10 * 60_000;
  mock.timers.tick(10 * 60_000);
  await settle();
  assert.equal(server.requests.length, 2);
  hintTerms(null);
  hintTerms(undefined);
  mock.timers.tick(60_000);
  await settle();
  assert.equal(server.requests.length, 2);
});

test('hintTerms while following: the hinted answer is followed up (the server needs a moment to verify)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  server.fee = { perps: 20, spot: 20 };
  server.tier = { index: 0, next: { atUsd: 10, fee: { perps: 15, spot: 20 } } };
  followTerms(WALLET);
  await settle(() => server.requests.length === 1 && currentTerms(WALLET) !== null);
  assert.equal(feeNow('perps', WALLET), 20);
  // A fill: the wallet passed the milestone. The server answers "pending", then the lower fee.
  hintTerms(WALLET);
  server.volume = { totalUsd: 12.4, pending: true };
  clock.mono += 3_000;
  mock.timers.tick(3_000);
  await settle(() => server.requests.length === 2);
  assert.equal(server.requests[1]!.hint, true);
  assert.equal(feeNow('perps', WALLET), 20, 'not yet');
  server.volume = { totalUsd: 12.4, pending: false };
  server.fee = { perps: 15, spot: 20 };
  server.tier = { index: 1, next: null };
  clock.mono += 30_000;
  mock.timers.tick(30_000);
  await settle(() => feeNow('perps', WALLET) === 15);
  assert.equal(feeNow('perps', WALLET), 15, 'the milestone\'s fee, half a minute after the server had it');
  assert.equal(server.requests.at(-1)!.hint, false, 'the follow-up is a plain read');
  followTerms(null);
});
