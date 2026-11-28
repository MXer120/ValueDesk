/**
 * The cards, built from what each page already shows (owner 2026-11-14: "share button for bot results as cards, and
 * general share cards"). Only figures the page has: a figure it does not have is left off the card, never estimated.
 *
 * Where a viewer lands (the growth loop): a bot card opens New bot with the same market and preset, one click from the
 * same setup; a trade or position card opens that market on Trade; a copy card the copy-trading page; a portfolio card
 * the portfolio page.
 */
import type { AlgoView } from '@copy-engine';
import { STRATEGY_INFO, strategyOf, type Strategy } from '../../bots/presets';
import { recipeOfSpec } from '../../bots/recipes';
import { dayWords, duration, pctSigned, shortAddress, usdShort, usdSigned, type CardData, type CardFact } from './card';

export const SITE = 'https://valuedesk.so';
const sym = (s: string) => s.replace(/-USD$/i, '');
/** A price as the market shows it: as many places as it needs, no more than 6 significant. */
const price = (x: number): string => (x >= 1_000 ? x.toLocaleString('en-US', { maximumFractionDigits: 1 }) : x >= 1 ? x.toLocaleString('en-US', { maximumFractionDigits: 3 }) : Number(x.toPrecision(4)).toString());
const ok = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/* -------------------------------------------------------------------- bots ----- */

/** The page a viewer of a bot card lands on: New bot, same market, same preset (a hedge: the hedge page). */
export function botLink(v: Pick<AlgoView, 'algo'>): string {
  const s = v.algo.spec;
  const kind = s.kind === 'hedge' ? 'hedge' : s.kind === 'mm' || s.kind === 'grid' ? recipeOfSpec(s) : null;
  const q = new URLSearchParams({ market: s.symbol, ...(kind ? { kind } : {}) });
  return `${SITE}/bots/new?${q.toString()}`;
}

const MAKERS: ReadonlySet<Strategy> = new Set(['market', 'maker', 'lead']);

export function botCard(v: AlgoView, now = Date.now()): CardData | null {
  const b = v.bot;
  const st = strategyOf(v.algo.spec);
  if (!b || !st) return null;
  const s = v.algo.spec;
  const name = MAKERS.has(st) ? 'Market maker' : `${STRATEGY_INFO[st].name} bot`;
  const since = v.algo.startedAt ?? v.algo.createdAt;
  const ended = v.algo.endedAt;
  const when = ended ? `Ran ${duration(ended - since)}` : `Running ${duration(now - since)}`;
  const bp = b.costPerMillion !== null && Number.isFinite(b.costPerMillion) ? b.costPerMillion / 100 : null;
  // A negative cost is what the bot earned per volume: said as earned, in green, never as a red "cost" (the app's costText).
  const earned = bp !== null && bp < 0;
  const bpText = bp !== null ? `${earned ? '+' : ''}${Math.abs(bp).toFixed(2)} bp` : null;
  const costWord = earned ? 'earned' : 'cost';
  const costLabel = earned ? 'Earned' : 'Cost';
  const series = v.algo.book?.series ?? [];
  const facts: CardFact[] = [];
  const maker = MAKERS.has(st);
  if (maker) {
    if (bpText) facts.push({ label: costLabel, value: bpText, kind: 'plain' });
    facts.push({ label: 'PnL', value: usdSigned(b.netPnl), kind: 'usd' });
  } else {
    facts.push({ label: 'Volume', value: usdShort(b.volume), kind: 'usd' });
    if (bpText) facts.push({ label: costLabel, value: bpText, kind: 'plain' });
  }
  facts.push({ label: 'Fills', value: b.fills.toLocaleString('en-US'), kind: 'stat' });
  if (b.volume > 0) facts.push({ label: 'Maker share', value: `${Math.round(b.makerShare * 100)}%`, kind: 'stat' });
  const pills = [{ text: s.symbol }, ...(s.paper ? [{ text: 'Practice' }] : [])];
  const foot = s.paper ? 'Practice: no real orders' : maker ? 'Cost = fees and price PnL per volume' : 'Net PnL after every fee';
  const base = {
    label: 'Bot', when, title: name, pills, facts, foot, link: botLink(v), second: null, wallet: v.algo.owner,
    hidden: bpText ? { label: `${earned ? 'Earned' : 'Cost'} per $1M traded`, big: bpText, tone: earned ? ('up' as const) : ('neutral' as const) } : { label: 'Fills', big: b.fills.toLocaleString('en-US'), tone: 'neutral' as const },
  };
  if (maker) {
    // The market maker's card leads with the volume, the cost as the second line (the owner's default bot card).
    const vol = series.map((p) => p[1]);
    const last = vol[vol.length - 1] ?? 0;
    const cost = series.filter((p) => p[1] > last * 0.02 && p[1] > 0).map((p) => (-p[2] / p[1]) * 10_000);
    return {
      ...base, kind: 'botvol', usd: b.netPnl, pct: null,
      lead: {
        label: 'Volume', big: usdShort(b.volume), usdBig: true, sub: bpText ?? '', subRest: bpText ? costWord : '',
        altLabel: `${earned ? 'Earned' : 'Cost'} per $1M traded`, altBig: bpText ?? `${b.fills.toLocaleString('en-US')} fills`, altSub: '', altSubRest: '',
      },
      chart: vol.length > 1 ? { type: 'volume', vol, cost: cost.length > 1 ? cost : null, costEnd: bpText } : null,
      post: ({ amounts }) => amounts
        ? `My ${sym(s.symbol)} market maker on ValueDesk: ${usdShort(b.volume)} traded${bpText ? `, ${bpText} ${costWord}` : ''}. The same setup:`
        : `My ${sym(s.symbol)} market maker on ValueDesk${bpText ? `: ${bpText} ${costWord} per volume` : ''}. The same setup:`,
    };
  }
  const ys = series.map((p) => p[2]);
  return {
    ...base, kind: 'bot', usd: b.netPnl, pct: null,
    chart: ys.length > 1 ? { type: 'pnl', ys } : null,
    post: ({ amounts }) => amounts
      ? `My ${sym(s.symbol)} ${name.toLowerCase()} on ValueDesk: ${usdSigned(b.netPnl)} net, ${usdShort(b.volume)} traded. The same setup:`
      : `My ${sym(s.symbol)} ${name.toLowerCase()} on ValueDesk${bpText ? `: ${bpText} ${costWord} per volume` : ''}. The same setup:`,
  };
}

