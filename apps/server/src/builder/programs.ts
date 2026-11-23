/**
 * The ValueDesk builder fee a wallet pays on each product, past its volume tier (owner 2026-11-08):
 *
 *   VIP        $1M of the wallet's own counted volume in 14 days (BuilderService.vipOf): the lowest bot fee
 *              (owner 2026-11-08: "for normal milestone hit only bot fees"); the other products keep their tier
 *   beta VIP   a wallet on the beta list, for 30 days from its listing (admin/store.ts activeFeePrograms): a VIP
 *              program, the lowest tier on every product - futures, spot, copy trading and bots
 *   programs   set on the dev page for one or many wallets: a fee (tenths of a bp, never below 0) or "VIP" on
 *              some products, from a time, until a time or until ended by hand ("VIP for 30 days", "0 for the
 *              launch week")
 *
 * The lowest of the tier, the running programs and VIP wins, per product. Nothing is stored about the result: it is
 * worked out on every read, so the moment a program ends (or a wallet stops being VIP) the tier of its volume is
 * what it pays again. Pure: the server and its tests read the same rules.
 */
import type { FeeProduct, FeeProgram } from '../admin/store.js';
import type { TiersConfig } from './config.js';
import { COPY_LADDER } from './tiers.js';

/** A program's fee that means "the lowest tier of each product" (VIP for a while). */
export const VIP_PROGRAM_FEE = -1;
/** The bot ladder's lowest step (packages/copy-engine policy.ts BOT_FEE_VIP). */
export const BOTS_VIP_FEE = 1;
/** The bot fee ladder (packages/copy-engine policy.ts BOT_FEE_LADDER), tenths of a bp by 14-day volume; kept equal by test/builderTiers.test.ts. */
export const BOT_LADDER: ReadonlyArray<{ fromUsd: number; fee: number }> = [
  // Owner 2026-11-23: 0.2 bp for everyone; 0.1 bp is VIP's (from $1M, service.ts VIP_MIN_USD).
  { fromUsd: 0, fee: 2 },
];
export function botLadderFee(volumeUsd: number): number {
  let fee = BOT_LADDER[0]!.fee;
  for (const s of BOT_LADDER) if (volumeUsd >= s.fromUsd) fee = s.fee;
  return fee;
}

/** The lowest fee of each product: the last tier of the site's file, the copy ladder's last step, the bots' VIP fee. */
export function vipFees(cfg: TiersConfig | null): Record<FeeProduct, number | null> {
  const last = cfg?.tiers[cfg.tiers.length - 1] ?? null;
  return { perps: last?.perps ?? null, spot: last?.spot ?? null, copy: COPY_LADDER[COPY_LADDER.length - 1]!.fee, bots: BOTS_VIP_FEE };
}

export interface Lowered {
  /** Per product: the fee below the tier that applies, why, and until when (null: no end). Absent: the tier. */
  fees: Partial<Record<FeeProduct, { fee: number; why: string; until: number | null }>>;
  vip: boolean;
}

/** What VIP and the running programs lower each product to (the caller takes the lower of this and the tier). */
export function lowered(programs: readonly FeeProgram[], vip: boolean, cfg: TiersConfig | null, now: number): Lowered {
  const top = vipFees(cfg);
  const out: Lowered = { fees: {}, vip };
  const offer = (p: FeeProduct, fee: number | null, why: string, until: number | null) => {
    if (fee === null || !Number.isFinite(fee)) return;
    const f = Math.max(0, Math.round(fee));
    const cur = out.fees[p];
    // The lower fee wins; at the same fee the longer one (no end counts longest).
    if (!cur || f < cur.fee || (f === cur.fee && (until === null || (cur.until !== null && until > cur.until)))) out.fees[p] = { fee: f, why, until };
  };
  if (vip) offer('bots', top.bots, 'VIP', null);
  for (const g of programs) {
    if (g.from > now || (g.until !== null && g.until <= now)) continue;
    for (const p of g.products) offer(p, g.fee === VIP_PROGRAM_FEE ? top[p] : g.fee, g.label || (g.fee === VIP_PROGRAM_FEE ? 'VIP program' : 'Fee program'), g.until);
  }
  return out;
}

/** The soonest end among the given products' lowered fees (ms), or null: what a signed fee may not outlive. */
export function soonestEnd(l: Lowered, products: readonly FeeProduct[]): number | null {
  let t: number | null = null;
  for (const p of products) {
    const u = l.fees[p]?.until;
    if (u !== null && u !== undefined && (t === null || u < t)) t = u;
  }
  return t;
}
