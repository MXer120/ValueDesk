/**
 * New hedge (owner 2026-11-14: "a hedging bot for OI on perps ... even at max leverage ... perps hedged with spot or
 * 2 sodex accounts"). Five places: the shape, the market, size and safety, the second wallet (or the coin), review.
 * The receipt on the right is bots/hedge.ts hedgeNumbers: the same arithmetic the executor runs (engine algo/hedge.ts).
 *
 * A pair is two bots, each signed by its own wallet. This page starts this wallet's leg and keeps an invitation in the
 * browser; when the second wallet is connected, the Bots page shows "Start leg 2" (HedgeInvites).
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { onWalletPrompting, shareMoreAccounts, walletAccountList, walletPrompting } from '../../wallet';
import { useWalletSnapshot } from '../account/useWallet';
import { Row as SettingRow } from './BotSettings';
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
import { Button, Icon, NumberField, Panel, SearchField, Segmented, Shell, ShellHeader, Skeleton, Slider, StatusPill, TextInput } from './kit/kit';
import './hedge.css';

const STEPS = [
  { title: 'Shape', hint: 'Two wallets or spot' },
  { title: 'Market', hint: 'Where it holds' },
  { title: 'Size & safety', hint: 'OI and buffers' },
  { title: 'Other leg', hint: 'Second wallet or coin' },
  { title: 'Review', hint: 'Name and start' },
] as const;

/** Safety: how close a liquidation may come before both legs shrink; they grow back at twice that. */
const SAFETY = [{ id: 'tight', label: 'Tight', min: 3 }, { id: 'balanced', label: 'Balanced', min: 5 }, { id: 'safe', label: 'Safe', min: 8 }] as const;
const safetyKey = (min: number): string => SAFETY.find((o) => o.min === min)?.id ?? 'own';
const RUN_FOR: readonly number[] = [24, 168];
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pct = (x: number | null, d = 1) => (x === null || !Number.isFinite(x) ? DASH : `${(x * 100).toFixed(d)}%`);

