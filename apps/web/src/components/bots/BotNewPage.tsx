/**
 * Bots > New bot: a page, not a window, in the Bots kit. Left: what it is (market maker or grid), where (with what
 * Explore estimates it costs there and cheaper markets with room), and its settings. Right, held in view: what it is
 * estimated to cost per $1M on that market, who takes there, where the money goes, and Start. One wallet signature.
 */
import { useEffect, useMemo, useState } from 'react';
import { checkSizes, parseAlgoSpec, type MarketInfo } from '@copy-engine';
import { DASH, fmtUsd } from '../../format';
import { useSymbols } from '../../hooks';
import { MarketSelect } from '../algo/MarketSelect';
import { marketOf } from '../algo/draft';
import { useHistory } from '../algo/liveData';
import { CoinIcon } from '../CoinIcon';
import { useBotMarkets, bpToPerMillion, type BotMarket } from '../../bots/data';
import { goBots, type BotsView } from '../../bots/routes';
import { STRATEGIES, STRATEGY_INFO, costPerMillion, draftFor, gridRange, specOf, type BotDraft, type Strategy } from '../../bots/presets';
import { BotIcon } from './BotIcon';
import { BotSettings } from './BotSettings';
import { describe } from './BotForm';
import { BotsHead, type BotsCtx } from './BotsPage';
import { Button, Icon, Inset, Panel, RollingNumber, SegmentedBar, Shell, ShellHeader, Skeleton, StatusPill } from './kit/kit';

const fmtBpUsd = (bp: number | null | undefined): string => (bp === null || bp === undefined ? DASH : bp < 0 ? `earns ${fmtUsd(-bpToPerMillion(bp), 0)}` : fmtUsd(bpToPerMillion(bp), 0));
const CONF_TONE = { high: 'positive', medium: 'warning', low: 'neutral' } as const;
export const TAKER_COLORS = { patient: 'var(--pos)', fast: 'var(--neg)', other: 'rgb(var(--ink) / 0.28)' };

/** Who takes small makers' quotes on a market, as TUFFUI's stacked bar with its key. */
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
        <span><i style={{ background: TAKER_COLORS.patient }} />Patient <b>{Math.round(m.takers.t1002 * 100)}%</b></span>
        <span><i style={{ background: TAKER_COLORS.fast }} />Fast <b>{Math.round(m.takers.t23342 * 100)}%</b></span>
        <span><i style={{ background: TAKER_COLORS.other }} />Others <b>{Math.round(m.takers.other * 100)}%</b></span>
      </div>
    </div>
  );
}

/** What Explore estimates for this market: the number, its range, how sure, who takes, where the money goes. */
export function Estimate({ m, gate, feeBps }: { m: BotMarket | null; gate: boolean; feeBps: number }) {
  if (!m) return <p className="bots-fine">No estimate for this market yet: too few trades from small makers there to read one.</p>;
  const est = gate && m.gateCostBps !== null ? m.gateCostBps : m.estCostBps;
  const losses = est - feeBps;
  return (
    <div className="bots-est">
      <div className="bots-est__big">
        <span className="bots-est__k">Estimated cost per $1M{gate ? ', gate on' : ''}</span>
        <RollingNumber value={fmtBpUsd(est)} className={`bots-est__v${est < 0 ? ' pos' : ''}`} />
        <span className="bots-est__sub">
          range {fmtBpUsd(m.estCostLowBps)} to {fmtBpUsd(m.estCostHighBps)}
          <StatusPill size="sm" tone={CONF_TONE[m.confidence]} dot>{m.confidence} confidence</StatusPill>
        </span>
      </div>
      <Takers m={m} />
      <Inset className="bots-ledger">
        <div><span>Fees (SoDEX + ValueDesk)</span><b>{fmtBpUsd(feeBps)}</b></div>
        <div><span>{losses >= 0 ? 'Price moves against fills' : 'Spread kept after price moves'}</span><b className={losses > 0 ? 'neg' : 'pos'}>{losses >= 0 ? '+' : '−'}{fmtUsd(Math.abs(bpToPerMillion(losses)), 0)}</b></div>
        <div className="is-total"><span>All-in</span><b>{fmtBpUsd(est)}</b></div>
      </Inset>
      <p className="bots-fine">From the last day of this market's trades: what makers our size kept 30 s after each fill, plus the fees. Fills from the patient taker cost little; fills from the fast one cost about 1 bp each.</p>
    </div>
  );
}

