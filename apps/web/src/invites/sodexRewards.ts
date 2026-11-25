/**
 * A wallet's referral rewards on SoDEX - the USDC fee rebates and the SoPoints - read from SoDEX itself with the wallet's
 * own sign-in (the one the SoPoints page uses, pointsAuth.ts), from this browser straight to alpha-biz.sodex.dev.
 *
 * WHERE EACH FIGURE COMES FROM, as SoDEX's own referral page reads them (its bundle, 2026-11-25):
 *   biz/referral/myStats         earnedRewardsOnChain (all rebates made claimable so far), pendingRewards (not yet),
 *                                totalFeesEarned, the $2,000 volume that unlocks the programme, the weekly invite limit
 *   biz/referral/myClaimHistory  every claim: its transaction and time. Its `fees` is NOT the claim's amount (2026-11-26: it
 *                                carried the wallet's running total in raw units, 610228924 for a claim of 1.97242); the
 *                                amount is read from the claim's own transaction (the contract's Claimed event)
 *   biz/referral/myList          every invitee: volume, fees, the rebate and the SoPoints it earned this wallet
 *   the rewards contract         getClaimedAmount, public on ValueChain: what this wallet claimed (no sign-in needed)
 *   claimable                  = max(0, earnedRewardsOnChain - getClaimedAmount), as SoDEX's page works it out
 *   biz/sopoints/…/week/list     the SoPoints of every week of both seasons (soPointsV2.ts)
 *
 * SoDEX's rules (its FAQ): pending rebates are fixed every Saturday 00:00 UTC and become claimable every Tuesday 12:00
 * UTC, from $1.00 on. A claim (biz/airdrop/v1/referral_claim) takes no address: SoDEX pays the signed-in wallet, on chain,
 * without a signature or gas. Nothing here goes through a server of ours.
 */
import { claimWindow } from '@sign/invites/claim';
import { authed, authedPost } from '../points';
import { VALUECHAIN_RPC, rpcCall } from '../trading/rpc';

