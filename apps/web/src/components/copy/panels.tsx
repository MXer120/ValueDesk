/**
 * The Copy page's panels. Ids are permanent - they key the saved layout.
 *
 * Built from the design system the portfolio exports (Card, Group, Row, Stat)
 * and the order ticket's field classes (.oe-*), inside the `pf` scope the
 * dashboard root carries. Nothing here draws a style of its own that an
 * existing Valuetrade surface already has.
 *
 * HONESTY RULES this file keeps:
 *  - "Start copying" starts a real copy (or a paper one, labelled paper
 *    everywhere) only after the follower's own signatures in copy setup;
 *    nothing is pre-ticked, nothing starts on its own.
 *  - A number the venue did not report is an em-dash, never a zero; a live
 *    copy's PnL is the copier's own books (fills it saw, marks it read).
 *  - The fee shown is the fee charged; the backtest says what it cannot see.
 *  - Traders are shown by public, objective numbers, the same for everyone:
 *    nothing here recommends a trader to anyone.
 */
import { useEffect, useId, useState, type ReactNode } from 'react';
import { COPY_FEE_LADDER, SKIP_REASONS, feePercent, type ActivityEntry, type CopyView } from '@copy-engine';
import { MODE_LABEL } from '../../copy/CopySetupSheet';
import { commandCopy, copyActivity, copyRows, readiness, stopAllCopies, type CopyModeId, type CopyRow } from '../../copy/live';
import { notify, notifyError } from '../../toast';
import { useConfirm } from '../Modal';
import { DASH, fmt, fmtUsd, shortAddr, signClass } from '../../format';
import { winRateView } from '../../winRateView';
import { VENUE_LABEL, type TraderRow, type Venue, type VsPosition, type Window } from '../../vsApi';
import type { PanelDefinition } from '../../dashboard';
import { PanelTabs } from '../../dashboard/Panel';
import { Card, Group, Row, Stat } from '../portfolio/parts';
import { LoadFailed } from '../LoadFailed';
import { EquityChart } from './EquityChart';
import { CoinLabel } from '../CoinIcon';
import { coinOf, skipReasonLabel, type SimResult, type SimTrade } from './sim';
import {
  BACKTEST_WINDOWS, MIN_ORDER_USD, COPY_BUILDER_TENTHS_BPS, SIZING_MODES, TAKER_RATE, WINDOW_LABEL,
  fmtRate, fmtSignedPct, fmtSignedUsd, fmtSize, isAddress, workedExample, type SetupField, type SetupState,
} from './setup';
import { FILL_LIMIT, type CopyContext, type Load } from './useCopy';

/* ------------------------------------------------------------ helpers ----- */

const VENUES: ReadonlyArray<{ v: Venue; label: string }> = [
  { v: 'sodex', label: VENUE_LABEL.sodex },
  { v: 'hyperliquid', label: VENUE_LABEL.hyperliquid },
];

/**
 * The portfolio's segmented control (`.pf-seg` / `.pf-ctl`), typed for any
 * value. Same shape as the points page's local Seg: the classes are the design
 * system's, only the type is local.
 */
function Seg<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: ReadonlyArray<{ v: T; label: string; hint?: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="pf-seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="tab"
          aria-selected={o.v === value}
          title={o.hint}
          className={`pf-ctl ${o.v === value ? 'is-on' : ''}`}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A price at six significant figures: 84,298.7, 0.0001234, 80,714. The venue's tick is not in the contract. */
const fmtPx = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? DASH : fmt(Number(v.toPrecision(6)));

const pctOf = (frac: number | null | undefined, dp = 1): string =>
  frac === null || frac === undefined || !Number.isFinite(frac) ? DASH : `${(frac * 100).toFixed(dp)}%`;

function fmtAgo(ms: number | null | undefined): string {
  if (!ms) return DASH;
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129_600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

const fmtStamp = (ms: number): string =>
  new Date(ms).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

const fmtDay = (ms: number): string =>
  new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });

/** A trader is shown by short address only; a row's `label` is never rendered. */
const nameOf = (r: Pick<TraderRow, 'address'>): string => shortAddr(r.address);

/**
 * One sentence for a failed load: "<What> couldn't load." with Retry, never the
 * reason (that is in the console). "Not implemented yet" is a state, not an
 * error: `plural` names it in that sentence.
 */
function loadNote(l: Load<unknown>, venue: Venue, what: string, plural: string): ReactNode {
  if (l.code === 'not_available') {
    return <p className="pf-note">{VENUE_LABEL[venue]} {plural} are not available here yet.</p>;
  }
  return <LoadFailed what={what} onRetry={l.reload} />;
}

/* ============================================================ traders ===== */

function TradersPanel({ c }: { c: CopyContext }) {
  const q = c.query.trim();
  const pasted = isAddress(q);
  const rows = c.board.data?.rows ?? [];

  return (
    <Card title="Traders" action={<Seg value={c.venue} options={VENUES} onChange={c.setVenue} label="Venue" />}>
      <div className="scan-addr">
        <input
          value={c.query}
          onChange={(e) => c.setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && pasted) c.selectLeader(q); }}
          placeholder="0x… address, or search a name"
          aria-label="Trader address or name"
          spellCheck={false}
        />
        <button type="button" className="pf-btn" disabled={!pasted} onClick={() => c.selectLeader(q)}>
          Load
        </button>
      </div>

      <Group
        title={q && !pasted ? `Matching “${q}”` : `Top ${VENUE_LABEL[c.venue]} traders · 30D PnL`}
        action={c.board.loading ? <span className="pf-unit">Loading…</span> : undefined}
      >
        {c.board.error ? loadNote(c.board, c.venue, 'Rankings', 'rankings') : rows.length === 0 && !c.board.loading ? (
          <p className="pf-note">{q && !pasted ? 'No trader matches that.' : 'No ranked traders.'}</p>
        ) : (
          <div className="acct">
            <table className="acct-table copy-pick">
              <thead>
                <tr>
                  <th>Trader</th>
                  <th className="num">PnL</th>
                  <th className="num">ROI</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const on = r.address.toLowerCase() === c.leader;
                  const pnl = r.pnl['30d'] ?? null;
                  const roi = r.roi['30d'] ?? null;
                  return (
                    <tr
                      key={r.address}
                      className={on ? 'is-on' : undefined}
                      tabIndex={0}
                      aria-selected={on}
                      title={r.address}
                      onClick={() => c.selectLeader(r.address)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); c.selectLeader(r.address); } }}
                    >
                      <td><span className="copy-addr">{nameOf(r)}</span></td>
                      <td className={`num ${signClass(pnl)}`}>{pnl === null ? DASH : fmtSignedUsd(pnl, 0)}</td>
                      <td className={`num ${signClass(roi)}`}>{fmtSignedPct(roi, 1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Group>
      {c.board.data?.source && <p className="pf-note">Source: {c.board.data.source}.</p>}
    </Card>
  );
}

