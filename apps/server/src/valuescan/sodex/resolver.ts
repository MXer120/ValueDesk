/**
 * SoDEX account id -> owner wallet address.
 *
 * Trade prints carry only numeric account ids (`bi`/`si`). An id never changes
 * owner, so every answer is cached for the life of the process. Sources, in
 * order (research 01 §1, 04 §3.6):
 *
 *  1. anything we already saw pair an id with an address (leaderboard rows,
 *     account state reads) - free;
 *  2. SoDEX's bulk resolver, `POST https://sodex.dev/{net}/chain/users/addresses`
 *     with `{"userIds":[...]}` (500 ids per call verified). Ids it does not know
 *     are simply absent from the answer;
 *  3. if that host fails, the on-chain resolver in sodex/chain.ts
 *     (`resolveAccountOnChain`, owner lookup + round trip + corroboration), for a
 *     handful of ids at a time, and only its verified answers.
 *
 * Account ids and user ids are the same numbers today (no sub-accounts exist;
 * getNextUserId ~= getNextAccountId), which is why the bulk resolver's
 * `userIds` accepts the ids from trade prints.
 */
import { NETWORK } from '../../config.js';
import { resolveAccountOnChain } from '../../sodex/chain.js';
import { lowerAddress } from './mappers.js';
import { isRateLimit, noteRateLimited, sleep } from './util.js';

const BULK_URL = `https://sodex.dev/${NETWORK === 'testnet' ? 'testnet' : 'mainnet'}/chain/users/addresses`;
const BULK_MAX = 500;
/** Collect ids this long before sending, so a burst of prints becomes one call. */
const BATCH_DELAY_MS = 60;
/** An id the resolvers could not answer is not asked about again for this long. */
const NEGATIVE_TTL_MS = 10 * 60_000;
/** After a failed lookup (host down, rate limited) ids are retried sooner. */
const RETRY_AFTER_FAILURE_MS = 60_000;
/** On-chain fallback is 2 RPC calls + 1 GET per id; keep it to a trickle. */
const ONCHAIN_PER_BATCH = 3;

const known = new Map<number, string>();
const unknownUntil = new Map<number, number>();
const queued = new Set<number>();
const inFlight = new Set<number>();
const waiters = new Map<number, Array<() => void>>();
let timer: NodeJS.Timeout | undefined;
let flushing = false;

/** Record an id/address pair seen elsewhere (leaderboard, account state). */
export function seedAddress(accountId: unknown, address: unknown): void {
  const id = Number(accountId);
  const a = lowerAddress(address);
  if (Number.isInteger(id) && id > 0 && a) {
    known.set(id, a);
    unknownUntil.delete(id);
  }
}

export const knownAddress = (accountId: number): string | undefined => known.get(accountId);

export const resolverStats = () => ({ known: known.size, queued: queued.size, negative: unknownUntil.size });

/** Parse the bulk resolver's `data`: `[{userId: "52599", address: "0xE290..."}]`. */
export function parseBulk(data: unknown): Map<number, string> {
  const out = new Map<number, string>();
  if (!Array.isArray(data)) return out;
  for (const row of data) {
    const id = Number((row as { userId?: unknown })?.userId);
    const a = lowerAddress((row as { address?: unknown })?.address);
    if (Number.isInteger(id) && id > 0 && a) out.set(id, a);
  }
  return out;
}

async function bulkLookup(ids: number[]): Promise<Map<number, string>> {
  const res = await fetch(BULK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ userIds: ids }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (res.status === 429 || /\b1015\b/.test(text)) {
    throw Object.assign(new Error(`id resolver rate limited (HTTP ${res.status})`), { status: 429 });
  }
  let body: { code?: unknown; data?: unknown } | null = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`id resolver: non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok || !body || (body.code !== undefined && String(body.code) !== '0')) {
    throw new Error(`id resolver failed (HTTP ${res.status})`);
  }
  return parseBulk(body.data);
}

function schedule(): void {
  if (timer || flushing) return;
  timer = setTimeout(() => {
    timer = undefined;
    void flush();
  }, BATCH_DELAY_MS);
  timer.unref?.();
}

async function flush(): Promise<void> {
  if (flushing || !queued.size) return;
  flushing = true;
  const ids = [...queued].filter((id) => !known.has(id)).slice(0, BULK_MAX);
  for (const id of queued) if (known.has(id)) queued.delete(id);
  for (const id of ids) {
    queued.delete(id);
    inFlight.add(id);
  }
  try {
    let got = new Map<number, string>();
    let bulkFailed = false;
    try {
      got = await bulkLookup(ids);
    } catch (e) {
      bulkFailed = true;
      if (isRateLimit(e)) noteRateLimited();
      for (const id of ids.slice(0, ONCHAIN_PER_BATCH)) {
        const r = await resolveAccountOnChain(id).catch(() => null);
        if (r?.verified && r.address) got.set(id, r.address.toLowerCase());
      }
    }
    const now = Date.now();
    for (const id of ids) {
      const a = got.get(id);
      if (a) known.set(id, a);
      // "The resolver has no such id" is an answer; "the resolver was down" is not.
      else unknownUntil.set(id, now + (bulkFailed ? RETRY_AFTER_FAILURE_MS : NEGATIVE_TTL_MS));
    }
  } finally {
    for (const id of ids) {
      inFlight.delete(id);
      const ws = waiters.get(id);
      waiters.delete(id);
      ws?.forEach((w) => w());
    }
    // Waiters of ids that turned out to be known already (seeded meanwhile).
    for (const [id, ws] of waiters) {
      if (known.has(id)) {
        waiters.delete(id);
        ws.forEach((w) => w());
      }
    }
    flushing = false;
    if (queued.size) {
      await sleep(250); // spread consecutive batches out a little
      schedule();
    }
  }
}

function isNegative(id: number, now: number): boolean {
  const until = unknownUntil.get(id);
  if (until === undefined) return false;
  if (until > now) return true;
  unknownUntil.delete(id);
  return false;
}

/** Queue ids for resolution without waiting for the answer. */
export function prefetchIds(ids: Iterable<number>): void {
  const now = Date.now();
  let added = false;
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0 || known.has(id) || isNegative(id, now)) continue;
    if (queued.has(id) || inFlight.has(id)) continue;
    queued.add(id);
    added = true;
  }
  if (added) schedule();
}

/**
 * Resolve what can be resolved within `timeoutMs`. Ids still unknown after
 * that are simply absent from the result; they keep resolving in the
 * background and will be there next time.
 */
export async function resolveIds(ids: Iterable<number>, timeoutMs = 3_000): Promise<Map<number, string>> {
  const want = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0);
  const now = Date.now();
  const pending = want.filter((id) => !known.has(id) && !isNegative(id, now));
  if (pending.length) {
    const done = Promise.all(
      pending.map(
        (id) =>
          new Promise<void>((resolve) => {
            const list = waiters.get(id) ?? [];
            list.push(resolve);
            waiters.set(id, list);
          }),
      ),
    );
    prefetchIds(pending);
    // A flush may already be under way for an id queued earlier; its waiter is
    // released by that flush.
    await Promise.race([done, sleep(timeoutMs)]);
  }
  const out = new Map<number, string>();
  for (const id of want) {
    const a = known.get(id);
    if (a) out.set(id, a);
  }
  return out;
}
