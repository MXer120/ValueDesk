/**
 * How far a story's coins have moved since it came out (owner, 2026-10-26): each
 * coin chip in the News widget shows its % change from the price at the story's
 * time to the price now.
 *
 * Prices are this terminal's own market's candles (SoDEX, the book on screen):
 * 5-minute candles for the last day, hourly ones for the week before; the price
 * at a story's time is the open of the candle it falls in, the price now the
 * newest close. One read per coin and interval, kept two minutes and shared by
 * every story; a coin this book does not trade has no move.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, type Engine, type Kline } from '../../api';
import { pollEvery } from '../../exchange/visibility';

/** Where a coin's price is read: the engine and its market's name (BTC -> BTC-USD), or undefined. */
export interface PriceSource {
  engine: Engine;
  market: (coin: string) => string | undefined;
}

const KEEP_MS = 2 * 60_000;
const M5 = 5 * 60_000;
const H1 = 60 * 60_000;
/** Coins read for one list, at most. */
const MAX_COINS = 24;

interface Series { m5: Kline[]; h1: Kline[] }
const kept = new Map<string, { at: number; read: Promise<Series | null> }>();

function series(engine: Engine, market: string): Promise<Series | null> {
  const key = `${engine}:${market}`;
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.read;
  const read = Promise.all([api.klines(engine, market, '5m', 288), api.klines(engine, market, '1h', 200)])
    .then(([a, b]) => ({ m5: a.klines, h1: b.klines }))
    .catch(() => null);
  kept.set(key, { at: Date.now(), read });
  return read;
}

/** The open of the candle `t` falls in, newest-first candles of `span`; null before the first. */
function priceAt(rows: Kline[], span: number, t: number): number | null {
  for (const k of rows) {
    if (k.t <= t) return t < k.t + span ? Number(k.o) : null;
  }
  return null;
}

/** A story's move for one coin, % (null when unknown). */
export function moveSince(s: Series | null | undefined, t: number): number | null {
  if (!s || !t || !s.m5.length) return null;
  const now = Number(s.m5[0]!.c);
  const inDay = s.m5.length && t >= s.m5[s.m5.length - 1]!.t;
  const then = inDay ? priceAt(s.m5, M5, t) : priceAt(s.h1, H1, t);
  if (!then || !Number.isFinite(now) || then <= 0) return null;
  return ((now - then) / then) * 100;
}

/** The candles of the coins in `items` this book trades, by coin; re-read every two minutes. */
export function useCoinSeries(items: ReadonlyArray<{ symbols: string[] }>, src: PriceSource | undefined): Map<string, Series | null> {
  const coins = useMemo(() => {
    if (!src) return [] as string[];
    const out: string[] = [];
    for (const n of items) for (const c of n.symbols) if (!out.includes(c) && src.market(c)) out.push(c);
    return out.slice(0, MAX_COINS);
  }, [items, src]);
  const key = `${src?.engine ?? ''}|${coins.join(',')}`;
  const [got, setGot] = useState<Map<string, Series | null>>(new Map());
  useEffect(() => {
    if (!src || !coins.length) return;
    let off = false;
    const load = () => {
      void Promise.all(coins.map((c) => series(src.engine, src.market(c)!).then((s) => [c, s] as const))).then((rows) => {
        if (!off) setGot(new Map(rows));
      });
    };
    load();
    // Two candle reads per coin: none while the tab is hidden, caught up when it is shown.
    const stop = pollEvery(KEEP_MS, load);
    return () => {
      off = true;
      stop();
    };
    // `key` stands for the coins and the engine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return got;
}
