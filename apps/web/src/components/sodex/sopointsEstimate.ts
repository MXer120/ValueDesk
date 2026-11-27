/**
 * The SoPoints estimate, asked of the server (apps/server routes/sopointsEstimate.ts). The fitted model never reaches
 * the page (owner 2026-11-27: "our formula cant be in the frontend code, it needs to be hidden"): the page sends the
 * weeks it wants priced and, signed in, the wallet's scored weeks, and gets back each plan's own points in a typical,
 * a busy and a quiet week, made the wallet's own by its past weeks (its quiet-week points, its distance from the
 * model, its usual invited points), plus what each past week earned beyond the model ("other").
 *
 * Fast (owner: "loading fast"): one request per change, the same question answered from memory, a slider's drag
 * debounced, the last answer kept on screen while the next one loads, and a wallet's last answer kept in this browser
 * so a return visit shows it at once.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnyWeek } from './soPointsV2';

export interface EstPlan {
  futures: number;
  spot?: number;
  oi?: number;
  wealth?: number;
  vault?: number;
  boostedShare?: number;
  coef?: number;
}

export interface EstWeek {
  weekNo: number;
  futures: number;
  spot: number;
  oi: number;
  wealth: number;
  vault: number;
  points: number;
  referral: number;
  bonusPct: number;
}

export interface EstBand {
  /** Own points (before invited points and the squad's boost) in a typical week, a busy one and a quiet one. */
  mid: number;
  busy: number;
  quiet: number;
  parts: { futures: number; spot: number; oi: number; wealth: number; vault: number; extra: number };
}

export interface EstCalib {
  ratio: number;
  extra: number;
  referral: number;
  weeks: number;
  rows: Array<{ weekNo: number; own: number; explained: number; other: number }>;
}

export interface EstAnswer {
  model: { fittedOn: string; fittedAt: string };
  plans: EstBand[];
  calib: EstCalib | null;
}

/** A wallet's scored Layer 1 weeks as the estimate reads them (SoDEX's own rows, newest 40). */
export function estWeeks(all: readonly AnyWeek[]): EstWeek[] {
  return all
    .filter((w) => w.season === 'L1' && w.split.week.pointsStatus === 'CONFIRMED' && !w.split.week.isLive)
    .slice(-40)
    .map((w) => {
      const k = w.split.week;
      return {
        weekNo: k.weekNo,
        futures: k.futuresVolume || 0,
        spot: k.spotVolume || 0,
        oi: k.oi ?? 0,
        wealth: k.wealthTvl ?? 0,
        vault: k.vaultHolding ?? 0,
        points: k.points || 0,
        referral: k.referralPoints || 0,
        bonusPct: k.totalBonusPct ?? 0,
      };
    });
}

/* ------------------------------------------------------------------------------------ the request ----- */

const memo = new Map<string, Promise<EstAnswer | null>>();
const MEMO_MAX = 200;

/** The server's answer, or null (no model, offline, refused). The same body is asked once. */
export function fetchEstimate(plans: readonly EstPlan[], weeks: readonly EstWeek[] | null): Promise<EstAnswer | null> {
  const body = JSON.stringify(weeks && weeks.length ? { plans, weeks } : { plans });
  const hit = memo.get(body);
  if (hit) return hit;
  const p = fetch('/api/vs/sopoints/estimate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', body })
    .then(async (r) => {
      if (!r.ok) return null;
      const j = (await r.json()) as { ok?: boolean } & Partial<EstAnswer>;
      return j.ok && Array.isArray(j.plans) && j.model ? { model: j.model, plans: j.plans, calib: j.calib ?? null } : null;
    })
    .catch(() => null);
  memo.set(body, p);
  // A failure is asked again next time; the memory stays bounded.
  void p.then((a) => { if (!a) memo.delete(body); });
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!);
  return p;
}

const KEEP = 'vs.sp.est.';
const kept = (key: string | null): EstAnswer | null => {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(KEEP + key);
    return raw ? (JSON.parse(raw) as EstAnswer) : null;
  } catch {
    return null;
  }
};
const keep = (key: string | null, a: EstAnswer) => {
  if (!key) return;
  try { localStorage.setItem(KEEP + key, JSON.stringify(a)); } catch { /* storage full or off: the next visit asks again */ }
};

export interface EstState {
  data: EstAnswer | null;
  /** A newer answer is on its way (the shown one is the last). */
  loading: boolean;
  /** The server gave no estimate (no model there, offline): the page shows none. */
  failed: boolean;
}

/**
 * Plans priced by the server. `null` plans: nothing asked. The first answer is asked at once, later changes after
 * `debounceMs`; `keepKey` keeps the last answer in this browser for the next visit (a wallet's address, a page's name).
 */
export function useEstimate(plans: readonly EstPlan[] | null, weeks: readonly EstWeek[] | null, opts: { debounceMs?: number; keepKey?: string | null } = {}): EstState {
  const key = useMemo(() => (plans ? JSON.stringify([plans, weeks ?? null]) : null), [plans, weeks]);
  const keepKey = opts.keepKey ?? null;
  const [st, setSt] = useState<EstState>(() => ({ data: kept(keepKey), loading: !!plans, failed: false }));
  const first = useRef(true);
  useEffect(() => {
    if (!key || !plans) return;
    let live = true;
    setSt((s) => ({ ...s, loading: true }));
    const go = () => {
      void fetchEstimate(plans, weeks).then((a) => {
        if (!live) return;
        if (a) keep(keepKey, a);
        setSt((s) => ({ data: a ?? s.data, loading: false, failed: !a && !s.data }));
      });
    };
    const wait = first.current ? 0 : opts.debounceMs ?? 0;
    first.current = false;
    const t = wait ? window.setTimeout(go, wait) : (go(), 0);
    return () => { live = false; if (t) window.clearTimeout(t); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  // A different kept answer (another wallet) shows at once.
  useEffect(() => { const k = kept(keepKey); if (k) setSt((s) => ({ ...s, data: k })); }, [keepKey]);
  return st;
}
