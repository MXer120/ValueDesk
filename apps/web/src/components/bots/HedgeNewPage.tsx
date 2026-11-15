/**
 * New hedge (owner 2026-11-14: "a hedging bot for OI on perps ... even at max leverage ... perps hedged with spot or
 * 2 sodex accounts"). Five places: the shape, the market, size and safety, the second wallet (or the coin), review.
 * The receipt on the right is bots/hedge.ts hedgeNumbers: the same arithmetic the executor runs (engine algo/hedge.ts).
 *
 * A pair is two bots, each signed by its own wallet. This page starts this wallet's leg and keeps an invitation in the
 * browser; when the second wallet is connected, the Bots page shows "Start leg 2" (HedgeInvites).
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { onWalletPrompting, walletPrompting } from '../../wallet';
import { DASH, fmtUsd } from '../../format';
import { useSymbols } from '../../hooks';
import { useConfirm } from '../Modal';
import { CoinIcon } from '../CoinIcon';
import { useBotMarkets } from '../../bots/data';
import { goBots, type BotsView } from '../../bots/routes';
import { PRACTICE_BOTS, refusalOf } from '../../bots/presets';
import { HEDGE_DEFAULT, hedgeNumbers, hedgeProblems, hedgeSpecs, isAddress, newPairId, savePending, type HedgeDraft } from '../../bots/hedge';
import { useReferral } from '../../onboarding/referral';
import { HEDGE_PAIRS_LIVE } from '../../bots/hedgeRules';
import { requestDeposit, requestTransfer } from '../account/actions';
import { notify } from '../../toast';
import { StrategyTile } from './BotIcon';
import { BotsHead, type BotsCtx } from './BotsPage';
import { useFuturesCoin } from './hedgeData';
import { Button, Icon, NumberField, Panel, SearchField, Segmented, Shell, ShellHeader, Skeleton, Slider, StatusPill, Switch, TextInput } from './kit/kit';
import './hedge.css';

const STEPS = [
  { title: 'Shape', hint: 'Two wallets or spot' },
  { title: 'Market', hint: 'Where it holds' },
  { title: 'Size & safety', hint: 'OI and buffers' },
  { title: 'Other leg', hint: 'Second wallet or coin' },
  { title: 'Review', hint: 'Name and start' },
] as const;

const BUFFERS = [2, 3, 5, 8];
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pct = (x: number | null, d = 1) => (x === null || !Number.isFinite(x) ? DASH : `${(x * 100).toFixed(d)}%`);

export function HedgeNewPage({ ctx, view }: { ctx: BotsCtx; view: Extract<BotsView, { page: 'new' }> }) {
  const [d, setD] = useState<HedgeDraft>(() => ({ ...HEDGE_DEFAULT, symbol: view.market ?? 'BTC-USD' }));
  const set = (p: Partial<HedgeDraft>) => setD((x) => ({ ...x, ...p }));
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { byName } = useSymbols('perps');
  const sym = byName.get(d.symbol);
  const maxLev = sym?.maxLeverage ?? 20;
  const takerBps = sym ? Number(sym.takerFee) * 10_000 || 4 : 4;
  const markets = useBotMarkets('24h');
  const mk = markets.data?.markets.find((m) => m.symbol === d.symbol) ?? null;
  const mark = mk?.price ?? null;
  // Two-wallet hedges run as practice until the terms allow real ones (hedgeRules.ts HEDGE_PAIRS_LIVE; the executor
  // refuses them too).
  const pairPractice = d.shape === 'pair' && !HEDGE_PAIRS_LIVE;
  const paper = PRACTICE_BOTS && (!ctx.liveAllowed || d.paper || pairPractice);
  // The market's maximum leverage by default (owner: "even at max leverage"): the least margin locked per leg.
  useEffect(() => { if (sym?.maxLeverage && d.leverage > sym.maxLeverage) set({ leverage: sym.maxLeverage }); }, [sym?.maxLeverage]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = hedgeNumbers({ ...d, paper }, mark ?? 0, maxLev, takerBps, ctx.feeTenths / 10);
  const problems = hedgeProblems({ ...d, paper }, ctx.address);
  const partnerRef = useReferral(d.shape === 'pair' && isAddress(d.partner) ? d.partner.trim() : null);
  const coin = useFuturesCoin(d.shape === 'spot' ? ctx.address : null, sym?.baseCoin ?? d.symbol.replace(/-USD$/, ''));
  const coinUsd = coin !== null && mark ? coin * mark : null;
  const running = ctx.bots.some((v) => !v.algo.spec.paper && v.algo.spec.symbol === d.symbol && !['done', 'cancelled', 'expired', 'failed'].includes(v.algo.status));

  const stepErr = at === 2 ? problems.size ?? problems.buffer ?? problems.loss ?? null : at === 3 && d.shape === 'pair' ? problems.partner ?? null : null;
  const whyNot =
    !ctx.address ? 'Connect your wallet to start a bot.'
    : !PRACTICE_BOTS && !ctx.liveAllowed ? 'Real bots are not open for this wallet yet.'
    : pairPractice && !PRACTICE_BOTS ? 'Two-wallet hedges open once the terms allow real ones. A hedge against spot runs now.'
    : ctx.setupWhy(paper) ? ctx.setupWhy(paper)
    : !ctx.ready ? 'The ValueDesk executor is not ready yet.'
    : !ctx.live.hosted.info?.features?.includes('hedge') ? 'The executor does not run hedges yet.'
    : Object.values(problems)[0] ?? (!paper && running ? `You already run a real bot on ${d.symbol}: one per market.` : null);

  const { confirm, dialog } = useConfirm();
  const start = async () => {
    if (whyNot || !ctx.address) return;
    const pairId = newPairId();
    const specs = hedgeSpecs({ ...d, paper }, ctx.address, pairId);
    const body = d.shape === 'pair'
      ? `${d.side === 'buy' ? 'Long' : 'Short'} up to ${fmtUsd(d.sizeUsd, 0)} of ${d.symbol} here, and the other side in ${short(d.partner.trim())} once that wallet starts its leg. Both legs shrink when a liquidation comes within ${d.minLiqPct}%.`
      : `Short ${d.symbol} as large as the ${sym?.baseCoin ?? 'coin'} in your futures balance, up to ${fmtUsd(d.sizeUsd, 0)}.`;
    const ok = await confirm({ title: `Start this hedge?`, body: `${body} ${paper ? 'Practice: no orders are sent.' : 'Real orders: every leg takes (IOC) and pays the taker fee.'}`, confirmLabel: paper ? 'Start practice hedge' : 'Start hedge' });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const v = await ctx.start(specs.main);
      if (specs.partner) {
        savePending({ pairId, main: ctx.address.toLowerCase(), partner: d.partner.trim().toLowerCase(), symbol: d.symbol, spec: specs.partner, at: Date.now() });
        notify('ok', `Leg 1 started. Switch your wallet to ${short(d.partner.trim())} and open Bots: it asks to start leg 2.`);
      }
      goBots({ page: 'bot', id: v.algo.id });
    } catch (e) {
      const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : null;
      setError(refusalOf(code, e instanceof Error ? e.message : String(e), false).text);
    } finally {
      setBusy(false);
    }
  };
  const signing = useSyncExternalStore(onWalletPrompting, walletPrompting);
  const last = STEPS.length - 1;

  return (
    <>
      {dialog}
      <BotsHead view={view} title="New hedge" sub="Open interest held market-neutral: a long and a short of the same size." lead={<Button variant="quiet" icon="arrowLeft" onClick={() => goBots({ page: 'new', market: d.symbol, kind: null })}>Bot types</Button>} />
      <nav className="bots-wsteps" aria-label="Steps">
        <ol>
          {STEPS.map((st, i) => (
            <li key={st.title} className={i === at ? 'is-on' : i < at ? 'is-done' : ''}>
              <button type="button" onClick={() => i <= at && setAt(i)} disabled={i > at} aria-current={i === at ? 'step' : undefined}>
                <span className="bots-wsteps__t">
                  <b>{i < at ? <Icon name="check" size={12} /> : <span className="bots-wsteps__n">{i + 1}</span>}{st.title}</b>
                  <small>{st.hint}</small>
                </span>
                <span className="bots-wsteps__seg" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
        <span className="bots-wsteps__count">{at + 1}/{STEPS.length}</span>
      </nav>
      <div className="bots-wizard">
        <div className="bots-wizard__main">
          {at === 0 && (
            <Shell>
              <ShellHeader icon="layers" title="Shape" subtitle="What holds the other side?" />
              <div className="bots-types" role="radiogroup" aria-label="Hedge shape">
                {([
                  { id: 'pair', name: 'Two wallets', line: 'A long in this wallet, the same short in a second wallet.', good: 'The most open interest per dollar: both legs at up to the maximum leverage.' },
                  { id: 'spot', name: 'Against spot', line: 'A short as large as the coin this wallet holds in its futures balance.', good: 'The calmest: SoDEX counts the coin as margin, so the short is hard to liquidate.' },
                ] as const).map((s) => {
                  const on = d.shape === s.id;
                  return (
                    <button key={s.id} type="button" role="radio" aria-checked={on} aria-label={s.name} className={`bots-type${on ? ' is-on' : ''}`} onClick={() => set({ shape: s.id, ...(s.id === 'spot' ? { side: 'sell' as const } : {}) })}>
                      <span className={`bots-radio${on ? ' is-on' : ''}`} aria-hidden="true" />
                      <StrategyTile strategy="hedge" size={48} />
                      <span className="bots-type__t"><b>{s.name}</b><span>{s.line}</span><small>{s.good}</small></span>
                      <span className="bots-cat__n">{s.id === 'pair' ? '2 legs' : '1 leg'}</span>
                    </button>
                  );
                })}
              </div>
              <p className="hg-note"><Icon name="warning" size={13} />Both legs only take (IOC), so they never trade with each other. SoDEX rules out wash trading and manipulative farming; a hedge holds real positions on both sides, at the taker fee every time it opens or closes.</p>
            </Shell>
          )}

          {at === 1 && (
            <Shell>
              <ShellHeader icon="compass" title="Market" subtitle="One market. A liquid one keeps the taker cost low." />
              <HedgeMarkets value={d.symbol} onPick={(s) => set({ symbol: s })} markets={markets.data?.markets ?? null} maxOf={(s) => byName.get(s)?.maxLeverage ?? null} />
            </Shell>
          )}

          {at === 2 && (
            <Shell>
              <ShellHeader icon="gear" title="Size & safety" subtitle="Sized by how far the liquidation stays, not by the leverage." />
              <Panel className="hg-form">
                {d.shape === 'pair' && (
                  <Row title="This wallet" line="The second wallet takes the other side.">
                    <Segmented label="This wallet's side" value={d.side} onChange={(v) => set({ side: v })} options={[{ value: 'buy', label: 'Long' }, { value: 'sell', label: 'Short' }]} />
                  </Row>
                )}
                <Row title="Size per leg" line={d.shape === 'pair' ? `Open interest: ${fmtUsd(n.oiUsd, 0)} across both legs.` : 'Up to this much short; never more than the coin you hold.'} error={problems.size}>
                  <div className="bots-sizeline">
                    <Slider label="Size slider" value={Math.min(50_000, d.sizeUsd)} min={50} max={50_000} step={50} onChange={(v) => set({ sizeUsd: Math.round(v) })} minLabel="$50" maxLabel="$50k" />
                    <NumberField label="Size per leg" hideLabel value={d.sizeUsd} onChange={(v) => v !== null && set({ sizeUsd: v })} unit="USD" className="bots-sizeline__n" />
                  </div>
                </Row>
                {d.shape === 'pair' && (
                  <Row title="Margin per leg" line="What each wallet's futures account holds for it. The losing leg's account decides how large both can be.">
                    <NumberField label="Margin per leg" value={d.marginUsd} onChange={(v) => v !== null && set({ marginUsd: v })} unit="USD" />
                  </Row>
                )}
                <Row title="Leverage" line={`Set on SoDEX before the first order: the maximum (${maxLev}x) locks the least margin. The buffer below sets the size, so a higher leverage does not mean a closer liquidation.`}>
                  <div className="bots-sizeline">
                    <Slider label="Leverage slider" value={Math.min(maxLev, d.leverage)} min={1} max={maxLev} step={1} onChange={(v) => set({ leverage: Math.round(v) })} minLabel="1x" maxLabel={`${maxLev}x`} />
                    <b className="hg-lev">{Math.min(maxLev, d.leverage)}x</b>
                  </div>
                </Row>
                {d.shape === 'pair' && (
                  <>
                    <Row title="Liquidation buffer" line={`When a leg's liquidation comes within this much of the price, both legs get smaller. At this size: a ${pct(n.trimMove)} move does it.`} error={problems.buffer}>
                      <Segmented label="Liquidation buffer" value={String(d.minLiqPct)} onChange={(v) => { const x = Number(v); set({ minLiqPct: x, growLiqPct: Math.max(d.growLiqPct, x * 2) }); }} options={[...BUFFERS.map((b) => ({ value: String(b), label: `${b}%` })), ...(BUFFERS.includes(d.minLiqPct) ? [] : [{ value: String(d.minLiqPct), label: `${d.minLiqPct}%` }])]} />
                    </Row>
                    <Row title="Grow back at" line="Both legs grow back towards the size only while every liquidation stays this far away.">
                      <NumberField label="Grow back at" value={d.growLiqPct} onChange={(v) => v !== null && set({ growLiqPct: v })} unit="%" />
                    </Row>
                  </>
                )}
                <Row title="Step" line="Each order per leg. Smaller steps keep the legs closer together while they open.">
                  <NumberField label="Step" value={d.sliceUsd} onChange={(v) => v !== null && set({ sliceUsd: v })} unit="USD" />
                </Row>
                <Row title="Max slippage" line="A taker goes no further than this from the mark.">
                  <NumberField label="Max slippage" value={d.maxSlipBps} onChange={(v) => v !== null && set({ maxSlipBps: v })} unit="bp" />
                </Row>
                <Row title="Stop if it loses" line="Both legs together, after every fee. Then it closes both." error={problems.loss}>
                  <NumberField label="Loss" value={d.maxLossUsd} optional onChange={(v) => set({ maxLossUsd: v })} unit="USD" />
                </Row>
                <Row title="Take profit" line="Optional: stops once the pair's net PnL reaches this.">
                  <NumberField label="Profit" value={d.takeProfitUsd} optional onChange={(v) => set({ takeProfitUsd: v !== null && v > 0 ? v : null })} unit="USD" />
                </Row>
                <Row title="Run for" line="Empty: until you stop it.">
                  <NumberField label="Hours" value={d.runHours} optional onChange={(v) => set({ runHours: v !== null && v > 0 ? v : null })} unit="h" />
                </Row>
                <Row title="On stop" line={d.onStop === 'close' ? 'Closes both legs, a step at a time, evenly.' : 'Leaves both positions open, unmanaged: a move can then liquidate one.'}>
                  <Segmented label="On stop" value={d.onStop} onChange={(v) => set({ onStop: v })} options={[{ value: 'close', label: 'Close both' }, { value: 'keep', label: 'Keep' }]} />
                </Row>
                {PRACTICE_BOTS && ctx.liveAllowed && (
                  <Row title="Practice" line={pairPractice ? 'Two-wallet hedges run as practice for now. A hedge against spot runs with real orders.' : 'Runs against the live market and sends nothing.'}>
                    <Switch checked={paper} disabled={pairPractice} onChange={(v) => set({ paper: v })} label="Practice" hideLabel />
                  </Row>
                )}
              </Panel>
            </Shell>
          )}

          {at === 3 && d.shape === 'pair' && (
            <Shell>
              <ShellHeader icon="robot" title="Second wallet" subtitle="It signs its own leg: you switch your wallet to it once, after this one starts." />
              <Panel className="hg-form">
                <Row title="Address" line="The wallet that holds the other side. It needs its own SoDEX account and trading key; the page walks it through." error={problems.partner}>
                  <TextInput aria-label="Second wallet address" placeholder="0x…" value={d.partner} onChange={(e) => set({ partner: e.target.value })} spellCheck={false} className="hg-addr" />
                </Row>
                {isAddress(d.partner) && (
                  <div className="hg-ref">
                    <span className="hg-ref__k">SoDEX referral of {short(d.partner.trim())}</span>
                    {partnerRef === 'none' && <StatusPill size="sm" tone="warning" dot>No code yet</StatusPill>}
                    {(partnerRef === 'bound' || partnerRef === 'pending') && <StatusPill size="sm" tone="positive" dot>On VALUEDESK</StatusPill>}
                    {partnerRef === 'other' && <StatusPill size="sm" dot>Has a code</StatusPill>}
                    {partnerRef === 'unknown' && <StatusPill size="sm">Checking…</StatusPill>}
                    <small>{partnerRef === 'none' ? 'When it connects, it is offered ValueDesk\'s code VALUEDESK with what it gives (a new wallet uses it before its first leg).' : partnerRef === 'other' ? 'It keeps its own code: we only offer ours to wallets without one.' : ''}</small>
                  </div>
                )}
                <ol className="hg-steps">
                  <li><b>This wallet starts leg 1.</b> It waits, holding nothing, until leg 2 is there.</li>
                  <li><b>Switch your wallet app to {isAddress(d.partner) ? short(d.partner.trim()) : 'the second wallet'}</b> and open Bots here: it shows the invitation.</li>
                  <li><b>That wallet signs leg 2</b> (its terms and trading key the first time). Both legs then open together.</li>
                </ol>
              </Panel>
            </Shell>
          )}

          {at === 3 && d.shape === 'spot' && (
            <Shell>
              <ShellHeader icon="robot" title="The coin" subtitle={`The short follows the ${sym?.baseCoin ?? 'coin'} in this wallet's futures balance.`} />
              <Panel className="hg-form">
                <Row title={`${sym?.baseCoin ?? 'Coin'} as futures margin`} line="Bought on spot, then moved from Spot to Futures. It can come before or after the start: the short grows as it arrives.">
                  <b className="hg-coin">{coin === null ? DASH : `${coin} ${sym?.baseCoin ?? ''}`}<small>{coinUsd !== null ? ` · ${fmtUsd(coinUsd, 0)}` : ''}</small></b>
                </Row>
                <div className="hg-actions">
                  <Button variant="secondary" icon="arrowRight" onClick={() => { window.location.assign(`/trade?engine=spot&symbol=${encodeURIComponent(`${sym?.baseCoin ?? 'BTC'}-USDC`)}`); }}>Buy {sym?.baseCoin ?? 'it'} on spot</Button>
                  <Button variant="secondary" icon="layers" onClick={() => requestTransfer({ from: 'spot', to: 'perps', coin: sym?.baseCoin })}>Move to Futures</Button>
                  <Button variant="quiet" onClick={() => requestDeposit()}>Deposit</Button>
                </div>
                <p className="hg-note"><Icon name="shield" size={13} />SoDEX counts BTC, ETH and XAUT at 90%, SOL and BNB at 80% (docs.sodex.com, Multi-Asset Margin). When it stops, it closes the short; the coin stays yours.</p>
              </Panel>
            </Shell>
          )}

          {at === 4 && (
            <Shell>
              <ShellHeader icon="check" title="Review" subtitle="Name it and start." />
              <Panel className="hg-form">
                <Row title="Name" line="Optional.">
                  <TextInput aria-label="Name" placeholder={`Hedge ${d.symbol.replace(/-USD$/, '')}`} value={d.label} maxLength={40} onChange={(e) => set({ label: e.target.value })} />
                </Row>
                {error && <p className="bots-err" role="alert">{error}</p>}
                {!paper && <p className="hg-note"><Icon name="warning" size={13} />Real orders. A move faster than it can shrink both legs can still liquidate one; the other is then closed. SoDEX cannot move margin between two wallets.</p>}
              </Panel>
            </Shell>
          )}
        </div>

        <aside className="bots-newside">
          <Shell className="bots-sidecard">
            <div className="bots-rc">
              <header className="bots-rc__head">
                <span className="hg-av"><CoinIcon coin={d.symbol} size={30} /></span>
                <span className="bots-rc__name"><b>{d.label.trim() || `Hedge ${d.symbol.replace(/-USD$/, '')}`}</b><small>{d.shape === 'pair' ? 'Two wallets' : 'Against spot'}</small></span>
                <StatusPill size="sm" tone={paper ? 'neutral' : 'positive'} dot>{paper ? 'Practice' : 'Live'}</StatusPill>
              </header>
              <section className="bots-rc__hero">
                <span className="bots-rc__k">Open interest held</span>
                <span className="bots-rc__v">{mark ? fmtUsd(n.oiUsd, 0) : DASH}</span>
                <span className="bots-rc__meta">
                  {n.legUsd < d.sizeUsd - 0.5 && d.shape === 'pair' && <StatusPill size="sm" tone="warning" dot>Margin allows {fmtUsd(n.legUsd, 0)} a leg</StatusPill>}
                  <span className="bots-rc__chip"><Icon name="bolt" size={12} />{fmtUsd(n.roundTripFeesUsd, 2)} to open and close</span>
                </span>
              </section>
              <section className="hg-legs" aria-label="Legs">
                <div className="hg-leg">
                  <StatusPill size="sm" tone={d.side === 'buy' && d.shape === 'pair' ? 'positive' : 'negative'}>{d.shape === 'pair' && d.side === 'buy' ? 'Long' : 'Short'}</StatusPill>
                  <span>This wallet{ctx.address ? ` · ${short(ctx.address)}` : ''}</span>
                  <b>{fmtUsd(n.legUsd, 0)}</b>
                </div>
                <div className="hg-leg">
                  {d.shape === 'pair'
                    ? <StatusPill size="sm" tone={d.side === 'buy' ? 'negative' : 'positive'}>{d.side === 'buy' ? 'Short' : 'Long'}</StatusPill>
                    : <StatusPill size="sm" tone="positive">Coin</StatusPill>}
                  <span>{d.shape === 'pair' ? (isAddress(d.partner) ? short(d.partner.trim()) : 'Second wallet') : `${sym?.baseCoin ?? 'Coin'} as futures margin`}</span>
                  <b>{d.shape === 'pair' ? fmtUsd(n.legUsd, 0) : coinUsd !== null ? fmtUsd(coinUsd, 0) : DASH}</b>
                </div>
              </section>
              <section className="bots-rc__tiles">
                <div className="bots-rc__tile"><span>Liquidation</span><b>{d.shape === 'spot' ? 'Far' : pct(n.liqDistance)}<small>{d.shape === 'spot' ? ' · coin is margin' : ' away'}</small></b></div>
                <div className="bots-rc__tile"><span>Shrinks at</span><b>{d.shape === 'spot' ? DASH : pct(n.trimMove)}<small>{d.shape === 'spot' ? '' : ' move'}</small></b></div>
                <div className="bots-rc__tile"><span>Leverage</span><b>{Math.min(maxLev, d.leverage)}x</b></div>
                <div className="bots-rc__tile"><span>Margin locked</span><b>{fmtUsd(n.initialUsd, 0)}<small> a leg</small></b></div>
                <div className="bots-rc__tile"><span>Loss limit</span><b>{d.maxLossUsd === null ? 'None' : fmtUsd(d.maxLossUsd, 0)}</b></div>
                <div className="bots-rc__tile"><span>Runs</span><b>{d.runHours === null ? 'Until stopped' : `${d.runHours} h`}</b></div>
              </section>
              <div className="bots-sidepanel__act">
                {at > 0 && <Button variant="secondary" size="md" icon="arrowLeft" onClick={() => setAt((x) => Math.max(0, x - 1))}>Back</Button>}
                {at < last
                  ? <Button variant="primary" size="md" className="bots-stepper__next" disabled={!!stepErr} title={stepErr ?? undefined} onClick={() => setAt((x) => Math.min(last, x + 1))}>Next<Icon name="arrowRight" size={14} /></Button>
                  : <Button variant="go" size="md" className="bots-stepper__next" icon="play" loading={busy} disabled={!!whyNot || busy} title={whyNot ?? undefined} onClick={() => void start()}>{busy && signing ? 'Waiting for your wallet…' : busy ? 'Starting…' : paper ? 'Start practice hedge' : d.shape === 'pair' ? 'Start leg 1' : 'Start hedge'}</Button>}
              </div>
              {at === last && whyNot && !busy && <p className="bots-fine" role="status">{whyNot}{ctx.address && ctx.setupWhy(paper) ? <> <button type="button" className="bots-link" onClick={() => ctx.setup(paper)}>Set up</button></> : null}</p>}
              {stepErr && at < last && <p className="bots-fine" role="status">{stepErr}</p>}
            </div>
          </Shell>
        </aside>
      </div>
    </>
  );
}

function Row({ title, line, error, children }: { title: string; line?: string; error?: string | null; children: React.ReactNode }) {
  return (
    <div className="hg-row">
      <div className="hg-row__t"><b>{title}</b>{line && <small>{line}</small>}</div>
      <div className="hg-row__c">{children}{error && <p className="bots-err" role="alert">{error}</p>}</div>
    </div>
  );
}

/** The markets, busiest first: one to pick. */
function HedgeMarkets({ value, onPick, markets, maxOf }: { value: string; onPick: (s: string) => void; markets: Array<{ symbol: string; price: number; volumeUsdH: number; spreadBps: number }> | null; maxOf: (s: string) => number | null }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...(markets ?? [])].filter((m) => !needle || m.symbol.toLowerCase().includes(needle)).sort((a, b) => b.volumeUsdH - a.volumeUsdH).slice(0, needle ? 40 : 12);
  }, [markets, q]);
  if (!markets) return <div className="bots-skels">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="bots-skel" />)}</div>;
  return (
    <Panel className="bots-mstep">
      <div className="bots-toolbar"><SearchField value={q} onChange={setQ} placeholder="Search a market (BTC, ETH, SOL…)" label="Search a market" className="bots-toolbar__search" /></div>
      <div className="bots-tablewrap">
        <table className="bots-table bots-mt" aria-label="Markets">
          <thead><tr><th /><th>Market</th><th className="right">Price</th><th className="right">Activity / h</th><th className="right">Spread</th><th className="right">Max leverage</th></tr></thead>
          <tbody>
            {list.map((m) => {
              const on = m.symbol === value;
              return (
                <tr key={m.symbol} role="radio" aria-checked={on} aria-label={m.symbol} tabIndex={0} className={`bots-row${on ? ' is-picked' : ''}`} onClick={() => onPick(m.symbol)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(m.symbol); } }}>
                  <td className="bots-mt__pick"><span className={`bots-radio${on ? ' is-on' : ''}`} aria-hidden="true" /></td>
                  <td><span className="bots-mt__name"><CoinIcon coin={m.symbol} size={22} /><span><b>{m.symbol.replace(/-USD$/, '')}</b><small>{m.symbol}</small></span></span></td>
                  <td className="right num dim">{fmtUsd(m.price)}</td>
                  <td className="right num">{fmtUsd(m.volumeUsdH, 0)}</td>
                  <td className="right num dim">{m.spreadBps.toFixed(1)} bp</td>
                  <td className="right num">{maxOf(m.symbol) ?? DASH}{maxOf(m.symbol) ? 'x' : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
