/**
 * Signed fee terms: the ONLY thing that can lower a wallet's builder fee
 * (docs/BUILDER-TIERS.md sections 2, 3 and 7).
 *
 * THE RULE. The fee an order carries is the build's default fee
 * (VITE_BUILDER_FEE_*, config.ts) unless Valuescan's own server has signed, for
 * THIS wallet, THIS request and a short time, that it is lower. `feeNow` is
 * that number and nothing else feeds it: no storage key, no URL parameter, no
 * debug hook, no unsigned field of the answer. Whatever goes wrong - the
 * request blocked, the answer rewritten, replayed, expired, signed by an
 * unknown key, for another wallet, builder or chain - the result is the
 * DEFAULT (highest) fee, never a lower one.
 *
 * HOW AN ANSWER IS CHECKED. The app sends a fresh random nonce, then rebuilds
 * the signed message itself FROM THE VALUES IT IS ABOUT TO USE (the chain it
 * trades on, the pinned builder, the connected wallet, the nonce it just sent,
 * the two fees) and verifies the Ed25519 signature over it with WebCrypto,
 * under a key pinned in the bundle (VITE_BUILDER_TERMS_KEYS). A field the app
 * does not use is not trusted; a field it uses is covered by the signature.
 *
 * HOW LONG IT HOLDS. For the answer's `ttl`, at most 15 minutes, counted on the
 * monotonic clock from the moment the answer arrived - setting the system clock
 * back gains nothing. The wall clock can only END terms early (a machine that
 * slept: the monotonic clock of some browsers stands still meanwhile). Verified
 * terms live in this module's memory only; a reload starts with the default.
 *
 * WHAT IT DOES NOT NEED. A build without pinned keys, a build without a
 * builder, and a browser whose WebCrypto has no Ed25519 never ask for terms:
 * every order carries the default fee.
 *
 * The request goes to Valuescan's own API (the origin the app is served from),
 * never to SoDEX. The live runner uses this same module from Node
 * (`configureTerms` with its own endpoint and fetch).
 */
import { BUILDER_FEE_CAP, type Engine } from '@sodex-core';
import { activeBuilder } from './builder';
import { base64UrlBytes, tradingConfig } from './config';
import { logger } from '../log';

const log = logger('trade');

/** Relative to the origin the app is served from - the same base as the index API (/api/vs/*). */
export const TERMS_PATH = '/api/vs/builder/terms';
/** However long the server says, never longer than this. */
export const TERMS_TTL_CAP_MS = 15 * 60_000;
/** Asked again this often while trading is on (well inside the server's ttl). */
export const TERMS_REFRESH_MS = 4 * 60_000;
/** ...and never more often than this, whatever a ttl says. */
const TERMS_MIN_REFRESH_MS = 30_000;
/** After an answer that says a verification is running: look again this soon, this many times. */
const TERMS_PENDING_MS = 30_000;
const TERMS_PENDING_RUNS = 6;
/** After a request that got no answer: try again this soon (three times, then the normal pace). */
const TERMS_RETRY_MS = 60_000;
/** A fill is reported to the server (hint=1) this long after it, and at most once per this gap. */
const HINT_DELAY_MS = 3_000;
const HINT_MIN_GAP_MS = 60_000;

export interface TermsFee {
  perps: number;
  spot: number;
}

/**
 * What the answer says besides the signed fee. NOT signed and decides nothing:
 * it is shown, and it tells the app when to look again.
 */
export interface TermsDisplay {
  /** Volume the server has counted for this wallet, USD. */
  volumeUsd: number | null;
  /** The window that volume covers, in days (null: lifetime). */
  volumeDays: number | null;
  /** A verification is queued or running: the fee may change shortly. */
  pending: boolean;
  tierIndex: number | null;
  /** The next tier: from `atUsd` of counted volume the fee is `fee`. */
  next: { atUsd: number; fee: TermsFee } | null;
  flags: string[];
}

