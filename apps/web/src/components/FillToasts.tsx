/**
 * A notification for every fill on the connected account, on any page:
 * "BTC long filled" / "0.0125 BTC @ 84,211 · maker". Rides SoDEX's own
 * `accountTrade` stream (perps and spot) - no polling. A burst (one order
 * sweeping several levels) collapses into one card per order side and market.
 */
import { useRef } from 'react';
import { useChannel } from '../hooks';
import { notifyTrade } from '../toast';
import { coinLabel, fmt } from '../format';
import type { Engine } from '../api';

interface Fill { T?: number; t?: number; time?: number; s?: string; symbol?: string; p?: string; price?: string; q?: string; quantity?: string; m?: boolean; S?: unknown; side?: unknown }

/** "BTC-USD" / "vBTC_vUSDC" -> "BTC". */
const baseOf = (symbol: string): string => (symbol.split(/[-_/]/)[0] ?? symbol).replace(/^v(?=[A-Z])/, '');
const sideOf = (f: Fill): 'buy' | 'sell' | null => {
  const v = String(f.S ?? f.side ?? '').toUpperCase();
  return v === 'BUY' || v === '1' ? 'buy' : v === 'SELL' || v === '2' ? 'sell' : null;
};

function useFills(engine: Engine, address: string | null) {
  const pending = useRef(new Map<string, { qty: number; notional: number; maker: boolean; side: 'buy' | 'sell' | null; symbol: string }>());
  const timer = useRef<number | undefined>(undefined);
  const flush = () => {
    for (const g of pending.current.values()) {
      const base = baseOf(g.symbol);
      const avg = g.qty > 0 ? g.notional / g.qty : 0;
      const sideWord = g.side === null ? '' : engine === 'perps' ? (g.side === 'buy' ? ' long' : ' short') : (g.side === 'buy' ? ' buy' : ' sell');
      notifyTrade('filled', {
        coin: base,
        title: `${coinLabel(base) || base}${sideWord} filled`,
        detail: `${fmt(g.qty)} ${coinLabel(base) || base} @ ${fmt(avg)} · ${g.maker ? 'maker' : 'taker'}`,
      });
    }
    pending.current.clear();
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
      const g = pending.current.get(key) ?? { qty: 0, notional: 0, maker: !!f.m, side, symbol };
      g.qty += q;
      g.notional += q * p;
      pending.current.set(key, g);
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 350);
  });
}

export function FillToasts({ address }: { address: string | null }) {
  useFills('perps', address);
  useFills('spot', address);
  return null;
}
