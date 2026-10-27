/**
 * The parts of the site a feedback message can be about (owner, 2026-10-27: "for
 * bug more like UI, algo orders, deposit and withdrawals stuff like that + make
 * it possible to select multiple via dropdown + search"). The form's Area picker
 * lists these (apps/web/src/feedback/AreaPicker.tsx); the server takes only these
 * ids (ops/feedback.ts) and names them in the owner's Telegram message.
 *
 * Pure and shared through the web's @sign alias. An id, once used, is never
 * renamed (stored messages carry it); a label may change.
 */

export interface FeedbackArea {
  id: string;
  label: string;
  /** Other words people search for. */
  words?: string;
}

export const FEEDBACK_AREAS: readonly FeedbackArea[] = [
  { id: 'layout', label: 'Layout & UI', words: 'design panels dashboard theme screen mobile' },
  { id: 'charts', label: 'Charts', words: 'candles indicators drawing tradingview' },
  { id: 'orderbook', label: 'Order book & trades', words: 'depth tape book prices' },
  { id: 'orders', label: 'Placing orders', words: 'buy sell ticket limit market tp sl leverage' },
  { id: 'algo', label: 'Algo orders', words: 'twap vwap pov bracket basket scale iceberg' },
  { id: 'copy', label: 'Copy trading', words: 'follow leader hosted executor' },
  { id: 'funds', label: 'Deposits & withdrawals', words: 'transfer bridge usdc balance fund' },
  { id: 'portfolio', label: 'Portfolio & positions', words: 'pnl history fills account' },
  { id: 'wallet', label: 'Wallet connection', words: 'connect sign metamask walletconnect' },
  { id: 'news', label: 'News & calendar', words: 'events releases fomc' },
  { id: 'fedlive', label: 'Fed live', words: 'powell transcript speech' },
  { id: 'liqmap', label: 'Liquidation heatmap', words: 'liquidations heat map' },
  { id: 'leaderboard', label: 'Leaderboard', words: 'traders ranking whales scan' },
  { id: 'points', label: 'Points', words: 'rewards fees tier' },
  { id: 'knowledge', label: 'Knowledge', words: 'folders docs notes boards' },
  { id: 'notifications', label: 'Notifications', words: 'bell alerts toasts' },
  { id: 'speed', label: 'Speed & performance', words: 'slow lag freeze loading crash' },
  { id: 'other', label: 'Other' },
];

export const AREA_IDS: ReadonlySet<string> = new Set(FEEDBACK_AREAS.map((a) => a.id));

/** The label of an area id, or the id itself. */
export const areaLabel = (id: string): string => FEEDBACK_AREAS.find((a) => a.id === id)?.label ?? id;

/** The areas whose label or words match a search, in list order. */
export function searchAreas(q: string): FeedbackArea[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...FEEDBACK_AREAS];
  return FEEDBACK_AREAS.filter((a) => {
    const hay = `${a.label} ${a.words ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
