/**
 * Bots > New bot, in four steps, with a receipt beside them (owner 2026-11-07, 2026-11-08):
 *
 *   1 Bot      a category (market maker, grid), then one of its bots: every setting our live runs and backtests
 *              kept is a bot of its own (bots/recipes.ts), with what it was measured at
 *   2 Market   one or several markets from a ranked table: price, activity per hour, what $1M does there, the
 *              uninformed flow's share, the spread. Several markets start one bot each, with the same settings.
 *   3 Settings three sub-steps: Size & risk, Quoting (simple, advanced folded), Safeguards (BotSettings)
 *   4 Review   the name; the receipt holds the rest; Start (asks first; the wallet signs at most once a day)
 *
 * The receipt on the right: the estimate per $1M with its range, how it adds up (the market's reading, the bot,
 * each safeguard, the wallet's own bots: bots/estimate.ts), what will run, and the balance it needs.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { onWalletPrompting, walletPrompting } from '../../wallet';
import { GLOSSARY } from '../../bots/glossary';
import { FINAL_STATUSES, parseAlgoSpec, regionPolicy, type MarketInfo } from '@copy-engine';
import { requestDeposit } from '../account/actions';
import { BETA_APPLY_URL } from '../../beta/access';
import { useBotLeverage } from '../../bots/leverage';
import { DASH, fmtUsd } from '../../format';
import { useSymbols } from '../../hooks';
import { useConfirm } from '../Modal';
import { marketOf } from '../algo/draft';
import { useHistory } from '../algo/liveData';
import { CoinIcon } from '../CoinIcon';
import { useBotMarkets, bpToPerMillion, type BotMarket } from '../../bots/data';
import { goBots, type BotsView } from '../../bots/routes';
import { STRATEGY_INFO, autoLeverage, clampLeverage, draftOfSpec, costPerMillion, gridRange, leverageCap, planMarkets, refusalOf, suggestedSpreadBps, type BotDraft, type RefusalAction, type Strategy } from '../../bots/presets';
import { CATEGORIES, RECIPE, draftOfRecipe, recipeOfDraft, recipesOf, type Category, type Recipe, type RecipeId } from '../../bots/recipes';
import { bestOf, estimate, feeAdjOf, ownRuns, type BotEstimate, type EstLine, type OwnRun } from '../../bots/estimate';
import { GRID_PRESETS, draftStepBps, gridEstimate, gridHalfRange, presetRangePct, useHourlyVol, type GridEstimate, type GridPresetId } from '../../bots/gridPresets';
import { GRID_BT_DAYS, GRID_BT_MARKETS } from '../../bots/gridBacktest';
import { BotAvatar, StrategyTile } from './BotIcon';
import { BrandMark } from '../BrandMark';
import { useAllocation } from './Allocation';
import { BotSettings, NameField, SEC_NAMES, type Sec } from './BotSettings';
import { BOTS_PREFILL_KEY, BotsHead, type BotsCtx } from './BotsPage';
import { Button, Icon, Inset, Panel, ProgressBar, RollingNumber, SearchField, Segmented, SegmentedBar, Shell, ShellHeader, Skeleton, StatusPill } from './kit/kit';

/** A cost in bp as what $1M does: −$185 (it costs), +$359 (it earns). */
export const fmtBpUsd = (bp: number | null | undefined): string => (bp === null || bp === undefined ? DASH : bp < 0 ? `+${fmtUsd(-bpToPerMillion(bp), 0)}` : bp > 0 ? `−${fmtUsd(bpToPerMillion(bp), 0)}` : fmtUsd(0, 0));
export const bpCls = (bp: number | null | undefined): string => (bp === null || bp === undefined ? '' : bp < 0 ? 'pos' : bp > 0 ? 'neg' : '');
const CONF_TONE = { high: 'positive', medium: 'warning', low: 'neutral' } as const;
/** How much an estimate rests on, in words (owner 2026-11-08: "medium" said nothing). */
export const CONF_WORDS = { high: 'Plenty of trades', medium: 'Fewer trades', low: 'Few trades' } as const;
export const CONF_HINT = 'How many trades on this market the estimate rests on: the fewer, the less sure it is.';
/** Who takes small makers' quotes: uninformed flow (1002, cheap to fill), informed flow (23342, about 1 bp a fill). */
export const TAKER_COLORS = { patient: 'var(--pos)', fast: 'var(--neg)', other: 'rgb(var(--ink) / 0.28)' };
const SOURCE: Record<EstLine['source'], string> = { market: 'This market\'s trades', tests: 'Our live runs and backtests', yours: 'Your own bots', none: 'Not measured here' };

/** Who takes small makers' quotes on a market. */
export function Takers({ m }: { m: BotMarket }) {
  return (
    <div className="bots-takers">
      <SegmentedBar
        label="Who takes small makers' quotes here"
        max={1}
        size="md"
        segments={[
          { id: 'p', value: m.takers.t1002, label: 'Uninformed flow', color: TAKER_COLORS.patient },
          { id: 'f', value: m.takers.t23342, label: 'Informed flow', color: TAKER_COLORS.fast },
          { id: 'o', value: m.takers.other, label: 'Others', color: TAKER_COLORS.other },
        ]}
      />
      <div className="bots-takers__key">
        <span title={GLOSSARY.uninformed}><i style={{ background: TAKER_COLORS.patient }} />Uninformed <b>{Math.round(m.takers.t1002 * 100)}%</b></span>
        <span title={GLOSSARY.informed}><i style={{ background: TAKER_COLORS.fast }} />Informed <b>{Math.round(m.takers.t23342 * 100)}%</b></span>
        <span><i style={{ background: TAKER_COLORS.other }} />Others <b>{Math.round(m.takers.other * 100)}%</b></span>
      </div>
    </div>
  );
}

/** What a bot is estimated to do on a market: the number, its range, how sure, who takes, the split. */
export function Estimate({ m, gate, feeBps, compact, d, runs, feeAdj = 0 }: { m: BotMarket | null; gate: boolean; feeBps: number; compact?: boolean; d?: BotDraft; runs?: readonly OwnRun[]; feeAdj?: number }) {
  if (!m) return <p className="bots-fine">Too few trades here to estimate.</p>;
  const e = d ? estimate(d, m, runs, feeAdj) : null;
  const est = e?.bp ?? (gate && m.gateCostBps !== null ? m.gateCostBps : m.estCostBps) + feeAdj;
  const low = e?.low ?? m.estCostLowBps;
  const high = e?.high ?? m.estCostHighBps;
  const conf = e?.confidence ?? m.confidence;
  const losses = est - feeBps;
  return (
    <div className="bots-est">
      <div className="bots-est__big">
        <span className="bots-est__k">Per $1M{e?.learned ? ' · learned' : gate ? ' · gate on' : ''}</span>
        <RollingNumber value={fmtBpUsd(est)} className={`bots-est__v ${bpCls(est)}`} />
        <span className="bots-est__sub">
          {fmtBpUsd(low)} to {fmtBpUsd(high)}
          <StatusPill size="sm" tone={CONF_TONE[conf]} dot title={CONF_HINT}>{CONF_WORDS[conf]}</StatusPill>
        </span>
      </div>
      <Takers m={m} />
      {!compact && (
        <Inset className="bots-ledger">
          <div><span>Fees</span><b className="neg">{fmtBpUsd(feeBps)}</b></div>
          {(() => {
            // The same lines as the receipt beside it: price moves on their own, then the bot's own lines (bots elsewhere, gates).
            const moves = e ? (e.lines.find((l) => l.id === 'market')?.bp ?? est) - feeBps : losses;
            const rest = e ? e.lines.filter((l) => l.id !== 'market' && l.bp !== null && l.counted !== false && Math.abs(l.bp) >= 0.005) : [];
            const row = (k: string, label: string, bp: number) => <div key={k}><span>{label}</span><b className={bp > 0 ? 'neg' : 'pos'}>{bp > 0 ? '−' : '+'}{fmtUsd(Math.abs(bpToPerMillion(bp)), 0)}</b></div>;
            return [row('moves', moves >= 0 ? 'Price moves' : 'Spread kept', moves), ...rest.map((l) => row(l.id, l.label, l.bp!))];
          })()}
          <div className="is-total"><span>All-in</span><b className={bpCls(est)}>{fmtBpUsd(est)}</b></div>
        </Inset>
      )}
    </div>
  );
}