/* ------------------------------------------------------- trades, positions ----- */

export interface TradeFigures {
  symbol: string;
  side: 'long' | 'short' | null;
  leverage: number | null;
  entry: number | null;
  exit: number | null;
  /** Base units, with its unit word. */
  size: number | null;
  unit: string;
  /** Realized PnL after trading fees, USD. */
  pnl: number | null;
  /** Return on the margin, a fraction. */
  roe: number | null;
  opened: number | null;
  closed: number | null;
  wallet: string | null;
}

/** The market on Trade (trading/listed.ts linkedMarket reads ?symbol=). */
const tradeLink = (symbol: string) => `${SITE}/trade?symbol=${encodeURIComponent(symbol)}`;

function legFacts(t: { entry: number | null; exitLabel: string; exit: number | null; size: number | null; unit: string }, held: string | null): CardFact[] {
  const f: CardFact[] = [];
  if (ok(t.entry) && t.entry > 0) f.push({ label: 'Entry', value: price(t.entry), kind: 'price' });
  if (ok(t.exit) && t.exit > 0) f.push({ label: t.exitLabel, value: price(t.exit), kind: 'price' });
  if (ok(t.size) && t.size > 0) f.push({ label: 'Size', value: `${Number(t.size.toPrecision(6))} ${t.unit}`, kind: 'usd' });
  if (held) f.push({ label: 'Held', value: held, kind: 'plain' });
  f.push({ label: 'Venue', value: 'SoDEX', kind: 'plain' });
  return f;
}

function sidePills(side: 'long' | 'short' | null, lev: number | null): CardData['pills'] {
  return [...(side ? [{ text: side === 'long' ? 'Long' : 'Short', tone: true }] : []), ...(ok(lev) && lev > 0 ? [{ text: `${Math.round(lev)}x` }] : [])];
}

/** A closed position (Portfolio history). PnL is SoDEX's realized PnL after trading fees; funding is not in it. */
export function tradeCard(t: TradeFigures): CardData | null {
  if (!ok(t.pnl) && !ok(t.roe)) return null;
  const held = ok(t.opened) && ok(t.closed) && t.closed > t.opened ? duration(t.closed - t.opened) : null;
  const side = t.side === 'long' ? 'Long' : t.side === 'short' ? 'Short' : '';
  return {
    kind: 'trade', label: 'Trade', when: ok(t.closed) ? dayWords(t.closed) : 'Closed', title: t.symbol, pills: sidePills(t.side, t.leverage),
    usd: ok(t.pnl) ? t.pnl : null, pct: ok(t.roe) ? t.roe : null,
    facts: legFacts({ entry: t.entry, exitLabel: 'Exit', exit: t.exit, size: t.size, unit: t.unit }, held),
    foot: 'Closed position · after trading fees', chart: null, link: tradeLink(t.symbol),
    second: { title: 'Entry and exit prices', kind: 'price' }, wallet: t.wallet,
    post: ({ amounts }) => `${side ? `${side} ` : ''}${sym(t.symbol)}${ok(t.leverage) ? ` ${Math.round(t.leverage)}x` : ''} on ValueDesk: ${ok(t.roe) ? pctSigned(t.roe) : ''}${amounts && ok(t.pnl) ? `${ok(t.roe) ? ', ' : ''}${usdSigned(t.pnl)}` : ''}`.trim(),
  };
}

