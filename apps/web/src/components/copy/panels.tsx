/**
 * The Copy page's My copies panel: every copy, its activity, the replay's
 * trades. A trader opens on the Scan page; the trader grid and the copy dialog
 * are Discover.tsx and CopyModal.tsx.
 *
 * Built from the design system the portfolio exports (Card, Group, Row, Stat),
 * inside the `pf` scope CopyPage gives them. Nothing here draws a style of its
 * own that an existing Valuetrade surface already has.
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
import { useEffect, useState, type ReactNode } from 'react';
import { SKIP_REASONS, type ActivityEntry, type CopyView } from '@copy-engine';
import { MODE_LABEL } from '../../copy/CopySetupSheet';
import { commandCopy, copyActivity, copyRows, stopAllCopies, type CopyRow, type LiveCopy } from '../../copy/live';
import { notify, notifyError } from '../../toast';
import { pollEvery } from '../../exchange/visibility';
import { useConfirm } from '../Modal';
import { DASH, fmt, fmtUsd, shortAddr, signClass } from '../../format';
import { VENUE_LABEL, type Venue } from '../../vsApi';
import { PanelTabs } from '../../dashboard/Panel';
import { Card, Group, Row, Stat } from '../portfolio/parts';
import { CoinLabel } from '../CoinIcon';
import { IdChip } from '../accountTables/IdCell';
import { skipReasonLabel, type SimTrade } from './sim';
import { fmtSignedPct, fmtSignedUsd, fmtSize } from './setup';
import type { CopyContext } from './useCopy';
import { fmtPlain } from '../../numStyle';
import { openShare } from '../share/host';
import { copyCard } from '../share/shareData';

/* ------------------------------------------------------------ helpers ----- */

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

const fmtStamp = (ms: number): string =>
  new Date(ms).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

const fmtDay = (ms: number): string =>
  new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });

/* ============================================================ copies ====== */

/** What the copies table needs: the live copy state, the wallet, and where a trader opens. */
export interface CopiesSource {
  live: LiveCopy;
  wallet: string | null;
  onScan: (address: string, venue?: Venue) => void;
}

export function CopiesPanel({ c }: { c: CopyContext }) {
  const trades = c.sim.result?.fills ?? [];
  return (
    <Card className="pf-card--band">
      <div className="dash pf-band">
        <CopiesTabs src={c} extra={[{
          key: 'trades',
          label: `Backtest trades${trades.length ? ` (${fmt(trades.length, 0)})` : ''}`,
          content: <TradeLog trades={trades} />,
        }]} />
      </div>
    </Card>
  );
}

/**
 * Managing the copies: My copies (Pause, Resume, Stop, Close, Stop all) and each
 * copy's Activity. The Portfolio page's My copies card opens it ("Manage copies").
 */
export function CopiesManager({ src }: { src: CopiesSource }) {
  return (
    <div className="dash pf-band">
      <CopiesTabs src={src} />
    </div>
  );
}

function CopiesTabs({ src, extra = [] }: { src: CopiesSource; extra?: Array<{ key: string; label: string; content: ReactNode }> }) {
  const rows = copyRows(src.live);
  const running = rows.filter((r) => r.view.subscription.status !== 'stopped');
  const [picked, setPicked] = useState<string | null>(null);
  const [tab, setTab] = useState<string>('mine');
  const sel = rows.find((r) => r.view.subscription.id === picked) ?? null;
  return (
    <PanelTabs
      active={tab}
      onChange={setTab}
      tabs={[
        {
          key: 'mine',
          label: `My copies (${running.length})`,
          content: <MyCopies src={src} rows={rows} onActivity={(id) => { setPicked(id); setTab('activity'); }} />,
        },
        {
          key: 'activity',
          label: sel ? `Activity · ${shortAddr(sel.view.subscription.settings.leader.address)}` : 'Activity',
          content: <CopyActivity row={sel} rows={rows} onPick={setPicked} />,
        },
        ...extra,
      ]}
    />
  );
}

const STATUS_LABEL: Record<string, string> = { active: 'Copying', paused: 'Paused', stopped: 'Stopped', halted: 'Halted', blocked: 'Blocked' };

function sizingOf(v: CopyView): string {
  const s = v.subscription.settings;
  const size = s.sizingMode === 'proportional' ? 'Proportional'
    : s.sizingMode === 'fixedRatio' ? `${fmt(s.ratio * 100, 2)}% of leader`
    : `${fmtUsd(s.fixedNotionalUsd, 0)} / trade`;
  const sized = (s.multiplier ?? 1) !== 1 ? `${size} · ${fmt(s.multiplier, 2)}×` : size;
  return s.direction === 'counter' ? `Counter · ${sized}` : sized;
}

function MyCopies({ src: c, rows, onActivity }: { src: CopiesSource; rows: CopyRow[]; onActivity: (id: string) => void }) {
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
                <td>{sizingOf(v)} · {fmtPlain(s.settings.maxLeverage)}x</td>
                <td className="num">{fmtUsd(v.equity, 2)}</td>
                <td className={`num ${signClass(v.pnl)}`}>{fmtSignedUsd(v.pnl)} <span className="muted">{fmtSignedPct(v.pnlPct)}</span></td>
                <td className="num">{v.positions.length ? `${v.positions.length} · ${fmtUsd(v.grossNotional, 0)}` : DASH}</td>
                <td className="num copy-time">{fmtDay(s.createdAt)}</td>
                <td>
                  <span className={`copy-status copy-status--${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span>{' '}
                  <IdChip label="ID" what="Copy ID" id={s.id} />
                  {s.statusReason && s.status !== 'active' && <span className="copy-reason">{s.statusReason}</span>}
                </td>
                <td className="num">
                  <span className="copy-acts">
                    <button type="button" className="pf-ctl" onClick={() => onActivity(s.id)}>Activity</button>
                    <button
                      type="button"
                      className="pf-ctl"
                      onClick={() => { const card = copyCard({ leader: lead.address, venue: VENUE_LABEL[lead.venue], pnl: v.pnl, pct: v.pnlPct, since: s.createdAt, multiplier: s.settings.multiplier ?? 1, orders: v.orders, realized: v.realizedPnl, paper: s.settings.paper, wallet: s.owner }); if (card) openShare(card); }}
                    >
                      Share
                    </button>
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
  // Why, in words - with what the copier saw when it says more (a different asset's two prices).
  if (e.kind === 'skip') return `${(SKIP_REASONS as Record<string, string>)[e.reason] ?? skipReasonLabel(e.reason)}${e.detail ? ` (${e.detail})` : ''}`;
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
    // Paused while the tab is hidden; a refresh that fell due runs the moment it is shown.
    const stop = pollEvery(10_000, () => void load());
    return () => { dead = true; stop(); };
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
        <IdChip label="Copy ID" what="Copy ID" id={row.view.subscription.id} />
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