export interface VerifiedTerms {
  /** The wallet they were signed for, lower-case. */
  address: string;
  builderId: number;
  chain: number;
  /** Signed. Each fee is a whole number from 0 to the build's default for that engine. */
  fee: TermsFee;
  nonce: string;
  issued: number;
  /** As signed. */
  ttl: number;
  /** How long this browser holds them: min(ttl, 15 minutes). */
  validForMs: number;
  /** The pinned key that verified them (first 8 hex of SHA-256 of the raw key). */
  keyId: string;
  display: TermsDisplay;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TermsOptions {
  /** Pinned public keys: base64url of the raw 32 bytes. Empty: no terms are asked for. */
  keys: readonly string[];
  /** Where terms are asked for. Default: TERMS_PATH on the app's own origin. */
  endpoint?: string;
  fetch?: FetchLike;
  /** A clock that never jumps, ms. Default: performance.now(). */
  monotonicNow?: () => number;
  /** The wall clock, ms. It can only end terms early. Default: Date.now(). */
  wallNow?: () => number;
}

// --- settings --------------------------------------------------------------------------

let custom: TermsOptions | null = null;

const settings = () => ({
  keys: custom ? custom.keys : tradingConfig().termsKeys,
  endpoint: custom?.endpoint ?? TERMS_PATH,
  fetch: custom?.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init)),
  mono: custom?.monotonicNow ?? (() => performance.now()),
  wall: custom?.wallNow ?? (() => Date.now()),
});

type Timer = ReturnType<typeof setTimeout>;
const quiet = (t: Timer): Timer => {
  // Outside a browser (tests, the live runner) a timer here must not keep the process alive.
  (t as unknown as { unref?: () => void }).unref?.();
  return t;
};

// --- state -----------------------------------------------------------------------------

interface Held {
  terms: VerifiedTerms;
  /** When the answer arrived, on both clocks. */
  mono: number;
  wall: number;
  timer?: Timer;
}

/** Verified terms per wallet (lower-case). Memory only - by design nothing here survives a reload. */
const held = new Map<string, Held>();
/** When each wallet's terms were last asked for (monotonic). */
const lastAsk = new Map<string, number>();
/** Whether the last request for a wallet got no answer at all (as opposed to an answer that gave no terms). */
const unreachable = new Set<string>();
const inflight = new Map<string, Promise<VerifiedTerms | null>>();
const listeners = new Set<() => void>();
let revision = 0;
const warned = new Set<string>();

function emit(): void {
  revision += 1;
  for (const l of listeners) {
    try {
      l();
    } catch (e) {
      log.error('builder terms listener failed', { error: String(e) });
    }
  }
}

/** Told when the fee a wallet owes may have changed (new terms, or terms that ran out). */
export function subscribeTerms(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Changes whenever `feeNow` may answer differently (for useSyncExternalStore). */
export const termsRevision = (): number => revision;

/** The first time a reason is seen it is a warning; after that it is detail. */
function note(reason: string, data: Record<string, unknown>): void {
  if (warned.has(reason)) log.debug(`builder fee terms: ${reason}`, data);
  else {
    warned.add(reason);
    log.warn(`builder fee terms: ${reason} - the default fee applies`, data);
  }
}

// --- the pinned keys ---------------------------------------------------------------------

interface PinnedKey {
  id: string;
  key: CryptoKey;
}

let pinnedFor = '';
/** null: this runtime cannot verify Ed25519 at all. */
let pinnedP: Promise<PinnedKey[] | null> | null = null;

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** `keyId`: the first 8 hex characters of SHA-256 of the raw public key. */
export async function termsKeyId(publicKey: string): Promise<string | null> {
  const raw = base64UrlBytes(publicKey);
  const subtle = globalThis.crypto?.subtle;
  if (!raw || raw.length !== 32 || !subtle) return null;
  return hex(new Uint8Array(await subtle.digest('SHA-256', raw as BufferSource))).slice(0, 8);
}

async function importPinned(keys: readonly string[]): Promise<PinnedKey[] | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const out: PinnedKey[] = [];
  let failed = 0;
  for (const k of keys) {
    const raw = base64UrlBytes(k);
    if (!raw || raw.length !== 32) continue;
    try {
      const key = await subtle.importKey('raw', raw as BufferSource, { name: 'Ed25519' }, false, ['verify']);
      out.push({ id: (await termsKeyId(k))!, key });
    } catch {
      failed += 1;
    }
  }
  // Every usable-looking key refused: the algorithm is not there (an older browser).
  return out.length === 0 && failed > 0 ? null : out;
}

function pinnedKeys(): Promise<PinnedKey[] | null> {
  const keys = settings().keys;
  const sig = keys.join(',');
  if (!pinnedP || pinnedFor !== sig) {
    pinnedFor = sig;
    pinnedP = importPinned(keys).catch(() => null);
  }
  return pinnedP;
}

/** Could terms lower a fee here at all? A builder that charges, and at least one pinned key. */
export const termsPossible = (): boolean => !!activeBuilder(tradingConfig().builder) && settings().keys.length > 0;

