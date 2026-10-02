/**
 * Large SoDEX perps trades, from the gateway WebSocket `trade` channel.
 *
 * Every print carries the buyer and seller account ids (`bi`/`si`); REST prints
 * do not, so this stream is the only source that says WHO traded (research 01
 * §1). `S` is the aggressor, so the taker is `bi` on a BUY and `si` on a SELL.
 *
 * One dedicated connection, subscribed to every perps symbol with the verified
 * `symbols: [...]` form (one ack per symbol, 98 of the 1000 subscriptions an IP
 * may hold). It is its own `Upstream`, not the hub's shared one, so the hub's
 * browser fan-out never sees this firehose and a hub unsubscribe can never cut
 * it. It starts on the first whales() call and closes after 30 idle minutes.
 *
 * Prints of one taker order are folded into one trade (WhaleAggregator), kept in
 * a ring buffer from $10k notional up, and their taker ids are resolved to
 * addresses in the background (resolver.ts), so a request rarely waits.
 *
 * The venue's own market makers and system accounts are left out: they are
 * ~90 % of all activity (research 01 §3) and a hedge by the house market maker
 * is not a trader anyone can copy. The ids are the ones research 01 names.
 *
 * WHAT THIS COSTS SODEX, WHATEVER THE NUMBER OF VISITORS. A request reads the
 * ring buffer; it never causes a request of its own. One feed serves everyone:
 *   - one socket, one `trade` subscription per perps symbol (98 of the 1,000
 *     an IP may hold; the indexer's own stream is a second socket);
 *   - the symbol list: one gateway read when the feed starts and one per
 *     30 minutes while it runs. A start that fails is not tried again for
 *     START_RETRY_MS, so an outage costs at most two attempts a minute (each
 *     the gateway client's usual 4 tries), not one per visitor;
 *   - taker addresses: from the index first (its SoDEX lists pair ids with
 *     wallets - a key lookup in a file), and only for ids it does not know
 *     from the bulk resolver, which sends at most one call per 2 s for up to
 *     500 ids: 30 a minute at the very most, and 4 a minute while that host
 *     fails (resolver.ts).
 */
import { reader } from '../../indexer/reader.js';
import { Upstream } from '../../sodex/ws.js';
import { symbols } from '../../sodex/symbols.js';
import type { WhaleTrade } from '../types.js';
import { WhaleAggregator, takerOf, type WhaleAgg, type WsPrint } from './mappers.js';
import { knownAddress, prefetchIds, resolveIds, seedAddress } from './resolver.js';

/** Smallest trade kept. Requests with a lower `minUsd` still only see trades from here up. */
export const WHALE_FLOOR_USD = 10_000;
const RING_MAX = 2_000;
const IDLE_STOP_MS = 30 * 60_000;
const SYMBOL_REFRESH_MS = 30 * 60_000;
const RESOLVE_WAIT_MS = 2_500;
/** A start that failed is not tried again for this long, whoever asks meanwhile. */
export const START_RETRY_MS = 30_000;

/**
 * 998 mirror/bridge withdrawal account, 999 cross-engine id, 1001 / 1002 / 23342
 * market makers, 2140 also named as a market maker to drop at ingest (research 01).
 */
export const SYSTEM_ACCOUNT_IDS: ReadonlySet<number> = new Set([998, 999, 1001, 1002, 2140, 23342]);

const aggregator = new WhaleAggregator(1_500);
const ring: WhaleAgg[] = [];

let up: Upstream | null = null;
let starting: Promise<void> | null = null;
let ticker: NodeJS.Timeout | undefined;
let lastUsed = 0;
let symbolsCheckedAt = 0;
const subscribed = new Set<string>();
let printsSeen = 0;
let startedAt = 0;
let lastError: string | null = null;
let startFailedAt = 0;
let startError: unknown = null;
/** Ids the index did not know, and when it was asked: not looked up again on every request. */
const notInIndex = new Map<number, number>();
const INDEX_MISS_MS = 60_000;

/**
 * Pair these account ids with the wallets the index already knows them by
 * (its SoDEX lists): a key lookup in a file, no request to SoDEX. What is
 * left goes to the bulk resolver.
 */
export function seedFromIndex(ids: Iterable<number>): void {
  let s: ReturnType<typeof reader> = null;
  const now = Date.now();
  try {
    for (const id of ids) {
      if (!Number.isInteger(id) || id <= 0 || knownAddress(id)) continue;
      if (now - (notInIndex.get(id) ?? 0) < INDEX_MISS_MS) continue;
      s ??= reader();
      if (!s) return;
      const a = s.accountAddress('sodex', id);
      if (a) seedAddress(id, a);
      else {
        if (notInIndex.size > 10_000) notInIndex.clear();
        notInIndex.set(id, now);
      }
    }
  } catch { /* the index only saves requests here: the resolver still answers */ }
}