/** The two bot types, said plainly. */
const TYPE_ABOUT: Record<Category, { line: string; good: string }> = {
  market: { line: 'Keeps a buy and a sell at the best price, all day.', good: 'For building trading volume at the lowest cost.' },
  grid: { line: 'Buys lower and sells higher inside a price range you set.', good: 'For a market moving sideways.' },
};

/**
 * The wizard's places (owner 2026-11-08): bot type, markets (so the presets' costs are those markets'), preset,
 * settings in three parts, review.
 */
type Part = Sec;
const PART_NAMES: Record<Part, string> = SEC_NAMES;
type Place = { step: 0 | 1 | 2 | 3 | 4; part?: Part };
const STEPS = [
  { title: 'Bot type', hint: 'Market maker or grid' },
  { title: 'Markets', hint: 'Where it trades' },
  { title: 'Preset', hint: 'A setup we tested' },
  { title: 'Settings', hint: 'Size, quoting, safeguards' },
  { title: 'Review', hint: 'Name and start' },
] as const;
// A grid has no quoting: that part is skipped.
const placesFor = (grid: boolean): Place[] => [
  { step: 0 }, { step: 1 }, { step: 2 }, { step: 3, part: 'size' }, ...(grid ? [] : [{ step: 3 as const, part: 'quote' as const }]), { step: 3, part: 'guard' }, { step: 4 },
];

/** A market without an oracle runs the plain maker: quotes off SoDEX's book, no gate, no rest. */
export const noLeadOf = (m: BotMarket | null | undefined): boolean => m?.lead === null;
export const effectiveDraft = (d: BotDraft, m: BotMarket | null | undefined): BotDraft => (d.strategy === 'market' && noLeadOf(m) ? { ...d, strategy: 'maker', gate: false } : d);

type MSort = 'best' | 'activity' | 'uninformed' | 'spread';

/** The markets, ranked; tick one or several. Activity is the market's own volume per hour (a bot's size does not change it). */
function MarketStep({ picked, toggle, markets, costOf, running, real }: {
  picked: string[]; toggle: (s: string) => void; markets: BotMarket[] | null; costOf: (m: BotMarket) => number | null;
  /** Markets where the wallet already runs a real bot (one real bot per market: the executor refuses a second). */
  running: ReadonlySet<string>;
  /** Starting real bots: those markets cannot be picked. */
  real: boolean;
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<MSort>('best');
  const [all, setAll] = useState(false);
  const { byName } = useSymbols('perps');
  const needle = q.trim().toLowerCase();
  const list = useMemo(() => {
    const xs = (markets ?? []).filter((m) => (!needle || m.symbol.toLowerCase().includes(needle)) && (all || needle || m.confidence !== 'low'));
    const by: Record<MSort, (m: BotMarket) => number> = { best: (m) => costOf(m) ?? 99, activity: (m) => -m.volumeUsdH, uninformed: (m) => -m.takers.t1002, spread: (m) => m.spreadBps };
    return [...xs].sort((x, y) => by[sort](x) - by[sort](y));
  }, [markets, needle, sort, all, costOf]);
  // What is ticked stays on top, so a preselected market (BTC, or one sent from Explore) is never hidden below the fold.
  const shown = useMemo(() => {
    const top = needle ? [] : list.filter((m) => picked.includes(m.symbol));
    const rest = list.filter((m) => !top.includes(m));
    return [...top, ...(all || needle ? rest : rest.slice(0, Math.max(0, 10 - top.length)))];
  }, [list, picked, all, needle]);
  const best = useMemo(() => (markets ?? []).filter((m) => m.confidence === 'high').sort((x, y) => (costOf(x) ?? 99) - (costOf(y) ?? 99))[0]?.symbol ?? null, [markets, costOf]);
  const extra = needle ? [...byName.keys()].filter((x) => x.toLowerCase().includes(needle) && !(markets ?? []).some((m) => m.symbol === x)).slice(0, 12) : [];
  if (!markets) return <div className="bots-skels">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="bots-skel" />)}</div>;
  const head = (k: MSort, label: string, title?: string) => (
    <th className="right" title={title}>
      <button type="button" className={`bots-th${sort === k ? ' is-on' : ''}`} onClick={() => setSort(k)}>{label}{sort === k && <Icon name="down" size={10} />}</button>
    </th>
  );
  const row = (symbol: string, m: BotMarket | null) => {
    const on = picked.includes(symbol);
    const c = m ? costOf(m) : null;
    const busy = running.has(symbol);
    // A market a real bot already trades: a real one cannot be added (ticked ones can still be unticked).
    const locked = real && busy && !on;
    const flip = () => { if (!locked) toggle(symbol); };
    return (
      <tr key={symbol} role="checkbox" aria-checked={on} aria-disabled={locked || undefined} aria-label={symbol} tabIndex={0} title={busy ? (real ? 'You already run a real bot here. Stop it first, or run this one as practice.' : 'You already run a real bot here.') : undefined} className={`bots-row${on ? ' is-picked' : ''}${locked ? ' is-blocked' : ''}`} onClick={flip} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } }}>
        <td className="bots-mt__pick"><span className={`bots-tick${on ? ' is-on' : ''}`} aria-hidden="true">{on && <Icon name="check" size={11} />}</span></td>
        <td>
          <span className="bots-mt__name">
            <CoinIcon coin={symbol} size={22} />
            <span><b>{symbol.replace(/-USD$/, '')}</b><small>{symbol}</small></span>
            {symbol === best && <StatusPill size="sm" tone="positive">best</StatusPill>}
            {busy && <StatusPill size="sm" tone={real ? 'warning' : 'neutral'} dot>running</StatusPill>}
            {m?.lead === null && <StatusPill size="sm">no oracle</StatusPill>}
            {!m && <StatusPill size="sm">little traded</StatusPill>}
          </span>
        </td>
        <td className="right num dim">{m ? fmtUsd(m.price) : DASH}</td>
        <td className="right num">{m ? fmtUsd(m.volumeUsdH, 0) : DASH}</td>
        <td className={`right num bots-strong ${bpCls(c)}`}>{fmtBpUsd(c)}</td>
        <td className="right">{m ? <span className="bots-share"><ProgressBar value={m.takers.t1002} max={1} size="sm" color={TAKER_COLORS.patient} label="Uninformed flow share" /><b>{Math.round(m.takers.t1002 * 100)}%</b></span> : DASH}</td>
        <td className="right num dim">{m ? `${m.spreadBps.toFixed(1)} bp` : DASH}</td>
      </tr>
    );
  };
  return (
    <Panel className="bots-mstep">
      <div className="bots-toolbar">
        <SearchField value={q} onChange={setQ} placeholder="Search a market (SOL, DOGE, NVDA…)" label="Search a market" className="bots-toolbar__search" />
        <span className="bots-toolbar__n">{picked.length} selected</span>
        <span className="bots-toolbar__sp" />
        <Segmented value={all ? 'all' : 'read'} label="Markets shown" onChange={(v) => setAll(v === 'all')} options={[{ value: 'read', label: 'Well read' }, { value: 'all', label: `All ${markets.length}` }]} />
      </div>
      <div className="bots-tablewrap">
        <table className="bots-table bots-mt" aria-label="Markets">
          <colgroup><col style={{ width: 36 }} /><col /><col style={{ width: 110 }} /><col style={{ width: 130 }} /><col style={{ width: 110 }} /><col style={{ width: 150 }} /><col style={{ width: 90 }} /></colgroup>
          <thead>
            <tr>
              <th />
              <th>Market</th>
              <th className="right">Price</th>
              {head('activity', 'Activity / h', "The market's traded volume per hour, last day")}
              {head('best', 'Per $1M', 'What $1M of this bot is estimated to do here, all-in')}
              {head('uninformed', 'Uninformed', "Share of small makers' fills taken by uninformed flow")}
              {head('spread', 'Spread')}
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => row(m.symbol, m))}
            {extra.map((x) => row(x, null))}
          </tbody>
        </table>
      </div>
      {!all && !needle && list.length > shown.length && <button type="button" className="bots-more__t" onClick={() => setAll(true)}>Show {list.length - shown.length} more<Icon name="arrowRight" size={13} /></button>}
    </Panel>
  );
}