export interface PositionFigures {
  symbol: string;
  side: 'long' | 'short' | null;
  leverage: number | null;
  entry: number | null;
  mark: number | null;
  size: number | null;
  unit: string;
  /** Unrealized PnL at the mark, USD. */
  upnl: number | null;
  roe: number | null;
  wallet: string | null;
  now?: number;
}

/** An open position: unrealized PnL at the mark now. */
export function positionCard(p: PositionFigures): CardData | null {
  if (!ok(p.upnl) && !ok(p.roe)) return null;
  const side = p.side === 'long' ? 'Long' : p.side === 'short' ? 'Short' : '';
  return {
    kind: 'position', label: 'Position', when: dayWords(p.now ?? Date.now()), title: p.symbol, pills: sidePills(p.side, p.leverage),
    usd: ok(p.upnl) ? p.upnl : null, pct: ok(p.roe) ? p.roe : null,
    facts: legFacts({ entry: p.entry, exitLabel: 'Mark', exit: p.mark, size: p.size, unit: p.unit }, null),
    foot: 'Open position · unrealized, at the mark', chart: null, link: tradeLink(p.symbol),
    second: { title: 'Entry and mark prices', kind: 'price' }, wallet: p.wallet,
    post: ({ amounts }) => `${side ? `${side} ` : ''}${sym(p.symbol)}${ok(p.leverage) ? ` ${Math.round(p.leverage)}x` : ''} on ValueDesk, open: ${ok(p.roe) ? pctSigned(p.roe) : ''}${amounts && ok(p.upnl) ? `${ok(p.roe) ? ', ' : ''}${usdSigned(p.upnl)}` : ''}`.trim(),
  };
}

/* -------------------------------------------------------------------- copies ----- */

export interface CopyFigures {
  leader: string;
  /** The trader's venue, as the page labels it (Hyperliquid, SoDEX…). */
  venue: string;
  pnl: number | null;
  /** My copy's return, a fraction. */
  pct: number | null;
  since: number | null;
  multiplier: number | null;
  /** Orders the copy sent (the copier's own count). */
  orders: number | null;
  realized: number | null;
  paper: boolean;
  wallet: string | null;
}

export function copyCard(c: CopyFigures): CardData | null {
  if (!ok(c.pnl) && !ok(c.pct)) return null;
  const facts: CardFact[] = [];
  if (ok(c.orders)) facts.push({ label: 'Orders copied', value: c.orders.toLocaleString('en-US'), kind: 'stat' });
  if (ok(c.multiplier)) facts.push({ label: 'Multiplier', value: `${c.multiplier}x`, kind: 'plain' });
  if (ok(c.realized)) facts.push({ label: 'Realized', value: usdSigned(c.realized), kind: 'usd' });
  facts.push({ label: 'Venues', value: `${c.venue} → SoDEX`, kind: 'plain' });
  return {
    kind: 'copy', label: 'Copy trading', when: ok(c.since) ? `Since ${dayWords(c.since)}` : 'Copying', over: c.paper ? 'Copying · practice' : 'Copying',
    title: shortAddress(c.leader), titleIsAddress: true, pills: ok(c.multiplier) ? [{ text: `${c.multiplier}x` }] : [],
    usd: ok(c.pnl) ? c.pnl : null, pct: ok(c.pct) ? c.pct : null, facts,
    foot: c.paper ? 'Practice copy: no real orders' : 'My copy · fees included', chart: null, link: `${SITE}/copy`,
    second: { title: 'Trader address', kind: 'title' }, wallet: c.wallet,
    post: ({ amounts }) => `Copy trading on ValueDesk: ${ok(c.pct) ? pctSigned(c.pct) : ''}${amounts && ok(c.pnl) ? `${ok(c.pct) ? ', ' : ''}${usdSigned(c.pnl)}` : ''} since ${ok(c.since) ? dayWords(c.since) : 'I started'}.`,
  };
}

/* ----------------------------------------------------------------- portfolio ----- */

export interface PortfolioFigures {
  /** The window's words: '24H', '7D', '30D', 'ALL'. */
  range: string;
  /** PnL over the window, USD (SoDEX's series, from the window's start). */
  change: number;
  /** The PnL path from the window's start (0). */
  ys: number[];
  trades: number | null;
  volume: number | null;
  value: number | null;
  wallet: string | null;
  /**
   * Which chart the element shows (owner 2026-11-28: "share buttons ... need to always show whats selected, timeframe,
   * chart, exactly whats selected in the element"): the PnL, or the change in value. PnL when not given.
   */
  view?: 'pnl' | 'value';
  /** Scan: someone else's wallet - the card names it and links to it instead of "SoDEX account" and /portfolio. */
  title?: string;
  label?: string;
  link?: string;
  foot?: string;
}

