/**
 * Bots > New bot, in four steps, with a receipt beside them (owner 2026-11-07):
 *
 *   1 Bot      market maker (R10) or grid
 *   2 Market   one or several markets from a ranked table: price, activity per hour, what $1M does there, the
 *              uninformed flow's share, the spread. Several markets start one bot each, with the same settings.
 *   3 Settings Size & risk, Quoting, Safeguards (BotSettings)
 *   4 Review   the name; the receipt holds the rest; Start (asks first; one signature per bot)
 *
 * The receipt on the right lists what will run and what it is estimated to cost, line by line.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { checkSizes, parseAlgoSpec, type MarketInfo } from '@copy-engine';
import { DASH, fmtUsd } from '../../format';
import { useSymbols } from '../../hooks';
import { useConfirm } from '../Modal';
import { marketOf } from '../algo/draft';
import { useHistory } from '../algo/liveData';
import { CoinIcon } from '../CoinIcon';
import { useBotMarkets, bpToPerMillion, type BotMarket } from '../../bots/data';
import { goBots, type BotsView } from '../../bots/routes';
import { STRATEGIES, STRATEGY_INFO, costPerMillion, draftFor, gridRange, specOf, type BotDraft, type Strategy } from '../../bots/presets';
import { BotAvatar, StrategyTile } from './BotIcon';
import { BotSettings, NameField } from './BotSettings';
import { BotsHead, type BotsCtx } from './BotsPage';
import { Button, Icon, Inset, Panel, ProgressBar, RollingNumber, SearchField, Segmented, SegmentedBar, Shell, ShellHeader, Skeleton, StatusPill } from './kit/kit';

/** A cost in bp as what $1M does: −$185 (it costs), +$359 (it earns). */
export const fmtBpUsd = (bp: number | null | undefined): string => (bp === null || bp === undefined ? DASH : bp < 0 ? `+${fmtUsd(-bpToPerMillion(bp), 0)}` : bp > 0 ? `−${fmtUsd(bpToPerMillion(bp), 0)}` : fmtUsd(0, 0));
export const bpCls = (bp: number | null | undefined): string => (bp === null || bp === undefined ? '' : bp < 0 ? 'pos' : bp > 0 ? 'neg' : '');
const CONF_TONE = { high: 'positive', medium: 'warning', low: 'neutral' } as const;
/** Who takes small makers' quotes: uninformed flow (1002, cheap to fill), informed flow (23342, about 1 bp a fill). */
export const TAKER_COLORS = { patient: 'var(--pos)', fast: 'var(--neg)', other: 'rgb(var(--ink) / 0.28)' };

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

