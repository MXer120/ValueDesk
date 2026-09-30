/**
 * The Copy page's panels. Ids are permanent - they key the saved layout.
 *
 * Built from the design system the portfolio exports (Card, Group, Row, Stat)
 * and the order ticket's field classes (.oe-*), inside the `pf` scope the
 * dashboard root carries. Nothing here draws a style of its own that an
 * existing Valuetrade surface already has.
 *
 * HONESTY RULES this file keeps:
 *  - No copy exists and none can: the contract is not deployed. "My copies" is
 *    empty by construction and says why; "Start copying" ends in that sentence
 *    and never reaches a wallet (the provider prop is deliberately unused).
 *  - A number the venue did not report is an em-dash, never a zero.
 *  - Planned fees are labelled planned; the backtest says what it cannot see.
 */
import { useId, type ReactNode } from 'react';
import { DASH, fmt, fmtUsd, shortAddr, signClass } from '../../format';
import { winRateView } from '../../winRateView';
import { VENUE_LABEL, type TraderRow, type Venue, type VsPosition, type Window } from '../../vsApi';
import type { PanelDefinition } from '../../dashboard';
import { PanelTabs } from '../../dashboard/Panel';
import { Card, Group, Row, Stat } from '../Portfolio';
import { LoadFailed } from '../LoadFailed';
import { EquityChart } from './EquityChart';
import { CoinLabel } from '../CoinIcon';
import { coinOf, skipReasonLabel, type SimResult, type SimTrade } from './sim';
import {
  BACKTEST_WINDOWS, MIN_ORDER_USD, PLANNED_BUILDER_TENTHS_BPS, SIZING_MODES, TAKER_RATE, WINDOW_LABEL,
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
  const builder = PLANNED_BUILDER_TENTHS_BPS / 100_000;
  const s = c.profile.data?.summary ?? null;
  const example = workedExample(parsed, c.profile.data ?? null, (sym) => coinOf(c.venue, sym));
  const errorList = Object.values(errs);
  const canStart = !!c.leader && errorList.length === 0;

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
          </div>
        </Group>

        <Group title="Fees">
          <dl className="oe-out copy-fees">
            <div className="oe-out__row">
              <dt className="oe-out__k" title={`${VENUE_LABEL[c.venue]}'s published base-tier perps taker fee. Copied orders are IOC, so they take.`}>
                Taker fee <span className="oe-tag">{VENUE_LABEL[c.venue]}, base tier</span>
              </dt>
              <dd className="oe-out__v">{fmtRate(taker)}</dd>
            </div>
            <div className="oe-out__row">
              <dt className="oe-out__k" title="Not charged today: there is no copy executor yet. Planned as 5 bp on copied orders that open or add to a position; closes pay no builder fee.">
                Builder fee <span className="oe-tag">planned, opens and adds</span>
              </dt>
              <dd className="oe-out__v">{fmtRate(builder)}</dd>
            </div>
            <div className="oe-out__row">
              <dt className="oe-out__k" title="Taker in and out, plus the planned builder fee on the way in. Slippage is extra.">
                Round trip <span className="oe-tag">est.</span>
              </dt>
              <dd className="oe-out__v">{fmtRate(taker * 2 + builder)}</dd>
            </div>
            <div className="oe-out__row">
              <dt className="oe-out__k" title="The builder-fee approval you would sign would be capped at this, not at the venue maximum.">
                Approval cap <span className="oe-tag">planned</span>
              </dt>
              <dd className="oe-out__v">{fmtRate(builder)}</dd>
            </div>
          </dl>
        </Group>

        {errorList.length > 0 && <p className="oe-note copy-errors">{errorList.join(' ')}</p>}

        <button
          type="button"
          className="pf-btn pf-btn--primary pf-btn--wide"
          disabled={!canStart}
          title={!c.leader ? 'Pick a trader first' : errorList.length ? 'Fix the setup first' : undefined}
          onClick={c.requestStart}
        >
          Start copying
        </button>

        {c.startRequested ? (
          <div className="pf-warn copy-notlive" role="status">
            <strong>Not live yet: the copy contract is not deployed.</strong>
            <p>
              Nothing was signed and your wallet was not asked for anything. Your setup stays saved in
              this browser; copying opens when the contract launches.
            </p>
          </div>
        ) : (
          <p className="pf-note">Nothing on this page signs or sends. Copying launches with the on-chain copy contract.</p>
        )}
      </div>
    </Card>
  );
}

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
  return (
    <Card className="pf-card--band">
      <div className="dash pf-band">
        <PanelTabs
          tabs={[
            { key: 'mine', label: 'My copies (0)', content: <MyCopies c={c} /> },
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

function MyCopies({ c }: { c: CopyContext }) {
  return (
    <div className="acct">
      <table className="acct-table">
        <thead>
          <tr>
            <th>Trader</th>
            <th>Venue</th>
            <th className="num">Allocation</th>
            <th>Sizing</th>
            <th className="num">Equity</th>
            <th className="num">PnL</th>
            <th className="num">Since</th>
            <th>Status</th>
          </tr>
        </thead>
      </table>
      <p className="acct-empty">
        No copies. Copy trading launches with the on-chain copy contract, which is not deployed yet,
        so nothing can be running here.{c.wallet ? '' : ' Connect a wallet to see yours once it does.'}
      </p>
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
    <Card title="How it works (planned)" action={<span className="pf-chip pf-chip--warn">Not deployed</span>}>
      <div className="copy-how">
        <Group title="Your funds stay yours">
          <p>Copies trade in your own SoDEX or Hyperliquid account. Valuescan never holds a deposit.</p>
        </Group>
        <Group title="A key that can only trade">
          <p>
            Your wallet authorises a session key. On SoDEX the plan is permission mask 14: cancel, withdraw
            and transfer off, trade (which includes cancelling) on. That is SoDEX's documented meaning, not
            yet verified on the gateway. On Hyperliquid it is an agent wallet, which cannot withdraw.
          </p>
        </Group>
        <Group title="Terms on-chain">
          <p>Who you copy, your allocation and your limits are recorded in a copy contract on ValueChain.</p>
        </Group>
        <Group title="Stop at any time">
          <p>Unsubscribe on-chain, or revoke the key at the exchange, or let it expire.</p>
        </Group>
        <p className="pf-note">
          Planned builder fee {fmtRate(PLANNED_BUILDER_TENTHS_BPS / 100_000)} on copied opens and adds, on top of the
          venue's own fees. Minimum copied order {fmtUsd(MIN_ORDER_USD, 0)}.
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