export function BotNewPage({ ctx, view }: { ctx: BotsCtx; view: Extract<BotsView, { page: 'new' }> }) {
  const startKind: Strategy = view.kind === 'grid' ? 'grid' : 'market';
  const [d, setD] = useState<BotDraft>(() => draftFor(startKind, 'balanced', view.market ?? 'BTC-USD'));
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
  const feeBps = markets.data ? markets.data.fee.makerBps + ctx.feeTenths / 10 : 1.2 + ctx.feeTenths / 10;
  const floor = costPerMillion(d, market, mark, ctx.feeTenths);
  const paper = !ctx.liveAllowed || d.paper;

  const check = useMemo(() => {
    try {
      const spec = parseAlgoSpec(specOf({ ...d, paper }, mark));
      if (!market) return [] as string[];
      return checkSizes(spec, market, { price: mark, seed: 1, now: Date.now() }).errors;
    } catch (e) {
      return [e instanceof Error ? e.message : String(e)];
    }
  }, [d, mark, market, paper]);
  const why = ctx.setupWhy(paper);
  const can = !check.length && !why && ctx.ready && (d.strategy !== 'grid' || !!range);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const v = await ctx.start(specOf({ ...d, paper }, mark));
      goBots({ page: 'bot', id: v.algo.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cheaper = (markets.data?.markets ?? []).filter((m) => m.symbol !== d.symbol && m.confidence !== 'low' && m.capacityUsdH >= 1_000 && est && m.estCostBps < est.estCostBps - 0.05).slice(0, 4);

  return (
    <>
      <BotsHead view={view} title="New bot" sub="Choose what it does and where. It starts as soon as you sign, and you can change or stop it at any time." />
      <div className="bots-newgrid">
        <div className="bots-newform">
          <Shell>
            <ShellHeader icon="layers" title="Strategy" subtitle="What it does on the book" />
            <div className="bots-kinds" role="radiogroup" aria-label="Strategy">
              {STRATEGIES.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={d.strategy === s}
                  className={`bots-kind${d.strategy === s ? ' is-on' : ''}`}
                  onClick={() => setD(draftFor(s, 'balanced', d.symbol))}
                >
                  <span className="tf-tile"><BotIcon strategy={s} size={18} /></span>
                  <span className="bots-kind__t">
                    <b>{STRATEGY_INFO[s].name}{s === 'market' && <StatusPill size="sm" tone="positive">Lowest cost</StatusPill>}</b>
                    <small>{STRATEGY_INFO[s].line}</small>
                  </span>
                  <span className="bots-kind__radio" aria-hidden="true" />
                </button>
              ))}
            </div>
            <ul className="bots-how">{STRATEGY_INFO[d.strategy].how.map((h) => <li key={h}><Icon name="check" size={13} />{h}</li>)}</ul>
          </Shell>

          <Shell>
            <ShellHeader icon="compass" title="Market" subtitle="Any SoDEX perpetual. Explore compares what a market maker costs on each." aside={<Button variant="quiet" onClick={() => goBots({ page: 'explore' })}>Every market<Icon name="arrowRight" size={13} /></Button>} />
            <Panel className="bots-mktpanel">
              <div className="bots-mktpick"><MarketSelect value={d.symbol} onChange={(v) => set({ symbol: v, low: null, high: null })} compact /></div>
              {cheaper.length > 0 && d.strategy === 'market' && (
                <div className="bots-cheap">
                  <p className="bots-cheap__k">Cheaper now, with room to trade</p>
                  <div className="bots-cheap__row">
                    {cheaper.map((m) => (
                      <button key={m.symbol} type="button" className="bots-chip" onClick={() => set({ symbol: m.symbol })}>
                        <CoinIcon coin={m.symbol} size={16} />
                        <b>{m.base}</b>
                        <small>{fmtBpUsd(m.estCostBps)}</small>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </Panel>
          </Shell>

          <Shell>
            <ShellHeader icon="gear" title="Settings" subtitle="Change any of them later, from the bot's page" />
            <BotSettings d={d} set={set} running={false} range={range} mark={mark} liveAllowed={ctx.liveAllowed} />
          </Shell>
        </div>

        <aside className="bots-newside">
          <Shell className="bots-sidecard">
            <ShellHeader tile={<CoinIcon coin={d.symbol} size={20} />} title={d.symbol} subtitle={STRATEGY_INFO[d.strategy].name} aside={paper ? <StatusPill tone="brand" size="sm">Practice</StatusPill> : <StatusPill tone="warning" size="sm">Real orders</StatusPill>} />
            <Panel className="bots-sidepanel">
              {d.strategy === 'market' ? (
                markets.data ? <Estimate m={est} gate={d.gate} feeBps={feeBps} /> : markets.error ? <p className="bots-fine">Estimates are not available right now ({markets.error}). The fees alone are {fmtUsd(floor.fees, 0)} per $1M.</p> : <div className="bots-skels"><Skeleton className="bots-skel is-big" /><Skeleton className="bots-skel" /></div>
              ) : (
                <div className="bots-est">
                  <div className="bots-est__big">
                    <span className="bots-est__k">Per $1M, before price moves</span>
                    <RollingNumber value={floor.net < 0 ? `earns ${fmtUsd(-floor.net, 0)}` : fmtUsd(floor.net, 0)} className={`bots-est__v${floor.net < 0 ? ' pos' : ''}`} />
                    <span className="bots-est__sub">fees {fmtUsd(floor.fees, 0)}{floor.edge !== null ? `, grid steps earn ${fmtUsd(floor.edge, 0)}` : ''}</span>
                  </div>
                </div>
              )}
              <Inset className="bots-summary">{describe(d.strategy === 'market' ? { ...d, strategy: 'maker' } : d, range)}{d.strategy === 'market' && d.gate ? ` It adds no quote while Binance moved more than ${d.gateBps} bp in ${d.gateWindowS} s.` : ''}</Inset>
              {check.map((e) => <p key={e} className="bots-err" role="alert">{e}</p>)}
              {why && ctx.address && <p className="bots-note">{why} <button type="button" className="bots-link" onClick={() => ctx.setup(paper)}>Set up</button></p>}
              {!ctx.address && <p className="bots-note">Connect your wallet to start a bot.</p>}
              {error && <p className="bots-err" role="alert">{error}</p>}
              <Button variant="primary" size="md" className="bots-start" icon="play" loading={busy} disabled={!can} onClick={() => void start()}>
                {busy ? 'Starting…' : paper ? 'Start practice bot' : 'Start bot'}
              </Button>
              <p className="bots-fine bots-center">{paper ? 'Practice: runs against the real book, sends nothing.' : 'Real orders in your SoDEX account.'} One wallet signature. Stop it any time.</p>
            </Panel>
          </Shell>
        </aside>
      </div>
    </>
  );
}
