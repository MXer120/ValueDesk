/**
 * Bots > New bot, in four steps (owner 2026-11-07: "setting up a bot should be multi step", fewer sentences):
 *
 *   1 Bot      market maker (R10) or grid
 *   2 Market   the busiest markets as cards, every other one in a searchable list; each with what it costs there
 *   3 Size     order size, loss limit, volume target, Advanced, practice
 *   4 Review   what starts, the estimate, the name, Start (one wallet signature)
 *
 * The stepper on the left keeps the estimate for the chosen market in view.
 */
import { useEffect, useMemo, useState } from 'react';
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
import { BotIcon } from './BotIcon';
import { BotSettings, NameField } from './BotSettings';
import { BotsHead, type BotsCtx } from './BotsPage';
import { Button, Icon, Inset, Panel, ProgressBar, RollingNumber, SearchField, Segmented, SegmentedBar, Shell, ShellHeader, Skeleton, StatusPill } from './kit/kit';

/** A cost in bp as what $1M does: −$185 (it costs), +$359 (it earns). */
export const fmtBpUsd = (bp: number | null | undefined): string => (bp === null || bp === undefined ? DASH : bp < 0 ? `+${fmtUsd(-bpToPerMillion(bp), 0)}` : bp > 0 ? `−${fmtUsd(bpToPerMillion(bp), 0)}` : fmtUsd(0, 0));
export const bpCls = (bp: number | null | undefined): string => (bp === null || bp === undefined ? '' : bp < 0 ? 'pos' : bp > 0 ? 'neg' : '');
const fmtVol = (usdH: number): string => fmtUsd(usdH * 24, 0);
const CONF_TONE = { high: 'positive', medium: 'warning', low: 'neutral' } as const;
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
          { id: 'p', value: m.takers.t1002, label: 'Patient taker', color: TAKER_COLORS.patient },
          { id: 'f', value: m.takers.t23342, label: 'Fast taker', color: TAKER_COLORS.fast },
          { id: 'o', value: m.takers.other, label: 'Others', color: TAKER_COLORS.other },
        ]}
      />
      <div className="bots-takers__key">
        <span title="Fills from the patient taker cost makers little."><i style={{ background: TAKER_COLORS.patient }} />Patient <b>{Math.round(m.takers.t1002 * 100)}%</b></span>
        <span title="Fills from the fast taker cost about 1 bp each."><i style={{ background: TAKER_COLORS.fast }} />Fast <b>{Math.round(m.takers.t23342 * 100)}%</b></span>
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
        <span className="bots-est__k">Est. cost per $1M{gate ? ' · gate on' : ''}</span>
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
  { title: 'Size', hint: 'How much' },
  { title: 'Review', hint: 'Check and start' },
] as const;

/** A market without a Binance price runs the plain maker: quotes off SoDEX's book, no gate, no rest. */
export const noLeadOf = (m: BotMarket | null | undefined): boolean => m?.lead === null;
export const effectiveDraft = (d: BotDraft, m: BotMarket | null | undefined): BotDraft => (d.strategy === 'market' && noLeadOf(m) ? { ...d, strategy: 'maker', gate: false } : d);

type MSort = 'best' | 'volume' | 'patient' | 'room';

