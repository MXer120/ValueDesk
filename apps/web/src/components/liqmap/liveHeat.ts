/**
 * The liquidation heatmap, live: one WebSocket to the API's /ws/liq (server
 * routes/liqWs.ts) per widget. It sends the whole heatmap on subscribing and every
 * 30 s, and the changed buckets every second in between; this keeps them merged
 * into one heatmap in the API's own shape, so the widget draws it exactly as it
 * draws an HTTP answer.
 *
 * In production the socket goes straight to the instance (VITE_LIQ_WS_URL: Vercel's
 * functions hold no socket); in dev through Vite's /ws proxy to the local API.
 * While it is not connected the widget polls over HTTP instead (`connected`).
 *
 * A fine window (`fineSub`, owner 2026-11-01: $10 and $1 "as accurate / updating as the normal
 * heatmap"): the server's fine layer (BTC $1 near the price) summed k cells at a time over the price
 * window on screen, sent whole and then its changed cells a second apart like the buckets.
 */
import { useEffect, useRef, useState } from 'react';
import type { LiqHeatmap } from '@sign/indexer/liqRead.js';
import type { Venue } from '../../vsApi';

type Row = LiqHeatmap['buckets'][number];

/** Where the socket goes. */
export function liqWsUrl(): string | null {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const set = env?.VITE_LIQ_WS_URL?.trim();
  if (set) return set;
  if (typeof location === 'undefined') return null;
  // Dev: the Vite server proxies /ws to the local API (vite.config.ts).
  if (!env?.DEV) return null;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/liq`;
}

/** A delta frame merged into the heatmap held (exported for tests). */
export function mergeDelta(h: LiqHeatmap, d: { at: number; p: number; b: Row[]; cov?: Partial<Record<Venue, number[]>> }): LiqHeatmap {
  const by = new Map<number, Row>(h.buckets.map((r) => [r[0], r]));
  for (const r of d.b) {
    if (!r[3] && !r[4]) by.delete(r[0]);
    else by.set(r[0], r);
  }
  const coverage = { ...h.coverage };
  for (const [v, c] of Object.entries(d.cov ?? {}) as Array<[Venue, number[]]>) {
    const was = coverage[v];
    // [long, short, long priced, short priced, positions, past (the snapshot's stands), long none, short none] (server live.ts Cov; older: five).
    if (was) coverage[v] = { ...was, long: c[0]!, short: c[1]!, longKnown: c[2]!, shortKnown: c[3]!, positions: c[4]!, ...(c.length >= 8 ? { longNone: c[6]!, shortNone: c[7]! } : {}) };
  }
  return { ...h, at: d.at, price: d.p, buckets: [...by.values()].sort((a, b) => a[0] - b[0]), coverage };
}

/** The fine layer's step and reach for the coin (server live.ts FineAgg: BTC $1 over the buckets' range, 0.2-3x the price). */
export interface FineMeta { st: number; lo: number; hi: number }

/** A fine window of the stream: the layer summed `k` cells at a time over [from, to), as the server sent it and its deltas moved it. */
export interface LiveFine {
  coin: string;
  at: number;
  p: number;
  /** The step drawn (the layer's times k), the layer's own, and how many of it make one. */
  st: number;
  base: number;
  k: number;
  from: number;
  to: number;
  buckets: Row[];
}

/** A fine delta merged into the window held (exported for tests). */
export function mergeFine(f: LiveFine, d: { at: number; p: number; b: Row[] }): LiveFine {
  const by = new Map<number, Row>(f.buckets.map((r) => [r[0], r]));
  for (const r of d.b) {
    if (!r[3] && !r[4]) by.delete(r[0]);
    else by.set(r[0], r);
  }
  return { ...f, at: d.at, p: d.p, buckets: [...by.values()].sort((a, b) => a[0] - b[0]) };
}

/** What to ask of the fine layer: cells per drawn one and the price window (null: nothing). */
export type FineSub = { k: number; from: number; to: number } | null;

export function useLiveHeat(coin: string, venues: readonly Venue[], on: boolean, k = 5, fineSub: FineSub = null): {
  data: LiqHeatmap | null; connected: boolean; k: number; fineMeta: FineMeta | null; fine: LiveFine | null;
} {
  const [data, setData] = useState<LiqHeatmap | null>(null);
  /** The width (server buckets per bar) the data held is summed to. */
  const [dataK, setDataK] = useState(1);
  const [connected, setConnected] = useState(false);
  const [fineMeta, setFineMeta] = useState<FineMeta | null>(null);
  const [fine, setFine] = useState<LiveFine | null>(null);
  const want = useRef({ coin, venues, k, fineSub });
  want.current = { coin, venues, k, fineSub };
  const ws = useRef<WebSocket | null>(null);
  const key = `${coin}|${venues.join(',')}`;
  const fineKey = fineSub ? `${fineSub.k}|${fineSub.from}|${fineSub.to}` : '-';
  const subKey = `${key}|${k}|${fineKey}`;
  const subMsg = () => JSON.stringify({ op: 'sub', coin: want.current.coin, venues: want.current.venues, k: want.current.k, fine: want.current.fineSub });

  // One socket for the widget's life; it resubscribes when the coin, the venues, the width or the fine window change.
  useEffect(() => {
    const url = on ? liqWsUrl() : null;
    if (!url) return;
    let closed = false;
    let backoff = 1_000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      const s = new WebSocket(url);
      ws.current = s;
      s.onopen = () => {
        backoff = 1_000;
        setConnected(true);
        s.send(subMsg());
      };
      s.onmessage = (ev) => {
        let m: { t?: string; coin?: string } & Record<string, unknown>;
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        if (m.coin !== want.current.coin) return;
        if (m.t === 's') {
          const { t: _t, live: _l, k: sk, fine: fm, ...heat } = m as unknown as LiqHeatmap & { t: string; live: boolean; k?: number; fine?: FineMeta | null };
          setDataK(Number(sk) || 1);
          setData(heat);
          setFineMeta(fm ?? null);
        } else if (m.t === 'd') {
          setData((h) => (h && h.coin === m.coin ? mergeDelta(h, m as never) : h));
        } else if (m.t === 'fm') {
          const { st, lo, hi } = m as unknown as FineMeta;
          setFineMeta({ st, lo, hi });
        } else if (m.t === 'fs') {
          const { t: _t, ...f } = m as unknown as LiveFine & { t: string };
          setFine(f);
        } else if (m.t === 'fd') {
          setFine((f) => (f && f.coin === m.coin ? mergeFine(f, m as never) : f));
        }
      };
      s.onclose = () => {
        if (ws.current === s) ws.current = null;
        setConnected(false);
        if (closed) return;
        timer = setTimeout(open, backoff);
        backoff = Math.min(30_000, backoff * 2);
      };
      s.onerror = () => s.close();
    };
    open();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws.current?.close();
      ws.current = null;
      setConnected(false);
    };
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setData((h) => (h && h.coin === coin && h.venues.join(',') === venues.join(',') ? h : null));
    // A window panned stays drawn until the next arrives; another coin's never.
    setFine((f) => (f && f.coin === coin && fineSub ? f : null));
  }, [subKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Without a fine window the subscription goes at once; a fine one waits for the pan to settle (a quarter second).
  useEffect(() => {
    if (fineSub) {
      const t = setTimeout(() => { const s = ws.current; if (s?.readyState === 1) s.send(subMsg()); }, 250);
      return () => clearTimeout(t);
    }
    const s = ws.current;
    if (s?.readyState === 1) s.send(subMsg());
    return undefined;
  }, [subKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data: data && data.coin === coin ? data : null, connected, k: dataK, fineMeta: data && data.coin === coin ? fineMeta : null, fine: fine && fine.coin === coin && fineSub ? fine : null };
}