// --- the signed message --------------------------------------------------------------------

export interface TermsFields {
  chain: number;
  builderId: number;
  address: string;
  perps: number;
  spot: number;
  nonce: string;
  issued: number;
  ttl: number;
}

/** Exactly the bytes the server signs: UTF-8, lines joined by "\n", no trailing newline. */
export function termsMessage(t: TermsFields): string {
  return [
    'valuescan-builder-terms/1',
    `chain:${t.chain}`,
    `builder:${t.builderId}`,
    `address:${t.address.toLowerCase()}`,
    `perps:${t.perps}`,
    `spot:${t.spot}`,
    `nonce:${t.nonce}`,
    `issued:${t.issued}`,
    `ttl:${t.ttl}`,
  ].join('\n');
}

/** 16 random bytes as base64url: 22 characters of [A-Za-z0-9_-], never reused. */
function newNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- reading an answer -----------------------------------------------------------------------

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const whole = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi;
const amount = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export interface TermsExpect {
  /** The chain this app trades on. */
  chain: number;
  /** The pinned builder. */
  builderId: number;
  /** The connected wallet, lower-case. */
  address: string;
  /** The nonce just sent. */
  nonce: string;
  /** The build's default fees: terms may only be at or below them. */
  defaults: TermsFee;
}

export type TermsReading =
  | { ok: true; fee: TermsFee; issued: number; ttl: number; keyId: string | null; sig: Uint8Array; display: TermsDisplay }
  | { ok: false; why: string };

/** What is shown, sanitised: nothing here is signed, and nothing here decides a fee. */
function displayOf(o: Record<string, unknown>, fee: TermsFee): TermsDisplay {
  const volume = obj(o.volume);
  const tier = obj(o.tier);
  const next = obj(tier?.next);
  const nextFee = obj(next?.fee);
  const atUsd = amount(next?.atUsd);
  const nextPerps = nextFee?.perps;
  const nextSpot = nextFee?.spot;
  const index = tier?.index;
  // A "next tier" is only one when it is a whole fee at or below the current one, and lower somewhere.
  const lower =
    whole(nextPerps, 0, fee.perps) && whole(nextSpot, 0, fee.spot) && (nextPerps < fee.perps || nextSpot < fee.spot)
      ? { perps: nextPerps, spot: nextSpot }
      : null;
  return {
    volumeUsd: amount(volume?.totalUsd),
    volumeDays: whole(volume?.days, 1, 365) ? (volume!.days as number) : null,
    pending: volume?.pending === true,
    tierIndex: whole(index, 0, 1_000) ? index : null,
    next: lower && atUsd !== null ? { atUsd, fee: lower } : null,
    flags: Array.isArray(o.flags) ? o.flags.filter((f): f is string => typeof f === 'string').slice(0, 8) : [],
  };
}

/**
 * Is this answer one the app may use - before its signature is checked? Every
 * value the app is about to use must be the one it expects: the chain it
 * trades on, the pinned builder, the connected wallet, the nonce it just sent,
 * and fees that are whole numbers from 0 to the build's default.
 */
