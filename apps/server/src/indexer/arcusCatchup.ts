/**
 * Arcus's source for the catch-up (tradeCatchup.ts). What its REST gives, measured 2026-11-06:
 *   /v1/trades?market=&from=&to=&limit=   newest first, at most 1,000 rows, `from` and `to` in µs and inclusive, the same market
 *                                         answered back to 2026-07 and further; every row names maker and taker.
 *   tradeId   the stream's, shared over all markets: not contiguous per market (so no "beyond reach" count), and 22 of 19,000
 *             rows ran against time order, so rows go by time.
 *   timestamp NOT the stream's: REST's is 2 to 16 ms earlier on every row, and it is the one Arcus's candles count by. Read twice
 *             it does not move. So what is held is matched with a margin (FlowRecorder.missingNear), and prints added here keep it.
 *   candles   tradeCount also counts trades that neither this nor the stream shows: 42 of 33,275 in the slots tried, all in moving
 *             markets (BTC 14:30: 357 against 342, 0.5 % of its volume). Nothing here can fill those. Takeovers and ADL perhaps; not proven.
 *   Limits    20 weight + 1 per 20 rows returned (docs; 429 after 27 calls at 1,000 rows, as that says), of the IP's 1,500 a minute.
 *             The indexer takes 450 and the API 300 + checks, so one read per 10 s at most, about 420 weight a minute at worst.
 *
 * Normal running, on 2026-11-06's 520,000 trades a day: about 160 calls an hour, 72 weight a minute, 210 MB a day coming in. A walk after an outage costs
 * one call per 1,000 trades.
 */
import { ARCUS_API } from '../valuedesk/extra/arcus.js';
import type { Print } from './streams.js';
import { RestReader, TradeCatchup, type CatchupSource } from './tradeCatchup.js';

export const ARCUS_PAGE = 1_000;
const TICK_MS = 10_000;
/** How far back a market first seen is read: the first start's repair. */
const FIRST_BACK_MS = 24 * 3_600_000;

export interface ArcusRow { tradeId?: string; timestamp?: number; marketDisplayName?: string }

export type ArcusRead = CatchupSource<ArcusRow>['read'];

export class ArcusCatchup extends TradeCatchup<ArcusRow> {
  private readonly reader: RestReader | null;

  constructor(
    add: (rows: ArcusRow[]) => Print[],
    log: (line: string) => void,
    cursor: { load(): Record<string, number>; save(through: Record<string, number>): void },
    injected?: { read: ArcusRead; markets: () => Promise<string[]>; now: () => number },
  ) {
    const reader = injected ? null : new RestReader(ARCUS_API);
    super({
      name: 'arcus',
      title: 'Arcus',
      limit: ARCUS_PAGE,
      tickMs: TICK_MS,
      markets: injected?.markets ?? (async () => {
        const { status, data } = await reader!.get('/v1/markets', 'markets');
        if (status !== 200) throw new Error(`HTTP ${status}`);
        return ((data ?? []) as Array<{ marketDisplayName?: string; status?: string }>).flatMap((m) => (m.marketDisplayName && (m.status ?? 'ONLINE') === 'ONLINE' ? [m.marketDisplayName] : []));
      }),
      read: injected?.read ?? (async (market, w) => {
        // `to` in µs takes in the whole of its millisecond, as rows are compared by the millisecond.
        const q = `market=${encodeURIComponent(market)}&limit=${ARCUS_PAGE}${w.from !== undefined ? `&from=${w.from * 1000}` : ''}${w.to !== undefined ? `&to=${w.to * 1000 + 999}` : ''}`;
        const { status, data } = await reader!.get(`/v1/trades?${q}`, 'trades');
        if (status === 429) return { rows: [], limited: true };
        if (status !== 200) throw new Error(`HTTP ${status}`);
        return { rows: Array.isArray(data) ? (data as ArcusRow[]) : [] };
      }),
      at: (r) => (typeof r.timestamp === 'number' ? Math.floor(r.timestamp / 1000) : undefined),
      windows: { firstBackMs: FIRST_BACK_MS, ...cursor },
    }, add, log, injected?.now ?? Date.now);
    this.reader = reader;
  }

  override stop(): void {
    super.stop();
    this.reader?.stop();
  }
}
