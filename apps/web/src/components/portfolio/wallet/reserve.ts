/**
 * What the Perps account holds and what is set aside of it (owner 2026-11-28: "change share to free margin ... anything
 * used up by bots or copy or algo orders needs to be dashed, e.g. dashed what we limit. Full sodex actual free margin";
 * "theres no allocation visible for each bot or all bots or copy").
 *
 * One read for the whole page (the All tab's bar and Perps tile, the Copy trading and Bots tabs):
 *   - SoDEX's own free margin (`availableMargin`) and the margin in use (cross + isolated + orders), verbatim;
 *   - what each copy may use (its allocation) and each real bot sets aside (bots/Allocation.ts marginOf, the same
 *     figures the Bots page and the executor's start check use) - limits ValueDesk keeps, drawn dashed;
 *   - algo orders set nothing aside in advance: the orders they have placed are already in SoDEX's margin in use, so
 *     they are counted, named, and not drawn twice.
 * Practice bots and paper copies set nothing aside. Localhost demo (devDemo.ts): sample copies and bots.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { FINAL_STATUSES, type AlgoView } from '@copy-engine';
import { copyRows, getLiveCopy, readiness, subscribeLiveCopy, useLiveCopy, type CopyRow } from '../../../copy/live';
import { useBots } from '../../../bots/useBots';
import { useAlgos } from '../../../algo/useAlgos';
import { marginCopies, marginOf, usePositionsMargin, type Allocation } from '../../bots/Allocation';
import { DEMO_BOTS, DEMO_COPY_ROWS, useDevDemo } from '../devDemo';
import type { Eip1193Provider } from '../../../wallet';
import type { PortfolioContext } from '../../Portfolio';
import { health } from './blocks';

export interface CopyLine { id: string; leader: string; venue: string; direction: 'copy' | 'counter'; allocationUsd: number; pnl: number; pnlPct: number; paper: boolean; mode: string; status: string; demo?: boolean }
export interface BotLine { id: string; label: string; symbol: string; usd: number; paper: boolean }

export interface Reserve {
  /** The Perps account value (SoDEX `av`). */
  equity: number | null;
  /** SoDEX's free margin, verbatim. */
  free: number | null;
  /** SoDEX's margin in use (positions and resting orders). */
  inUse: number | null;
  copies: CopyLine[];
  /** What the real copies may use together. */
  copyUsd: number;
  /** Real bots and what each sets aside. */
  bots: BotLine[];
  botUsd: number;
  /** Bots as the Bots tab lists them (null in the demo). */
  botViews: AlgoView[];
  botsLoading: boolean;
  signedIn: boolean;
  /** Algo orders running in this browser (their placed orders are in `inUse`). */
  algos: number;
  demo: boolean;
}

const copyLine = (r: CopyRow): CopyLine => {
  const s = r.view.subscription;
  return {
    id: s.id, leader: s.settings.leader.address, venue: s.settings.leader.venue ?? 'sodex', direction: s.settings.direction === 'counter' ? 'counter' : 'copy',
    allocationUsd: s.settings.allocationUsd, pnl: r.view.pnl, pnlPct: r.view.pnlPct, paper: !!s.settings.paper, mode: r.mode, status: s.status,
  };
};

export function useReserve(c: PortfolioContext, provider: Eip1193Provider | null): Reserve {
  const demo = useDevDemo();
  const owner = c.readOnly ? null : c.address;
  const live = useLiveCopy(owner, provider);
  const store = useSyncExternalStore(subscribeLiveCopy, getLiveCopy, getLiveCopy);
  const signedIn = owner !== null && readiness(live, 'hosted').connected;
  const { bots, loading } = useBots(owner, signedIn);
  const pm = usePositionsMargin(owner);
  const algos = useAlgos(owner);
  const h = health(c);
  const equity = c.model.account ? c.model.account.accountValue : null;
  return useMemo((): Reserve => {
    const base = { equity, free: h.available, inUse: h.inUse, signedIn, algos: 0, demo };
    if (demo) {
      const copies: CopyLine[] = DEMO_COPY_ROWS.map((x) => ({ ...x, demo: true }));
      const botsD: BotLine[] = DEMO_BOTS.map((b) => ({ id: b.id, label: b.name, symbol: b.symbol, usd: b.paper ? 0 : b.allocUsd, paper: b.paper }));
      return {
        ...base, copies, copyUsd: copies.filter((x) => !x.paper && x.status !== 'stopped').reduce((t, x) => t + x.allocationUsd, 0),
        bots: botsD, botUsd: botsD.reduce((t, b) => t + b.usd, 0), botViews: [], botsLoading: false,
      };
    }
    const a: Allocation = marginOf(bots, marginCopies(live ?? store), equity, pm);
    const copies = (live ?? store ? copyRows((live ?? store)!) : []).map(copyLine);
    const need = new Map(a.bots.map((b) => [b.id.slice(4), b.usd]));
    const botLines: BotLine[] = bots
      .filter((v) => v.algo.spec.bot === true)
      .map((v) => ({ id: v.algo.id, label: v.algo.spec.label ?? v.algo.spec.symbol, symbol: v.algo.spec.symbol, usd: need.get(v.algo.id) ?? 0, paper: !!v.algo.spec.paper }));
    return {
      ...base, copies, copyUsd: a.copyUsd, bots: botLines, botUsd: a.botUsd, botViews: bots, botsLoading: loading,
      algos: algos.views.filter((v) => v.algo.spec.bot !== true && !FINAL_STATUSES.has(v.algo.status)).length,
    };
  }, [demo, equity, h.available, h.inUse, signedIn, bots, loading, live, store, pm, algos]);
}
