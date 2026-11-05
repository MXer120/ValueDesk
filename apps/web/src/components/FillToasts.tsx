/**
 * A notification for every fill on the connected account, on any page:
 * "BTC long filled" / "0.0125 BTC @ 84,211 · maker". Rides SoDEX's own
 * `accountTrade` stream (perps and spot) - no polling. A burst (one order
 * sweeping several levels) collapses into one card per order side and market
 * (fillBatch.ts says how long it waits, and what a bot's run of fills shows).
 */
import { useRef } from 'react';
import { useChannel } from '../hooks';
import { notifyTrade } from '../toast';
import { baseOf, fillCards, fillWait, type FillGroup } from './fillBatch';
import type { Engine } from '../api';

interface Fill { T?: number; t?: number; time?: number; s?: string; symbol?: string; p?: string; price?: string; q?: string; quantity?: string; m?: boolean; S?: unknown; side?: unknown }

const sideOf = (f: Fill): 'buy' | 'sell' | null => {
  const v = String(f.S ?? f.side ?? '').toUpperCase();
  return v === 'BUY' || v === '1' ? 'buy' : v === 'SELL' || v === '2' ? 'sell' : null;
};

function useFills(engine: Engine, address: string | null) {
  const pending = useRef(new Map<string, FillGroup>());
  const timer = useRef<number | undefined>(undefined);
  const firstAt = useRef(0);
  const flush = () => {
    for (const c of fillCards([...pending.current.values()], engine)) notifyTrade('filled', c);
    pending.current.clear();
    firstAt.current = 0;
  };
  useChannel(engine, address ? { channel: 'accountTrade', user: address } : null, (data, pushType) => {
    if (pushType === 'snapshot') return; // history on subscribe, not news
    const list: Fill[] = Array.isArray(data) ? data : data ? [data] : [];
    for (const f of list) {
      const symbol = String(f.s ?? f.symbol ?? '');
      const q = Number(f.q ?? f.quantity);
      const p = Number(f.p ?? f.price);
      if (!symbol || !(q > 0) || !(p > 0)) continue;
      // Only news: a fill stamped more than a minute ago is history replayed on subscribe.
      const at = Number(f.T ?? f.t ?? f.time);
      if (at > 0 && Date.now() - (at < 1e12 ? at * 1000 : at) > 60_000) continue;
      const side = sideOf(f);
      const key = `${symbol}:${side}`;
      const g = pending.current.get(key) ?? { qty: 0, notional: 0, maker: !!f.m, side, symbol, fills: 0 };
      g.qty += q;
      g.notional += q * p;
      g.fills++;
      pending.current.set(key, g);
    }
    if (pending.current.size === 0) return;
    const now = Date.now();
    if (!firstAt.current) firstAt.current = now;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, fillWait(firstAt.current, now));
  });
}

export function FillToasts({ address }: { address: string | null }) {
  useFills('perps', address);
  useFills('spot', address);
  return null;
}
