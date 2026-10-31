/**
 * Reads of SoDEX that confirm one another.
 *
 * SoDEX's gateway answers one account from backends that disagree (mainnet,
 * 2026-10-29 ~20:55 UTC, behind Cloudflare FRA): of six reads of GET
 * /perps/accounts/{a}/state seconds apart, four showed a BTC-USD position
 * closed minutes before (its fills prove the account flat, and SoDEX's matching
 * refuses a reduce-only close of it: "position not found") while the marks and
 * the equity in them were fresh; GET /user/{a}/api-keys alternated with a list
 * 17 minutes old; the order history and the trades lagged the fills by tens of
 * seconds. Nothing in a header or the body tells the backends apart.
 *
 * So one read that shows a change nobody here made proves nothing. It is acted
 * on only when CONFIRM_READS more reads, CONFIRM_GAP_MS apart, agree with it;
 * on any disagreement nothing is done this round. The confirming reads are made
 * only then - a state read is weight 5 of SoDEX's per-IP limit a minute
 * (6,000 on 2026-10-31) - never on every tick.
 */
import { sleep } from './io.ts';

/** Reads made after the one that showed a change, before it is acted on. */
export const CONFIRM_READS = 2;
/** The pause before each of them. */
export const CONFIRM_GAP_MS = 2_000;

export type Confirmed<T> =
  /** Every read agreed: the last of them (the freshest). */
  | { ok: true; value: T }
  /** They did not (or one failed): what each read showed, for the log. */
  | { ok: false; seen: string[] };

/**
 * `first` confirmed by `reads` more reads: each must show the same `view` (what
 * the caller is about to act on, e.g. the sizes of the markets that changed).
 * A read that fails confirms nothing. `gapMs` 0 (tests) reads at once.
 */
export async function confirmRead<T>(first: T, read: () => Promise<T>, view: (t: T) => string, o: { reads?: number; gapMs?: number } = {}): Promise<Confirmed<T>> {
  const want = view(first);
  const seen = [want];
  let last = first;
  for (let i = 0; i < (o.reads ?? CONFIRM_READS); i++) {
    const gap = o.gapMs ?? CONFIRM_GAP_MS;
    if (gap > 0) await sleep(gap);
    try {
      last = await read();
    } catch (e) {
      seen.push(`read failed: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`);
      return { ok: false, seen };
    }
    const v = view(last);
    seen.push(v);
    if (v !== want) return { ok: false, seen };
  }
  return { ok: true, value: last };
}

/** A position size as a confirming read compares it (12 significant digits: float noise is not a disagreement). */
export const sizeView = (n: number | null | undefined): string => (n === null || n === undefined ? 'unread' : String(Number((n || 0).toPrecision(12))));