function MarketStep({ d, set, markets }: { d: BotDraft; set: (p: Partial<BotDraft>) => void; markets: BotMarket[] | null; feeBps: number }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<MSort>('best');
  const [all, setAll] = useState(false);
  const { byName } = useSymbols('perps');
  const needle = q.trim().toLowerCase();
  const list = useMemo(() => {
    const xs = (markets ?? []).filter((m) => (!needle || m.symbol.toLowerCase().includes(needle)) && (all || needle || m.confidence !== 'low'));
    const by: Record<MSort, (m: BotMarket) => number> = { best: (m) => m.estCostBps, volume: (m) => -m.volumeUsdH, patient: (m) => -m.takers.t1002, room: (m) => -m.capacityUsdH };
    return [...xs].sort((x, y) => by[sort](x) - by[sort](y));
  }, [markets, needle, sort, all]);
  const shown = all || needle ? list : list.slice(0, 10);
  const best = useMemo(() => (markets ?? []).filter((m) => m.confidence === 'high' && m.capacityUsdH >= 1_000).sort((x, y) => x.estCostBps - y.estCostBps)[0]?.symbol ?? null, [markets]);
  const extra = needle ? [...byName.keys()].filter((x) => x.toLowerCase().includes(needle) && !(markets ?? []).some((m) => m.symbol === x)).slice(0, 12) : [];
  const pick = (symbol: string) => set({ symbol, low: null, high: null });
  if (!markets) return <div className="bots-skels">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="bots-skel" />)}</div>;
  const head = (k: MSort, label: string) => (
    <th className="right"><button type="button" className={`bots-sort${sort === k ? ' is-on' : ''}`} onClick={() => setSort(k)}>{label}</button></th>
  );
  return (
    <Panel className="bots-mstep">
      <div className="bots-toolbar">
        <SearchField value={q} onChange={setQ} placeholder="Search a market (SOL, DOGE, NVDA…)" label="Search a market" className="bots-toolbar__search" />
        <span className="bots-toolbar__sp" />
        <Segmented value={all ? 'all' : 'read'} label="Markets shown" onChange={(v) => setAll(v === 'all')} options={[{ value: 'read', label: 'Well read' }, { value: 'all', label: `All ${markets.length}` }]} />
      </div>
      <div className="bots-tablewrap">
        <table className="bots-table bots-mtable" role="radiogroup" aria-label="Market">
          <thead>
            <tr>
              <th>Market</th>
              <th className="right">Price</th>
              {head('volume', 'Volume / day')}
              {head('best', 'Per $1M')}
              {head('patient', 'Patient taker')}
              {head('room', 'Room / h')}
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => {
              const on = d.symbol === m.symbol;
              return (
                <tr key={m.symbol} role="radio" aria-checked={on} aria-label={m.symbol} tabIndex={0} className={`bots-row${on ? ' is-open' : ''}`} onClick={() => pick(m.symbol)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && pick(m.symbol)}>
                  <td>
                    <span className="bots-mkt__name">
                      <span className={`bots-radio${on ? ' is-on' : ''}`} aria-hidden="true" />
                      <CoinIcon coin={m.symbol} size={20} />
                      <b>{m.symbol}</b>
                      {m.symbol === best && <StatusPill size="sm" tone="positive">best</StatusPill>}
                      {m.lead === null && <StatusPill size="sm">no Binance</StatusPill>}
                    </span>
                  </td>
                  <td className="right num dim">{fmtUsd(m.price)}</td>
                  <td className="right num">{fmtUsd(m.volumeUsdH * 24, 0)}</td>
                  <td className={`right num bots-strong ${bpCls(m.estCostBps)}`}>{fmtBpUsd(m.estCostBps)}</td>
                  <td className="right"><span className="bots-share"><ProgressBar value={m.takers.t1002} max={1} size="sm" color={TAKER_COLORS.patient} label="Patient taker share" /><b>{Math.round(m.takers.t1002 * 100)}%</b></span></td>
                  <td className="right num dim">{fmtUsd(m.capacityUsdH, 0)}</td>
                </tr>
              );
            })}
            {extra.map((x) => (
              <tr key={x} role="radio" aria-checked={d.symbol === x} aria-label={x} tabIndex={0} className={`bots-row${d.symbol === x ? ' is-open' : ''}`} onClick={() => pick(x)}>
                <td><span className="bots-mkt__name"><span className={`bots-radio${d.symbol === x ? ' is-on' : ''}`} aria-hidden="true" /><CoinIcon coin={x} size={20} /><b>{x}</b><StatusPill size="sm">little traded</StatusPill></span></td>
                <td className="right dim" colSpan={5}>No estimate</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!all && !needle && list.length > 10 && <button type="button" className="bots-more__t" onClick={() => setAll(true)}>{list.length - 10} more<Icon name="arrowRight" size={13} /></button>}
    </Panel>
  );
}