/* ============================================================= trader ===== */

function TraderPanel({ c }: { c: CopyContext }) {
  if (!c.leader) {
    return (
      <Card title="Trader">
        <p className="pf-note">Pick a trader from the list, paste an address, or open one from Explore or the Leaderboard.</p>
      </Card>
    );
  }
  const p = c.profile.data;
  const s = p?.summary;
  const w = c.window;
  const title = nameOf({ address: c.leader });

  return (
    <Card
      title={title}
      action={
        <button type="button" className="pf-ctl" onClick={() => c.onScan(c.leader!, c.venue)} title="Open this trader in Scan">
          Scan
        </button>
      }
    >
      {c.profile.loading ? <p className="pf-note">Loading…</p>
        : c.profile.error ? loadNote(c.profile, c.venue, 'Trader profile', 'trader profiles')
        : !p || !s ? <p className="pf-note">No {VENUE_LABEL[c.venue]} activity for this address.</p>
        : (
          <>
            <Group title={`${VENUE_LABEL[c.venue]} · ${WINDOW_LABEL[w]}`}>
              <Row label="Address" value={<span className="copy-addr" title={s.address}>{shortAddr(s.address)}</span>} privacy="history" />
              <Row label="Account value" value={s.accountValue === null ? DASH : fmtUsd(s.accountValue, 2)} cls={s.accountValue === null ? 'pf-dim' : undefined} />
              <Row label="PnL" privacy="pnl" value={fmtSignedUsd(s.pnl[w] ?? null)} cls={s.pnl[w] == null ? 'pf-dim' : signClass(s.pnl[w])} />
              <Row label="ROI" privacy="pnl" value={fmtSignedPct(s.roi[w] ?? null)} cls={s.roi[w] == null ? 'pf-dim' : signClass(s.roi[w])} />
              <Row label="Volume" value={s.volume[w] == null ? DASH : fmtUsd(s.volume[w]!, 0)} cls={s.volume[w] == null ? 'pf-dim' : undefined} />
              <Row
                label="Win rate"
                privacy="pnl"
                value={s.winRate != null && winRateView(s).approx ? `≈${pctOf(s.winRate)}` : pctOf(s.winRate)}
                cls={s.winRate == null ? 'pf-dim' : undefined}
                hint={winRateView(s, { context: 'sample', fmtDate: fmtDay }).title}
              />
              <Row label="Trades" privacy="counts" value={s.trades == null ? DASH : fmt(s.trades, 0)} cls={s.trades == null ? 'pf-dim' : undefined} />
              <Row label="Max drawdown" privacy="pnl" value={pctOf(s.maxDrawdown)} cls={s.maxDrawdown == null ? 'pf-dim' : undefined} />
              <Row label="Last trade" privacy="history" value={fmtAgo(s.lastActive)} cls={s.lastActive ? undefined : 'pf-dim'} />
            </Group>
            {s.tags && s.tags.length > 0 && (
              <div className="copy-tags">
                {s.tags.map((t) => <span key={t} className="pf-chip">{t}</span>)}
              </div>
            )}
            <p className="pf-note">Source: {p.source}. Updated {fmtAgo(p.updatedAt)}.</p>
          </>
        )}
    </Card>
  );
}

/* ========================================================== positions ===== */

function PositionsPanel({ c }: { c: CopyContext }) {
  const positions = c.profile.data?.positions ?? [];
  const total = positions.reduce((a, p) => a + Math.abs(p.notional), 0);
  return (
    <Card
      title="Leader positions"
      action={positions.length > 0 ? <span className="pf-unit">{positions.length} open · {fmtUsd(total, 0)}</span> : undefined}
    >
      {!c.leader ? <p className="pf-note">Pick a trader to see what they hold right now.</p>
        : c.profile.loading ? <p className="pf-note">Loading…</p>
        : c.profile.error ? loadNote(c.profile, c.venue, 'Positions', 'positions')
        : positions.length === 0 ? <p className="pf-note">No open positions.</p>
        : (
          <div className="acct pf-tablewrap">
            <table className="acct-table">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Side</th>
                  <th className="num">Size</th>
                  <th className="num">Notional</th>
                  <th className="num">Entry</th>
                  <th className="num">Mark</th>
                  <th className="num">Unreal. PnL</th>
                  <th className="num">Lev.</th>
                  <th className="num">Liq.</th>
                </tr>
              </thead>
              <tbody>
                {[...positions].sort((a, b) => Math.abs(b.notional) - Math.abs(a.notional)).map((p) => (
                  <PositionRow key={`${p.symbol}-${p.side}`} p={p} />
                ))}
              </tbody>
            </table>
          </div>
        )}
    </Card>
  );
}

function PositionRow({ p }: { p: VsPosition }) {
  return (
    <tr>
      <td>{p.symbol}{p.marginMode ? <span className="acct-tag"> {p.marginMode}</span> : null}</td>
      <td className={p.side === 'long' ? 'pos' : 'neg'}>{p.side === 'long' ? 'Long' : 'Short'}</td>
      <td className="num">{fmtSize(p.size)}</td>
      <td className="num">{fmtUsd(Math.abs(p.notional), 2)}</td>
      <td className="num">{fmtPx(p.entryPx)}</td>
      <td className="num">{fmtPx(p.markPx)}</td>
      <td className={`num ${signClass(p.uPnl)}`}>{p.uPnl === null ? DASH : fmtSignedUsd(p.uPnl)}</td>
      <td className="num">{p.leverage === null ? DASH : `${fmt(p.leverage, 0)}x`}</td>
      <td className="num">{fmtPx(p.liqPx)}</td>
    </tr>
  );
}