/** What Explore estimates for a market: the number, its range, how sure, who takes, the split. */
export function Estimate({ m, gate, feeBps, compact }: { m: BotMarket | null; gate: boolean; feeBps: number; compact?: boolean }) {
  if (!m) return <p className="bots-fine">Too few trades here to estimate.</p>;
  const est = gate && m.gateCostBps !== null ? m.gateCostBps : m.estCostBps;
  const losses = est - feeBps;
  return (
    <div className="bots-est">
      <div className="bots-est__big">
        <span className="bots-est__k">Per $1M{gate ? ' · gate on' : ''}</span>
        <RollingNumber value={fmtBpUsd(est)} className={`bots-est__v ${bpCls(est)}`} />
        <span className="bots-est__sub">
          {fmtBpUsd(m.estCostLowBps)} to {fmtBpUsd(m.estCostHighBps)}
          <StatusPill size="sm" tone={CONF_TONE[m.confidence]} dot>{m.confidence}</StatusPill>
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

const STEPS = [
  { title: 'Bot', hint: 'What it does' },
  { title: 'Market', hint: 'Where it trades' },
  { title: 'Settings', hint: 'Size and safeguards' },
  { title: 'Review', hint: 'Name and start' },
] as const;

/** A market without a Binance price runs the plain maker: quotes off SoDEX's book, no gate, no rest. */
export const noLeadOf = (m: BotMarket | null | undefined): boolean => m?.lead === null;
export const effectiveDraft = (d: BotDraft, m: BotMarket | null | undefined): BotDraft => (d.strategy === 'market' && noLeadOf(m) ? { ...d, strategy: 'maker', gate: false } : d);

type MSort = 'best' | 'activity' | 'uninformed' | 'spread';

/** The markets, ranked; tick one or several. Activity is the market's own volume per hour (a bot's size does not change it). */
function MarketStep({ picked, toggle, markets }: { picked: string[]; toggle: (s: string) => void; markets: BotMarket[] | null }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<MSort>('best');
  const [all, setAll] = useState(false);
  const { byName } = useSymbols('perps');
  const needle = q.trim().toLowerCase();
  const list = useMemo(() => {
    const xs = (markets ?? []).filter((m) => (!needle || m.symbol.toLowerCase().includes(needle)) && (all || needle || m.confidence !== 'low'));
    const by: Record<MSort, (m: BotMarket) => number> = { best: (m) => m.estCostBps, activity: (m) => -m.volumeUsdH, uninformed: (m) => -m.takers.t1002, spread: (m) => m.spreadBps };
    return [...xs].sort((x, y) => by[sort](x) - by[sort](y));
  }, [markets, needle, sort, all]);
  const shown = all || needle ? list : list.slice(0, 10);
  const best = useMemo(() => (markets ?? []).filter((m) => m.confidence === 'high').sort((x, y) => x.estCostBps - y.estCostBps)[0]?.symbol ?? null, [markets]);
  const extra = needle ? [...byName.keys()].filter((x) => x.toLowerCase().includes(needle) && !(markets ?? []).some((m) => m.symbol === x)).slice(0, 12) : [];
  if (!markets) return <div className="bots-skels">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="bots-skel" />)}</div>;
  const head = (k: MSort, label: string, title?: string) => (
    <th className="right" title={title}>
      <button type="button" className={`bots-th${sort === k ? ' is-on' : ''}`} onClick={() => setSort(k)}>{label}{sort === k && <Icon name="down" size={10} />}</button>
    </th>
  );
  const row = (symbol: string, m: BotMarket | null) => {
    const on = picked.includes(symbol);
    return (
      <tr key={symbol} role="checkbox" aria-checked={on} aria-label={symbol} tabIndex={0} className={`bots-row${on ? ' is-picked' : ''}`} onClick={() => toggle(symbol)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(symbol); } }}>
        <td className="bots-mt__pick"><span className={`bots-tick${on ? ' is-on' : ''}`} aria-hidden="true">{on && <Icon name="check" size={11} />}</span></td>
        <td>
          <span className="bots-mt__name">
            <CoinIcon coin={symbol} size={22} />
            <span><b>{symbol.replace(/-USD$/, '')}</b><small>{symbol}</small></span>
            {symbol === best && <StatusPill size="sm" tone="positive">best</StatusPill>}
            {m?.lead === null && <StatusPill size="sm">no Binance</StatusPill>}
            {!m && <StatusPill size="sm">little traded</StatusPill>}
          </span>
        </td>
        <td className="right num dim">{m ? fmtUsd(m.price) : DASH}</td>
        <td className="right num">{m ? fmtUsd(m.volumeUsdH, 0) : DASH}</td>
        <td className={`right num bots-strong ${m ? bpCls(m.estCostBps) : ''}`}>{m ? fmtBpUsd(m.estCostBps) : DASH}</td>
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
              {head('best', 'Per $1M', "What $1M of a small maker's volume did here, all-in")}
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

/** The receipt: what will run, line by line, and what it is estimated to do per $1M. */
function Receipt({ d, eff, picked, markets, feeBps, paper, floor, step, children }: {
  d: BotDraft; eff: BotDraft; picked: string[]; markets: BotMarket[]; feeBps: number; paper: boolean; floor: ReturnType<typeof costPerMillion>; step: number; children: ReactNode;
}) {
  const known = picked.map((s) => markets.find((m) => m.symbol === s) ?? null).filter((m): m is BotMarket => !!m);
  const gate = eff.strategy === 'market' && eff.gate;
  const bp = (m: BotMarket) => (gate && m.gateCostBps !== null ? m.gateCostBps : m.estCostBps);
  const avg = known.length ? known.reduce((x, m) => x + bp(m), 0) / known.length : null;
  const guards = [eff.strategy === 'market' && eff.gate ? 'Gate' : null, d.flowOn ? 'Flow' : null, d.quiet.length ? 'Quiet hours' : null, d.maxSpreadBps !== null ? 'Spread' : null].filter(Boolean);
  const need = (d.strategy === 'grid' ? d.orderUsd * d.levels : d.maxInventoryUsd + d.orderUsd * 2) * picked.length;
  const name = d.label.trim() || `${STRATEGY_INFO[eff.strategy].name}${picked.length === 1 ? ` ${picked[0]!.replace(/-USD$/, '')}` : ''}`;
  const grid = eff.strategy === 'grid';
  return (
    <div className="bots-receipt">
      <div className="bots-receipt__head">
        <BotAvatar symbol={picked[0] ?? d.symbol} strategy={eff.strategy} size={40} />
        <span><b>{name}</b><small>{paper ? 'Practice · no orders sent' : 'Real orders'}</small></span>
      </div>
      <dl className="bots-receipt__lines">
        <div><dt>Strategy</dt><dd>{STRATEGY_INFO[eff.strategy].name}{eff.strategy === 'market' ? ' · R10' : ''}</dd></div>
        <div><dt>{picked.length === 1 ? 'Market' : `Markets · ${picked.length}`}</dt><dd className="bots-receipt__mkts">{picked.length ? picked.map((s) => <span key={s}><CoinIcon coin={s} size={14} />{s.replace(/-USD$/, '')}</span>) : DASH}</dd></div>
        <div><dt>Order size</dt><dd>{fmtUsd(d.orderUsd, 0)}{grid ? ` × ${d.levels}` : ' a side'}</dd></div>
        {!grid && <div><dt>Max holding</dt><dd>{fmtUsd(d.maxInventoryUsd, 0)}</dd></div>}
        <div><dt>Loss limit</dt><dd>{d.maxLossUsd === null ? 'None' : fmtUsd(d.maxLossUsd, 0)}</dd></div>
        <div><dt>Safeguards</dt><dd>{guards.length ? guards.join(' · ') : 'None'}</dd></div>
      </dl>
      <div className="bots-receipt__cut" aria-hidden="true" />
      <dl className="bots-receipt__lines">
        <div><dt>Fees per $1M</dt><dd className="neg">{fmtBpUsd(feeBps)}</dd></div>
        {grid
          ? <div><dt>Grid steps per $1M</dt><dd className="pos">{floor.edge !== null ? `+${fmtUsd(floor.edge, 0)}` : DASH}</dd></div>
          : known.length === 1
            ? <div><dt>Price moves</dt><dd className={bp(known[0]!) - feeBps > 0 ? 'neg' : 'pos'}>{bp(known[0]!) - feeBps > 0 ? '−' : '+'}{fmtUsd(Math.abs(bpToPerMillion(bp(known[0]!) - feeBps)), 0)}</dd></div>
            : known.map((m) => <div key={m.symbol}><dt>{m.base}</dt><dd className={bpCls(bp(m))}>{fmtBpUsd(bp(m))}</dd></div>)}
      </dl>
      <div className="bots-receipt__total">
        <span>Est. per $1M{picked.length > 1 ? ', average' : ''}</span>
        <RollingNumber value={grid ? (floor.net < 0 ? `+${fmtUsd(-floor.net, 0)}` : `−${fmtUsd(floor.net, 0)}`) : fmtBpUsd(avg)} className={`bots-receipt__v ${grid ? (floor.net < 0 ? 'pos' : 'neg') : bpCls(avg)}`} />
      </div>
      {known.length === 1 && step < 3 && <Takers m={known[0]!} />}
      <dl className="bots-receipt__lines is-foot">
        <div><dt>Balance needed</dt><dd>about {fmtUsd(need, 0)}</dd></div>
        <div><dt>Signatures</dt><dd>{Math.max(1, picked.length)}</dd></div>
      </dl>
      {children}
    </div>
  );
}

export function BotNewPage({ ctx, view }: { ctx: BotsCtx; view: Extract<BotsView, { page: 'new' }> }) {
  const startKind: Strategy = view.kind === 'grid' ? 'grid' : 'market';
  const [d, setD] = useState<BotDraft>(() => draftFor(startKind, 'balanced', view.market ?? 'BTC-USD'));
  const [picked, setPicked] = useState<string[]>(() => [view.market ?? 'BTC-USD']);
  const [step, setStep] = useState(view.market ? 1 : 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (view.market) { setD((x) => ({ ...x, symbol: view.market! })); setPicked([view.market]); } }, [view.market]);
  const set = (p: Partial<BotDraft>) => setD((x) => ({ ...x, ...p }));
  // The first picked market leads the form (its price, its minimum size); the others start with the same settings.
  useEffect(() => { if (picked[0] && picked[0] !== d.symbol) setD((x) => ({ ...x, symbol: picked[0]!, low: null, high: null })); }, [picked, d.symbol]);
  const toggle = (s: string) => setPicked((xs) => (xs.includes(s) ? (xs.length > 1 ? xs.filter((x) => x !== s) : xs) : d.strategy === 'grid' ? [s] : [...xs, s].slice(0, 8)));
  const { byName } = useSymbols('perps');
  const sym = byName.get(d.symbol);
  const market: MarketInfo | null = sym ? marketOf(sym) : null;
  const hist = useHistory(d.symbol, true, 10);
  const mark = hist?.length ? hist[hist.length - 1]!.p : null;
  const range = d.strategy === 'grid' ? gridRange(d, mark) : null;
  const markets = useBotMarkets('24h');
  const est = markets.data?.markets.find((m) => m.symbol === d.symbol) ?? null;
  const noLead = noLeadOf(est);
  const eff = effectiveDraft(d, est);
  const feeBps = markets.data ? markets.data.fee.makerBps + ctx.feeTenths / 10 : 1.2 + ctx.feeTenths / 10;
  const floor = costPerMillion(eff, market, mark, ctx.feeTenths);
  const paper = !ctx.liveAllowed || d.paper;
  const specFor = (s: string) => {
    const m = markets.data?.markets.find((x) => x.symbol === s) ?? null;
    return specOf({ ...effectiveDraft({ ...d, symbol: s }, m), paper }, s === d.symbol ? mark : null);
  };

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
  const can = !check.length && !why && ctx.ready && (d.strategy !== 'grid' || !!range) && picked.length > 0;

  const { confirm, dialog } = useConfirm();
  const start = async () => {
    const many = picked.length > 1;
    const ok = await confirm({
      title: many ? `Start ${picked.length} bots?` : `Start ${d.label.trim() || `${STRATEGY_INFO[eff.strategy].name} ${d.symbol.replace(/-USD$/, '')}`}?`,
      body: `${STRATEGY_INFO[eff.strategy].name} on ${picked.join(', ')}, ${fmtUsd(d.orderUsd, 0)} orders${d.strategy === 'grid' ? '' : `, up to ${fmtUsd(d.maxInventoryUsd, 0)} held each`}${d.maxLossUsd !== null ? `, stops at a ${fmtUsd(d.maxLossUsd, 0)} loss` : ''}. ${paper ? 'Practice: no orders are sent.' : 'Real orders in your SoDEX account.'}${many ? ` One signature per bot (${picked.length}).` : ''}`,
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

  const next = () => setStep((s) => Math.min(3, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));
  const startLabel = busy ? 'Starting…' : paper ? (picked.length > 1 ? `Start ${picked.length} practice bots` : 'Start practice bot') : (picked.length > 1 ? `Start ${picked.length} bots` : 'Start bot');

  return (
    <>
      {dialog}
      <BotsHead view={view} title="New bot" sub="Pick a bot, its markets and its settings." />
      <nav className="bots-wsteps" aria-label="Steps">
        <ol>
          {STEPS.map((st, i) => (
            <li key={st.title} className={i === step ? 'is-on' : i < step ? 'is-done' : ''}>
              <button type="button" onClick={() => i <= step && setStep(i)} disabled={i > step} aria-current={i === step ? 'step' : undefined}>
                <span className="bots-wsteps__t"><b>{i < step ? <Icon name="check" size={12} /> : <span className="bots-wsteps__n">{i + 1}</span>}{st.title}</b><small>{st.hint}</small></span>
                <span className="bots-wsteps__seg" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
        <span className="bots-wsteps__count">{step + 1}/4</span>
      </nav>
      <div className="bots-wizard">
        <div className="bots-wizard__main">
          {step === 0 && (
            <Shell>
              <ShellHeader icon="layers" title="Strategy" subtitle="Maker fee only, never the spread." />
              <div className="bots-strows" role="radiogroup" aria-label="Strategy">
                {STRATEGIES.map((st) => {
                  const c = costPerMillion(draftFor(st), null, null, ctx.feeTenths);
                  const on = d.strategy === st;
                  return (
                    <button key={st} type="button" role="radio" aria-checked={on} aria-label={STRATEGY_INFO[st].name} className={`bots-strow${on ? ' is-on' : ''}`} onClick={() => { setD({ ...draftFor(st, 'balanced', d.symbol), label: d.label, paper: d.paper }); if (st === 'grid') setPicked((xs) => xs.slice(0, 1)); }}>
                      <span className={`bots-radio${on ? ' is-on' : ''}`} aria-hidden="true" />
                      <StrategyTile strategy={st} size={44} />
                      <span className="bots-strow__t">
                        <b>{STRATEGY_INFO[st].name}{st === 'market' && <StatusPill size="sm" tone="positive">R10</StatusPill>}</b>
                        <small>{STRATEGY_INFO[st].line}</small>
                      </span>
                      <span className="bots-strow__n">
                        {st === 'market' && est
                          ? <><b className={bpCls(est.estCostBps)}>{fmtBpUsd(est.estCostBps)}</b><small>per $1M on {est.base}</small></>
                          : <><b className="neg">−{fmtUsd(c.fees, 0)}</b><small>fees per $1M</small></>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </Shell>
          )}

          {step === 1 && (
            <Shell>
              <ShellHeader icon="compass" title="Markets" subtitle={d.strategy === 'grid' ? 'One market for a grid.' : 'Tick one or several: one bot each.'} aside={<Button variant="quiet" onClick={() => goBots({ page: 'explore' })}>Compare all<Icon name="arrowRight" size={13} /></Button>} />
              <MarketStep picked={picked} toggle={toggle} markets={markets.data?.markets ?? (markets.error ? [] : null)} />
            </Shell>
          )}

          {step === 2 && (
            <Shell>
              <ShellHeader icon="gear" title="Settings" subtitle={picked.length > 1 ? `The same for all ${picked.length} markets.` : 'Uses your SoDEX futures USDC.'} />
              <Panel className="bots-sizepanel">
                <BotSettings d={d} set={set} range={range} mark={mark} liveAllowed={ctx.liveAllowed} noLead={noLead} />
              </Panel>
            </Shell>
          )}

          {step === 3 && (
            <Shell>
              <ShellHeader icon="check" title="Review" subtitle="Check the receipt, name it, start." />
              <Panel className="bots-review">
                <NameField d={d} set={set} />
                {check.map((e) => <p key={e} className="bots-err" role="alert">{e}</p>)}
                {why && ctx.address && <p className="bots-note">{why} <button type="button" className="bots-link" onClick={() => ctx.setup(paper)}>Set up</button></p>}
                {!ctx.address && <p className="bots-note">Connect your wallet to start a bot.</p>}
                {error && <p className="bots-err" role="alert">{error}</p>}
              </Panel>
              {picked.length === 1 && est && (
                <Panel className="bots-review__est"><Estimate m={est} gate={eff.strategy === 'market' && eff.gate} feeBps={feeBps} /></Panel>
              )}
            </Shell>
          )}
        </div>

        <aside className="bots-newside">
          <Shell className="bots-sidecard">
            <Receipt d={d} eff={eff} picked={picked} markets={markets.data?.markets ?? []} feeBps={feeBps} paper={paper} floor={floor} step={step}>
              <div className="bots-sidepanel__act">
                {step > 0 && <Button variant="secondary" size="md" icon="arrowLeft" onClick={back}>Back</Button>}
                {step < 3
                  ? <Button variant="primary" size="md" className="bots-stepper__next" onClick={next}>Next<Icon name="arrowRight" size={14} /></Button>
                  : <Button variant="go" size="md" className="bots-stepper__next" icon="play" loading={busy} disabled={!can} onClick={() => void start()}>{startLabel}</Button>}
              </div>
            </Receipt>
          </Shell>
        </aside>
      </div>
    </>
  );
}