/** How much a bot trades against the default, in a word and three bars (owner 2026-11-08: for someone new). */
const volumeWord = (x: number): { n: 1 | 2 | 3; word: string } => (x >= 1.1 ? { n: 3, word: 'Trades the most' } : x >= 0.9 ? { n: 2, word: 'Trades normally' } : { n: 1, word: 'Trades less' });
const TRACK = { proven: { tone: 'positive', label: 'Proven live' }, tested: { tone: 'neutral', label: 'Tested' }, early: { tone: 'warning', label: 'New' } } as const;
/** One bot's estimate over several markets: the plain average (each market gets one bot of the same size). */
function estimateOver(ms: readonly BotMarket[], f: (m: BotMarket) => BotEstimate): BotEstimate | null {
  const es = ms.map(f).filter((e) => e.bp !== null);
  if (!es.length) return null;
  const avg = (g: (e: BotEstimate) => number | null) => { const xs = es.map(g).filter((x): x is number => x !== null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
  return { ...es[0]!, bp: avg((e) => e.bp), low: avg((e) => e.low), high: avg((e) => e.high), volumeX: avg((e) => e.volumeX) ?? 1 };
}

/** A grid's backtest reading as the picker's estimate (its cost per $1M; no range, no market lines). */
function gridAsEstimate(g: GridEstimate): BotEstimate {
  return { bp: g.bp, low: null, high: null, volumeX: 1, lines: [], learned: null, confidence: null };
}

/** A grid preset's level count. */
const RECIPE_LEVELS = (rc: Recipe): number => (rc.id in GRID_PRESETS ? GRID_PRESETS[rc.id as GridPresetId].levels : rc.params.levels ?? 20);

/** A percent with as many places as it needs (0.62%, 4.1%, 12%). */
const pct = (x: number): string => `${x < 1 ? x.toFixed(2) : x < 10 ? x.toFixed(1) : x.toFixed(0)}%`;

/** A cost per $1M without the sign wall: a cost reads as a plain amount, earnings in green with a plus. */
const costText = (bp: number): { v: string; k: string; cls: string } => (bp < 0 ? { v: `+${fmtUsd(-bpToPerMillion(bp), 0)}`, k: 'earned per $1M traded', cls: 'pos' } : { v: fmtUsd(bpToPerMillion(bp), 0), k: 'cost per $1M traded', cls: '' });

/**
 * One bot to pick, read at a glance (owner 2026-11-08: "they will only read the cost and decide off of that"): a plain
 * sentence, the cost as the one number, how much it trades and how well it is tested in a word each; the test name and
 * the runs behind it open only on the picked bot.
 */
function RecipeRow({ rc, on, pick, est, where, best, blocked, grid = null, symbol }: { rc: Recipe; on: boolean; pick: () => void; est: BotEstimate | null; where: string; best: boolean; blocked?: string; grid?: GridEstimate | null; symbol?: string }) {
  const vol = est ? volumeWord(est.volumeX) : null;
  const c = est && est.bp !== null ? costText(est.bp) : null;
  const nc = est?.lines.filter((l) => l.counted === false && l.bp !== null) ?? [];
  const extra = nc.length ? nc.reduce((t, l) => t + l.bp!, 0) : null;
  return (
    <button type="button" role="radio" aria-checked={on} aria-label={rc.name} className={`bots-strow bots-rrow${on ? ' is-on' : ''}${best ? ' is-best' : ''}${blocked ? ' is-blocked' : ''}`} onClick={pick} disabled={!!blocked} title={blocked}>
      <span className={`bots-radio${on ? ' is-on' : ''}`} aria-hidden="true" />
      <StrategyTile strategy={rc.strategy} size={40} />
      <span className="bots-strow__t">
        <b>{rc.name}{best && <StatusPill size="sm" tone="positive" dot>Best {where.startsWith('on ') ? where : 'for these markets'}</StatusPill>}</b>
        <small>{blocked ?? rc.plain}</small>
        {rc.category === 'market' && (
          <span className="bots-rrow__facts">
            {vol && <span className="bots-vol" title={`${Math.round(est!.volumeX * 100)}% of the default's volume`}><i className="bots-vol__bars" aria-hidden="true">{[1, 2, 3].map((k) => <i key={k} className={k <= vol.n ? 'is-on' : ''} />)}</i>{vol.word}</span>}
            <StatusPill size="sm" tone={TRACK[rc.proof].tone}>{TRACK[rc.proof].label}</StatusPill>
          </span>
        )}
        {rc.category === 'grid' && grid && grid.stepBps > 0 && (
          <span className="bots-rrow__facts">
            <span className="bots-rrow__fact">Steps {pct(grid.stepBps / 100)}</span>
            <span className="bots-rrow__fact">Range ±{pct(gridHalfRange(grid.stepBps, RECIPE_LEVELS(rc)) * 100)}</span>
            {grid.ploss !== null && <StatusPill size="sm" tone={grid.ploss > 0.45 ? 'negative' : 'neutral'}>Lost in {Math.round(grid.ploss * 100)}% of tests</StatusPill>}
          </span>
        )}
        {on && rc.category === 'grid' && grid?.row && (
          <span className="bots-rrow__how">
            <span className="bots-rrow__howk">How we know</span>
            <span className="bots-rrow__ev">
              {[
                { what: `7-day runs, ${GRID_BT_MARKETS.length} markets`, per1m: grid.row.all[4] },
                ...(grid.row.day ? [{ what: '1-day runs', per1m: grid.row.day[4] }] : []),
                ...(symbol && grid.row.m[symbol] ? [{ what: `${symbol.replace(/-USD$/, '')} alone, 7-day runs`, per1m: grid.row.m[symbol]![4] }] : []),
              ].map((e) => { const x = costText(-e.per1m / 100); return <span key={e.what} className="bots-ev is-replay"><i aria-hidden="true" />{e.what}<b className={x.cls}>{x.v}</b></span>; })}
            </span>
            <small className="bots-rrow__nc">Backtest on {GRID_BT_DAYS} days of 1-minute prices, price moves included, at a 1.7 bp fee a fill (the cost on the right is at yours). A grid earns while the price swings sideways and loses when it runs off: on average it comes out close to even.</small>
          </span>
        )}
        {on && rc.evidence.length > 0 && (
          <span className="bots-rrow__how">
            <span className="bots-rrow__howk">How we know</span>
            <span className="bots-rrow__ev">
              {rc.evidence.slice(0, 3).map((e) => { const x = costText(e.bp); return <span key={e.what} className={`bots-ev is-${e.kind}`}><i aria-hidden="true" />{e.what}<b className={x.cls}>{x.v}</b></span>; })}
            </span>
            {extra !== null && <small className="bots-rrow__nc">Our tests show it about {fmtUsd(bpToPerMillion(-extra), 0)} cheaper. Not in the cost until it is proven live.</small>}
          </span>
        )}
      </span>
      <span className="bots-strow__n">
        {c
          ? <><b className={c.cls}>{c.v}</b><small>{c.k}</small><small>{where}</small></>
          : <><b className="dim">{DASH}</b><small>{rc.category === 'grid' ? 'reading the market' : 'not enough trades yet'}</small></>}
      </span>
    </button>
  );
}

/** A signed bar for one line of the receipt: left of the middle earns, right costs. */
function LineBar({ bp, max }: { bp: number | null; max: number }) {
  if (bp === null) return <span className="bots-rc__bar is-none" />;
  const w = Math.min(50, (Math.abs(bp) / max) * 50);
  return <span className="bots-rc__bar"><i className={bp > 0 ? 'neg' : 'pos'} style={bp > 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} /></span>;
}

/** The estimate's range, from low to high, with the estimate on it and zero marked. */
function RangeTrack({ low, high, v }: { low: number; high: number; v: number }) {
  const lo = Math.min(low, v, 0) - 0.2;
  const hi = Math.max(high, v, 0) + 0.2;
  // Costlier to the left, earning to the right (the labels read the same way).
  const at = (x: number) => `${((hi - x) / (hi - lo)) * 100}%`;
  return (
    <div className="bots-rc__range" aria-hidden="true">
      <span className="bots-rc__rtrack"><i style={{ left: at(Math.max(low, high)), width: `calc(${at(Math.min(low, high))} - ${at(Math.max(low, high))})` }} /></span>
      <span className="bots-rc__rzero" style={{ left: at(0) }} />
      <span className={`bots-rc__rdot ${bpCls(v)}`} style={{ left: at(v) }} />
    </div>
  );
}

/** The receipt: the estimate, how it adds up, what will run, what it needs. */
function Receipt({ d, eff, picked, markets, feeBps, feeAdj, paper, floor, runs, chosen, children, free = null, need, ownUsd = 0, gEst = null }: {
  /** A grid's backtest reading (null: not a grid). */
  gEst?: GridEstimate | null;
  d: BotDraft; eff: BotDraft; picked: string[]; markets: BotMarket[]; feeBps: number; feeAdj: number; paper: boolean; floor: ReturnType<typeof costPerMillion>; runs: readonly OwnRun[];
  /** What the picked bots set aside together: the same figure the start check uses (planMarkets, botMarginUsd). */
  need: number;
  /** Margin the wallet's own positions hold now: shown, not gated (the executor does not count it either). */
  ownUsd?: number;
  /** On or past the Markets step: before that the receipt names the preset only, with our mark. */
  chosen: boolean; children: ReactNode;
  /** The futures margin free for new bots (null while unknown). */
  free?: number | null;
}) {
  const grid = eff.strategy === 'grid';
  const rc = RECIPE[recipeOfDraft(d)];
  const ests = picked.map((s) => markets.find((m) => m.symbol === s) ?? null).filter((m): m is BotMarket => !!m).map((m) => ({ m, e: estimate(effectiveDraft({ ...d, symbol: m.symbol }, m), m, runs, feeAdj) }));
  const known = ests.filter((x) => x.e.bp !== null);
  const avg = (f: (e: BotEstimate) => number | null) => { const xs = known.map((x) => f(x.e)).filter((x): x is number => x !== null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
  const bp = grid ? (gEst?.bp ?? null) : avg((e) => e.bp);
  const low = grid ? null : avg((e) => e.low);
  const high = grid ? null : avg((e) => e.high);
  const volX = avg((e) => e.volumeX) ?? 1;
  // The lines, averaged over the picked markets: fees, price moves, then the bot and each safeguard.
  const lines: Array<{ id: string; label: string; bp: number | null; source: EstLine['source']; note?: string; counted?: boolean }> = [];
  if (grid) {
    // Per $1M traded: the fees, what the steps give back (half a step per $1 traded), and what the price did to what
    // the grid held - the backtest's result less the other two.
    const steps = gEst && gEst.stepBps > 0 ? -gEst.stepBps / 2 : null;
    lines.push({ id: 'fees', label: 'Fees', bp: feeBps, source: 'market' });
    lines.push({ id: 'steps', label: 'Grid steps', bp: steps, source: 'market' });
    if (gEst?.bp != null && steps !== null) lines.push({ id: 'moves', label: 'Price moves', bp: gEst.bp - feeBps - steps, source: 'tests', note: 'What the price did to what the grid held, in our backtest.' });
  } else if (known.length) {
    lines.push({ id: 'fees', label: 'Fees', bp: feeBps, source: 'market' });
    lines.push({ id: 'moves', label: 'Price moves', bp: avg((e) => (e.lines.find((l) => l.id === 'market')?.bp ?? 0) - feeBps), source: 'market' });
    const ids = [...new Set(known.flatMap((x) => x.e.lines.map((l) => l.id)))].filter((id) => id !== 'market');
    for (const id of ids) {
      const ls = known.map((x) => x.e.lines.find((l) => l.id === id)).filter((l): l is EstLine => !!l);
      const vals = ls.map((l) => l.bp).filter((x): x is number => x !== null);
      lines.push({ id, label: ls[0]!.label, bp: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, source: ls[0]!.source, note: ls.length === 1 ? ls[0]!.note : undefined, counted: ls[0]!.counted });
    }
  }
  const maxAbs = Math.max(0.5, ...lines.map((l) => Math.abs(l.bp ?? 0)));
  const learned = known.map((x) => x.e.learned).find((l) => !!l) ?? null;
  const conf = known[0]?.e.confidence ?? null;
  const name = d.label.trim() || `${rc.name}${chosen && picked.length === 1 ? ` ${picked[0]!.replace(/-USD$/, '')}` : ''}`;
  const guards = [
    { id: 'gate', icon: 'pulse' as const, label: 'Volatility gate', on: eff.strategy === 'market' && eff.gate },
    { id: 'flow', icon: 'robot' as const, label: 'Flow gate', on: !grid && d.flowOn },
    { id: 'quiet', icon: 'clock' as const, label: 'Trading hours', on: !grid && d.quiet.length > 0 },
    { id: 'news', icon: 'bolt' as const, label: 'News gate', on: !grid && d.news !== null },
    { id: 'spread', icon: 'layers' as const, label: 'Spread limit', on: d.maxSpreadBps !== null },
  ];
  return (
    <div className="bots-rc">
      <header className="bots-rc__head">
        {!chosen
          ? <span className="bots-rc__brand"><BrandMark size={26} /></span>
          : picked.length > 1
          ? <span className="bots-rc__coins" aria-label={picked.join(', ')}>{picked.slice(0, 3).map((x) => <CoinIcon key={x} coin={x} size={28} />)}{picked.length > 3 && <b>+{picked.length - 3}</b>}</span>
          : <BotAvatar symbol={picked[0] ?? d.symbol} strategy={eff.strategy} size={44} />}
        <span className="bots-rc__name"><b>{name}</b><small>{!chosen ? (rc.category === 'grid' ? 'Grid' : 'Market maker') : picked.length > 1 ? `${rc.name} · ${picked.map((x) => x.replace(/-USD$/, '')).join(', ')}` : rc.name}</small></span>
        <StatusPill size="sm" tone={paper ? 'neutral' : 'positive'} dot>{paper ? 'Practice' : 'Live'}</StatusPill>
      </header>

      {!chosen ? (
        <section className="bots-rc__hero">
          <span className="bots-rc__k">Estimated cost per $1M traded</span>
          <span className="bots-rc__v dim">{DASH}</span>
          <span className="bots-rc__meta"><span className="bots-rc__chip"><Icon name="compass" size={12} />Shown once you pick markets</span></span>
        </section>
      ) : (
      <section className="bots-rc__hero">
        <span className="bots-rc__k">{bp !== null && bp < 0 ? 'Estimated earnings' : 'Estimated cost'} per $1M traded{picked.length > 1 ? `, ${picked.length} markets` : ''}</span>
        <RollingNumber value={bp === null ? DASH : costText(bp).v} className={`bots-rc__v ${bp === null ? '' : costText(bp).cls}`} />
        {low !== null && high !== null && bp !== null && (
          <>
            <RangeTrack low={low} high={high} v={bp} />
            <span className="bots-rc__rl"><span>{fmtBpUsd(Math.max(low, high))}</span><span>{fmtBpUsd(Math.min(low, high))}</span></span>
          </>
        )}
        <span className="bots-rc__meta">
          {conf && <StatusPill size="sm" tone={CONF_TONE[conf]} dot title={CONF_HINT}>{CONF_WORDS[conf]}</StatusPill>}
          {!grid && volX < 0.995 && <span className="bots-rc__chip"><Icon name="clock" size={12} />Quotes {Math.round(volX * 100)}% of the time</span>}
          {grid && gEst?.ploss != null && <StatusPill size="sm" tone={gEst.ploss > 0.45 ? 'negative' : 'neutral'} dot>Lost in {Math.round(gEst.ploss * 100)}% of 7-day tests</StatusPill>}
          {grid && gEst?.dayBps != null && gEst.turn != null && (
            <span className="bots-rc__chip" title="The backtest's average day, on this grid's size (levels × order).">
              <Icon name="clock" size={12} />Average day {gEst.dayBps >= 0 ? '+' : '−'}{fmtUsd(Math.abs((gEst.dayBps * d.orderUsd * d.levels) / 10_000), 2)} · trades {fmtUsd(gEst.turn * d.orderUsd * d.levels, 0)}
            </span>
          )}
          {learned && <span className="bots-rc__chip is-learn"><Icon name="bolt" size={12} />Learned from {fmtUsd(learned.volumeUsd, 0)} of your bots</span>}
        </span>
      </section>
      )}

      {chosen && lines.length > 0 && (
        <section className="bots-rc__sum" aria-label="How it adds up">
          {lines.map((l) => (
            <div key={l.id} className={`bots-rc__line${l.counted === false ? ' is-off' : ''}`} title={`${SOURCE[l.source]}${l.note ? ` · ${l.note}` : ''}`}>
              <span className="bots-rc__ll"><i className={`bots-src is-${l.source}`} aria-hidden="true" />{l.label}</span>
              <LineBar bp={l.bp} max={maxAbs} />
              <b className={l.counted === false ? 'dim' : bpCls(l.bp)}>{l.bp === null ? 'n/a' : fmtBpUsd(l.bp)}</b>
              {l.note && <small className="bots-rc__note">{l.note}</small>}
            </div>
          ))}
          <div className="bots-rc__srckey"><span><i className="bots-src is-market" />Market data</span><span><i className="bots-src is-tests" />Tests</span><span><i className="bots-src is-yours" />Your bots</span></div>
        </section>
      )}

      <section className="bots-rc__tiles">
        <div className="bots-rc__tile is-wide">
          <span>{picked.length === 1 ? 'Market' : `Markets · ${picked.length}`}</span>
          <b className="bots-rc__mkts">{!chosen ? <span className="dim">Picked in the next step</span> : picked.length ? picked.map((s) => <span key={s}><CoinIcon coin={s} size={16} />{s.replace(/-USD$/, '')}</span>) : DASH}</b>
        </div>
        <div className="bots-rc__tile"><span>Order size</span><b>{fmtUsd(d.orderUsd, 0)}<small>{grid ? ` × ${d.levels}` : ' a side'}</small></b></div>
        {!grid ? <div className="bots-rc__tile"><span>Max holding</span><b>{fmtUsd(d.maxInventoryUsd, 0)}</b></div> : <div className="bots-rc__tile"><span>Levels</span><b>{d.levels}{gEst && gEst.stepBps > 0 ? <small>{` · ${pct(gEst.stepBps / 100)} apart`}</small> : null}</b></div>}
        <div className="bots-rc__tile"><span>Loss limit</span><b>{d.maxLossUsd === null ? 'None' : fmtUsd(d.maxLossUsd, 0)}</b></div>
        <div className="bots-rc__tile"><span>Runs</span><b>{d.runHours === null ? 'Until stopped' : d.runHours >= 168 ? `${Math.round(d.runHours / 24)} days` : `${d.runHours} h`}</b></div>
      </section>

      <section className="bots-rc__guards" aria-label="Safeguards">
        {guards.map((g) => (
          <span key={g.id} className={`bots-rc__guard${g.on ? ' is-on' : ''}`} title={`${g.label}: ${g.on ? 'on' : 'off'}`}>
            <Icon name={g.icon} size={13} /><span>{g.label}</span>
          </span>
        ))}
      </section>

      <footer className="bots-rc__foot">
        <div><span>Sets aside</span><b className={!paper && free !== null && need > free ? 'neg' : ''}>about {fmtUsd(need, 0)}</b></div>
        <div title="Your futures account less what your real bots and copies set aside."><span>Free for bots</span><b>{free === null ? DASH : fmtUsd(free, 0)}</b></div>
        {ownUsd >= 1 && <div title="Margin your own open positions hold now. Not set aside for bots, but it moves with them."><span>Your positions use</span><b>{fmtUsd(ownUsd, 0)}</b></div>}
      </footer>
      {children}
    </div>
  );
}

/** The settings "Run again" left for this page (sessionStorage, BotsPage BOTS_PREFILL_KEY), if fresh and for this market. */
function prefillDraft(market: string | null | undefined): BotDraft | null {
  try {
    const raw = sessionStorage.getItem(BOTS_PREFILL_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(BOTS_PREFILL_KEY);
    const p = JSON.parse(raw) as { at?: number; spec?: Record<string, unknown> };
    if (!p.spec || !(Number(p.at) > Date.now() - 10 * 60_000)) return null;
    if (market && p.spec.symbol !== market) return null;
    return draftOfSpec(parseAlgoSpec(p.spec));
  } catch {
    return null;
  }
}

export function BotNewPage({ ctx, view }: { ctx: BotsCtx; view: Extract<BotsView, { page: 'new' }> }) {
  const startRecipe: RecipeId = view.kind && view.kind in RECIPE ? (view.kind as RecipeId) : view.kind === 'grid' ? 'grid' : 'r10';
  // A preset change keeps every setting that is not the preset's own (bots/recipes.ts draftOfRecipe).
  const fromRecipe = draftOfRecipe;
  // "Run again" / "Run with real orders" (BotsPage runAgain): the stopped bot's settings, kept 10 minutes, read once.
  const [d, setD] = useState<BotDraft>(() => prefillDraft(view.market) ?? fromRecipe(startRecipe, view.market ?? 'BTC-USD'));
  const [cat, setCat] = useState<Category>(RECIPE[startRecipe].category);
  const [picked, setPicked] = useState<string[]>(() => [view.market ?? 'BTC-USD']);
  const grid = d.strategy === 'grid';
  const places = placesFor(grid);
  // From Explore (a market given): its markets are picked, the preset is next.
  const [at, setAt] = useState(view.market ? 2 : 0);
  const place = places[Math.min(at, places.length - 1)]!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; action: RefusalAction; label: string | null; started: string[]; left: string[]; symbol: string | null } | null>(null);
  useEffect(() => { if (view.market) { setD((x) => ({ ...x, symbol: view.market! })); setPicked([view.market]); } }, [view.market]);
  const set = (p: Partial<BotDraft>) => setD((x) => ({ ...x, ...p }));
  // The first picked market leads the form (its price, its minimum size); the others start with the same settings.
  useEffect(() => { if (picked[0] && picked[0] !== d.symbol) setD((x) => ({ ...x, symbol: picked[0]!, low: null, high: null })); }, [picked, d.symbol]);
  const { byName } = useSymbols('perps');
  const sym = byName.get(d.symbol);
  const market: MarketInfo | null = sym ? marketOf(sym) : null;
  const hist = useHistory(d.symbol, true, 10);
  const mark = hist?.length ? hist[hist.length - 1]!.p : null;
  // A grid preset's step is k x the market's hourly volatility: its range follows the market once that is read.
  const vol = useHourlyVol(grid ? d.symbol : null);
  useEffect(() => {
    if (!grid || d.gridK === null || d.low !== null || d.high !== null || vol === null) return;
    const p = presetRangePct(d.gridK, d.levels, vol);
    if (Math.abs(p - d.rangePct) > 1e-6) setD((x) => (x.gridK === d.gridK && x.levels === d.levels && x.low === null ? { ...x, rangePct: p } : x));
  }, [grid, d.gridK, d.levels, d.low, d.high, d.rangePct, vol]);
  const range = grid ? gridRange(d, mark) : null;
  const markets = useBotMarkets('24h');
  const paper = !ctx.liveAllowed || d.paper;

  // Leverage: under every picked market's maximum, nothing else (owner 2026-11-08); none offered while a maximum is
  // unknown. Auto (the default) follows the sizing: the lowest leverage at which the margin fits (autoLeverage below).
  const regionMax: number | null = null;
  const lev = useBotLeverage(ctx.address, d.symbol);
  const maxes = picked.map((x) => byName.get(x)?.maxLeverage ?? null);
  const levCap = maxes.some((x) => x === null || x === undefined) ? null : leverageCap(Math.min(...(maxes as number[])), regionMax);
  const holdLev = useRef(false);
  const levSym = useRef(d.symbol);
  useEffect(() => {
    if (levSym.current === d.symbol) return;
    levSym.current = d.symbol;
    if (holdLev.current) return;
    setD((x) => (x.leverage === null ? x : { ...x, leverage: null }));
  }, [d.symbol]);
  useEffect(() => {
    if (d.leverage !== null && levCap !== null && clampLeverage(d.leverage, levCap) !== d.leverage) {
      setD((x) => ({ ...x, leverage: clampLeverage(x.leverage, levCap) }));
    }
  }, [levCap, d.leverage]);

  // Markets a real bot of this wallet already trades (the executor's one real bot per market).
  const runningReal = useMemo(() => new Set(ctx.bots.filter((v) => v.algo.spec.bot && !v.algo.spec.paper && !FINAL_STATUSES.has(v.algo.status)).map((v) => v.algo.spec.symbol)), [ctx.bots]);
  const toggle = (s: string) => {
    if (!paper && runningReal.has(s) && !picked.includes(s)) return;
    setPicked((xs) => (xs.includes(s) ? (xs.length > 1 ? xs.filter((x) => x !== s) : xs) : grid ? [s] : [...xs, s].slice(0, 8)));
  };
  const runs = useMemo(() => ownRuns(ctx.bots, markets.data?.markets ?? null), [ctx.bots, markets.data]);
  const est = markets.data?.markets.find((m) => m.symbol === d.symbol) ?? null;
  const noLead = noLeadOf(est);
  const eff = effectiveDraft(d, est);
  // Fees: SoDEX's maker rate and this wallet's own bot fee (ctx.feeTenths, from the executor's /me), never a flat 0.1 bp.
  const feeBps = (markets.data ? markets.data.fee.makerBps : 1.2) + ctx.feeTenths / 10;
  const feeAdj = feeAdjOf(ctx.feeTenths, markets.data?.fee.builderBps);
  const floor = costPerMillion(eff, market, mark, ctx.feeTenths);
  // A grid's estimate is what the same grid did in our backtest (price moves included), at this wallet's fee.
  const gridEstOf = (x: BotDraft): GridEstimate => gridEstimate({ symbol: x.symbol, stepBps: draftStepBps(x, vol), levels: x.levels, outOfRange: x.outOfRange, volBps: vol, feeBps });
  const gEst = grid ? gridEstOf(d) : null;
  const costOf = useMemo(() => (m: BotMarket) => estimate(effectiveDraft({ ...d, symbol: m.symbol }, m), m, runs, feeAdj).bp, [d, runs, feeAdj]);
  const rid = recipeOfDraft(d);

  // Every picked market checked with its own price, rules and leverage before anything is signed.
  const lookUp = (s: string) => {
    const m = markets.data?.markets.find((x) => x.symbol === s) ?? null;
    const y = byName.get(s);
    return { market: y ? marketOf(y) : null, price: s === d.symbol ? mark : (m?.price ?? null), maxLeverage: y?.maxLeverage ?? null, draft: effectiveDraft({ ...d, symbol: s }, m) };
  };
  const plans = useMemo(() => planMarkets(d, picked, lookUp, { paper, regionMax, mark }), [d, picked, markets.data, byName, mark, paper, regionMax]); // eslint-disable-line react-hooks/exhaustive-deps
  const lead = plans.find((x) => x.symbol === d.symbol) ?? null;
  const many = picked.length > 1;
  const sizeErrors = lead?.errors ?? [];
  const sizeNotes = lead?.notes ?? [];
  const allErrors = plans.flatMap((x) => x.errors.map((e) => (many ? `${x.symbol.replace(/-USD$/, '')}: ${e}` : e)));
  const allNotes = plans.flatMap((x) => x.notes.map((e) => (many ? `${x.symbol.replace(/-USD$/, '')}: ${e}` : e)));
  const why = ctx.setupWhy(paper);
  // Smart margining: a real bot (each of several) sets aside what it needs; together they fit the free margin.
  const alloc = useAllocation(ctx);
  const needAll = plans.reduce((t, x) => t + x.marginUsd, 0);
  // Free as the executor counts it: the account less the real bots' margin and the hosted copies' allocations. The
  // user's own positions are shown beside it, not taken off (the executor does not).
  const hostedCopyUsd = alloc.copies.filter((c) => !c.mode || c.mode === 'hosted').reduce((t, c) => t + c.usd, 0);
  const free = alloc.equity === null ? null : Math.max(0, alloc.equity - alloc.botUsd - hostedCopyUsd);
  const short = !paper && free !== null && needAll > free + 1e-6 ? needAll - free : 0;
  // The size check itself (owner 2026-11-09: settings must not take more size than the margin can carry): an error on
  // the size step, with the size that fits, so Next waits for it - not only a refusal at Start.
  const levNow = Math.max(1, d.leverage ?? 1);
  const atCap = levCap !== null && levNow >= levCap;
  const fit = short > 0 && needAll > 0 ? (free ?? 0) / needAll : 1;
  const marginError: string | null = short > 0
    ? `Needs about ${fmtUsd(needAll, 0)} of margin at ${levNow}x, but ${fmtUsd(free ?? 0, 0)} is free. `
      + (grid
        ? `Lower the order size to about ${fmtUsd(Math.floor(d.orderUsd * fit), 0)}`
        : `Lower Max holding to about ${fmtUsd(Math.floor(d.maxInventoryUsd * fit), 0)}`)
      + `${atCap ? '' : ', raise the leverage'}, or deposit more.`
    : null;
  const sizeProblems = marginError ? [...sizeErrors, marginError] : sizeErrors;
  // Auto leverage (owner 2026-11-08): what the bots may hold and quote at 1x, against what is free.
  const reserveAll = plans.reduce((t, x) => t + x.marginUsd * Math.max(1, d.leverage ?? 1), 0);
  const autoLev = autoLeverage(reserveAll, paper ? null : free, levCap);
  useEffect(() => {
    if (d.leverageAuto && autoLev !== null && d.leverage !== autoLev) setD((x) => ({ ...x, leverage: autoLev }));
  }, [d.leverageAuto, autoLev, d.leverage]);
  const clash = paper ? [] : picked.filter((x) => runningReal.has(x));
  const whyNot: string | null =
    !ctx.address ? 'Connect your wallet to start a bot.'
    : why ? why
    : !ctx.ready ? 'The ValueDesk executor is not ready yet.'
    : !picked.length ? 'Pick at least one market.'
    : grid && !range ? 'Waiting for the price to set the range.'
    : allErrors.length ? 'Fix the order size first (see Review).'
    : !paper && d.leverage === null ? "Reading the market's leverage and your account…"
    : clash.length ? `You already run a real bot on ${clash.map((x) => x.replace(/-USD$/, '')).join(', ')}. Stop it, untick it, or turn on Practice.`
    : short > 0 ? `Needs ${fmtUsd(needAll, 0)} of margin, ${fmtUsd(free ?? 0, 0)} is free.`
    : null;
  const can = whyNot === null;

  const { confirm, dialog } = useConfirm();
  const start = async () => {
    if (!can) return;
    const list = [...picked];
    const ok = await confirm({
      title: many ? `Start ${list.length} bots?` : `Start ${d.label.trim() || `${RECIPE[rid].name} ${d.symbol.replace(/-USD$/, '')}`}?`,
      body: `${RECIPE[rid].name} on ${list.join(', ')}, ${fmtUsd(d.orderUsd, 0)} orders${grid ? '' : `, up to ${fmtUsd(d.maxInventoryUsd, 0)} held each`}${d.maxLossUsd !== null ? `, stops at a ${fmtUsd(d.maxLossUsd, 0)} loss` : ''}.${allNotes.length ? ` ${allNotes.join(' ')}` : ''} ${paper ? 'Practice: no orders are sent.' : `Real orders in your SoDEX account, about ${fmtUsd(needAll, 0)} of margin set aside.`}`,
      confirmLabel: paper ? (many ? `Start ${list.length} practice bots` : 'Start practice bot') : (many ? `Start ${list.length} bots` : 'Start bot'),
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    const started: string[] = [];
    let last: Awaited<ReturnType<BotsCtx['start']>> | null = null;
    // Each market leaves the list once its bot started, so a retry never starts it twice; the leverage stays as set.
    holdLev.current = true;
    try {
      // Built again now, so the run time counts from the start, not from when the page was drawn.
      for (const p of planMarkets(d, list, lookUp, { paper, regionMax, mark })) {
        try {
          if (!p.spec) throw new Error(`${p.symbol}: these settings do not make a valid bot.`);
          last = await ctx.start(p.spec);
          started.push(p.symbol);
          const done = p.symbol;
          setPicked((xs) => (xs.length > 1 ? xs.filter((x) => x !== done) : xs));
        } catch (e) {
          const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : null;
          const r = refusalOf(code, e instanceof Error ? e.message : String(e), many);
          const left = list.filter((x) => !started.includes(x));
          if (started.length) setPicked(left);
          setError({ ...r, started: [...started], left, symbol: p.symbol });
          return;
        }
      }
      if (many || !last) goBots({ page: 'overview' });
      else goBots({ page: 'bot', id: last.algo.id });
    } finally {
      holdLev.current = false;
      setBusy(false);
    }
  };
  const act = (a: RefusalAction) => {
    if (a === 'setup') ctx.setup(false);
    else if (a === 'deposit') requestDeposit();
    else if (a === 'discord') window.open(BETA_APPLY_URL, '_blank', 'noopener,noreferrer');
    else if (a === 'practice') set({ paper: true });
    else if (a === 'size') { const k = places.findIndex((p) => p.part === 'size'); if (k >= 0) setAt(k); }
    else if (a === 'stop-other') {
      const other = error?.symbol ? ctx.bots.find((v) => v.algo.spec.bot && !v.algo.spec.paper && !FINAL_STATUSES.has(v.algo.status) && v.algo.spec.symbol === error.symbol) : null;
      goBots(other ? { page: 'bot', id: other.algo.id } : { page: 'overview' });
    }
  };

  // While the wallet shows a signature (the day key's approval), the button says so instead of "Starting…".
  const signing = useSyncExternalStore(onWalletPrompting, walletPrompting);
  const last = places.length - 1;
  const next = () => setAt((s) => Math.min(last, s + 1));
  const back = () => setAt((s) => Math.max(0, s - 1));
  const goStep = (i: number) => { const k = places.findIndex((p) => p.step === i); if (k >= 0 && k <= at) setAt(k); };
  const startLabel = busy && signing ? 'Waiting for your wallet…' : busy ? 'Starting…' : paper ? (picked.length > 1 ? `Start ${picked.length} practice bots` : 'Start practice bot') : (picked.length > 1 ? `Start ${picked.length} bots` : 'Start bot');
  const parts = places.filter((p) => p.step === 3).map((p) => p.part!);
  const pickRecipe = (id: RecipeId) => {
    setD((x) => fromRecipe(id, x.symbol, x));
    if (RECIPE[id].strategy === 'grid') setPicked((xs) => xs.slice(0, 1));
  };
  // The picker: the best on this market first (credited only for measured edges: bestOf), then cheapest first.
  const pickedMs = picked.map((x) => markets.data?.markets.find((m) => m.symbol === x) ?? null).filter((m): m is BotMarket => !!m);
  // A preset that quotes off the oracle needs every picked market to have one (owner 2026-11-08).
  const noOracle = pickedMs.filter((m) => m.lead === null).map((m) => m.symbol.replace(/-USD$/, ''));
  const blocked = (rc: Recipe) => rc.oracle && noOracle.length > 0;
  const scored = recipesOf(cat).filter((rc) => !blocked(rc)).map((rc) => {
    if (rc.category === 'grid') {
      const g = gridEstOf(fromRecipe(rc.id, d.symbol, d));
      return { id: rc.id, rc, e: g.bp === null ? null : gridAsEstimate(g), g };
    }
    return { id: rc.id, rc, e: estimateOver(pickedMs, (m) => estimate(effectiveDraft(fromRecipe(rc.id, m.symbol, d), m), m, runs, feeAdj)), g: null };
  });
  const where = picked.length === 1 ? `on ${picked[0]!.replace(/-USD$/, '')}` : `average, ${picked.length} markets`;
  const bestId = cat === 'market' && pickedMs.length ? bestOf(scored.filter((x): x is typeof x & { e: BotEstimate } => !!x.e && x.e.bp !== null).map((x) => ({ id: x.id, est: x.e })))?.id ?? null : null;
  const blockedRows = recipesOf(cat).filter(blocked);
  // Grids keep their order (wide, balanced, dense): their costs are within each other's noise, the order says what they are.
  const rows = cat === 'grid' ? scored : [...scored].sort((a, b) => (a.id === bestId ? -1 : b.id === bestId ? 1 : (a.e?.bp ?? 99) - (b.e?.bp ?? 99)));
  // The spread limit from the picked markets' real spread (the widest of them), while it is still the untouched default.
  const spreadHint = pickedMs.map((m) => suggestedSpreadBps(m)).filter((x): x is number => x !== null);
  const spreadSuggest = spreadHint.length ? Math.max(...spreadHint) : null;
  useEffect(() => { if (spreadSuggest !== null && d.maxSpreadBps === 20 && spreadSuggest !== 20) setD((x) => (x.maxSpreadBps === 20 ? { ...x, maxSpreadBps: spreadSuggest } : x)); }, [spreadSuggest]); // eslint-disable-line react-hooks/exhaustive-deps
  // Markets without an oracle picked while an oracle preset is on: the book maker takes over.
  useEffect(() => { if (cat === 'market' && noOracle.length && RECIPE[rid].oracle) setD((x) => fromRecipe('touch', x.symbol, x)); }, [cat, noOracle.length, rid]); // eslint-disable-line react-hooks/exhaustive-deps
  const nextLabel = place.step === 3 && place.part !== parts[parts.length - 1] ? `Next: ${PART_NAMES[parts[parts.indexOf(place.part!) + 1]!]}` : 'Next';

  return (
    <>
      {dialog}
      <BotsHead view={view} title="New bot" sub="Pick a bot, its markets and its settings." />
      <nav className="bots-wsteps" aria-label="Steps">
        <ol>
          {STEPS.map((st, i) => (
            <li key={st.title} className={i === place.step ? 'is-on' : i < place.step ? 'is-done' : ''}>
              <button type="button" onClick={() => goStep(i)} disabled={i > place.step} aria-current={i === place.step ? 'step' : undefined}>
                <span className="bots-wsteps__t">
                  <b>{i < place.step ? <Icon name="check" size={12} /> : <span className="bots-wsteps__n">{i + 1}</span>}{st.title}</b>
                  {i === 3 ? (
                    <span className="bots-wsteps__subs">
                      {parts.map((p) => {
                        const k = places.findIndex((x) => x.part === p);
                        return <span key={p} className={`bots-wsub${place.part === p ? ' is-on' : k < at ? ' is-done' : ''}`} onClick={(e) => { if (k <= at) { e.stopPropagation(); setAt(k); } }}>{PART_NAMES[p]}</span>;
                      })}
                    </span>
                  ) : <small>{st.hint}</small>}
                </span>
                <span className="bots-wsteps__seg" aria-hidden="true">{i === 3 && <span className="bots-wsteps__fill" style={{ width: place.step > 3 ? '100%' : place.step < 3 ? '0%' : `${((parts.indexOf(place.part!) + 1) / parts.length) * 100}%` }} />}</span>
              </button>
            </li>
          ))}
        </ol>
        <span className="bots-wsteps__count">{place.step + 1}/{STEPS.length}{place.part ? ` · ${PART_NAMES[place.part]}` : ''}</span>
      </nav>
      <div className="bots-wizard">
        <div className="bots-wizard__main">
          {place.step === 0 && (
            <Shell>
              <ShellHeader icon="layers" title="Bot type" subtitle="What should your bot do?" />
              <div className="bots-types" role="radiogroup" aria-label="Bot type">
                {CATEGORIES.map((c) => {
                  const on = cat === c.id;
                  const n = recipesOf(c.id).length;
                  return (
                    <button key={c.id} type="button" role="radio" aria-checked={on} aria-label={c.name} className={`bots-type${on ? ' is-on' : ''}`} onClick={() => { setCat(c.id); if (RECIPE[rid].category !== c.id) pickRecipe((recipesOf(c.id).find((r) => r.tag === 'Recommended') ?? recipesOf(c.id)[0]!).id); }}>
                      <span className={`bots-radio${on ? ' is-on' : ''}`} aria-hidden="true" />
                      <StrategyTile strategy={c.id === 'grid' ? 'grid' : 'market'} size={48} />
                      <span className="bots-type__t">
                        <b>{c.name}</b>
                        <span>{TYPE_ABOUT[c.id].line}</span>
                        <small>{TYPE_ABOUT[c.id].good}</small>
                      </span>
                      <span className="bots-cat__n">{n} {n === 1 ? 'preset' : 'presets'}</span>
                    </button>
                  );
                })}
              </div>
            </Shell>
          )}

          {place.step === 2 && (
            <Shell>
              <ShellHeader icon="star" title="Preset" subtitle={grid ? `Grids we backtested on ${GRID_BT_MARKETS.length} markets over ${GRID_BT_DAYS} days, sized to ${d.symbol.replace(/-USD$/, '')}'s swings now.` : `Setups we tested, ${picked.length === 1 ? `on ${picked[0]!.replace(/-USD$/, '')}` : `on your ${picked.length} markets`}. Lower cost is better.`} />
              <div className="bots-strows" role="radiogroup" aria-label="Preset">
                {rows.map(({ rc, e, g }) => (
                  <RecipeRow key={rc.id} rc={rc} on={rid === rc.id} pick={() => pickRecipe(rc.id)} where={where} est={e} best={rc.id === bestId} grid={g} symbol={d.symbol} />
                ))}
                {blockedRows.map((rc) => (
                  <RecipeRow key={rc.id} rc={rc} on={false} pick={() => undefined} where={where} est={null} best={false} blocked={`Needs an oracle price: ${noOracle.join(', ')} ${noOracle.length === 1 ? 'has' : 'have'} none.`} />
                ))}
              </div>
            </Shell>
          )}

          {place.step === 1 && (
            <Shell>
              <ShellHeader icon="compass" title="Markets" subtitle={grid ? 'One market for a grid.' : 'Tick one or several: one bot each, with the same settings.'} aside={<Button variant="quiet" onClick={() => goBots({ page: 'explore' })}>Compare all<Icon name="arrowRight" size={13} /></Button>} />
              <MarketStep picked={picked} toggle={toggle} markets={markets.data?.markets ?? (markets.error ? [] : null)} costOf={costOf} running={runningReal} real={!paper} />
            </Shell>
          )}

          {place.step === 3 && (
            <Shell>
              <ShellHeader icon="gear" title={PART_NAMES[place.part!]} subtitle={place.part === 'size' ? (picked.length > 1 ? `The same for all ${picked.length} markets.` : 'Uses your SoDEX futures USDC.') : place.part === 'quote' ? `${RECIPE[rid].name}'s values, marked Default where they are unchanged.` : 'Each one moves the estimate on the right.'} />
              <Panel className="bots-sizepanel">
                <BotSettings d={d} set={set} range={range} mark={mark} grid={gEst ? { stepBps: gEst.stepBps, netStepBps: gEst.netStepBps, k: gEst.k, feeBps } : undefined} liveAllowed={ctx.liveAllowed} noLead={noLead} part={place.part as Sec} hidePractice={place.part !== 'size'} lev={levCap === null ? undefined : { ...lev, max: levCap }} sizeErrors={sizeProblems} sizeNotes={sizeNotes} />
              </Panel>
            </Shell>
          )}

          {place.step === 4 && (
            <Shell>
              <ShellHeader icon="check" title="Review" subtitle="Check the receipt, name it, start." />
              <Panel className="bots-review">
                <NameField d={d} set={set} />
                {allErrors.map((e) => <p key={e} className="bots-err" role="alert">{e} <button type="button" className="bots-link" onClick={() => act('size')}>Change the size</button></p>)}
                {allNotes.map((e) => <p key={e} className="bots-note"><Icon name="warning" size={13} />{e} The margin below counts that size.</p>)}
                {clash.length > 0 && <p className="bots-err" role="alert">You already run a real bot on {clash.map((x) => x.replace(/-USD$/, '')).join(', ')}: one real bot per market. Untick {clash.length === 1 ? 'it' : 'them'} in Markets, stop the other bot, or turn on Practice.</p>}
                {short > 0 && <p className="bots-err" role="alert">{many ? 'These bots' : 'This bot'} would set aside {fmtUsd(needAll, 0)}, but only {fmtUsd(free ?? 0, 0)} of your futures account is free ({[alloc.botUsd > 0 ? `${fmtUsd(alloc.botUsd, 0)} with your other bots` : '', hostedCopyUsd > 0 ? `${fmtUsd(hostedCopyUsd, 0)} with copy trading` : ''].filter(Boolean).join(', ') || 'nothing set aside yet'}). Lower the size or max holding, deposit more, or stop a bot or a copy. <button type="button" className="bots-link" onClick={() => requestDeposit()}>Deposit</button></p>}
                {why && ctx.address && <p className="bots-note">{why} <button type="button" className="bots-link" onClick={() => ctx.setup(paper)}>Set up</button></p>}
                {!ctx.address && <p className="bots-note">Connect your wallet to start a bot.</p>}
                {error && (
                  <div className="bots-err" role="alert">
                    <p>{error.started.length > 0 ? `Not every bot started. ${error.symbol ? `${error.symbol.replace(/-USD$/, '')}: ` : ''}` : ''}{error.text}</p>
                    {error.started.length > 0 && <p>Started: {error.started.join(', ')}. Not started: {error.left.join(', ')}. Start again to try only the ones not started.</p>}
                    {error.action && error.label && <Button variant="secondary" onClick={() => act(error.action)}>{error.label}</Button>}
                  </div>
                )}
              </Panel>
              {picked.length === 1 && est && (
                <Panel className="bots-review__est"><Estimate m={est} gate={eff.strategy === 'market' && eff.gate} feeBps={feeBps} feeAdj={feeAdj} d={eff} runs={runs} /></Panel>
              )}
            </Shell>
          )}
        </div>

        <aside className="bots-newside">
          <Shell className="bots-sidecard">
            <Receipt chosen={place.step >= 1} gEst={gEst} d={d} eff={eff} picked={picked} markets={markets.data?.markets ?? []} feeBps={feeBps} feeAdj={feeAdj} paper={paper} floor={floor} runs={runs} free={free} need={needAll} ownUsd={alloc.perpsUsd}>
              <div className="bots-sidepanel__act">
                {at > 0 && <Button variant="secondary" size="md" icon="arrowLeft" onClick={back}>Back</Button>}
                {at < last
                  ? <Button variant="primary" size="md" className="bots-stepper__next" disabled={place.step === 3 && place.part === 'size' && sizeProblems.length > 0} title={place.step === 3 && sizeProblems.length ? sizeProblems[0] : undefined} onClick={next}>{nextLabel}<Icon name="arrowRight" size={14} /></Button>
                  : <Button variant="go" size="md" className="bots-stepper__next" icon="play" loading={busy} disabled={!can || busy} title={whyNot ?? undefined} onClick={() => void start()}>{startLabel}</Button>}
              </div>
              {at === last && whyNot && !busy && <p className="bots-fine" role="status">{whyNot}{why && ctx.address ? <> <button type="button" className="bots-link" onClick={() => ctx.setup(paper)}>Set up</button></> : null}</p>}
            </Receipt>
          </Shell>
        </aside>
      </div>
    </>
  );
}

/** Kept for callers that name a strategy's line. */
export const strategyLine = (s: Strategy): string => STRATEGY_INFO[s].line;