/* ============================================================= setup ====== */

/** One ticket field: the label inside the box, the value right-aligned, a unit after it. */
function Field({ id, label, value, onChange, suffix, placeholder, error, mode = 'decimal' }: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  placeholder?: string;
  error?: string;
  mode?: 'decimal' | 'text';
}) {
  return (
    <div className={`oe-inputrow${error ? ' copy-invalid' : ''}`} title={error}>
      <label className="oe-inlabel" htmlFor={id}>{label}</label>
      <input
        id={id}
        className="oe-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode={mode === 'decimal' ? 'decimal' : undefined}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={error ? true : undefined}
      />
      {suffix && <span className="oe-suffix">{suffix}</span>}
    </div>
  );
}

function SetupPanel({ c }: { c: CopyContext }) {
  const uid = useId().replace(/:/g, '');
  const { setup, parsed } = c;
  const errs = parsed.errors;
  const set = (k: SetupField) => (v: string) => c.patchSetup({ [k]: v } as Partial<SetupState>);
  const taker = TAKER_RATE[c.venue];
  const builder = COPY_BUILDER_TENTHS_BPS / 100_000;
  const s = c.profile.data?.summary ?? null;
  const example = workedExample(parsed, c.profile.data ?? null, (sym) => coinOf(c.venue, sym));
  const errorList = Object.values(errs);
  const canStart = !!c.leader && errorList.length === 0 && !!c.copySettings;
  const [starting, setStarting] = useState(false);
  const ready = readiness(c.live, c.runOn);
  const missing = [
    !ready.terms && 'accept the terms',
    !ready.connected && (c.runOn === 'self' ? 'connect your copier' : 'sign in'),
    !setup.paper && !ready.fee && 'approve the copy fee',
    !setup.paper && !ready.key && 'approve a copy key',
  ].filter(Boolean).join(', ');

  return (
    <Card
      title="Copy setup"
      action={<button type="button" className="pf-ctl" onClick={c.resetSetup} title="Back to the default setup">Reset</button>}
    >
      <div className="oe copy-ticket">
        <dl className="oe-facts">
          <div className="oe-facts__row">
            <dt>Copying</dt>
            <dd className={c.leader ? '' : 'is-dim'}>
              {c.leader ? `${nameOf({ address: c.leader })} · ${VENUE_LABEL[c.venue]}` : 'No trader picked'}
            </dd>
          </div>
          <div className="oe-facts__row">
            <dt>Leader equity</dt>
            <dd className={s?.accountValue == null ? 'is-dim' : ''}>{s?.accountValue == null ? DASH : fmtUsd(s.accountValue, 0)}</dd>
          </div>
        </dl>

        <Field id={`${uid}-alloc`} label="Allocation" value={setup.allocation} onChange={set('allocation')} suffix="USDC" placeholder="1,000" error={errs.allocation} />

        <Group title="Sizing">
          <Seg value={setup.mode} options={SIZING_MODES} onChange={(m) => c.patchSetup({ mode: m })} label="Sizing mode" />
          {setup.mode === 'fixedRatio' && (
            <Field id={`${uid}-ratio`} label="Size" value={setup.ratioPct} onChange={set('ratioPct')} suffix="% of leader" error={errs.ratioPct} />
          )}
          {setup.mode === 'fixedNotional' && (
            <Field id={`${uid}-notional`} label="Per trade" value={setup.notional} onChange={set('notional')} suffix="USDC" error={errs.notional} />
          )}
          <p className="oe-hint copy-example">
            {example ? example.text
              : c.leader && c.profile.data ? 'The leader is flat right now, so there is no position to size against.'
              : SIZING_MODES.find((m) => m.v === setup.mode)?.hint}
            {example?.caveat && <span className="copy-caveat"> {example.caveat}</span>}
          </p>
        </Group>

        <Group title="Risk">
          <div className="oe-exitgrid">
            <Field id={`${uid}-lev`} label="Max leverage" value={setup.maxLeverage} onChange={set('maxLeverage')} suffix="x" error={errs.maxLeverage} />
            <Field id={`${uid}-maxpos`} label="Max position" value={setup.maxPosition} onChange={set('maxPosition')} suffix="USDC" error={errs.maxPosition} />
            <Field id={`${uid}-sl`} label="Stop loss" value={setup.stopLoss} onChange={set('stopLoss')} suffix="%" placeholder="off" error={errs.stopLoss} />
            <Field id={`${uid}-tp`} label="Take profit" value={setup.takeProfit} onChange={set('takeProfit')} suffix="%" placeholder="off" error={errs.takeProfit} />
            <Field id={`${uid}-dd`} label="Drawdown stop" value={setup.drawdown} onChange={set('drawdown')} suffix="%" placeholder="off" error={errs.drawdown} />
            <Field id={`${uid}-slip`} label="Slippage cap" value={setup.slippageBps} onChange={set('slippageBps')} suffix="bps" error={errs.slippageBps} />
          </div>
          <p className="oe-hint copy-hint">
            Stop loss and take profit are a percent of the copied position's margin at your max leverage.
            The drawdown stop closes everything and stops the copy when your equity falls that far from its peak.
          </p>
          <div className="copy-coins">
            <Field id={`${uid}-allow`} label="Only copy" value={setup.allow} onChange={set('allow')} mode="text" placeholder="all coins" error={errs.allow} />
            <Field id={`${uid}-deny`} label="Never copy" value={setup.deny} onChange={set('deny')} mode="text" placeholder="none" error={errs.deny} />
          </div>
          <div className="oe-opts copy-opts">
            <label className="oe-check">
              <input type="checkbox" checked={setup.copyExisting} onChange={(e) => c.patchSetup({ copyExisting: e.target.checked })} />
              Copy positions the leader already holds
            </label>
            <label className="oe-check" title="Isolated: each copied position has its own margin, so one cannot drain the others.">
              <input type="checkbox" checked={setup.marginMode === 'isolated'} onChange={(e) => c.patchSetup({ marginMode: e.target.checked ? 'isolated' : 'cross' })} />
              Isolated margin per copied position
            </label>
            {c.runOn === 'browser' && (
              <label className="oe-check" title="Every copied order waits for your yes in this tab (60 seconds).">
                <input type="checkbox" checked={setup.confirmEach} onChange={(e) => c.patchSetup({ confirmEach: e.target.checked })} />
                Ask me before each copied trade
              </label>
            )}
            <label className="oe-check" title="Runs against the leader's live trades and keeps books, but sends nothing to SoDEX.">
              <input type="checkbox" checked={setup.paper} onChange={(e) => c.patchSetup({ paper: e.target.checked })} />
              Paper copy (nothing is sent)
            </label>
          </div>
        </Group>

        <Group title="Runs on">
          <div className="copy-runon">
            <Seg value={c.runOn} options={RUN_ON} onChange={(m) => c.setRunOn(m)} label="Where the copier runs" />
            <span className={`copy-ready${ready.ready ? ' is-ok' : ''}`}>
              {!c.wallet ? 'Connect a wallet to set up copying.' : ready.ready ? `${MODE_LABEL[c.runOn]} is set up.` : `${MODE_LABEL[c.runOn]}: ${missing}.`}{' '}
              <button type="button" className="fx-link" onClick={() => c.openSetup(false)}>{ready.ready ? 'Manage' : 'Set up'}</button>
            </span>
            {c.runOn === 'browser' && <span className="copy-ready">Copies only while a ValueDesk tab is open in this browser.</span>}
          </div>
        </Group>

        <Group title="Fees">
          <dl className="oe-out copy-fees">
            <div className="oe-out__row">
              <dt className="oe-out__k" title="SoDEX's published base-tier perps taker fee. Copied orders are IOC, so they take.">
                Taker fee <span className="oe-tag">SoDEX, base tier</span>
              </dt>
              <dd className="oe-out__v">{fmtRate(taker)}</dd>
            </div>
            <div className="oe-out__row">
              <dt className="oe-out__k" title={`The ValueDesk copy fee on every copied order (opens, adds, reductions, closes), by your 14-day volume: ${COPY_FEE_LADDER.map((s) => `${feePercent(s.fee)}${s.fromUsd ? ` from $${s.fromUsd.toLocaleString('en-US')}` : ''}`).join(', ')}. SoDEX charges it.`}>
                Copy fee <span className="oe-tag">every copied order</span>
              </dt>
              <dd className="oe-out__v">{setup.paper ? fmtRate(0) : `${fmtRate(builder)} max`}</dd>
            </div>
            <div className="oe-out__row">
              <dt className="oe-out__k" title="Taker and copy fee in and out. Slippage is extra.">
                Round trip <span className="oe-tag">est.</span>
              </dt>
              <dd className="oe-out__v">{fmtRate(taker * 2 + (setup.paper ? 0 : builder * 2))}</dd>
            </div>
            <div className="oe-out__row">
              <dt className="oe-out__k" title="The ceiling you approve on SoDEX for ValueDesk's builder fee. You can revoke it any time.">
                Approval cap
              </dt>
              <dd className="oe-out__v">{fmtRate(builder)}</dd>
            </div>
          </dl>
        </Group>

        {(errorList.length > 0 || c.copyErrors.length > 0) && <p className="oe-note copy-errors">{(errorList.length ? errorList : c.copyErrors).join(' ')}</p>}

        <button
          type="button"
          className="pf-btn pf-btn--primary pf-btn--wide"
          disabled={!canStart || starting}
          title={!c.leader ? 'Pick a trader first' : errorList.length ? 'Fix the setup first' : undefined}
          onClick={() => {
            setStarting(true);
            c.startCopy()
              .then((started) => {
                if (started) notify('ok', setup.paper ? 'Paper copy started.' : 'Copying started.');
              })
              .catch((e) => notifyError('Start copying', e))
              .finally(() => setStarting(false));
          }}
        >
          {starting ? 'Starting…' : setup.paper ? 'Start paper copy' : 'Start copying'}
        </button>
        <p className="pf-note">
          You choose the trader and every rule. Copies trade in your own SoDEX account; ValueDesk never holds your funds.
          Not investment advice: past results do not predict future ones. <a className="fx-link" href="/copy-terms">Copy terms and risks</a>.
        </p>
      </div>
    </Card>
  );
}