const BIZ = 'https://alpha-biz.sodex.dev';
/** SoDEX's referral rewards contract on ValueChain, the epoch its page reads, and ValueChain's USDC. */
export const REWARDS_CONTRACT = '0x4e0cED3cb2775a82718F9A29C5F86A34169958eC';
export const REWARDS_EPOCH = 2;
export const REWARDS_USDC = '0xcb7F80Dff2727c791fA491722c428e6657f7e2c6';
/** keccak256('getClaimedAmount(uint256,address,address)'), first 4 bytes (checked against the live contract in the test). */
export const CLAIMED_SELECTOR = '0x8383aa93';
/** SoDEX's smallest claim. */
export const MIN_CLAIM_USD = 1;

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number.parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
};
/** Milliseconds from what SoDEX sends for a time: ms, seconds or an ISO string. Null when it is none of them. */
export function timeMs(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

export interface SodexStats {
  /** Every rebate SoDEX made claimable so far, claimed ones included, USD. */
  settledUsd: number;
  pendingUsd: number;
  /** SoDEX's own total ("claimed + pending rewards"). */
  totalUsd: number;
  /** The programme is unlocked: enough volume or vault stake. */
  unlocked: boolean;
  volumeUsd: number;
  volumeNeededUsd: number;
  traders: number;
  weekInvites: number | null;
  weekInvitesMax: number | null;
  nextAt: number | null;
  code: string | null;
  referredBy: string | null;
}

export function parseStats(d: Record<string, unknown>): SodexStats {
  const ref = (d.referrerState ?? {}) as { stage?: string; data?: { code?: string; totalReferrals?: unknown } };
  const ready = ref.stage === 'ready';
  const cum = num(d.cumVlm);
  const need = num(d.vlmThreshold);
  const max = d.maxInvitesPerWeek === null || d.maxInvitesPerWeek === undefined ? null : num(d.maxInvitesPerWeek);
  return {
    settledUsd: num(d.earnedRewardsOnChain),
    pendingUsd: num(d.pendingRewards),
    totalUsd: num(d.totalFeesEarned),
    // SoDEX's own test (its NV): either requirement.
    unlocked: cum >= need || num(d.vaultNetStake) >= num(d.vaultNetStakeThreshold),
    volumeUsd: cum,
    volumeNeededUsd: need,
    traders: ready ? num(ref.data?.totalReferrals) : 0,
    weekInvites: max === null ? null : num(d.weeklyInviteCount),
    weekInvitesMax: max,
    nextAt: timeMs(d.nextAvailableTime),
    code: ready && ref.data?.code ? ref.data.code : null,
    referredBy: ((d.referredBy ?? null) as { code?: string } | null)?.code || null,
  };
}

/** One USDC claim. `usd`: from its transaction on chain; null until read, or when it cannot be. */
export interface SodexClaim { usd: number | null; at: number; tx: string | null }
export function parseClaims(d: unknown): { total: number; list: SodexClaim[] } {
  const o = (d ?? {}) as { total?: unknown; list?: unknown };
  const list = (Array.isArray(o.list) ? o.list : []) as Array<Record<string, unknown>>;
  return {
    total: num(o.total),
    list: list.flatMap((r) => {
      const at = timeMs(r.time);
      return at === null ? [] : [{ usd: null, at, tx: typeof r.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(r.txHash) ? r.txHash.toLowerCase() : null }];
    }),
  };
}

/** keccak256('Claimed(uint256,address,address,uint256,bool)'): epoch, user and token indexed; amount and a flag in the data. */
export const CLAIMED_TOPIC = '0x0be0cb7a90a777a82578b63bfbffd13e1ed78edd777c27b5a7779fbdba198a54';
interface Log { address?: string; topics?: string[]; data?: string }
/** The USDC a transaction's Claimed event paid this wallet, or null when it holds none. */
export function claimedIn(logs: readonly Log[], wallet: string): number | null {
  const user = word(wallet);
  let micro = 0n;
  let found = false;
  for (const l of logs) {
    if (l.address?.toLowerCase() !== REWARDS_CONTRACT.toLowerCase() || l.topics?.[0]?.toLowerCase() !== CLAIMED_TOPIC) continue;
    if (l.topics[2]?.replace(/^0x/, '').toLowerCase() !== user || l.topics[3]?.replace(/^0x/, '').toLowerCase() !== word(REWARDS_USDC)) continue;
    const amount = (l.data ?? '').replace(/^0x/, '').slice(0, 64);
    if (!/^[0-9a-fA-F]{64}$/.test(amount)) continue;
    micro += BigInt(`0x${amount}`);
    found = true;
  }
  return found ? Number(micro) / 1e6 : null;
}
const TX_KEY = (tx: string) => `vd.sodex.claimtx.${tx.toLowerCase()}`;
/** A claim transaction's amount, from the chain (kept: a mined transaction does not change). */
export async function claimAmount(tx: string, wallet: string, call: typeof rpcCall = rpcCall): Promise<number | null> {
  try {
    const kept = localStorage.getItem(TX_KEY(tx));
    if (kept !== null && Number.isFinite(Number(kept))) return Number(kept);
  } catch { /* private mode */ }
  try {
    const r = await call<{ status?: string; logs?: Log[] } | null>(VALUECHAIN_RPC, 'eth_getTransactionReceipt', [tx]);
    if (!r.result || r.result.status !== '0x1') return null;
    const usd = claimedIn(r.result.logs ?? [], wallet);
    if (usd !== null) try { localStorage.setItem(TX_KEY(tx), String(usd)); } catch { /* private mode */ }
    return usd;
  } catch {
    return null;
  }
}

/** One invitee on SoDEX. */
export interface SodexTrader { wallet: string; volumeUsd: number; rebateUsd: number; points: number; at: number | null }
export function parseTraders(d: unknown): { total: number; list: SodexTrader[] } {
  const o = (d ?? {}) as { total?: unknown; list?: unknown };
  const list = (Array.isArray(o.list) ? o.list : []) as Array<Record<string, unknown>>;
  return {
    total: num(o.total),
    list: list.filter((r) => typeof r.inviteeWallet === 'string').map((r) => ({
      wallet: String(r.inviteeWallet).toLowerCase(), volumeUsd: num(r.volume), rebateUsd: num(r.yourRewardedFees), points: num(r.yourRewardedPoints), at: timeMs(r.referralTime),
    })),
  };
}

/** What can be claimed now: SoDEX's own arithmetic. Null while what was claimed is not known. */
export const claimableOf = (settledUsd: number, claimedUsd: number | null): number | null => (claimedUsd === null ? null : Math.max(0, settledUsd - claimedUsd));
/** Cents, rounded down: never a cent more than SoDEX pays. */
export const floorCents = (usd: number): number => Math.floor(usd * 100 + 1e-6) / 100;

/* ------------------------------------------------------------------------------------ reads ----- */

const POST_PAGE = 50; // the largest page SoDEX's own table asks for
/** Pages of a SoDEX list, all of them (at most 20: 2,000 rows). */
async function allPages<T>(read: (page: number) => Promise<{ total: number; list: T[] }>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await read(page);
    out.push(...r.list);
    if (!r.list.length || out.length >= r.total) break;
  }
  return out;
}