const RANGE_WORDS: Record<string, string> = { '24H': 'Last 24 hours', '7D': 'Last 7 days', '14D': 'Last 14 days', '30D': 'Last 30 days', '90D': 'Last 90 days', ALL: 'All time' };

/** How a Scan share names the wallet it shows: its short address and venue, linking to that Scan page. */
export function scanShare(address: string, venue: string, venueName: string): Pick<PortfolioFigures, 'title' | 'label' | 'link' | 'foot'> {
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  return { title: `${short} on ${venueName}`, label: 'Scan', link: `${SITE}/scan?address=${address}${venue === 'sodex' ? '' : `&venue=${venue}`}`, foot: venueName };
}

/**
 * Where the money is (the Portfolio's All and On-chain tabs, owner 2026-11-28 "Total value & share"): the total, and
 * each part with its share. No chart: the parts are the picture. Hidden dollars leave the shares only.
 */
export function holdingsCard(h: { title: string; total: number; parts: Array<{ label: string; usd: number }>; wallet: string | null; link?: string; label?: string }): CardData | null {
  if (!(h.total > 0)) return null;
  const parts = h.parts.filter((x) => x.usd > 0).sort((a, b) => b.usd - a.usd).slice(0, 4);
  const pct = (v: number) => `${((v / h.total) * 100).toFixed(1)}%`;
  return {
    kind: 'portfolio', label: h.label ?? 'Portfolio', when: 'Now', title: h.title, pills: [{ text: 'Total value' }],
    usd: null, pct: null,
    lead: { label: 'Total value', big: usdShort(h.total), usdBig: true, sub: '', subRest: '', altLabel: 'Largest part', altBig: parts[0] ? `${parts[0].label} ${pct(parts[0].usd)}` : '', altSub: '', altSubRest: '' },
    facts: parts.map((x) => ({ label: x.label, value: `${usdShort(x.usd)} · ${pct(x.usd)}`, kind: 'usd' as const })),
    foot: 'Each dollar counted once', chart: null, link: h.link ?? `${SITE}/portfolio`, second: null, wallet: h.wallet,
    post: ({ amounts }) => (amounts ? `${h.title} on ValueDesk: ${usdShort(h.total)}.` : `${h.title} on ValueDesk.`),
  };
}

export function portfolioCard(p: PortfolioFigures): CardData {
  const facts: CardFact[] = [];
  if (ok(p.value)) facts.push({ label: 'Account value', value: usdShort(p.value), kind: 'usd' });
  if (ok(p.trades)) facts.push({ label: 'Trades', value: p.trades.toLocaleString('en-US'), kind: 'stat' });
  if (ok(p.volume)) facts.push({ label: 'Volume', value: usdShort(p.volume), kind: 'usd' });
  const when = RANGE_WORDS[p.range] ?? p.range;
  const value = p.view === 'value';
  const what = value ? 'Change in value' : 'PnL';
  const whose = p.title ?? 'SoDEX account';
  const mine = !p.title;
  return {
    kind: 'portfolio', label: p.label ?? 'Portfolio', when, title: whose,
    pills: [{ text: p.range === 'ALL' ? 'All' : p.range }, ...(value ? [{ text: 'Total value' }] : [])],
    usd: p.change, pct: null, bigLabel: `${what}, ${when.toLowerCase()}`,
    // Hidden dollars: the chart says the rest; the words say which way, from the same figure.
    hidden: value
      ? { label: `${what}, ${when.toLowerCase()}`, big: p.change >= 0 ? 'Up' : 'Down', tone: p.change >= 0 ? 'up' : 'down' }
      : { label: `${what}, ${when.toLowerCase()}`, big: p.change >= 0 ? 'In profit' : 'In loss', tone: p.change >= 0 ? 'up' : 'down' },
    facts, foot: p.foot ?? (value ? 'SoDEX · deposits and withdrawals included' : 'SoDEX · fees and funding included'),
    chart: p.ys.length > 1 ? { type: 'pnl', ys: p.ys } : null, link: p.link ?? `${SITE}/portfolio`,
    second: facts.some((f) => f.kind === 'stat') ? { title: 'Trades', kind: 'stat' } : null, wallet: p.wallet,
    post: ({ amounts }) => {
      const who = mine ? 'My SoDEX account on ValueDesk' : `${whose} on ValueDesk`;
      return amounts ? `${who}, ${what.toLowerCase()} ${when.toLowerCase()}: ${usdSigned(p.change)}.` : `${who}, ${when.toLowerCase()}.`;
    },
  };
}