const RUN_ON: ReadonlyArray<{ v: CopyModeId; label: string; hint: string }> = [
  { v: 'browser', label: 'This browser', hint: 'Copies while this tab is open. The key stays in this browser.' },
  { v: 'hosted', label: 'ValueDesk', hint: 'Copies around the clock from ValueDesk’s executor in Tokyo.' },
  { v: 'self', label: 'Self-hosted', hint: 'Copies from a copier you run yourself.' },
];

/* ========================================================== backtest ====== */

function BacktestPanel({ c }: { c: CopyContext }) {
  const r = c.sim.result;
  const setWindow = (w: Window) => c.setWindow(w);
  const action = <Seg value={c.window} options={BACKTEST_WINDOWS} onChange={setWindow} label="Backtest window" />;

  const empty = (text: ReactNode) => (
    <Card title="Backtest" action={action}>
      <div className="pf-chart pf-chart--empty copy-chart">{typeof text === 'string' ? <p>{text}</p> : text}</div>
    </Card>
  );

  if (!c.leader) return empty('Pick a trader to replay their fills under your setup.');
  if (c.fills.loading) return empty('Loading fills…');
  if (c.fills.error) {
    return empty(c.fills.code === 'not_available'
      ? `${VENUE_LABEL[c.venue]} fills are not available here yet, so there is nothing to replay.`
      : <LoadFailed what="Fills" onRetry={c.fills.reload} />);
  }
  if (c.fills.data && c.fills.data.length === 0) return empty(`No fills in the last ${WINDOW_LABEL[c.window]}.`);
  if (Object.keys(c.parsed.errors).length) return empty('Fix the setup to run the backtest.');
  if (c.sim.error) return empty(<LoadFailed what="Backtest" onRetry={c.fills.reload} />);
  if (!r) return empty(c.sim.busy || c.profile.loading ? `Replaying ${fmt(c.fills.data?.length ?? 0, 0)} fills…` : 'Waiting for data…');

  if (r.copiedFills + r.skippedFills === 0) return empty(`No fills in the last ${WINDOW_LABEL[c.window]}.`);

  return <BacktestResult c={c} r={r} action={action} />;
}

