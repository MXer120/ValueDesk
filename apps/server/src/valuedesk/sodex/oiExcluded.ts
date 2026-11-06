/**
 * What SoDEX's open interest leaves out on our pages (owner, 2026-11-06: "dont display the pair only
 * the others"): SoDEX's own internal pair (internalWallets.ts) holds ~98% of it. SoDEX counts both
 * sides of a position in its figure (BTC 1816.4 with legs -895.34 and +895.34), so what the others
 * hold is the figure less each leg's absolute size - not twice one leg: a few markets do not offset
 * exactly (SPCX, CXMT on 2026-11-06).
 *
 * Read from SoDEX itself, not from the cohort books. Every read must succeed and say what it holds:
 * a failure or an answer without a list is an error, never zeros, since zeros would print the
 * inflated figure as if it were the others'. A failure is not cached, so the next asker tries again.
 */
import { EXCLUDED_WALLETS } from '../internalWallets.js';
import { gwGet } from './gateway.js';
import { TtlCache } from './util.js';

export interface SodexOiExcluded {
  /** Symbol (`BTC-USD`) -> coins to take off SoDEX's open interest. A market the pair does not hold is absent. */
  sizes: Record<string, number>;
  /** When the reads started (ms). */
  at: number;
}

const TTL_MS = 15_000;

/** SoDEX's own accounts, as internalWallets.ts flags them. */
export const sodexInternalAddresses = (): string[] =>
  EXCLUDED_WALLETS.filter((w) => w.venue === 'sodex' && w.kind === 'internal').map((w) => w.address);

/** One account's answer added to `sizes`. Throws on anything but a list of positions with a size each. */
function addPositions(sizes: Record<string, number>, address: string, body: unknown): void {
  const list = (body as { positions?: unknown } | null)?.positions;
  if (!Array.isArray(list)) throw new Error(`SoDEX sent no position list for ${address}`);
  for (const p of list as Array<{ symbol?: unknown; size?: unknown }>) {
    const size = typeof p?.size === 'string' && p.size.trim() !== '' ? Number(p.size) : Number.NaN;
    if (typeof p?.symbol !== 'string' || !p.symbol || !Number.isFinite(size)) {
      throw new Error(`SoDEX sent an unreadable position for ${address}`);
    }
    if (size !== 0) sizes[p.symbol] = (sizes[p.symbol] ?? 0) + Math.abs(size);
  }
}

/** Every account read, all or nothing. */
export async function readOiExcluded(
  get: (path: string) => Promise<unknown>,
  addresses: readonly string[],
  now: () => number = Date.now,
): Promise<SodexOiExcluded> {
  if (!addresses.length) throw new Error('No SoDEX internal accounts are flagged');
  const at = now();
  const bodies = await Promise.all(addresses.map((a) => get(`/api/v1/perps/accounts/${a}/positions`)));
  const sizes: Record<string, number> = {};
  bodies.forEach((b, i) => addPositions(sizes, addresses[i]!, b));
  return { sizes, at };
}

const cache = new TtlCache(1);

/** The sizes, held 15 s (one read at a time, however many ask); a failed read is thrown and not kept. */
export const sodexOiExcluded = (): Promise<SodexOiExcluded> =>
  cache.wrap('oi-excluded', TTL_MS, () => readOiExcluded((p) => gwGet<unknown>(p), sodexInternalAddresses()));
