/**
 * The Wealth reads the portfolio shares. Straight from this browser, like the rest of the
 * account's reads, so each visitor spends their own per-IP budget at SoDEX. Once a minute
 * while the tab is shown (pollEvery); the funds and quotes are public and change slowly.
 */
import { useEffect, useMemo, useState } from 'react';
import { logLoadFailure } from '../LoadFailed';
import { pollEvery } from '../../exchange/visibility';
import {
  joinHoldings, readFunds, readLedger, readMarkets, readPlans, readPnl, readPositions, readTradingStatus,
  type JoinedHolding, type TradingStatus, type WealthEntry, type WealthFund, type WealthPlan, type WealthPnl, type WealthPosition, type WealthQuote,
} from '../../trading/wealth';
import type { WealthRow } from './summary';

const POLL_MS = 60_000;

export interface WealthState {
  funds: WealthFund[] | null;
  quotes: Map<string, WealthQuote>;
  pnl: WealthPnl | null;
  holdings: JoinedHolding[] | null;
  /** The buckets' input. null until read, and while the read fails: Spot and EVM then stay as read. */
  rows: WealthRow[] | null;
  error: string | null;
  refresh: () => void;
}

/** The shelves and their live quotes. Public: no wallet needed. */
function useBoard() {
  const [funds, setFunds] = useState<WealthFund[] | null>(null);
  const [quotes, setQuotes] = useState<WealthQuote[]>([]);
  useEffect(() => {
    let off = false;
    const read = () => {
      readFunds().then((d) => { if (!off) setFunds(d ?? []); }).catch((e) => logLoadFailure('Wealth funds', e));
      readMarkets().then((d) => { if (!off) setQuotes(d); }).catch((e) => logLoadFailure('Wealth quotes', e));
    };
    read();
    const stop = pollEvery(POLL_MS, read);
    return () => { off = true; stop(); };
  }, []);
  return { funds, quotes };
}

export function useWealth(address: string | null, refreshToken: number): WealthState {
  const { funds, quotes } = useBoard();
  const [positions, setPositions] = useState<WealthPosition[] | null>(null);
  const [pnl, setPnl] = useState<WealthPnl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setPositions(null);
    setPnl(null);
    setError(null);
  }, [address]);

  useEffect(() => {
    if (!address) return;
    let off = false;
    const read = () => {
      Promise.all([readPositions(address), readPnl(address)])
        .then(([p, v]) => {
          if (off) return;
          setPositions(p);
          setPnl(v);
          setError(null);
        })
        .catch((e) => {
          if (off) return;
          setError((e as Error).message);
          logLoadFailure('Wealth holdings', e);
        });
    };
    read();
    const stop = pollEvery(POLL_MS, read);
    return () => { off = true; stop(); };
  }, [address, refreshToken, tick]);

  const holdings = useMemo(
    () => (positions && pnl ? joinHoldings(funds, positions, pnl) : null),
    [funds, positions, pnl],
  );
  const rows = useMemo(
    () => holdings?.map((h): WealthRow => ({
      fundId: h.fundId, coin: h.coin, marketValue: h.marketValue, inFlight: h.inFlight,
      shares: h.shares, spotShares: h.spotShares, perpShares: h.perpShares, evmShares: h.evmShares,
    })) ?? null,
    [holdings],
  );
  const byFund = useMemo(() => new Map(quotes.map((q) => [q.fundId, q])), [quotes]);
  return { funds, quotes: byFund, pnl, holdings, rows, error, refresh: () => setTick((t) => t + 1) };
}

/** What each fund allows right now. Only while the fund board is on screen. */
export function useTradingStatuses(funds: readonly WealthFund[] | null): Map<string, TradingStatus> {
  const [statuses, setStatuses] = useState<Map<string, TradingStatus>>(new Map());
  const ids = funds?.filter((f) => f.fundType !== 'bridged_vault' && !f.spotOnly).map((f) => f.fundId).join(',') ?? '';
  useEffect(() => {
    if (!ids) return;
    let off = false;
    const read = () => {
      void Promise.allSettled(ids.split(',').map((id) => readTradingStatus(id))).then((all) => {
        if (off) return;
        const next = new Map<string, TradingStatus>();
        for (const r of all) if (r.status === 'fulfilled' && r.value) next.set(r.value.fundId, r.value);
        setStatuses(next);
      });
    };
    read();
    const stop = pollEvery(POLL_MS, read);
    return () => { off = true; stop(); };
  }, [ids]);
  return statuses;
}

export function useLedger(address: string | null, refreshToken: number): { entries: WealthEntry[] | null; plans: WealthPlan[] | null; error: string | null } {
  const [entries, setEntries] = useState<WealthEntry[] | null>(null);
  const [plans, setPlans] = useState<WealthPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setEntries(null);
    setPlans(null);
    if (!address) return;
    let off = false;
    const read = () => {
      readLedger(address)
        .then((d) => { if (!off) { setEntries(d); setError(null); } })
        .catch((e) => { if (!off) setError((e as Error).message); logLoadFailure('Wealth history', e); });
      readPlans(address)
        .then((d) => { if (!off) setPlans(d); })
        .catch((e) => logLoadFailure('Recurring buys', e));
    };
    read();
    const stop = pollEvery(POLL_MS, read);
    return () => { off = true; stop(); };
  }, [address, refreshToken]);
  return { entries, plans, error };
}