function BacktestResult({ c, r, action }: { c: CopyContext; r: SimResult; action: ReactNode }) {
  const skipped = Object.entries(r.skippedByReason).sort((a, b) => b[1] - a[1]);
  const inWindow = r.copiedFills + r.skippedFills;
  const rec = c.sim.reconstruction;
  const notes: string[] = [...r.notes];
  if (c.sim.truncated) {
    notes.unshift(`Only the latest ${fmt(FILL_LIMIT, 0)} fills were replayed, back to ${fmtDay(r.from)}.`);
  }
  if (rec && rec.markets.length) {
    notes.push(`Leader positions before each fill were worked back from their current positions on ${rec.markets.length} market${rec.markets.length === 1 ? '' : 's'}.`);
  }
  if (rec && rec.rejected.length) {
    notes.push(`${rec.rejected.join(', ')}: current positions did not match the fill history, so those markets were rebuilt from fills alone.`);
  }

  return (
    <Card title="Backtest" action={action}>
      <div className="pf-readout copy-readout">
        <span className="pf-readout__label">Your copy · {WINDOW_LABEL[c.window]}{c.sim.busy ? ' · updating…' : ''}</span>
        <span className={`pf-readout__value ${signClass(r.roi)}`}>{fmtSignedPct(r.roi)}</span>
        <span className="pf-readout__sub">
          {fmtSignedUsd(r.pnl)} on {fmtUsd(r.startEquity, 0)} · leader {fmtSignedPct(r.leaderRoi)} on the same fills ·{' '}
          {fmtDay(r.from)} to {fmtDay(r.to)}
        </span>
      </div>

      <div className="copy-legend" aria-hidden="true">
        <span><i className="copy-swatch copy-swatch--you" />Your copy</span>
        <span><i className="copy-swatch copy-swatch--leader" />Leader, scaled to your allocation</span>
      </div>
      <EquityChart you={r.equityCurve} leader={r.leaderCurve} base={r.startEquity} />

      <div className="pf-statstrip copy-strip">
        <Stat label="Max drawdown" value={pctOf(r.maxDrawdown)} cls={r.maxDrawdown > 0 ? 'neg' : undefined}>
          <span className="pf-stat__sub">leader {pctOf(r.leaderMaxDrawdown)}</span>
        </Stat>
        <Stat label="Copied" value={`${fmt(r.copiedFills, 0)} of ${fmt(inWindow, 0)}`}>
          <span className="pf-stat__sub">{fmt(r.skippedFills, 0)} skipped{r.clampedFills ? ` · ${fmt(r.clampedFills, 0)} capped` : ''}</span>
        </Stat>
        <Stat label="Fees" value={fmtUsd(r.feesUsd, 2)}>
          <span className="pf-stat__sub">builder {fmtUsd(r.builderFeesUsd, 2)} planned</span>
        </Stat>
      </div>

      <div className="pf-duo copy-duo">
        <div>
          <Group title="Skipped, by reason">
            {skipped.length === 0 ? <p className="pf-note">Every fill in the window was copied.</p>
              : skipped.map(([reason, n]) => (
                <Row key={reason} label={<span title={reason}>{skipReasonLabel(reason)}</span>} value={fmt(n, 0)} privacy="counts" />
              ))}
          </Group>
          <Group title="Risk events">
            <Row label="Stop losses" value={fmt(r.riskEvents.stopLoss, 0)} privacy="counts" cls={r.riskEvents.stopLoss ? undefined : 'pf-dim'} />
            <Row label="Take profits" value={fmt(r.riskEvents.takeProfit, 0)} privacy="counts" cls={r.riskEvents.takeProfit ? undefined : 'pf-dim'} />
            <Row
              label="Copy stopped"
              value={r.haltReason === 'liquidation' ? `liquidated ${fmtStamp(r.stoppedAt!)}`
                : r.haltReason === 'drawdownStop' ? `drawdown stop ${fmtStamp(r.stoppedAt!)}` : 'no'}
              cls={r.haltReason ? 'neg' : 'pf-dim'}
              privacy="history"
            />
          </Group>
        </div>
        <Group title="Costs and volume">
          <Row label="Taker fees" value={fmtUsd(r.feesUsd - r.builderFeesUsd, 2)} privacy="fees" />
          <Row label="Builder fee (planned)" value={fmtUsd(r.builderFeesUsd, 2)} privacy="fees" />
          <Row label="Slippage (full cap)" value={fmtUsd(r.slippageUsd, 2)} privacy="fees" />
          <Row label="Traded volume" value={fmtUsd(r.volumeUsd, 0)} />
          <Row label="Realised PnL" privacy="pnl" value={fmtSignedUsd(r.realizedPnl)} cls={signClass(r.realizedPnl)} />
          <Row
            label="Still open at the end"
            privacy="pnl"
            value={r.openPositions.length ? `${r.openPositions.length} · ${fmtSignedUsd(r.unrealizedPnl)}` : 'none'}
            cls={r.openPositions.length ? signClass(r.unrealizedPnl) : 'pf-dim'}
            hint="Copied positions the leader had not closed by the end of the window, marked at the last fill price."
          />
        </Group>
      </div>

      {notes.map((n) => <p key={n} className="pf-note">{n}</p>)}
      <p className="pf-note">
        A replay of the leader's past fills: every copy fills at the leader's price plus your full slippage cap.
        Funding, detection latency and order-book depth are not modelled. Past results say nothing certain about the future.
      </p>
    </Card>
  );
}