export const fetchStats = (a: string): Promise<SodexStats> => authedPost<Record<string, unknown>>(`${BIZ}/biz/referral/myStats?wallet_address=${a}`, a).then((d) => parseStats(d ?? {}));
/** Every claim, each with its amount from its transaction. */
export async function fetchClaims(a: string, call: typeof rpcCall = rpcCall): Promise<SodexClaim[]> {
  const list = await allPages((page) => authedPost<unknown>(`${BIZ}/biz/referral/myClaimHistory?wallet_address=${a}`, a, { page, pageSize: POST_PAGE }).then(parseClaims));
  const out: SodexClaim[] = [];
  for (let i = 0; i < list.length; i += 4) {
    const part = list.slice(i, i + 4);
    out.push(...await Promise.all(part.map(async (c) => ({ ...c, usd: c.tx ? await claimAmount(c.tx, a, call) : null }))));
  }
  return out;
}
export const fetchTraders = (a: string): Promise<SodexTrader[]> => allPages((page) => authedPost<unknown>(`${BIZ}/biz/referral/myList?wallet_address=${a}`, a, { page, pageSize: POST_PAGE, hideZeroReward: false }).then(parseTraders));

const word = (hex: string): string => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
/** The call's data for getClaimedAmount(epoch, wallet, USDC). */
export const claimedCall = (wallet: string): string => `${CLAIMED_SELECTOR}${word(REWARDS_EPOCH.toString(16))}${word(wallet)}${word(REWARDS_USDC)}`;
/** USDC this wallet claimed from SoDEX's referral rewards so far (public, on chain). Null: the chain did not answer. */
export async function fetchClaimed(wallet: string, call: typeof rpcCall = rpcCall): Promise<number | null> {
  try {
    const r = await call<string>(VALUECHAIN_RPC, 'eth_call', [{ to: REWARDS_CONTRACT, data: claimedCall(wallet) }, 'latest']);
    return r.result && /^0x[0-9a-f]+$/i.test(r.result) ? Number(BigInt(r.result)) / 1e6 : null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------------------------- the claim ----- */

export class SodexClaimError extends Error {
  constructor(message: string, readonly kind: 'claimed' | 'busy' | 'failed' | 'slow') {
    super(message);
  }
}

const RECEIPT_TRIES = 60;
/**
 * Claim the USDC rebates: SoDEX sends them to the signed-in wallet. Only ever called from the Claim button. `usd`: what the
 * transaction paid, from the chain (null when it cannot be read; SoDEX's own `amount` is not trusted for it).
 */
export async function claimRebates(a: string, deps: { post?: typeof authedPost; call?: typeof rpcCall; wait?: (ms: number) => Promise<void> } = {}): Promise<{ usd: number | null; tx: string | null }> {
  const post = deps.post ?? authedPost;
  const call = deps.call ?? rpcCall;
  const wait = deps.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let d: { results?: Array<{ amount?: unknown; status?: unknown; txHash?: unknown }> } | null;
  try {
    d = await post(`${BIZ}/biz/airdrop/v1/referral_claim`, a, {});
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === -3001111) throw new SodexClaimError('SoDEX says this was claimed already.', 'claimed');
    if (code === -3000010) throw new SodexClaimError('SoDEX is busy. Try again in a minute.', 'busy');
    throw e;
  }
  const r = d?.results?.[0];
  if (!r) throw new SodexClaimError('SoDEX returned no claim.', 'failed');
  const tx = typeof r.txHash === 'string' && r.txHash ? r.txHash : null;
  const paid = async (): Promise<number | null> => (tx ? claimAmount(tx, a, call) : null);
  // SoDEX's statuses: 2 paid, 1 sent.
  if (Number(r.status) === 2) return { usd: await paid(), tx };
  if (Number(r.status) === 1 && tx) {
    for (let i = 0; i < RECEIPT_TRIES; i++) {
      const rc = await call<{ status?: string; logs?: Log[] } | null>(VALUECHAIN_RPC, 'eth_getTransactionReceipt', [tx]).catch(() => ({ result: null }));
      if (rc.result) {
        if (rc.result.status === '0x1') return { usd: claimedIn(rc.result.logs ?? [], a), tx };
        throw new SodexClaimError('The payment failed on chain. Nothing was claimed; try again.', 'failed');
      }
      await wait(2_000);
    }
    throw new SodexClaimError('SoDEX sent it, but the chain has not confirmed it yet. Look again in a few minutes.', 'slow');
  }
  throw new SodexClaimError('SoDEX could not pay it. Try again later.', 'failed');
}

/* ---------------------------------------------------------------------------- totals over time ----- */

/**
 * SoDEX keeps no history of rebates as they accrue: it dates the claims, and says the total now. So the line is made of
 * what is known for sure - what had been claimed by each claim, the totals this browser saw on earlier visits, what was made
 * claimable on the last Tuesday, and the total now - and at every moment shows the most that was certainly earned by then.
 * It never guesses between two points.
 *
 * The Tuesday: SoDEX puts the week's rewards on chain once a week, on Tuesday before 12:00 UTC, and not in between (the
 * contract's root updates of 2026-11-03, -10, -17 and -24: 09:38 to 10:51 UTC, no other). So what is settled now has been
 * since the last Tuesday 12:00 UTC - except in the hours before 12:00 on a Tuesday, when the next one may be in already.
 */
const SETTLE_LEAD_MS = 8 * 3_600_000;
export function settledPoint(settledUsd: number, now: number): LinePoint | null {
  const w = claimWindow(now);
  return settledUsd > 0 && w.closesAt - now > SETTLE_LEAD_MS ? { t: w.opensAt, v: settledUsd } : null;
}

export interface SeenTotal { t: number; usd: number }
const SEEN = (a: string) => `vd.sodex.rebates.${a.toLowerCase()}`;
const SEEN_MAX = 400;

export function readSeen(a: string): SeenTotal[] {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN(a)) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is SeenTotal => !!x && Number.isFinite((x as SeenTotal).t) && Number.isFinite((x as SeenTotal).usd)) : [];
  } catch {
    return [];
  }
}
/** Keep today's total, one a UTC day (the newest). */
export function noteSeen(a: string, usd: number, now = Date.now()): SeenTotal[] {
  const d = Math.floor(now / 86_400_000);
  const out = [...readSeen(a).filter((x) => Math.floor(x.t / 86_400_000) !== d), { t: now, usd }].sort((x, y) => x.t - y.t).slice(-SEEN_MAX);
  try { localStorage.setItem(SEEN(a), JSON.stringify(out)); } catch { /* private mode */ }
  return out;
}

