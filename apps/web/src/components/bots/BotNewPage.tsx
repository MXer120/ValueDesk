/**
 * Bots > New bot, in four steps, with a receipt beside them (owner 2026-11-07, 2026-11-08):
 *
 *   1 Bot      a category (market maker, grid), then one of its bots: every setting our live runs and backtests
 *              kept is a bot of its own (bots/recipes.ts), with what it was measured at
 *   2 Market   one or several markets from a ranked table: price, activity per hour, what $1M does there, the
 *              uninformed flow's share, the spread. Several markets start one bot each, with the same settings.
 *   3 Settings three sub-steps: Size & risk, Quoting (simple, advanced folded), Safeguards (BotSettings)
 *   4 Review   the name; the receipt holds the rest; Start (asks first; one signature per bot)
 *
 * The receipt on the right: the estimate per $1M with its range, how it adds up (the market's reading, the bot,
 * each safeguard, the wallet's own bots: bots/estimate.ts), what will run, and the balance it needs.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { botReserveUsd, checkSizes, parseAlgoSpec, type MarketInfo } from '@copy-engine';
import { DASH, fmtUsd } from '../../format';
import { useSymbols } from '../../hooks';
import { useConfirm } from '../Modal';
import { marketOf } from '../algo/draft';
import { useHistory } from '../algo/liveData';
import { CoinIcon } from '../CoinIcon';
import { useBotMarkets, bpToPerMillion, type BotMarket } from '../../bots/data';
import { goBots, type BotsView } from '../../bots/routes';
import { STRATEGY_INFO, costPerMillion, draftFor, gridRange, specOf, type BotDraft, type Strategy } from '../../bots/presets';
import { CATEGORIES, RECIPE, recipeOfDraft, recipesOf, type Category, type Recipe, type RecipeId } from '../../bots/recipes';
import { bestOf, estimate, ownRuns, type BotEstimate, type EstLine, type OwnRun } from '../../bots/estimate';
import { BotAvatar, StrategyTile } from './BotIcon';
import { BrandMark } from '../BrandMark';
import { useAllocation } from './Allocation';
import { BotSettings, NameField, SEC_NAMES, type Sec } from './BotSettings';
import { BotsHead, type BotsCtx } from './BotsPage';
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
        <span title="Uninformed flow: its fills cost makers little."><i style={{ background: TAKER_COLORS.patient }} />Uninformed <b>{Math.round(m.takers.t1002 * 100)}%</b></span>
        <span title="Informed flow: its fills cost about 1 bp each."><i style={{ background: TAKER_COLORS.fast }} />Informed <b>{Math.round(m.takers.t23342 * 100)}%</b></span>
        <span><i style={{ background: TAKER_COLORS.other }} />Others <b>{Math.round(m.takers.other * 100)}%</b></span>
      </div>
    </div>
  );
}

/** What a bot is estimated to do on a market: the number, its range, how sure, who takes, the split. */
export function Estimate({ m, gate, feeBps, compact, d, runs }: { m: BotMarket | null; gate: boolean; feeBps: number; compact?: boolean; d?: BotDraft; runs?: readonly OwnRun[] }) {
  if (!m) return <p className="bots-fine">Too few trades here to estimate.</p>;
  const e = d ? estimate(d, m, runs) : null;
  const est = e?.bp ?? (gate && m.gateCostBps !== null ? m.gateCostBps : m.estCostBps);
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
          <div><span>{losses >= 0 ? 'Price moves' : 'Spread kept'}</span><b className={losses > 0 ? 'neg' : 'pos'}>{losses > 0 ? '−' : '+'}{fmtUsd(Math.abs(bpToPerMillion(losses)), 0)}</b></div>
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
// A grid has one preset and no quoting: both are skipped.
const placesFor = (grid: boolean): Place[] => [
  { step: 0 }, { step: 1 }, ...(grid ? [] : [{ step: 2 as const }]), { step: 3, part: 'size' }, ...(grid ? [] : [{ step: 3 as const, part: 'quote' as const }]), { step: 3, part: 'guard' }, { step: 4 },
];

/** A market without an oracle runs the plain maker: quotes off SoDEX's book, no gate, no rest. */
export const noLeadOf = (m: BotMarket | null | undefined): boolean => m?.lead === null;
export const effectiveDraft = (d: BotDraft, m: BotMarket | null | undefined): BotDraft => (d.strategy === 'market' && noLeadOf(m) ? { ...d, strategy: 'maker', gate: false } : d);

type MSort = 'best' | 'activity' | 'uninformed' | 'spread';

/** The markets, ranked; tick one or several. Activity is the market's own volume per hour (a bot's size does not change it). */
function MarketStep({ picked, toggle, markets, costOf }: { picked: string[]; toggle: (s: string) => void; markets: BotMarket[] | null; costOf: (m: BotMarket) => number | null }) {
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
  const shown = all || needle ? list : list.slice(0, 10);
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
    return (
      <tr key={symbol} role="checkbox" aria-checked={on} aria-label={symbol} tabIndex={0} className={`bots-row${on ? ' is-picked' : ''}`} onClick={() => toggle(symbol)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(symbol); } }}>
        <td className="bots-mt__pick"><span className={`bots-tick${on ? ' is-on' : ''}`} aria-hidden="true">{on && <Icon name="check" size={11} />}</span></td>
        <td>
          <span className="bots-mt__name">
            <CoinIcon coin={symbol} size={22} />
            <span><b>{symbol.replace(/-USD$/, '')}</b><small>{symbol}</small></span>
            {symbol === best && <StatusPill size="sm" tone="positive">best</StatusPill>}
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
      {!all && !needle && list.length > 10 && <button type="button" className="bots-more__t" onClick={() => setAll(true)}>Show {list.length - 10} more<Icon name="arrowRight" size={13} /></button>}
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

/** A cost per $1M without the sign wall: a cost reads as a plain amount, earnings in green with a plus. */
const costText = (bp: number): { v: string; k: string; cls: string } => (bp < 0 ? { v: `+${fmtUsd(-bpToPerMillion(bp), 0)}`, k: 'earned per $1M traded', cls: 'pos' } : { v: fmtUsd(bpToPerMillion(bp), 0), k: 'cost per $1M traded', cls: '' });

/**
 * One bot to pick, read at a glance (owner 2026-11-08: "they will only read the cost and decide off of that"): a plain
 * sentence, the cost as the one number, how much it trades and how well it is tested in a word each; the test name and
 * the runs behind it open only on the picked bot.
 */
function RecipeRow({ rc, on, pick, est, where, best, blocked }: { rc: Recipe; on: boolean; pick: () => void; est: BotEstimate | null; where: string; best: boolean; blocked?: string }) {
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
          : <><b className="dim">{DASH}</b><small>{rc.category === 'grid' ? 'set by its range' : 'not enough trades yet'}</small></>}
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
function Receipt({ d, eff, picked, markets, feeBps, paper, floor, runs, chosen, children, free = null }: {
  d: BotDraft; eff: BotDraft; picked: string[]; markets: BotMarket[]; feeBps: number; paper: boolean; floor: ReturnType<typeof costPerMillion>; runs: readonly OwnRun[];
  /** On or past the Markets step: before that the receipt names the preset only, with our mark. */
  chosen: boolean; children: ReactNode;
  /** The futures margin free for new bots (null while unknown). */
  free?: number | null;
}) {
  const grid = eff.strategy === 'grid';
  const rc = RECIPE[recipeOfDraft(d)];
  const ests = picked.map((s) => markets.find((m) => m.symbol === s) ?? null).filter((m): m is BotMarket => !!m).map((m) => ({ m, e: estimate(effectiveDraft({ ...d, symbol: m.symbol }, m), m, runs) }));
  const known = ests.filter((x) => x.e.bp !== null);
  const avg = (f: (e: BotEstimate) => number | null) => { const xs = known.map((x) => f(x.e)).filter((x): x is number => x !== null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
  const bp = grid ? floor.net / 100 : avg((e) => e.bp);
  const low = grid ? null : avg((e) => e.low);
  const high = grid ? null : avg((e) => e.high);
  const volX = avg((e) => e.volumeX) ?? 1;
  // The lines, averaged over the picked markets: fees, price moves, then the bot and each safeguard.
  const lines: Array<{ id: string; label: string; bp: number | null; source: EstLine['source']; note?: string; counted?: boolean }> = [];
  if (grid) {
    lines.push({ id: 'fees', label: 'Fees', bp: feeBps, source: 'market' });
    lines.push({ id: 'steps', label: 'Grid steps', bp: floor.edge !== null ? -floor.edge / 100 : null, source: 'market' });
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
  const need = (d.strategy === 'grid' ? d.orderUsd * d.levels : d.maxInventoryUsd + d.orderUsd * 2) * picked.length;
  const name = d.label.trim() || `${rc.name}${chosen && picked.length === 1 ? ` ${picked[0]!.replace(/-USD$/, '')}` : ''}`;
  const guards = [
    { id: 'gate', icon: 'pulse' as const, label: 'Volatility gate', on: eff.strategy === 'market' && eff.gate },
    { id: 'flow', icon: 'robot' as const, label: 'Flow gate', on: !grid && d.flowOn },
    { id: 'quiet', icon: 'clock' as const, label: 'Trading hours', on: d.quiet.length > 0 },
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
          <b className="bots-rc__mkts">{!chosen ? <span className="dim">Next step</span> : picked.length ? picked.map((s) => <span key={s}><CoinIcon coin={s} size={16} />{s.replace(/-USD$/, '')}</span>) : DASH}</b>
        </div>
        <div className="bots-rc__tile"><span>Order size</span><b>{fmtUsd(d.orderUsd, 0)}<small>{grid ? ` × ${d.levels}` : ' a side'}</small></b></div>
        {!grid ? <div className="bots-rc__tile"><span>Max holding</span><b>{fmtUsd(d.maxInventoryUsd, 0)}</b></div> : <div className="bots-rc__tile"><span>Levels</span><b>{d.levels}</b></div>}
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
        <div><span>Free for bots</span><b>{free === null ? DASH : fmtUsd(free, 0)}</b></div>
        <div><span>Signatures</span><b>{Math.max(1, picked.length)}</b></div>
      </footer>
      {children}
    </div>
  );
}

export function BotNewPage({ ctx, view }: { ctx: BotsCtx; view: Extract<BotsView, { page: 'new' }> }) {
  const startRecipe: RecipeId = view.kind && view.kind in RECIPE ? (view.kind as RecipeId) : view.kind === 'grid' ? 'grid' : 'r10';
  const fromRecipe = (id: RecipeId, symbol: string, keep?: BotDraft): BotDraft => {
    const rc = RECIPE[id];
    const base = draftFor(rc.strategy, 'balanced', symbol);
    const size = keep && keep.strategy !== 'grid' && rc.strategy !== 'grid' ? { orderUsd: keep.orderUsd, maxInventoryUsd: keep.maxInventoryUsd, maxLossUsd: keep.maxLossUsd, flowOn: keep.flowOn, quiet: keep.quiet, maxSpreadBps: keep.maxSpreadBps, runHours: keep.runHours } : {};
    return { ...base, ...rc.params, ...size, strategy: rc.strategy, label: keep?.label ?? '', paper: keep?.paper ?? true };
  };
  const [d, setD] = useState<BotDraft>(() => fromRecipe(startRecipe, view.market ?? 'BTC-USD'));
  const [cat, setCat] = useState<Category>(RECIPE[startRecipe].category);
  const [picked, setPicked] = useState<string[]>(() => [view.market ?? 'BTC-USD']);
  const grid = d.strategy === 'grid';
  const places = placesFor(grid);
  // From Explore (a market given): its markets are picked, the preset is next.
  const [at, setAt] = useState(view.market ? 2 : 0);
  const place = places[Math.min(at, places.length - 1)]!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (view.market) { setD((x) => ({ ...x, symbol: view.market! })); setPicked([view.market]); } }, [view.market]);
  const set = (p: Partial<BotDraft>) => setD((x) => ({ ...x, ...p }));
  // The first picked market leads the form (its price, its minimum size); the others start with the same settings.
  useEffect(() => { if (picked[0] && picked[0] !== d.symbol) setD((x) => ({ ...x, symbol: picked[0]!, low: null, high: null })); }, [picked, d.symbol]);
  const toggle = (s: string) => setPicked((xs) => (xs.includes(s) ? (xs.length > 1 ? xs.filter((x) => x !== s) : xs) : grid ? [s] : [...xs, s].slice(0, 8)));
  const { byName } = useSymbols('perps');
  const sym = byName.get(d.symbol);
  const market: MarketInfo | null = sym ? marketOf(sym) : null;
  const hist = useHistory(d.symbol, true, 10);
  const mark = hist?.length ? hist[hist.length - 1]!.p : null;
  const range = grid ? gridRange(d, mark) : null;
  const markets = useBotMarkets('24h');
  const runs = useMemo(() => ownRuns(ctx.bots, markets.data?.markets ?? null), [ctx.bots, markets.data]);
  const est = markets.data?.markets.find((m) => m.symbol === d.symbol) ?? null;
  const noLead = noLeadOf(est);
  const eff = effectiveDraft(d, est);
  const feeBps = markets.data ? markets.data.fee.makerBps + ctx.feeTenths / 10 : 1.2 + ctx.feeTenths / 10;
  const floor = costPerMillion(eff, market, mark, ctx.feeTenths);
  const paper = !ctx.liveAllowed || d.paper;
  const costOf = useMemo(() => (m: BotMarket) => estimate(effectiveDraft({ ...d, symbol: m.symbol }, m), m, runs).bp, [d, runs]);
  const specFor = (s: string) => {
    const m = markets.data?.markets.find((x) => x.symbol === s) ?? null;
    return specOf({ ...effectiveDraft({ ...d, symbol: s }, m), paper }, s === d.symbol ? mark : null);
  };
  const rid = recipeOfDraft(d);

  const check = useMemo(() => {
    try {
      const spec = parseAlgoSpec(specOf({ ...eff, paper }, mark));
      if (!market) return [] as string[];
      return checkSizes(spec, market, { price: mark, seed: 1, now: Date.now() }).errors;
    } catch (e) {
      return [e instanceof Error ? e.message : String(e)];
    }
  }, [eff, mark, market, paper]);
  const why = ctx.setupWhy(paper);
  // Smart margining: a real bot (each of several) sets aside what it needs; together they fit the free margin.
  const alloc = useAllocation(ctx);
  const needAll = picked.reduce((t, s) => { try { return t + botReserveUsd(parseAlgoSpec(specFor(s))); } catch { return t; } }, 0);
  const short = !paper && alloc.free !== null && needAll > alloc.free + 1e-6 ? needAll - alloc.free : 0;
  const can = !check.length && !why && ctx.ready && (!grid || !!range) && picked.length > 0 && short === 0;

  const { confirm, dialog } = useConfirm();
  const start = async () => {
    const many = picked.length > 1;
    const ok = await confirm({
      title: many ? `Start ${picked.length} bots?` : `Start ${d.label.trim() || `${RECIPE[rid].name} ${d.symbol.replace(/-USD$/, '')}`}?`,
      body: `${RECIPE[rid].name} on ${picked.join(', ')}, ${fmtUsd(d.orderUsd, 0)} orders${grid ? '' : `, up to ${fmtUsd(d.maxInventoryUsd, 0)} held each`}${d.maxLossUsd !== null ? `, stops at a ${fmtUsd(d.maxLossUsd, 0)} loss` : ''}. ${paper ? 'Practice: no orders are sent.' : 'Real orders in your SoDEX account.'}${many ? ` One signature per bot (${picked.length}).` : ''}`,
      confirmLabel: paper ? (many ? `Start ${picked.length} practice bots` : 'Start practice bot') : (many ? `Start ${picked.length} bots` : 'Start bot'),
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      let last: Awaited<ReturnType<BotsCtx['start']>> | null = null;
      for (const s of picked) last = await ctx.start(specFor(s));
      if (many || !last) goBots({ page: 'overview' });
      else goBots({ page: 'bot', id: last.algo.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const last = places.length - 1;
  const next = () => setAt((s) => Math.min(last, s + 1));
  const back = () => setAt((s) => Math.max(0, s - 1));
  const goStep = (i: number) => { const k = places.findIndex((p) => p.step === i); if (k >= 0 && k <= at) setAt(k); };
  const startLabel = busy ? 'Starting…' : paper ? (picked.length > 1 ? `Start ${picked.length} practice bots` : 'Start practice bot') : (picked.length > 1 ? `Start ${picked.length} bots` : 'Start bot');
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
  const scored = recipesOf(cat).filter((rc) => !blocked(rc)).map((rc) => ({ id: rc.id, rc, e: rc.category === 'market' ? estimateOver(pickedMs, (m) => estimate(effectiveDraft(fromRecipe(rc.id, m.symbol, d), m), m, runs)) : null }));
  const where = picked.length === 1 ? `on ${picked[0]!.replace(/-USD$/, '')}` : `average, ${picked.length} markets`;
  const bestId = cat === 'market' && pickedMs.length ? bestOf(scored.filter((x): x is typeof x & { e: BotEstimate } => !!x.e && x.e.bp !== null).map((x) => ({ id: x.id, est: x.e })))?.id ?? null : null;
  const blockedRows = recipesOf(cat).filter(blocked);
  const rows = [...scored].sort((a, b) => (a.id === bestId ? -1 : b.id === bestId ? 1 : (a.e?.bp ?? 99) - (b.e?.bp ?? 99)));
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
                    <button key={c.id} type="button" role="radio" aria-checked={on} aria-label={c.name} className={`bots-type${on ? ' is-on' : ''}`} onClick={() => { setCat(c.id); if (RECIPE[rid].category !== c.id) pickRecipe(recipesOf(c.id)[0]!.id); }}>
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
              <ShellHeader icon="star" title="Preset" subtitle={`Setups we tested, ${picked.length === 1 ? `on ${picked[0]!.replace(/-USD$/, '')}` : `on your ${picked.length} markets`}. Lower cost is better.`} />
              <div className="bots-strows" role="radiogroup" aria-label="Preset">
                {rows.map(({ rc, e }) => (
                  <RecipeRow key={rc.id} rc={rc} on={rid === rc.id} pick={() => pickRecipe(rc.id)} where={where} est={e} best={rc.id === bestId} />
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
              <MarketStep picked={picked} toggle={toggle} markets={markets.data?.markets ?? (markets.error ? [] : null)} costOf={costOf} />
            </Shell>
          )}

          {place.step === 3 && (
            <Shell>
              <ShellHeader icon="gear" title={PART_NAMES[place.part!]} subtitle={place.part === 'size' ? (picked.length > 1 ? `The same for all ${picked.length} markets.` : 'Uses your SoDEX futures USDC.') : place.part === 'quote' ? `${RECIPE[rid].name}'s values, marked Default where they are unchanged.` : 'Each one moves the estimate on the right.'} />
              <Panel className="bots-sizepanel">
                <BotSettings d={d} set={set} range={range} mark={mark} liveAllowed={ctx.liveAllowed} noLead={noLead} part={place.part as Sec} hidePractice={place.part !== 'size'} />
              </Panel>
            </Shell>
          )}

          {place.step === 4 && (
            <Shell>
              <ShellHeader icon="check" title="Review" subtitle="Check the receipt, name it, start." />
              <Panel className="bots-review">
                <NameField d={d} set={set} />
                {check.map((e) => <p key={e} className="bots-err" role="alert">{e}</p>)}
                {short > 0 && <p className="bots-err" role="alert">{picked.length > 1 ? 'These bots' : 'This bot'} would set aside {fmtUsd(needAll, 0)}, but only {fmtUsd(alloc.free ?? 0, 0)} of your futures account is free ({fmtUsd(alloc.used, 0)} is with your other bots). Lower the size or max holding, or stop a bot.</p>}
                {why && ctx.address && <p className="bots-note">{why} <button type="button" className="bots-link" onClick={() => ctx.setup(paper)}>Set up</button></p>}
                {!ctx.address && <p className="bots-note">Connect your wallet to start a bot.</p>}
                {error && <p className="bots-err" role="alert">{error}</p>}
              </Panel>
              {picked.length === 1 && est && (
                <Panel className="bots-review__est"><Estimate m={est} gate={eff.strategy === 'market' && eff.gate} feeBps={feeBps} d={eff} runs={runs} /></Panel>
              )}
            </Shell>
          )}
        </div>

        <aside className="bots-newside">
          <Shell className="bots-sidecard">
            <Receipt chosen={place.step >= 1} d={d} eff={eff} picked={picked} markets={markets.data?.markets ?? []} feeBps={feeBps} paper={paper} floor={floor} runs={runs} free={alloc.free}>
              <div className="bots-sidepanel__act">
                {at > 0 && <Button variant="secondary" size="md" icon="arrowLeft" onClick={back}>Back</Button>}
                {at < last
                  ? <Button variant="primary" size="md" className="bots-stepper__next" onClick={next}>{nextLabel}<Icon name="arrowRight" size={14} /></Button>
                  : <Button variant="go" size="md" className="bots-stepper__next" icon="play" loading={busy} disabled={!can} onClick={() => void start()}>{startLabel}</Button>}
              </div>
            </Receipt>
          </Shell>
        </aside>
      </div>
    </>
  );
}

/** Kept for callers that name a strategy's line. */
export const strategyLine = (s: Strategy): string => STRATEGY_INFO[s].line;