/* ============================================================ copies ====== */

function CopiesPanel({ c }: { c: CopyContext }) {
  const trades = c.sim.result?.fills ?? [];
  const rows = copyRows(c.live);
  const running = rows.filter((r) => r.view.subscription.status !== 'stopped');
  const [picked, setPicked] = useState<string | null>(null);
  const [tab, setTab] = useState<string>('mine');
  const sel = rows.find((r) => r.view.subscription.id === picked) ?? null;
  return (
    <Card className="pf-card--band">
      <div className="dash pf-band">
        <PanelTabs
          active={tab}
          onChange={setTab}
          tabs={[
            {
              key: 'mine',
              label: `My copies (${running.length})`,
              content: <MyCopies c={c} rows={rows} onActivity={(id) => { setPicked(id); setTab('activity'); }} />,
            },
            {
              key: 'activity',
              label: sel ? `Activity · ${shortAddr(sel.view.subscription.settings.leader.address)}` : 'Activity',
              content: <CopyActivity row={sel} rows={rows} onPick={setPicked} />,
            },
            {
              key: 'trades',
              label: `Backtest trades${trades.length ? ` (${fmt(trades.length, 0)})` : ''}`,
              content: <TradeLog trades={trades} />,
            },
          ]}
        />
      </div>
    </Card>
  );
}

const STATUS_LABEL: Record<string, string> = { active: 'Copying', paused: 'Paused', stopped: 'Stopped', halted: 'Halted', blocked: 'Blocked' };

function sizingOf(v: CopyView): string {
  const s = v.subscription.settings;
  if (s.sizingMode === 'proportional') return 'Proportional';
  if (s.sizingMode === 'fixedRatio') return `${fmt(s.ratio * 100, 2)}% of leader`;
  return `${fmtUsd(s.fixedNotionalUsd, 0)} / trade`;
}

