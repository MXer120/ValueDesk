/**
 * Bots > New bot: a page, not a window. Left, what it is (market maker or grid), where (with what Explore estimates
 * it costs there), its size, the market gate, the advanced settings and limits. Right, held in view: what it is
 * estimated to cost per $1M on that market, where the money goes, and Start. One wallet signature starts it.
 */
import { useEffect, useMemo, useState } from 'react';
import { checkSizes, parseAlgoSpec, type MarketInfo } from '@copy-engine';
import { DASH, fmtUsd } from '../../format';
import { useSymbols } from '../../hooks';
import { DlgRow, DlgSection } from '../dialogParts';
import { MarketSelect } from '../algo/MarketSelect';
import { marketOf } from '../algo/draft';
import { useHistory } from '../algo/liveData';
import { CoinIcon } from '../CoinIcon';
import { Card } from '../portfolio/parts';
import { useBotMarkets, bpToPerMillion, type BotMarket } from '../../bots/data';
import { goBots, type BotsView } from '../../bots/routes';
import { STRATEGIES, STRATEGY_INFO, costPerMillion, draftFor, gridRange, specOf, type BotDraft, type Strategy } from '../../bots/presets';
import { BotIcon } from './BotIcon';
import { BotSettings } from './BotSettings';
import { describe } from './BotForm';
import { BotsHead, type BotsCtx } from './BotsPage';

const fmtBpUsd = (bp: number | null | undefined): string => (bp === null || bp === undefined ? DASH : bp < 0 ? `earns ${fmtUsd(-bpToPerMillion(bp), 0)}` : fmtUsd(bpToPerMillion(bp), 0));

