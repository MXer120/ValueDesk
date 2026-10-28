/**
 * The FOMC rate odds widget: for each coming meeting, how likely each decision
 * is (cut, hold, hike - and the target range it leads to), from Kalshi's
 * regulated prediction market, with Polymarket's price beside it where it lists
 * the same meeting; under it, how those odds moved (7 days to 3 months).
 *
 * Its settings are its own (per copy of the widget): the meeting, the range of
 * the history and whether the history shows.
 */
import { useMemo } from 'react';
import { useAsync, useStored } from '../../hooks';
import { EmptyState } from '../EmptyState';
import { SeriesChart, type ChartSeries } from '../datachart/SeriesChart';
import { macroApi, type FedOutcome } from './api';
import { fmtFixed, localize } from '../../numStyle';
import './macro.css';

const RANGES = [['7d', '7D'], ['30d', '30D'], ['90d', '3M']] as const;

/** Cuts green, hold grey, hikes red - deeper moves stronger. */
export function outcomeColor(bp: number): string {
  if (bp === 0) return '#9aa0a6';
  if (bp < 0) return bp <= -50 ? '#0a8f68' : '#00b481';
  return bp >= 50 ? '#b5271b' : '#ef4a3c';
}

const pct = (p: number) => `${fmtFixed(p * 100, p >= 0.995 || p <= 0.005 ? 0 : 1)}%`;

function meetingLabel(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getUTCFullYear() !== new Date().getUTCFullYear() ? '2-digit' : undefined, timeZone: 'UTC' });
}

/**
 * OFF (licence review 2026-10-28, docs/legal/THIRD-PARTY-REVIEW.md rows 2-3):
 * neither Kalshi's Developer Agreement nor Polymarket's Terms of Use allow
 * showing their prices on a commercial site without written permission. The
 * server answers `not_available` unless FOMC_ODDS=on; this switch also hides
 * the widget from the dashboard (registry.tsx) and keeps saved copies quiet.
 */
export const FOMC_ODDS_ON = false;

export function FedWatch({ instance }: { instance?: string }) {
  if (!FOMC_ODDS_ON) return <div className="mc"><EmptyState icon="news" title="FOMC rate odds are off" line="The prediction markets have not licensed their prices for display here, so this widget shows nothing for now." /></div>;
  return <FedWatchLive instance={instance} />;
}

function FedWatchLive({ instance }: { instance?: string }) {
  const ns = instance ? `.${instance}` : '';
  const [pick, setPick] = useStored<string | null>(`vs.fedwatch.meeting${ns}`, null);
  const [range, setRange] = useStored<string>(`vs.fedwatch.range${ns}`, '30d');
  const [showHistory, setShowHistory] = useStored<boolean>(`vs.fedwatch.history${ns}`, true);
  const fw = useAsync(() => macroApi.fedwatch(), [], { pollMs: 60_000 });
  const meetings = fw.data?.meetings ?? [];
  const m = meetings.find((x) => x.meeting === pick) ?? meetings[0];
  const hist = useAsync(() => (m && showHistory ? macroApi.fedHistory(m.meeting, range) : Promise.resolve(null)), [m?.meeting, range, showHistory], { pollMs: 10 * 60_000 });

  const outcomes = useMemo(() => [...(m?.outcomes ?? [])].sort((a, b) => a.bp - b.bp), [m]);
  const top = outcomes.reduce<FedOutcome | null>((best, o) => (!best || o.prob > best.prob ? o : best), null);
  const series = useMemo<ChartSeries[]>(() => (hist.data?.series ?? [])
    .filter((s) => s.points.length > 1)
    .map((s) => ({ key: s.key, kind: 'line', color: outcomeColor(s.bp), points: s.points.map(([t, p]) => [t, p * 100] as [number, number]), format: (v: number) => `${fmtFixed(v, 0)}%`, title: s.label })), [hist.data]);

  if (fw.error && !fw.data) return <div className="mc"><EmptyState icon="news" title="The rate odds did not load" line={fw.error} /></div>;
  if (!fw.data) return <div className="mc"><p className="acct-empty acct-loading" role="status"><span className="acct-spin" aria-hidden="true" />Loading…</p></div>;
  if (!m) return <div className="mc"><EmptyState icon="news" title="No meeting priced" line="Kalshi lists no open FOMC decision market right now." /></div>;

  const cur = fw.data.current;
  return (
    <div className="mc">
      <div className="mc__bar">
        <div className="mc__seg" role="radiogroup" aria-label="Meeting">
          {meetings.slice(0, 6).map((x) => (
            <button key={x.meeting} type="button" role="radio" aria-checked={x.meeting === m.meeting} className={x.meeting === m.meeting ? 'is-on' : ''} onClick={() => setPick(x.meeting)}>
              {meetingLabel(x.meeting)}
            </button>
          ))}
        </div>
        <span className="mc__spacer" />
        <label className="mc__toggle"><input type="checkbox" checked={showHistory} onChange={(e) => setShowHistory(e.target.checked)} /> History</label>
      </div>

      <div className="mc__head">
        <div>
          <span className="mc__kicker">FOMC · {new Date(m.statementAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          <b className="mc__big">{top ? `${top.label} ${pct(top.prob)}` : '—'}</b>
        </div>
        {cur && <span className="mc__note">Now {fmtFixed(cur.lower, 2)}–{fmtFixed(cur.upper, 2)}%</span>}
      </div>

      <ol className="mc__odds">
        {outcomes.map((o) => (
          <li key={o.key}>
            <span className="mc__olabel">{o.label}{o.target && <small>{localize(o.target)}%</small>}</span>
            <span className="mc__track"><i style={{ width: `${Math.max(0.5, o.prob * 100)}%`, background: outcomeColor(o.bp) }} /></span>
            <b className="mc__pct">{pct(o.prob)}</b>
            {m.polymarket && m.polymarket[o.key] !== undefined && <span className="mc__alt" title="Polymarket's price for the same outcome">{pct(m.polymarket[o.key]!)}</span>}
          </li>
        ))}
      </ol>
      {m.polymarket && <p className="mc__foot">Left: Kalshi. Right, grey: Polymarket.</p>}

      {showHistory && (
        <div className="mc__hist">
          <div className="mc__bar">
            <span className="mc__kicker">How the odds moved</span>
            <span className="mc__spacer" />
            <div className="mc__seg" role="radiogroup" aria-label="History range">
              {RANGES.map(([id, label]) => (
                <button key={id} type="button" role="radio" aria-checked={range === id} className={range === id ? 'is-on' : ''} onClick={() => setRange(id)}>{label}</button>
              ))}
            </div>
          </div>
          {series.length ? <SeriesChart series={series} height={180} daily={range !== '7d'} />
            : <p className="mc__note">{hist.loading ? 'Loading the history…' : 'No price history for this meeting yet.'}</p>}
        </div>
      )}
      <p className="mc__src">Market-implied odds from <a href="https://kalshi.com/markets/kxfeddecision" target="_blank" rel="noopener noreferrer">Kalshi</a>{m.polymarket ? <> and <a href="https://polymarket.com/" target="_blank" rel="noopener noreferrer">Polymarket</a></> : null}, not a forecast of ours · updated {new Date(m.updatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</p>
    </div>
  );
}
