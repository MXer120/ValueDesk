/**
 * The live data the Preview and a running order's window draw from: the
 * market's recent 1-minute closes (SoDEX klines, read again every 30 s while
 * shown).
 */
import { useEffect, useState } from 'react';
import { api } from '../../api';

export type Pt = { t: number; p: number };

/** 1-minute closes over the last `minutes` (null until read), while `on`. `from` reads from a time instead (a running order's start). */
export function useHistory(symbol: string | null, on: boolean, minutes = 90, from: number | null = null): Pt[] | null {
  const [pts, setPts] = useState<Pt[] | null>(null);
  useEffect(() => {
    if (!on || !symbol) return;
    let gone = false;
    const load = () => {
      // From a start time: enough candles to cover it (SoDEX gives at most 1000), a few minutes before.
      const want = from ? Math.min(1000, Math.ceil((Date.now() - from) / 60_000) + 10) : minutes;
      api
        .klines('perps', symbol, '1m', Math.max(10, want))
        .then((r) => {
          if (gone) return;
          setPts((r.klines ?? []).map((k) => ({ t: Number(k.t), p: Number(k.c) })).filter((x) => Number.isFinite(x.t) && x.p > 0).sort((a, b) => a.t - b.t));
        })
        .catch(() => !gone && setPts((x) => x ?? []));
    };
    load();
    const t = window.setInterval(load, 30_000);
    return () => {
      gone = true;
      window.clearInterval(t);
    };
  }, [symbol, on, minutes, from]);
  return on ? pts : null;
}