function MyCopies({ c, rows, onActivity }: { c: CopyContext; rows: CopyRow[]; onActivity: (id: string) => void }) {
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const live = rows.filter((r) => r.view.subscription.status !== 'stopped');

  const act = async (r: CopyRow, cmd: 'pause' | 'resume' | 'stop' | 'stop-close') => {
    if (cmd === 'stop' || cmd === 'stop-close') {
      const ok = await confirm({
        title: cmd === 'stop-close' ? 'Stop and close' : 'Stop copying',
        danger: true,
        confirmLabel: cmd === 'stop-close' ? 'Stop and close positions' : 'Stop copying',
        cancelLabel: 'Keep copying',
        body: (
          <p>
            {cmd === 'stop-close'
              ? 'The copy stops for good and its open positions are closed at the market (reduce-only, within a 1% slippage cap).'
              : 'The copy stops for good. Its open positions stay in your SoDEX account; close them yourself when you want.'}
          </p>
        ),
      });
      if (!ok) return;
    }
    setBusy(r.view.subscription.id);
    try {
      await commandCopy(r.mode, r.view.subscription.id, cmd);
    } catch (e) {
      notifyError('Copy', e);
    } finally {
      setBusy(null);
    }
  };

  const killAll = async () => {
    const close = { current: false };
    const ok = await confirm({
      title: 'Stop all copies',
      danger: true,
      confirmLabel: 'Stop all',
      cancelLabel: 'Keep copying',
      body: (
        <div className="stack">
          <p>Every copy in every mode stops now. Executors need one signature each.</p>
          <label className="row small">
            <input type="checkbox" onChange={(e) => { close.current = e.target.checked; }} /> Also close every copied position at the market
          </label>
          <p className="muted small">The hard stop is revoking the copy keys in copy setup: then nothing can trade with them at all.</p>
        </div>
      ),
    });
    if (!ok) return;
    setBusy('all');
    try {
      const failed = await stopAllCopies(close.current);
      if (failed.length) notify('warn', `Not everything stopped: ${failed.join(' ')}`);
      else notify('ok', 'Every copy is stopped.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="acct">
      {dialog}
      {c.live.browser.confirms.length > 0 && <p className="acct-empty">A copied trade is waiting for your answer (see the prompt at the bottom of the page).</p>}
      <table className="acct-table">
        <thead>
          <tr>
            <th>Trader</th>
            <th>Runs on</th>
            <th className="num">Allocation</th>
            <th>Sizing</th>
            <th className="num">Equity</th>
            <th className="num">PnL</th>
            <th className="num">Open</th>
            <th className="num">Since</th>
            <th>Status</th>
            <th className="num">
              {live.length > 0 && (
                <button type="button" className="pf-ctl" disabled={busy === 'all'} onClick={() => void killAll()} title="Stop every copy in every mode">
                  Stop all
                </button>
              )}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const v = r.view;
            const s = v.subscription;
            const lead = s.settings.leader;
            return (
              <tr key={`${r.mode}:${s.id}`}>
                <td>
                  <button type="button" className="acct-link" onClick={() => c.onScan(lead.address, lead.venue)} title="Open this trader">
                    {shortAddr(lead.address)}
                  </button>{' '}
                  <span className="muted">{VENUE_LABEL[lead.venue]}</span>
                </td>
                <td className="copy-mode">{MODE_LABEL[r.mode]}{s.settings.paper ? ' · paper' : ''}</td>
                <td className="num">{fmtUsd(s.settings.allocationUsd, 0)}</td>
                <td>{sizingOf(v)} · {s.settings.maxLeverage}x</td>
                <td className="num">{fmtUsd(v.equity, 2)}</td>
                <td className={`num ${signClass(v.pnl)}`}>{fmtSignedUsd(v.pnl)} <span className="muted">{fmtSignedPct(v.pnlPct)}</span></td>
                <td className="num">{v.positions.length ? `${v.positions.length} · ${fmtUsd(v.grossNotional, 0)}` : DASH}</td>
                <td className="num copy-time">{fmtDay(s.createdAt)}</td>
                <td>
                  <span className={`copy-status copy-status--${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
                  {s.statusReason && s.status !== 'active' && <span className="copy-reason">{s.statusReason}</span>}
                </td>
                <td className="num">
                  <span className="copy-acts">
                    <button type="button" className="pf-ctl" onClick={() => onActivity(s.id)}>Activity</button>
                    {s.status === 'active' && <button type="button" className="pf-ctl" disabled={busy === s.id} onClick={() => void act(r, 'pause')}>Pause</button>}
                    {(s.status === 'paused' || s.status === 'halted' || s.status === 'blocked') && (
                      <button type="button" className="pf-ctl" disabled={busy === s.id} onClick={() => void act(r, 'resume')}>Resume</button>
                    )}
                    {s.status !== 'stopped' && <button type="button" className="pf-ctl" disabled={busy === s.id} onClick={() => void act(r, 'stop')}>Stop</button>}
                    {s.status !== 'stopped' && v.positions.length > 0 && (
                      <button type="button" className="pf-ctl" disabled={busy === s.id} onClick={() => void act(r, 'stop-close')}>Close</button>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && (
        <p className="acct-empty">
          {c.wallet
            ? 'No copies yet. Pick a trader, set your rules, and press Start copying.'
            : 'Connect a wallet to see your copies.'}
          {c.live.hosted.info && !c.live.hosted.signedIn && c.wallet ? ' Copies on the ValueDesk executor show once you sign in to it (copy setup).' : ''}
        </p>
      )}
    </div>
  );
}

const LEG_LABEL: Record<string, string> = {
  open: 'Open', increase: 'Add', decrease: 'Reduce', close: 'Close', 'flip-close': 'Flip (close)', 'flip-open': 'Flip (open)',
  reconcile: 'Catch up', 'stop-loss': 'Stop loss', 'take-profit': 'Take profit', 'drawdown-stop': 'Drawdown stop', 'stop-all': 'Close (stop)',
};

function entryText(e: ActivityEntry): string {
  if (e.kind === 'skip') return (SKIP_REASONS as Record<string, string>)[e.reason] ?? skipReasonLabel(e.reason);
  if (e.kind === 'error') return `${e.reason === 'outcome-unknown' ? 'No answer from SoDEX' : 'Rejected'}${e.detail ? `: ${e.detail}` : ''}`;
  if (e.kind === 'status') return e.detail ?? STATUS_LABEL[e.reason] ?? e.reason;
  return LEG_LABEL[e.reason] ?? e.reason;
}

function CopyActivity({ row, rows, onPick }: { row: CopyRow | null; rows: CopyRow[]; onPick: (id: string) => void }) {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = row?.view.subscription.id ?? null;
  const mode = row?.mode ?? null;
  useEffect(() => {
    if (!id || !mode) return;
    let dead = false;
    const load = () =>
      copyActivity(mode, id).then(
        (e) => { if (!dead) { setEntries(e); setError(null); } },
        (e: unknown) => { if (!dead) setError(e instanceof Error ? e.message : String(e)); },
      );
    void load();
    const t = window.setInterval(load, 10_000);
    return () => { dead = true; window.clearInterval(t); };
  }, [id, mode]);

  if (!row) {
    return rows.length ? (
      <p className="acct-empty">
        Pick a copy:{' '}
        {rows.slice(0, 6).map((r) => (
          <button key={r.view.subscription.id} type="button" className="fx-link" onClick={() => onPick(r.view.subscription.id)}>
            {shortAddr(r.view.subscription.settings.leader.address)} ({MODE_LABEL[r.mode]}){' '}
          </button>
        ))}
      </p>
    ) : <p className="acct-empty">No copies yet.</p>;
  }
  if (error) return <p className="acct-empty">{error}</p>;
  if (!entries) return <p className="acct-empty">Loading…</p>;

  const csv = () => {
    const head = ['time', 'kind', 'what', 'market', 'side', 'size', 'price', 'notional_usd', 'reduce_only', 'builder_fee_tenths_bp', 'client_order_id', 'order_id', 'leader_before', 'leader_after', 'leader_price', 'paper'];
    const lines = entries.map((e) => [
      new Date(e.at).toISOString(), e.kind, entryText(e), e.symbol ?? '', e.side ?? '', e.size ?? '', e.price ?? '', e.notionalUsd ?? '', e.reduceOnly ?? '',
      e.builderFee ?? '', e.clOrdID ?? '', e.orderId ?? '', e.leader?.before ?? '', e.leader?.after ?? '', e.leader?.price ?? '', e.paper,
    ].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','));
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `valuedesk-copy-${row.view.subscription.id}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5_000);
  };

  return (
    <div className="acct">
      <div className="copy-killbar">
        <span className="muted">
          {shortAddr(row.view.subscription.settings.leader.address)} · {MODE_LABEL[row.mode]} · {fmt(row.view.orders, 0)} orders, {fmt(row.view.skips, 0)} skipped
        </span>
        <button type="button" className="pf-ctl" onClick={csv} disabled={!entries.length}>Export CSV</button>
      </div>
      <table className="acct-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Market</th>
            <th>What</th>
            <th className="num">Leader</th>
            <th className="num">Size</th>
            <th className="num">Price</th>
            <th className="num">Value</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const signed = e.size === null || e.side === null ? null : e.side === 'buy' ? e.size : -e.size;
            return (
              <tr key={e.id} className={e.kind === 'skip' || e.kind === 'status' ? 'muted' : undefined}>
                <td className="copy-time">{fmtStamp(e.at)}</td>
                <td>{e.symbol ? <CoinLabel coin={e.symbol}>{e.symbol}</CoinLabel> : DASH}</td>
                <td className={e.kind === 'error' ? 'neg' : undefined}>
                  {e.kind === 'fill' ? 'Filled' : e.kind === 'order' ? 'Sent' : e.kind === 'skip' ? 'Skipped' : e.kind === 'error' ? 'Error' : 'Status'}
                  {e.kind === 'order' || e.kind === 'fill' ? ` · ${LEG_LABEL[e.reason] ?? e.reason}` : ''}
                </td>
                <td className="num">{e.leader ? `${fmtSize(e.leader.before)} → ${fmtSize(e.leader.after)}` : DASH}</td>
                <td className={`num ${signClass(signed)}`}>{signed === null ? DASH : `${signed > 0 ? '+' : '−'}${fmtSize(signed)}`}</td>
                <td className="num">{e.price === null ? DASH : `${fmtPx(e.price)}${e.kind === 'order' ? ' lim' : ''}`}</td>
                <td className="num">{e.notionalUsd === null ? DASH : fmtUsd(e.notionalUsd, 2)}</td>
                <td className="muted copy-note">{e.kind === 'order' || e.kind === 'fill' ? (e.detail ?? (e.paper ? 'paper' : '')) : entryText(e)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {entries.length === 0 && <p className="acct-empty">Nothing yet: entries appear when the trader trades.</p>}
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  open: 'Open', increase: 'Add', decrease: 'Reduce', close: 'Close', flip: 'Flip', join: 'Join',
  skip: 'Skip', 'stop-loss': 'Stop loss', 'take-profit': 'Take profit', 'drawdown-stop': 'Drawdown stop',
  liquidation: 'Liquidated',
};

const LOG_ROWS = 300;

function TradeLog({ trades }: { trades: SimTrade[] }) {
  if (trades.length === 0) return <p className="acct-empty">Run a backtest to see every copied and skipped fill.</p>;
  const shown = trades.slice(-LOG_ROWS).reverse();
  return (
    <div className="acct">
      <table className="acct-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Market</th>
            <th>Action</th>
            <th className="num">Leader</th>
            <th className="num">You</th>
            <th className="num">Price</th>
            <th className="num">Fee</th>
            <th className="num">Realised</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((t) => {
            const lf = t.leaderFill;
            const leaderSigned = lf ? (lf.side === 'buy' ? 1 : -1) * lf.size : null;
            return (
              <tr key={t.seq}>
                <td className="copy-time">{fmtStamp(t.time)}</td>
                <td><CoinLabel coin={t.symbol}>{t.symbol}</CoinLabel></td>
                <td className={t.action === 'skip' ? 'muted' : undefined}>{ACTION_LABEL[t.action] ?? t.action}</td>
                <td className={`num ${signClass(leaderSigned)}`}>{leaderSigned === null ? DASH : `${leaderSigned > 0 ? '+' : '−'}${fmtSize(leaderSigned)}`}</td>
                <td className={`num ${signClass(t.size)}`}>{t.size === 0 ? DASH : `${t.size > 0 ? '+' : '−'}${fmtSize(t.size)}`}</td>
                <td className="num">{t.size === 0 ? DASH : fmtPx(t.price)}</td>
                <td className="num">{t.fee ? fmtUsd(t.fee, 2) : DASH}</td>
                <td className={`num ${signClass(t.realizedPnl)}`}>{t.realizedPnl ? fmtSignedUsd(t.realizedPnl) : DASH}</td>
                <td className="muted copy-note">
                  {t.skippedReason ? skipReasonLabel(t.skippedReason) : t.clampedBy ? `Capped: ${skipReasonLabel(t.clampedBy).toLowerCase()}` : t.note ?? ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {trades.length > LOG_ROWS && (
        <p className="acct-empty copy-lognote">The latest {fmt(LOG_ROWS, 0)} of {fmt(trades.length, 0)} entries.</p>
      )}
    </div>
  );
}

/* =============================================================== how ====== */

function HowPanel() {
  return (
    <Card title="How it works">
      <div className="copy-how">
        <Group title="Your funds stay yours">
          <p>
            Copies trade on SoDEX perps in your own account. ValueDesk never holds a deposit. A SoDEX or
            Hyperliquid trader can be followed; every copy is placed on SoDEX.
          </p>
        </Group>
        <Group title="You choose where it runs">
          <p>
            <b>This browser</b>: copies while a tab is open, with a key only this browser holds.{' '}
            <b>ValueDesk executor</b>: around the clock from Tokyo, with a key it holds for you.{' '}
            <b>Self-hosted</b>: an open-source copier on your own machine. Same engine in all three.
          </p>
        </Group>
        <Group title="Your rules, your signatures">
          <p>
            You pick the trader and every limit. Each step (terms, fee, key, start, stop) is a signature of your
            wallet; an executor keeps those as the record of your instructions. Copies are IOC limit orders inside
            your slippage cap; positions open before you start are left alone unless you choose otherwise.
          </p>
        </Group>
        <Group title="Stop at any time">
          <p>Pause or stop a copy, stop all copies at once, or revoke the copy key on SoDEX - after that nothing can trade with it.</p>
        </Group>
        <p className="pf-note">
          Copy fee up to {fmtRate(COPY_BUILDER_TENTHS_BPS / 100_000)} on every copied order (lower with volume), on top of
          SoDEX's own fees. Minimum copied order {fmtUsd(MIN_ORDER_USD, 0)}. In the EU and EEA copies are limited to 2x leverage.
          Not available in the US or sanctioned countries.
        </p>
      </div>
    </Card>
  );
}

/* ============================================================ registry ==== */

export const COPY_PANELS: Array<PanelDefinition<CopyContext>> = [
  { id: 'traders', title: 'Traders', pad: false, minW: 8, minH: 6, render: (c) => <TradersPanel c={c} /> },
  { id: 'trader', title: 'Trader', pad: false, minW: 8, minH: 5, render: (c) => <TraderPanel c={c} /> },
  { id: 'backtest', title: 'Backtest', pad: false, minW: 12, minH: 10, render: (c) => <BacktestPanel c={c} /> },
  { id: 'positions', title: 'Leader positions', pad: false, minW: 12, minH: 4, render: (c) => <PositionsPanel c={c} /> },
  { id: 'setup', title: 'Copy setup', pad: false, minW: 8, minH: 12, render: (c) => <SetupPanel c={c} /> },
  { id: 'copies', title: 'My copies', pad: false, minW: 12, minH: 5, render: (c) => <CopiesPanel c={c} /> },
  { id: 'how', title: 'How it works', pad: false, minW: 8, minH: 5, render: () => <HowPanel /> },
];