export interface LinePoint { t: number; v: number }
/** The USDC line, oldest first, never falling. `nowUsd`: claimed, claimable and pending together; `settled`: see settledPoint. */
export function usdcLine(claims: readonly SodexClaim[], seen: readonly SeenTotal[], nowUsd: number, now: number, settled: LinePoint | null = null): LinePoint[] {
  const xs: LinePoint[] = [];
  let cum = 0;
  // A claim whose amount is not known adds nothing: the line stays at what is certain.
  for (const c of [...claims].sort((a, b) => a.at - b.at)) { if (c.usd === null) continue; cum += c.usd; xs.push({ t: c.at, v: cum }); }
  for (const s of seen) if (s.t <= now) xs.push({ t: s.t, v: s.usd });
  if (settled && settled.t <= now) xs.push(settled);
  xs.sort((a, b) => a.t - b.t);
  const out: LinePoint[] = [];
  let top = 0;
  for (const p of xs) if (p.v > top + 1e-9) { top = p.v; out.push({ t: p.t, v: top }); }
  // A total now below what was seen (SoDEX corrected it) is shown as it is now: earlier points come down to it.
  if (nowUsd < top) return [...out.map((p) => ({ t: p.t, v: Math.min(p.v, nowUsd) })).filter((p, i, a) => i === 0 || p.v > a[i - 1]!.v), { t: now, v: nowUsd }];
  return [...out, { t: now, v: nowUsd }];
}