/** What Explore estimates for this market: the number, its range, and how sure. */
export function Estimate({ m, gate, feeBps }: { m: BotMarket | null; gate: boolean; feeBps: number }) {
  if (!m) return <p className="oe-hint">No estimate for this market yet: too few trades from small makers there to read one.</p>;
  const est = gate && m.gateCostBps !== null ? m.gateCostBps : m.estCostBps;
  const losses = est - feeBps;
  return (
    <div className="bots-est">
      <div className="bots-est__big">
        <span className="bots-est__k">Estimated cost per $1M{gate ? ', with the gate' : ''}</span>
        <span className={`bots-est__v${est < 0 ? ' pos' : ''}`}>{fmtBpUsd(est)}</span>
        <span className="bots-est__sub">range {fmtBpUsd(m.estCostLowBps)} to {fmtBpUsd(m.estCostHighBps)} · <span className={`bots-conf is-${m.confidence}`}>{m.confidence} confidence</span></span>
      </div>
      <dl className="bots-ledger">
        <dt>Fees (SoDEX + ValueDesk)</dt><dd>{fmtBpUsd(feeBps)}</dd>
        <dt>{losses >= 0 ? 'Price moves against fills' : 'Spread kept after price moves'}</dt><dd className={losses > 0 ? 'neg' : 'pos'}>{losses >= 0 ? '+' : '−'}{fmtUsd(Math.abs(bpToPerMillion(losses)), 0)}</dd>
        <dt className="is-total">All-in</dt><dd className="is-total">{fmtBpUsd(est)}</dd>
      </dl>
      <div className="bots-takers" aria-label="Who takes small makers' quotes here">
        <span className="bots-takers__bar">
          <i className="is-patient" style={{ width: `${m.takers.t1002 * 100}%` }} />
          <i className="is-fast" style={{ width: `${m.takers.t23342 * 100}%` }} />
          <i className="is-other" style={{ width: `${m.takers.other * 100}%` }} />
        </span>
        <span className="bots-takers__key">
          <span><i className="is-patient" />Patient taker {Math.round(m.takers.t1002 * 100)}%</span>
          <span><i className="is-fast" />Fast taker {Math.round(m.takers.t23342 * 100)}%</span>
          <span><i className="is-other" />Others {Math.round(m.takers.other * 100)}%</span>
        </span>
      </div>
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

  const cheaper = (markets.data?.markets ?? []).filter((m) => m.symbol !== d.symbol && m.confidence !== 'low' && m.capacityUsdH >= 1_000 && est && m.estCostBps < est.estCostBps - 0.05).slice(0, 3);

  return (
    <>
      <BotsHead view={view} title="New bot" sub="Choose what it does and where. It starts as soon as you sign, and you can change or stop it at any time." />
      <div className="bots-newgrid">
        <div className="bots-newform">
          <Card title="Strategy">
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
                  <BotIcon strategy={s} size={20} />
                  <span className="bots-kind__t">
                    <b>{STRATEGY_INFO[s].name}{s === 'market' && <span className="bots-tag">Lowest cost</span>}</b>
                    <small>{STRATEGY_INFO[s].line}</small>
                  </span>
                </button>
              ))}
            </div>
            <ul className="bots-how">{STRATEGY_INFO[d.strategy].how.map((h) => <li key={h}>{h}</li>)}</ul>
          </Card>

          <Card title="Market" className="dlg">
            <DlgSection label="Market">
              <DlgRow title="Market" line="Any SoDEX perpetual. Explore compares what a market maker costs on each.">
                <MarketSelect value={d.symbol} onChange={(v) => set({ symbol: v, low: null, high: null })} compact />
              </DlgRow>
              {cheaper.length > 0 && d.strategy === 'market' && (
                <DlgRow title="Cheaper now" line="Markets where makers our size paid less over the last day." stack>
                  <div className="bots-cheaprow">
                    {cheaper.map((m) => (
                      <button key={m.symbol} type="button" className="bots-chip" onClick={() => set({ symbol: m.symbol })}>
                        <CoinIcon coin={m.symbol} size={14} />
                        <b>{m.base}</b>
                        <small>{fmtBpUsd(m.estCostBps)}</small>
                      </button>
                    ))}
                    <button type="button" className="bots-link" onClick={() => goBots({ page: 'explore' })}>Every market</button>
                  </div>
                </DlgRow>
              )}
            </DlgSection>
          </Card>

          <Card title="Settings" className="dlg">
            <BotSettings d={d} set={set} running={false} range={range} mark={mark} liveAllowed={ctx.liveAllowed} />
          </Card>
        </div>

        <aside className="bots-newside">
          <Card title={<span className="bots-sidehead"><CoinIcon coin={d.symbol} size={16} />{d.symbol}</span>} className="bots-sidecard">
            {d.strategy === 'market' ? (
              markets.data ? <Estimate m={est} gate={d.gate} feeBps={feeBps} /> : markets.error ? <p className="oe-hint">Estimates are not available right now ({markets.error}). The fees alone are {fmtUsd(floor.fees, 0)} per $1M.</p> : <div className="bots-skel" aria-hidden="true"><span className="bots-bone" /><span className="bots-bone" /></div>
            ) : (
              <div className="bots-est">
                <div className="bots-est__big">
                  <span className="bots-est__k">Per $1M, before price moves</span>
                  <span className={`bots-est__v${floor.net < 0 ? ' pos' : ''}`}>{floor.net < 0 ? `earns ${fmtUsd(-floor.net, 0)}` : fmtUsd(floor.net, 0)}</span>
                  <span className="bots-est__sub">fees {fmtUsd(floor.fees, 0)}{floor.edge !== null ? `, grid steps earn ${fmtUsd(floor.edge, 0)}` : ''}</span>
                </div>
              </div>
            )}
            <p className="bots-summary">{describe(d.strategy === 'market' ? { ...d, strategy: 'maker' } : d, range)}{d.strategy === 'market' && d.gate ? ` It adds no quote while Binance moved more than ${d.gateBps} bp in ${d.gateWindowS} s.` : ''}</p>
            {check.map((e) => <p key={e} className="fx-note fx-note--err" role="alert">{e}</p>)}
            {why && ctx.address && <p className="fx-note">{why} <button type="button" className="bots-link" onClick={() => ctx.setup(paper)}>Set up</button></p>}
            {!ctx.address && <p className="fx-note">Connect your wallet to start a bot.</p>}
            {error && <p className="fx-note fx-note--err" role="alert">{error}</p>}
            <button type="button" className="pf-btn pf-btn--primary pf-btn--wide" disabled={!can || busy} onClick={() => void start()}>
              {busy ? 'Starting…' : paper ? 'Start practice bot' : 'Start bot'}
            </button>
            <p className="bots-foot-note">{paper ? 'Practice: runs against the real book, sends nothing.' : 'Real orders in your SoDEX account.'} One wallet signature. Stop it any time.</p>
          </Card>
        </aside>
      </div>
    </>
  );
}