function onPush(msg: { channel?: string; data?: unknown }): void {
  if (msg?.channel !== 'trade' || !Array.isArray(msg.data)) return;
  const now = Date.now();
  for (const p of msg.data as WsPrint[]) {
    printsSeen++;
    const taker = takerOf(p);
    if (!taker || SYSTEM_ACCOUNT_IDS.has(taker.accountId)) continue;
    aggregator.add(p, now);
  }
}

function drain(now = Date.now(), force = false): void {
  const done = aggregator.flush(now, WHALE_FLOOR_USD, force);
  if (!done.length) return;
  ring.push(...done);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  const ids = done.map((a) => a.accountId);
  seedFromIndex(ids);
  prefetchIds(ids);
}

function stop(): void {
  drain(Date.now(), true);
  up?.close();
  up = null;
  subscribed.clear();
  if (ticker) clearInterval(ticker);
  ticker = undefined;
}

async function perpsSymbols(): Promise<string[]> {
  return (await symbols('perps')).map((s) => s.name).filter(Boolean);
}

/** Pick up newly listed markets without touching the existing subscription. */
async function refreshSymbols(): Promise<void> {
  symbolsCheckedAt = Date.now();
  if (!up) return;
  const fresh = (await perpsSymbols()).filter((s) => !subscribed.has(s));
  if (!fresh.length) return;
  up.subscribe({ channel: 'trade', symbols: fresh });
  for (const s of fresh) subscribed.add(s);
}

async function ensureFeed(): Promise<void> {
  lastUsed = Date.now();
  if (up) {
    if (Date.now() - symbolsCheckedAt > SYMBOL_REFRESH_MS) void refreshSymbols().catch(() => {});
    return;
  }
  if (starting) return starting;
  // A start that just failed is not repeated for every request that follows it.
  if (startError && Date.now() - startFailedAt < START_RETRY_MS) throw startError;
  starting = (async () => {
    const list = await perpsSymbols();
    if (!list.length) throw new Error('SoDEX returned no perps symbols to subscribe to');
    const u = new Upstream('perps');
    u.on('push', onPush);
    u.on('upstream-error', (err: Error) => {
      lastError = err?.message ?? String(err);
    });
    u.subscribe({ channel: 'trade', symbols: list });
    for (const s of list) subscribed.add(s);
    up = u;
    startedAt = Date.now();
    symbolsCheckedAt = startedAt;
    ticker = setInterval(() => {
      drain();
      if (Date.now() - lastUsed > IDLE_STOP_MS) stop();
    }, 1_000);
    ticker.unref?.();
    startError = null;
  })().catch((e: unknown) => {
    startFailedAt = Date.now();
    startError = e ?? new Error('SoDEX whale feed failed to start');
    lastError = e instanceof Error ? e.message : String(e);
    throw e;
  }).finally(() => {
    starting = null;
  });
  return starting;
}

/** Tests: the feed as it is before its first use (closes the socket if one is open). */
export function resetWhaleFeed(): void {
  stop();
  ring.length = 0;
  notInIndex.clear();
  startFailedAt = 0;
  startError = null;
  lastError = null;
  symbolsCheckedAt = 0;
}

export const whaleFeedStats = () => ({
  running: up !== null,
  status: up?.status ?? 'closed',
  startedAt: startedAt || null,
  symbols: subscribed.size,
  printsSeen,
  buffered: ring.length,
  pending: aggregator.size,
  lastError,
});

/** Newest first, `notional >= max(minUsd, $10k)`. */
export async function whales(minUsd: number, limit: number): Promise<WhaleTrade[]> {
  await ensureFeed();
  drain();
  const floor = Math.max(minUsd, WHALE_FLOOR_USD);
  const picked: WhaleAgg[] = [];
  for (let i = ring.length - 1; i >= 0 && picked.length < limit; i--) {
    if (ring[i]!.notional >= floor) picked.push(ring[i]!);
  }
  const ids = picked.map((a) => a.accountId);
  seedFromIndex(ids);
  const addresses = await resolveIds(ids, RESOLVE_WAIT_MS);
  return picked.map((a) => ({
    venue: 'sodex',
    time: a.time,
    symbol: a.symbol,
    side: a.side,
    // Volume-weighted over the prints of the order.
    px: a.sz > 0 ? a.notional / a.sz : 0,
    sz: a.sz,
    notional: a.notional,
    address: addresses.get(a.accountId) ?? null,
    accountId: a.accountId,
  }));
}