/** How a strategy quotes, drawn: the market maker's two quotes at the touch, the grid's ladder. */
function StrategyArt({ s }: { s: Strategy }) {
  if (s === 'grid') {
    return (
      <svg viewBox="0 0 120 64" className="bots-art" aria-hidden="true">
        <path d="M4 40 C20 30, 32 46, 48 34 S78 22, 92 30 S112 40, 116 32" className="bots-art__px" />
        {[10, 18, 26, 34, 42, 50, 58].map((y, i) => <line key={y} x1="10" x2="110" y1={y} y2={y} className={i < 3 ? 'bots-art__ask' : i > 3 ? 'bots-art__bid' : 'bots-art__mid'} />)}
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 120 64" className="bots-art" aria-hidden="true">
      <path d="M4 34 C18 30, 30 38, 44 33 S70 28, 84 32 S108 36, 116 33" className="bots-art__px" />
      <rect x="70" y="22" width="40" height="6" rx="2" className="bots-art__askq" />
      <rect x="70" y="38" width="40" height="6" rx="2" className="bots-art__bidq" />
      <path d="M8 14h20M8 14l4-3M8 14l4 3" className="bots-art__lead" />
      <text x="32" y="17" className="bots-art__t">Binance</text>
    </svg>
  );
}

export function BotNewPage({ ctx, view }: { ctx: BotsCtx; view: Extract<BotsView, { page: 'new' }> }) {
  const startKind: Strategy = view.kind === 'grid' ? 'grid' : 'market';
  const [d, setD] = useState<BotDraft>(() => draftFor(startKind, 'balanced', view.market ?? 'BTC-USD'));
  const [step, setStep] = useState(view.market ? 1 : 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (view.market) setD((x) => ({ ...x, symbol: view.market! })); }, [view.market]);
  const set = (p: Partial<BotDraft>) => setD((x) => ({ ...x, ...p }));
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
  const can = !check.length && !why && ctx.ready && (d.strategy !== 'grid' || !!range);
  const estBps = est ? (eff.strategy === 'market' && eff.gate && est.gateCostBps !== null ? est.gateCostBps : est.estCostBps) : null;
  const need = d.strategy === 'grid' ? d.orderUsd * d.levels : d.maxInventoryUsd + d.orderUsd * 2;

  const { confirm, dialog } = useConfirm();
  const start = async () => {
    const ok = await confirm({
      title: `Start ${d.label.trim() || `${STRATEGY_INFO[eff.strategy].name} ${d.symbol.replace(/-USD$/, '')}`}?`,
      body: `${STRATEGY_INFO[eff.strategy].name} on ${d.symbol}, ${fmtUsd(d.orderUsd, 0)} orders${d.strategy === 'grid' ? '' : `, up to ${fmtUsd(d.maxInventoryUsd, 0)} held`}${d.maxLossUsd !== null ? `, stops at a ${fmtUsd(d.maxLossUsd, 0)} loss` : ''}. ${paper ? 'Practice: no orders are sent.' : 'Real orders in your SoDEX account.'}`,
      confirmLabel: paper ? 'Start practice bot' : 'Start bot',
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const v = await ctx.start(specOf({ ...eff, paper }, mark));
      goBots({ page: 'bot', id: v.algo.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const next = () => setStep((s) => Math.min(3, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  return (
    <>
      {dialog}
      <BotsHead view={view} title="New bot" sub="Pick a bot, a market and a size, then start it." />
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
              <ShellHeader icon="layers" title="Strategy" subtitle="Every order rests on the book: maker fee only." />
              <div className="bots-strows" role="radiogroup" aria-label="Strategy">
                {STRATEGIES.map((st) => {
                  const c = costPerMillion(draftFor(st), null, null, ctx.feeTenths);
                  const on = d.strategy === st;
                  const facts = st === 'market' ? ['Binance-led', 'Rests up to 10 s', 'At the touch', 'Gate, flow gate, quiet hours'] : ['Your price range', 'Buy low, sell high', 'Levels on both sides'];
                  return (
                    <button key={st} type="button" role="radio" aria-checked={on} aria-label={STRATEGY_INFO[st].name} className={`bots-strow${on ? ' is-on' : ''}`} onClick={() => setD({ ...draftFor(st, 'balanced', d.symbol), label: d.label, paper: d.paper })}>
                      <span className={`bots-radio${on ? ' is-on' : ''}`} aria-hidden="true" />
                      <StrategyArt s={st} />
                      <span className="bots-strow__t">
                        <b>{STRATEGY_INFO[st].name}{st === 'market' && <StatusPill size="sm" tone="positive">R10 · live tested</StatusPill>}</b>
                        <small>{STRATEGY_INFO[st].line}</small>
                        <span className="bots-strow__facts">{facts.map((f) => <span key={f}>{f}</span>)}</span>
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
              <ShellHeader icon="compass" title="Market" subtitle="Busy markets fill often and cheaply." aside={<Button variant="quiet" onClick={() => goBots({ page: 'explore' })}>Compare all<Icon name="arrowRight" size={13} /></Button>} />
              <MarketStep d={d} set={set} markets={markets.data?.markets ?? (markets.error ? [] : null)} feeBps={feeBps} />
              {noLead && d.strategy === 'market' && <p className="bots-note bots-note--pad"><Icon name="warning" size={13} /> No Binance price here: it quotes off SoDEX's book, without the gate.</p>}
            </Shell>
          )}

          {step === 2 && (
            <Shell>
              <ShellHeader icon="coins" title="Size" subtitle="Start small: $10–20 orders and a $1–3 loss limit." />
              <Panel className="bots-sizepanel">
                <div className="bots-callout"><Icon name="wallet" size={14} /><span>Trades futures: it uses the USDC in your SoDEX <b>futures</b> account.</span></div>
                <BotSettings d={d} set={set} range={range} mark={mark} liveAllowed={ctx.liveAllowed} noLead={noLead} />
              </Panel>
            </Shell>
          )}

          {step === 3 && (
            <Shell>
              <ShellHeader icon="check" title="Review and start" subtitle="One wallet signature. Stop or change it any time." />
              <Panel className="bots-review">
                <dl className="bots-review__list">
                  <div><dt>Bot</dt><dd><BotIcon strategy={eff.strategy} size={14} />{STRATEGY_INFO[eff.strategy].name}</dd></div>
                  <div><dt>Market</dt><dd><CoinIcon coin={d.symbol} size={16} />{d.symbol}</dd></div>
                  <div><dt>Order size</dt><dd>{fmtUsd(d.orderUsd, 0)}{d.strategy === 'grid' ? ` × ${d.levels} levels` : ' each side'}</dd></div>
                  {d.strategy !== 'grid' && <div><dt>Max holding</dt><dd>{fmtUsd(d.maxInventoryUsd, 0)}</dd></div>}
                  {eff.strategy === 'market' && <div><dt>Market gate</dt><dd>{eff.gate ? `On · ${d.gateBps} bp in ${d.gateWindowS} s` : 'Off'}</dd></div>}
                  <div><dt>Est. cost per $1M</dt><dd>{est ? `${fmtBpUsd(est.estCostLowBps)}–${fmtBpUsd(est.estCostHighBps)}` : DASH}</dd></div>
                  <div><dt>Stops if it loses</dt><dd>{d.maxLossUsd === null ? 'No limit' : fmtUsd(d.maxLossUsd, 2)}</dd></div>
                  <div><dt>Stops after</dt><dd>{d.volumeTargetUsd === null ? 'You stop it' : `${fmtUsd(d.volumeTargetUsd, 0)} traded`}</dd></div>
                  <div><dt>Balance needed</dt><dd>about {fmtUsd(need, 0)}</dd></div>
                  <div><dt>Orders</dt><dd>{paper ? <StatusPill tone="brand" size="sm">Practice</StatusPill> : <StatusPill tone="warning" size="sm">Real</StatusPill>}</dd></div>
                </dl>
                <NameField d={d} set={set} />
                {why && ctx.address && <p className="bots-note">{why} <button type="button" className="bots-link" onClick={() => ctx.setup(paper)}>Set up</button></p>}
                {!ctx.address && <p className="bots-note">Connect your wallet to start a bot.</p>}
              </Panel>
            </Shell>
          )}
        </div>
        <aside className="bots-newside">
          <Shell className="bots-sidecard">
            <ShellHeader tile={<CoinIcon coin={d.symbol} size={20} />} title={d.symbol} subtitle={`${STRATEGY_INFO[eff.strategy].name}${noLead && d.strategy === 'market' ? ' · no Binance price' : ''}`} aside={paper ? <StatusPill tone="brand" size="sm">Practice</StatusPill> : <StatusPill tone="warning" size="sm">Real</StatusPill>} />
            <Panel className="bots-sidepanel">
              {eff.strategy === 'grid' ? (
                <div className="bots-est">
                  <div className="bots-est__big">
                    <span className="bots-est__k">Per $1M, before price moves</span>
                    <RollingNumber value={floor.net < 0 ? `+${fmtUsd(-floor.net, 0)}` : `−${fmtUsd(floor.net, 0)}`} className={`bots-est__v ${floor.net < 0 ? 'pos' : 'neg'}`} />
                    <span className="bots-est__sub">fees {fmtUsd(floor.fees, 0)}{floor.edge !== null ? ` · steps earn ${fmtUsd(floor.edge, 0)}` : ''}</span>
                  </div>
                </div>
              ) : markets.data ? <Estimate m={est} gate={eff.strategy === 'market' && eff.gate} feeBps={feeBps} /> : markets.error ? <p className="bots-fine">Estimates unavailable. Fees alone: {fmtUsd(floor.fees, 0)} per $1M.</p> : <div className="bots-skels"><Skeleton className="bots-skel is-big" /><Skeleton className="bots-skel" /></div>}
              <div className="bots-sidepanel__facts">
                <span><small>Order</small><b>{fmtUsd(d.orderUsd, 0)}</b></span>
                <span><small>{d.strategy === 'grid' ? 'Levels' : 'Max holding'}</small><b>{d.strategy === 'grid' ? d.levels : fmtUsd(d.maxInventoryUsd, 0)}</b></span>
                <span><small>Loss limit</small><b>{d.maxLossUsd === null ? 'None' : fmtUsd(d.maxLossUsd, 0)}</b></span>
              </div>
              {step === 3 && check.map((e) => <p key={e} className="bots-err" role="alert">{e}</p>)}
              {step === 3 && error && <p className="bots-err" role="alert">{error}</p>}
              <div className="bots-sidepanel__act">
                {step > 0 && <Button variant="secondary" size="md" icon="arrowLeft" onClick={back}>Back</Button>}
                {step < 3
                  ? <Button variant="primary" size="md" className="bots-stepper__next" onClick={next}>Next<Icon name="arrowRight" size={14} /></Button>
                  : <Button variant="primary" size="md" className="bots-stepper__next" icon="play" loading={busy} disabled={!can} onClick={() => void start()}>{busy ? 'Starting…' : paper ? 'Start practice bot' : 'Start bot'}</Button>}
              </div>
            </Panel>
          </Shell>
        </aside>
      </div>
    </>
  );
}
