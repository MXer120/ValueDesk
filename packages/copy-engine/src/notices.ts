/**
 * What a follower should hear of, from either engine, as one notice: an algo that failed,
 * was stopped or held without being asked, or finished; a copy halted, blocked, paused or
 * stopped without being asked, or a copied position closed by its stop or outside the copier.
 * What the follower did themself (pause, cancel, stop) is not a notice - they know.
 *
 * The engines raise it through their host (AlgoHost / CopyHost `onNotice`): the browser puts it
 * in the bell and, once the wallet is verified, in its inbox on the server; the executor keeps
 * it for the wallet (its notices table) to be read after signing in.
 */
import type { AlgoRecord, AlgoStatus } from './algo/types.ts';
import { ALGO_NAMES } from './algo/spec.ts';
import type { AssetVerdict, Subscription, SubscriptionStatus } from './types.ts';

/** How much it matters: info (finished, closed by its stop), warn (stopped or held by the engine), error (failed, halted, a position closed outside). */
export type NoticeGrade = 'info' | 'warn' | 'error';
export type NoticeSource = 'algo' | 'copy';
export type NoticeKind = 'done' | 'ended' | 'failed' | 'stopped' | 'held' | 'halted' | 'blocked' | 'paused' | 'closed' | 'different-asset' | 'same-asset';

export interface EngineNotice {
  /** Stable for one event: `${source}:${ref}:${kind}:${at}` - a repeat is the same notice. */
  id: string;
  /** The wallet it is about (lower case). */
  owner: string;
  source: NoticeSource;
  /** The algo or copy id. */
  ref: string;
  kind: NoticeKind;
  grade: NoticeGrade;
  title: string;
  body: string;
  at: number;
  /** A paper algo or copy: nothing was sent. */
  paper: boolean;
}

/** The leader as the bell shows it: 0x1234…abcd. */
const leaderShort = (s: Subscription): string => `${s.settings.leader.address.slice(0, 6)}…${s.settings.leader.address.slice(-4)}`;

const mk = (n: Omit<EngineNotice, 'id'>): EngineNotice => ({ ...n, id: `${n.source}:${n.ref}:${n.kind}:${n.at}` });

/** "TWAP buy on BTC-USD", "Basket of 3 markets". */
export function algoName(a: AlgoRecord): string {
  const s = a.spec;
  if (s.kind === 'basket') return `Basket of ${s.legs.length} markets`;
  return `${ALGO_NAMES[s.kind]} ${'side' in s && s.side === 'sell' ? 'sell' : 'buy'} on ${'symbol' in s ? s.symbol : ''}`.trim();
}

/** An algo's status change as a notice, or null for what needs none (it runs, or the follower did it). */
export function algoNotice(a: AlgoRecord, status: AlgoStatus, reason: string | null, at = Date.now()): EngineNotice | null {
  const what = algoName(a);
  const body = reason ?? '';
  const base = { owner: a.owner, source: 'algo' as const, ref: a.id, body, at, paper: !!a.spec.paper };
  switch (status) {
    case 'failed': return mk({ ...base, kind: 'failed', grade: 'error', title: `${what} failed` });
    case 'cancelled':
      return /^Cancelled by you/.test(body) ? null : mk({ ...base, kind: 'stopped', grade: 'warn', title: `${what} stopped` });
    case 'expired': return mk({ ...base, kind: 'ended', grade: 'info', title: `${what} ended` });
    case 'done': return mk({ ...base, kind: 'done', grade: 'info', title: `${what} done` });
    case 'paused':
      return /^Paused by you/.test(body) ? null : mk({ ...base, kind: 'held', grade: 'warn', title: `${what} paused` });
    default: return null;
  }
}

/** A copy's status change as a notice, or null (it went on, or the follower did it). */
export function copyNotice(s: Subscription, status: SubscriptionStatus, reason: string | null, at = Date.now()): EngineNotice | null {
  const body = reason ?? '';
  const who = leaderShort(s);
  const base = { owner: s.owner, source: 'copy' as const, ref: s.id, body, at, paper: !!s.settings.paper };
  switch (status) {
    case 'halted': return mk({ ...base, kind: 'halted', grade: 'error', title: `Copy of ${who} halted` });
    case 'blocked': return mk({ ...base, kind: 'blocked', grade: 'warn', title: `Copy of ${who} is held` });
    case 'stopped':
      return /^Stopped by you/.test(body) ? null : mk({ ...base, kind: 'stopped', grade: 'warn', title: `Copy of ${who} stopped` });
    case 'paused':
      return /^Paused by you/.test(body) ? null : mk({ ...base, kind: 'paused', grade: 'warn', title: `Copy of ${who} paused` });
    default: return null;
  }
}

/** A copied position closed without the copier: by its own stop (info), or outside it - by the follower or SoDEX, a liquidation included (error). */
export function copyClosedNotice(s: Subscription, symbol: string, why: string, detail: string, at = Date.now()): EngineNotice {
  const who = leaderShort(s);
  const byStop = why === 'stop-loss' || why === 'take-profit';
  return mk({
    owner: s.owner, source: 'copy', ref: `${s.id}:${symbol}`, kind: 'closed', grade: byStop ? 'info' : 'error',
    title: `${symbol} closed in the copy of ${who}`, body: detail, at, paper: !!s.settings.paper,
  });
}

/** A price as the notice reads it: six significant digits. */
const px = (n: number): string => String(Number(n.toPrecision(6)));

/**
 * A leader's Hyperliquid market whose SoDEX market of the same name is a different asset
 * (warn: nothing new is copied there), or the same again once the two prices agree (info).
 */
export function copyAssetNotice(s: Subscription, leaderSymbol: string, v: AssetVerdict, at = Date.now()): EngineNotice {
  const who = leaderShort(s);
  const apart = `${(Math.abs(v.deviation) * 100).toFixed(1)}% apart`;
  const prices = `Hyperliquid's ${leaderSymbol} is at ${px(v.leaderPrice)}, SoDEX's ${v.market} at ${px(v.sodexPrice)} (${apart})`;
  const base = { owner: s.owner, source: 'copy' as const, ref: `${s.id}:${leaderSymbol}`, at, paper: !!s.settings.paper };
  return v.same
    ? mk({ ...base, kind: 'same-asset', grade: 'info', title: `${leaderSymbol} is copied again in the copy of ${who}`, body: `${prices}: the same asset again, so the leader's next changes there are copied.` })
    : mk({
        ...base, kind: 'different-asset', grade: 'warn', title: `${leaderSymbol} is not copied in the copy of ${who}`,
        body: `${prices}: not the same asset, so nothing new is opened on ${v.market}. A position the copy holds there still follows the leader's reductions and closes.`,
      });
}