export function HedgeNewPage({ ctx, view }: { ctx: BotsCtx; view: Extract<BotsView, { page: 'new' }> }) {
  const [d, setD] = useState<HedgeDraft>(() => ({ ...HEDGE_DEFAULT, symbol: view.market ?? 'BTC-USD' }));
  const set = (p: Partial<HedgeDraft>) => setD((x) => ({ ...x, ...p }));
  const [at, setAt] = useState(0);
  const [adv, setAdv] = useState(false);
  const [paste, setPaste] = useState(false);
  // The second wallet from the same wallet app: the accounts it shares with the site, never disconnecting this one.
  const { provider } = useWalletSnapshot();
  const [accounts, setAccounts] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (provider && at === 3) void walletAccountList(provider).then(setAccounts); }, [provider, at]);
  const me = ctx.address?.toLowerCase() ?? null;
  const others = accounts.filter((a) => a !== me);
  const addAccount = async () => {
    if (!provider) return;
    setAdding(true);
    try {
      const list = await shareMoreAccounts(provider);
      setAccounts(list);
      const fresh = list.find((a) => a !== me);
      if (fresh && !isAddress(d.partner)) set({ partner: fresh });
      if (!fresh) setPaste(true);
    } finally {
      setAdding(false);
    }
  };
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
    const ok = await confirm({ title: `Start this hedge?`, body: `${body} ${paper ? 'Practice: no orders are sent.' : 'Real orders at the taker fee.'}`, confirmLabel: paper ? 'Start practice hedge' : 'Start hedge' });
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
              <ShellHeader icon="gear" title="Size & safety" subtitle={d.shape === 'pair' ? 'How big each leg is, and how far its liquidation stays.' : 'How big the short may grow.'} />
              <Panel className="bots-sizepanel">
                <div className="bots-settings">
                  <div className="bots-fgrid">
                    {d.shape === 'pair' && (
                      <SettingRow label="This wallet" hint={`The second wallet takes the ${d.side === 'buy' ? 'short' : 'long'}.`}>
                        <Segmented label="This wallet's side" value={d.side} onChange={(v) => set({ side: v })} options={[{ value: 'buy', label: 'Long' }, { value: 'sell', label: 'Short' }]} />
                      </SettingRow>
                    )}
                    <SettingRow label="Size per leg" wide={d.shape !== 'pair'} hint={d.shape === 'pair' ? `${fmtUsd(n.oiUsd, 0)} open interest across both legs.` : 'Never more than the coin you hold.'}>
                      <div className="bots-sizeline">
                        <Slider label="Size slider" value={Math.min(50_000, d.sizeUsd)} min={50} max={50_000} step={50} onChange={(v) => set({ sizeUsd: Math.round(v) })} minLabel="$50" maxLabel="$50k" />
                        <NumberField label="Size per leg" hideLabel value={d.sizeUsd} onChange={(v) => v !== null && set({ sizeUsd: v })} error={problems.size ?? null} unit="USD" className="bots-sizeline__n" />
                      </div>
                    </SettingRow>
                    {d.shape === 'pair' && (
                      <SettingRow label="Margin per leg" hint={n.legUsd < d.sizeUsd - 0.5 ? `Allows ${fmtUsd(n.legUsd, 0)} a leg at this safety.` : "In each wallet's futures account."}>
                        <NumberField label="Margin per leg" hideLabel value={d.marginUsd} onChange={(v) => v !== null && set({ marginUsd: v })} unit="USD" />
                      </SettingRow>
                    )}
                    {d.shape === 'pair' && (
                      <SettingRow label="Safety" wide hint={`Both legs shrink when a liquidation comes within ${d.minLiqPct}% of the price: at this size, a ${pct(n.trimMove)} move.`}>
                        <Segmented label="Safety" value={safetyKey(d.minLiqPct)} onChange={(v) => { const x = SAFETY.find((o) => o.id === v); if (x) set({ minLiqPct: x.min, growLiqPct: x.min * 2 }); }} options={[...SAFETY.map((o) => ({ value: o.id, label: `${o.label} · ${o.min}%` })), ...(safetyKey(d.minLiqPct) === 'own' ? [{ value: 'own', label: `Own · ${d.minLiqPct}%` }] : [])]} />
                      </SettingRow>
                    )}
                    <SettingRow label="Stop if it loses" hint="Both legs together, after every fee. Then it closes both.">
                      <NumberField label="Loss" hideLabel value={d.maxLossUsd} optional onChange={(v) => set({ maxLossUsd: v })} error={problems.loss ?? null} unit="USD" />
                    </SettingRow>
                    <SettingRow label="Run for" wide={d.shape !== 'pair'} hint="Stops by itself after this long.">
                      <Segmented label="Run for" value={d.runHours === null ? 'open' : RUN_FOR.includes(d.runHours) ? String(d.runHours) : 'x'} onChange={(v) => v !== 'x' && set({ runHours: v === 'open' ? null : Number(v) })} options={[{ value: 'open', label: 'Until stopped' }, { value: '24', label: '24h' }, { value: '168', label: '7d' }, ...(d.runHours === null || RUN_FOR.includes(d.runHours) ? [] : [{ value: 'x', label: `${d.runHours}h` }])]} />
                    </SettingRow>
                  </div>
                  <button type="button" className={`bots-adv${adv ? ' is-open' : ''}`} aria-expanded={adv} onClick={() => setAdv((x) => !x)}>
                    <Icon name="gear" size={14} />
                    <b>Advanced settings</b>
                    <span className="bots-adv__sp" />
                    <Icon name="down" size={14} />
                  </button>
                  {adv && (
                    <div className="bots-fgrid bots-adv__body">
                      <SettingRow label="Leverage" wide hint={`The maximum (${maxLev}x) locks the least margin. Safety sets the size, so more leverage does not bring the liquidation closer.`}>
                        <div className="bots-sizeline">
                          <Slider label="Leverage slider" value={Math.min(maxLev, d.leverage)} min={1} max={maxLev} step={1} onChange={(v) => set({ leverage: Math.round(v) })} minLabel="1x" maxLabel={`${maxLev}x`} />
                          <NumberField label="Leverage" hideLabel value={Math.min(maxLev, d.leverage)} onChange={(v) => v !== null && set({ leverage: Math.max(1, Math.min(maxLev, Math.round(v))) })} unit="x" className="bots-sizeline__n" />
                        </div>
                      </SettingRow>
                      {d.shape === 'pair' && (
                        <SettingRow label="Grow back at" hint="Legs grow back only while every liquidation is this far away.">
                          <NumberField label="Grow back at" hideLabel value={d.growLiqPct} onChange={(v) => v !== null && set({ growLiqPct: v })} error={problems.buffer ?? null} unit="%" />
                        </SettingRow>
                      )}
                      <SettingRow label="Step" hint="Each order per leg.">
                        <NumberField label="Step" hideLabel value={d.sliceUsd} onChange={(v) => v !== null && set({ sliceUsd: v })} unit="USD" />
                      </SettingRow>
                      <SettingRow label="Max slippage" hint="From the mark.">
                        <NumberField label="Max slippage" hideLabel value={d.maxSlipBps} onChange={(v) => v !== null && set({ maxSlipBps: v })} unit="bp" />
                      </SettingRow>
                      <SettingRow label="Take profit" hint="Optional: stops at this net PnL.">
                        <NumberField label="Profit" hideLabel value={d.takeProfitUsd} optional onChange={(v) => set({ takeProfitUsd: v !== null && v > 0 ? v : null })} unit="USD" />
                      </SettingRow>
                      <SettingRow label="On stop" hint={d.onStop === 'close' ? 'Closes both legs, evenly.' : 'Leaves both open, unmanaged.'}>
                        <Segmented label="On stop" value={d.onStop} onChange={(v) => set({ onStop: v })} options={[{ value: 'close', label: 'Close both' }, { value: 'keep', label: 'Keep' }]} />
                      </SettingRow>
                    </div>
                  )}
                </div>
              </Panel>
            </Shell>
          )}

          {at === 3 && d.shape === 'pair' && (
            <Shell>
              <ShellHeader icon="robot" title="Other leg" subtitle="One wallet each side. Pick the second from your wallet: this one stays connected." />
              <Panel className="bots-sizepanel hg-leg2">
                <div className="hg-wallets" role="radiogroup" aria-label="Second wallet">
                  <div className="hg-wcard is-me">
                    <StatusPill size="sm" tone={d.side === 'buy' ? 'positive' : 'negative'}>{d.side === 'buy' ? 'Long' : 'Short'}</StatusPill>
                    <span className="hg-wcard__t"><b>{ctx.address ? short(ctx.address) : 'Not connected'}</b><small>{ctx.address ? 'Connected · leg 1' : 'Connect your wallet: leg 1'}</small></span>
                  </div>
                  {others.map((a) => {
                    const on = d.partner.trim().toLowerCase() === a;
                    return (
                      <button key={a} type="button" role="radio" aria-checked={on} className={`hg-wcard${on ? ' is-on' : ''}`} onClick={() => set({ partner: a })}>
                        <span className={`bots-radio${on ? ' is-on' : ''}`} aria-hidden="true" />
                        <span className="hg-wcard__t"><b>{short(a)}</b><small>In your wallet · leg 2, {d.side === 'buy' ? 'short' : 'long'}</small></span>
                      </button>
                    );
                  })}
                  <button type="button" className="hg-wcard is-add" onClick={() => void addAccount()} disabled={!provider || adding}>
                    <Icon name="plus" size={14} />
                    <span className="hg-wcard__t"><b>{adding ? 'Waiting for your wallet…' : 'Add an account from your wallet'}</b><small>Shares another account with ValueDesk. Nothing is disconnected.</small></span>
                  </button>
                </div>
                <div className="hg-paste">
                  {!paste
                    ? <button type="button" className="bots-link" onClick={() => setPaste(true)}>Or paste an address</button>
                    : <TextInput aria-label="Second wallet address" placeholder="0x…" value={d.partner} onChange={(e) => set({ partner: e.target.value })} spellCheck={false} className="hg-addr" />}
                  {problems.partner && isAddress(d.partner) && <p className="bots-err" role="alert">{problems.partner}</p>}
                </div>
                {isAddress(d.partner) && partnerRef === 'none' && (
                  <p className="hg-note"><StatusPill size="sm" tone="warning" dot>No SoDEX code yet</StatusPill>When {short(d.partner.trim())} signs its leg, it is offered the code VALUEDESK first.</p>
                )}
                <p className="hg-note"><Icon name="wallet" size={13} />Leg 2 is signed by {isAddress(d.partner) ? short(d.partner.trim()) : 'that account'} itself: after leg 1 starts, pick it in your wallet and Bots shows Start leg 2. Both legs then open together.</p>
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