export function readTermsAnswer(body: unknown, x: TermsExpect): TermsReading {
  const o = obj(body);
  if (!o || o.ok !== true) return { ok: false, why: 'the server did not answer with terms' };
  if (o.builderId === null || o.builderId === undefined) return { ok: false, why: 'fee tiers are off on the server' };
  if (o.builderId !== x.builderId) return { ok: false, why: `the terms are for builder ${String(o.builderId)}, not the pinned builder ${x.builderId}` };
  if (o.chain !== x.chain) return { ok: false, why: `the terms are for chain ${String(o.chain)}, not ${x.chain}` };
  if (typeof o.address !== 'string' || o.address.toLowerCase() !== x.address.toLowerCase()) return { ok: false, why: 'the terms are for another wallet' };
  if (typeof o.nonce !== 'string' || o.nonce !== x.nonce) return { ok: false, why: 'the terms answer another request (the nonce is not the one sent)' };
  const fee = obj(o.fee);
  const perps = fee?.perps;
  const spot = fee?.spot;
  if (!whole(perps, 0, x.defaults.perps) || !whole(spot, 0, x.defaults.spot)) {
    return { ok: false, why: `the fee (${String(perps)} / ${String(spot)}) is not a whole number from 0 to this build's default (${x.defaults.perps} / ${x.defaults.spot})` };
  }
  const issued = o.issued;
  const ttl = o.ttl;
  if (!whole(issued, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, why: 'issued is not a whole number' };
  if (!whole(ttl, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, why: 'ttl is not a positive whole number' };
  if (o.sig === null || o.sig === undefined) return { ok: false, why: 'the terms are not signed (the server has no terms key)' };
  const sig = typeof o.sig === 'string' ? base64UrlBytes(o.sig) : null;
  if (!sig || sig.length !== 64) return { ok: false, why: 'the signature is not base64url of 64 bytes' };
  return {
    ok: true,
    fee: { perps, spot },
    issued,
    ttl,
    keyId: typeof o.keyId === 'string' ? o.keyId : null,
    sig,
    display: displayOf(o, { perps, spot }),
  };
}

/** The pinned key the signature verifies under (the one `keyId` names is tried first), or null. */
async function verifiedBy(message: string, sig: Uint8Array, keys: readonly PinnedKey[], keyId: string | null): Promise<PinnedKey | null> {
  const subtle = globalThis.crypto.subtle;
  const data = new TextEncoder().encode(message);
  const ordered = [...keys].sort((a, b) => Number(b.id === keyId) - Number(a.id === keyId));
  for (const k of ordered) {
    try {
      if (await subtle.verify({ name: 'Ed25519' }, k.key, sig as BufferSource, data as BufferSource)) return k;
    } catch {
      /* not this key */
    }
  }
  return null;
}

// --- what is held, and for how long ---------------------------------------------------------

function alive(h: Held): boolean {
  const s = settings();
  const mono = s.mono() - h.mono;
  // Only ever earlier: a wall clock that ran past the ttl ends the terms (the machine slept); one set back gains nothing.
  const wall = s.wall() - h.wall;
  return mono >= 0 && mono < h.terms.validForMs && wall < h.terms.validForMs;
}

/**
 * The verified terms that hold for `address` right now, or null. Checked
 * against the configuration AS IT IS NOW: terms for another builder or chain,
 * or above today's default, do not count.
 */
export function currentTerms(address: string | null | undefined): VerifiedTerms | null {
  if (!address) return null;
  const h = held.get(address.toLowerCase());
  if (!h || !alive(h)) return null;
  const cfg = tradingConfig();
  const b = activeBuilder(cfg.builder);
  const t = h.terms;
  if (!b || t.builderId !== b.id || t.chain !== cfg.chainId || t.fee.perps > b.fee.perps || t.fee.spot > b.fee.spot) return null;
  return t;
}

/**
 * THE FEE AN ORDER PLACED NOW CARRIES on `engine` for `address`, tenths of a
 * basis point: the build's default, lowered only by verified terms for that
 * wallet. 0 when no builder is configured or the engine is not charged. Never
 * above the default or SoDEX's own cap.
 */
export function feeNow(engine: Engine, address: string | null | undefined): number {
  const b = activeBuilder(tradingConfig().builder);
  if (!b) return 0;
  const dflt = Math.min(b.fee[engine], BUILDER_FEE_CAP[engine]);
  if (!(dflt > 0)) return 0;
  const t = currentTerms(address);
  return t ? Math.min(dflt, t.fee[engine]) : dflt;
}

function store(owner: string, terms: VerifiedTerms, mono: number, wall: number): void {
  const before = held.get(owner);
  if (before?.timer) clearTimeout(before.timer);
  const h: Held = { terms, mono, wall };
  h.timer = quiet(
    setTimeout(() => {
      if (held.get(owner) !== h) return;
      held.delete(owner);
      log.info('builder fee terms ran out: the default fee applies until new ones arrive', { fee: terms.fee });
      emit();
    }, terms.validForMs + 25),
  );
  held.set(owner, h);
  const changed = !before || before.terms.fee.perps !== terms.fee.perps || before.terms.fee.spot !== terms.fee.spot;
  if (changed) log.info('builder fee terms verified', { fee: terms.fee, validForMs: terms.validForMs, keyId: terms.keyId, tier: terms.display.tierIndex });
  emit();
}

// --- asking ----------------------------------------------------------------------------------

async function ask(owner: string, hint: boolean): Promise<VerifiedTerms | null> {
  const cfg = tradingConfig();
  const b = activeBuilder(cfg.builder);
  if (!b || !/^0x[0-9a-f]{40}$/.test(owner)) return null;
  const s = settings();
  // Nothing pinned: nobody can lower the fee, so nothing is asked.
  if (!s.keys.length) return null;
  const keys = await pinnedKeys();
  if (keys === null) {
    note('this browser cannot verify Ed25519 signatures', {});
    return null;
  }
  if (!keys.length) {
    note('no pinned terms key is usable', {});
    return null;
  }

  const nonce = newNonce();
  lastAsk.set(owner, s.mono());
  const url = `${s.endpoint}${s.endpoint.includes('?') ? '&' : '?'}address=${owner}&nonce=${nonce}${hint ? '&hint=1' : ''}`;
  let res: Response;
  let body: unknown;
  let mono: number;
  let wall: number;
  try {
    res = await s.fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' });
    // The ttl counts from here: the moment the answer arrived.
    mono = s.mono();
    wall = s.wall();
    body = await res.json();
  } catch (e) {
    unreachable.add(owner);
    log.debug('builder fee terms: no answer; the fee stays what it is until the held terms run out', { error: String(e) });
    return null;
  }
  unreachable.delete(owner);
  if (!res.ok) {
    note(`the server answered HTTP ${res.status}`, {});
    return null;
  }
  const read = readTermsAnswer(body, { chain: cfg.chainId, builderId: b.id, address: owner, nonce, defaults: b.fee });
  if (!read.ok) {
    note(read.why, {});
    return null;
  }
  // Rebuilt from the values that are about to be used - not from the answer's own copy of them.
  const message = termsMessage({ chain: cfg.chainId, builderId: b.id, address: owner, perps: read.fee.perps, spot: read.fee.spot, nonce, issued: read.issued, ttl: read.ttl });
  const key = await verifiedBy(message, read.sig, keys, read.keyId);
  if (!key) {
    note('the signature does not verify under a pinned key', { keyId: read.keyId });
    return null;
  }
  const terms: VerifiedTerms = {
    address: owner,
    builderId: b.id,
    chain: cfg.chainId,
    fee: read.fee,
    nonce,
    issued: read.issued,
    ttl: read.ttl,
    validForMs: Math.min(read.ttl, TERMS_TTL_CAP_MS),
    keyId: key.id,
    display: read.display,
  };
  store(owner, terms, mono, wall);
  return terms;
}

/**
 * Ask the server for `address`'s terms and verify them. Resolves with the
 * verified terms, or null (none, unverifiable, unreachable - the default fee
 * then applies once any terms still held run out). Never throws. `hint` tells
 * the server this wallet has traded and is worth verifying soon.
 */
export function refreshTerms(address: string, o: { hint?: boolean } = {}): Promise<VerifiedTerms | null> {
  const owner = String(address ?? '').toLowerCase();
  const id = `${owner}|${o.hint ? 1 : 0}`;
  const running = inflight.get(id);
  if (running) return running;
  const p = ask(owner, !!o.hint)
    .catch((e) => {
      log.warn('builder fee terms: the check failed; the default fee applies', { error: String(e) });
      return null;
    })
    .finally(() => {
      if (inflight.get(id) === p) inflight.delete(id);
    });
  inflight.set(id, p);
  return p;
}

/**
 * Before an order: when no terms are held for the wallet and none were asked
 * for a moment ago, ask now - but wait at most `maxWaitMs`. An order is never
 * held up or refused over this: without terms it carries the default fee.
 */
export async function ensureTerms(address: string, maxWaitMs = 1_500): Promise<void> {
  const owner = String(address ?? '').toLowerCase();
  if (!termsPossible() || currentTerms(owner)) return;
  const last = lastAsk.get(owner);
  if (last !== undefined && settings().mono() - last < TERMS_RETRY_MS && !inflight.has(`${owner}|0`) && !inflight.has(`${owner}|1`)) return;
  let timer: Timer | undefined;
  await Promise.race([
    inflight.get(`${owner}|1`) ?? refreshTerms(owner),
    new Promise<void>((resolve) => {
      timer = quiet(setTimeout(resolve, maxWaitMs));
    }),
  ]);
  if (timer) clearTimeout(timer);
}

// --- keeping them current while trading is on ---------------------------------------------------

interface Follow {
  owner: string;
  timer?: Timer;
  pendingRuns: number;
  failures: number;
}

let follow: Follow | null = null;

async function followRun(f: Follow, hint: boolean): Promise<void> {
  if (f.timer) clearTimeout(f.timer);
  f.timer = undefined;
  const t = await refreshTerms(f.owner, { hint });
  if (follow !== f) return;
  let delay = TERMS_REFRESH_MS;
  if (t) {
    f.failures = 0;
    delay = Math.min(TERMS_REFRESH_MS, Math.max(TERMS_MIN_REFRESH_MS, Math.floor(t.validForMs / 2)));
    if (t.display.pending && f.pendingRuns < TERMS_PENDING_RUNS) {
      f.pendingRuns += 1;
      delay = Math.min(delay, TERMS_PENDING_MS);
    } else if (!t.display.pending) f.pendingRuns = 0;
  } else if (unreachable.has(f.owner) && f.failures < 3) {
    f.failures += 1;
    delay = TERMS_RETRY_MS;
  }
  f.timer = quiet(setTimeout(() => void followRun(f, false), delay));
}

/**
 * Keep `address`'s terms current: ask now, then every few minutes (sooner while
 * the server says a verification is running). `null` stops. The trading session
 * calls this when trading is enabled or restored, and when it goes off.
 */
export function followTerms(address: string | null): void {
  const owner = address ? address.toLowerCase() : null;
  if (follow && follow.owner === owner) return;
  if (follow?.timer) clearTimeout(follow.timer);
  follow = null;
  if (!owner || !termsPossible()) return;
  follow = { owner, pendingRuns: 0, failures: 0 };
  void followRun(follow, false);
}

const hintTimers = new Map<string, Timer>();
const lastHint = new Map<string, number>();

/**
 * A fill happened for `address`: tell the server (hint=1) so it verifies the
 * wallet's volume soon. Debounced - a burst of fills is one request - and at
 * most one a minute per wallet.
 */
export function hintTerms(address: string | null | undefined): void {
  if (!address || !termsPossible()) return;
  const owner = address.toLowerCase();
  if (hintTimers.has(owner)) return;
  const s = settings();
  const since = s.mono() - (lastHint.get(owner) ?? Number.NEGATIVE_INFINITY);
  const wait = Math.max(HINT_DELAY_MS, HINT_MIN_GAP_MS - since);
  hintTimers.set(
    owner,
    quiet(
      setTimeout(() => {
        hintTimers.delete(owner);
        lastHint.set(owner, settings().mono());
        if (follow && follow.owner === owner) {
          follow.pendingRuns = 0;
          void followRun(follow, true);
        } else void refreshTerms(owner, { hint: true });
      }, wait),
    ),
  );
}

// --- for the screen ---------------------------------------------------------------------------

export interface TermsView {
  /** What an order placed now carries, per engine (`feeNow`). */
  fee: TermsFee;
  /** The build's default fee, per engine. */
  default: TermsFee;
  /** The next tier the server names (display only), or null. */
  next: { atUsd: number; fee: TermsFee } | null;
  /** Volume counted so far, USD (display only), or null. */
  volumeUsd: number | null;
  /** The window that volume covers, in days (display only); null: lifetime. */
  volumeDays: number | null;
}

/** What the fee lines show for `address` - null when no verified terms hold (the default fee applies). */
export function termsView(address: string | null | undefined): TermsView | null {
  const t = currentTerms(address);
  const b = activeBuilder(tradingConfig().builder);
  if (!t || !b) return null;
  return {
    fee: { perps: feeNow('perps', address), spot: feeNow('spot', address) },
    default: { perps: b.fee.perps, spot: b.fee.spot },
    next: t.display.next,
    volumeUsd: t.display.volumeUsd,
    volumeDays: t.display.volumeDays,
  };
}

// --- configuration ------------------------------------------------------------------------------

function forget(): void {
  for (const h of held.values()) if (h.timer) clearTimeout(h.timer);
  held.clear();
  for (const t of hintTimers.values()) clearTimeout(t);
  hintTimers.clear();
  lastHint.clear();
  lastAsk.clear();
  unreachable.clear();
  inflight.clear();
  if (follow?.timer) clearTimeout(follow.timer);
  follow = null;
  pinnedP = null;
  pinnedFor = '';
}

/**
 * Use these keys, endpoint, fetch and clocks instead of the build's (the live
 * runner, tests). Everything held is forgotten: terms verified under other
 * settings do not carry over.
 */
export function configureTerms(o: TermsOptions): void {
  custom = { ...o, keys: [...o.keys] };
  forget();
  emit();
}

/** For tests: back to the build's own settings, nothing held. */
export function _resetTermsForTests(): void {
  custom = null;
  warned.clear();
  forget();
  emit();
}
