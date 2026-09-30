/**
 * All-time account statistics.
 *
 * Every number on this panel carries its provenance, because two of them come
 * from genuinely different places and WILL disagree:
 *
 *  - Fees, funding, fill count and traded volume are aggregated from a full
 *    backward walk of this account's own fill and funding history. Exact, and
 *    per-coin.
 *  - The realized-PnL headline is the venue's own precomputed figure. It is
 *    PERPS-ONLY and it is a DAILY SNAPSHOT - the panel prints the snapshot
 *    timestamp the venue reports, so its age is visible rather than implied.
 *
 * Two rules this panel does not bend:
 *
 *  1. FEES ARE PER-COIN. Spot buys are charged in the base coin and sells in
 *     vUSDC, so there is no single "$ fees paid" figure to show. Adding those
 *     buckets together would be arithmetic on unrelated units, so each coin gets
 *     its own row all the way to the screen.
 *  2. AN INCOMPLETE WALK SAYS SO. If any history walk stopped early - an error,
 *     a ceiling, anything other than reaching the end - a warning sits ABOVE the
 *     totals, because a partial sum rendered as an all-time total is a wrong
 *     number, and a wrong number on a trading screen is worse than a blank.
 *
 * There is no spot realized-PnL figure at all: the venue publishes none, and the
 * panel prints the reason instead of an estimate dressed up as the venue's.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type StatsResponse, type StatsSyncProgress, type StatsTradeStats } from '../api';
import { num, signClass } from '../format';
import { formatNumber } from '../intlCache';
import './Stats.css';

// Local aliases so the rest of this file (written before these moved to
// api.ts) does not need touching beyond these two renames.
type SyncProgress = StatsSyncProgress;
type TradeStats = StatsTradeStats;

const SCOPE_LABEL: Record<string, string> = {
  'trades-spot': 'spot fills',
  'trades-perps': 'perps fills',
  funding: 'funding payments',
};

// --- formatting --------------------------------------------------------------

/**
 * Magnitude-aware amount formatting.
 *
 * These totals span dust and seven figures in the same table: a per-coin spot fee
 * total can be 0.00041288 WSOSO on one row and 1,284.52 vUSDC on the next. One
 * fixed decimal count either rounds the small one away to a misleading "0.00" or
 * pads the large one with meaningless zeros.
 *
 * The maximum is what varies; the MINIMUM is only pinned above 1, where trailing
 * zeros are the conventional cents. Below 1 it stays 0, because padding
 * "0.5512" out to "0.55120000" claims eight digits of precision the venue never
 * reported.
 */
function fmtAmount(v: string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = num(v);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs === 0) return '0';
  const max = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  return formatNumber(n, 'en-US', {
    minimumFractionDigits: abs >= 1 ? 2 : 0,
    maximumFractionDigits: max,
  });
}

const fmtCount = (n: number): string => formatNumber(n, 'en-US');

/*
 * Dates are pinned to en-US for the same reason format.ts pins numbers: on a
 * de-DE browser the shared fmtDateTime renders "26.8.2026", which sits directly
 * under an "Apr 30, 2026" from the row above and reads as a different calendar.
 * Every date on this panel goes through these two helpers so they cannot drift.
 */
const fmtDay = (ms: number | null): string =>
  ms ? new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' }) : '—';

const fmtMoment = (ms: number | null): string =>
  ms
    ? new Date(ms).toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      })
    : '—';

const daysAgo = (ms: number): number => Math.floor((Date.now() - ms) / 86_400_000);

/** An amount and the coin it is denominated in - never a bare "$". */
function Amount({ value, coin }: { value: string | null; coin: string | null }) {
  return (
    <span className="stats-amount">
      <span className={signClass(value)}>{fmtAmount(value)}</span>{' '}
      {coin ? (
        <span className="stats-coin">{coin}</span>
      ) : (
        <span className="stats-coin muted" title="The venue did not report which coin this amount is in.">
          coin not reported
        </span>
      )}
    </span>
  );
}

// --- the venue's equity curve ------------------------------------------------

/**
 * Cumulative perps PnL, one point per UTC day, straight from the venue's
 * daily_stats series. Deliberately unlabelled on the axes: it is a shape, and the
 * numbers that matter are printed next to it.
 */
function Sparkline({ points }: { points: Array<{ t: number; pnl: string }> }) {
  if (points.length < 2) return null;
  const ys = points.map((p) => num(p.pnl));
  const min = Math.min(...ys, 0);
  const max = Math.max(...ys, 0);
  const span = max - min || 1;
  const W = 260;
  const H = 48;
  const d = ys
    .map((y, i) => {
      const x = (i / (ys.length - 1)) * W;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${(H - ((y - min) / span) * H).toFixed(1)}`;
    })
    .join(' ');
  const zero = H - ((0 - min) / span) * H;
  const last = ys[ys.length - 1] ?? 0;

  return (
    <svg
      className="stats-spark"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Cumulative perps PnL over ${points.length} days, ending at ${fmtAmount(String(last))}`}
    >
      {/* The zero line is the only reference point that means anything here. */}
      <line x1="0" y1={zero} x2={W} y2={zero} className="stats-spark-zero" />
      <path d={d} className={last >= 0 ? 'stats-spark-line pos' : 'stats-spark-line neg'} />
    </svg>
  );
}

// --- sync progress -----------------------------------------------------------

/**
 * A walk over a long history takes minutes and there is no total to divide by -
 * the gateway does not report how many fills exist. So this is an honest
 * indeterminate bar plus the two facts that ARE known: how much has been
 * collected, and how far back it has reached.
 */
function SyncBar({ scopes }: { scopes: Record<string, SyncProgress> }) {
  const active = Object.values(scopes).filter((s) => s.status === 'running');
  if (active.length === 0) return null;
  return (
    <div className="stats-sync" role="status" aria-live="polite">
      <div className="stats-sync-track">
        <div className="stats-sync-fill" />
      </div>
      <div className="stats-sync-lines">
        {active.map((s) => (
          <div key={s.kind} className="stats-sync-line">
            <span>Walking {SCOPE_LABEL[s.kind] ?? s.kind}</span>
            <span className="muted">
              {fmtCount(s.pages)} page{s.pages === 1 ? '' : 's'} · {fmtCount(s.cached + s.fetched)} rows
              {s.oldest ? ` · back to ${fmtDay(s.oldest)}` : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The completeness warning.
 *
 * Rendered ABOVE the totals on purpose. Anything short of "the walk reached the
 * beginning of this account's history" means the sums below are a floor, not a
 * total, and the reader has to know that before they read the number.
 *
 * A walk still IN PROGRESS counts. It is the easiest case to get wrong, because
 * the numbers underneath look perfectly finished while they are still climbing -
 * a fee total read mid-walk is simply a smaller number than the truth, with
 * nothing on screen to say so. The progress bar alone does not carry that: it
 * says the app is busy, not that these particular figures are provisional.
 */
function Coverage({ scopes }: { scopes: Record<string, SyncProgress> }) {
  const partial = Object.values(scopes).filter((s) => !s.complete || s.error || s.truncated);
  if (partial.length === 0) return null;
  const anyRunning = partial.some((s) => s.status === 'running');
  return (
    <div className="stats-warn">
      <strong>
        {anyRunning
          ? 'Still counting — the totals below are a partial sum.'
          : 'These totals are incomplete.'}
      </strong>
      <ul>
        {partial.map((s) => (
          <li key={s.kind}>
            {SCOPE_LABEL[s.kind] ?? s.kind}:{' '}
            {s.error ? (
              <span className="neg">{s.error}</span>
            ) : s.truncated ? (
              <span className="warn">{s.truncated}</span>
            ) : s.status === 'running' ? (
              'still walking backwards through this account\'s history'
            ) : (
              'the walk has not reached the beginning of this account\'s history yet'
            )}
            {s.oldest ? <span className="muted"> — counted back to {fmtDay(s.oldest)} so far</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- per-engine fill statistics ---------------------------------------------

function EngineBlock({ engine, s }: { engine: string; s: TradeStats }) {
  if (s.count === 0) return null;
  const { maker, taker, unknown } = s.liquidity;
  return (
    <div className="stats-engine">
      <h3>
        {engine} — {fmtCount(s.count)} fill{s.count === 1 ? '' : 's'}
      </h3>
      <table className="kv">
        <tbody>
          <tr>
            <th>First fill</th>
            <td>{fmtDay(s.firstTime)}</td>
          </tr>
          <tr>
            <th>Last fill</th>
            <td>{fmtMoment(s.lastTime)}</td>
          </tr>
          <tr>
            <th>Maker / taker</th>
            <td>
              {fmtCount(maker)} / {fmtCount(taker)}
              {unknown > 0 && <span className="muted"> · {fmtCount(unknown)} unreported</span>}
            </td>
          </tr>
        </tbody>
      </table>

      <h4>
        Fees paid
        {s.feeCoinUnlabelled > 0 && (
          <span className="muted small"> · {fmtCount(s.feeCoinUnlabelled)} rows had no coin label</span>
        )}
      </h4>
      <table className="datatable">
        <thead>
          <tr>
            <th>Coin</th>
            <th className="right">Total charged</th>
            <th className="right">Fills</th>
          </tr>
        </thead>
        <tbody>
          {s.fees.length === 0 && (
            <tr>
              <td colSpan={3} className="muted tablenote">
                No fees recorded on these fills.
              </td>
            </tr>
          )}
          {s.fees.map((f) => (
            <tr key={f.coin ?? '?'}>
              <td>{f.coin ?? <span className="muted">not reported</span>}</td>
              <td className="right">{fmtAmount(f.amount)}</td>
              <td className="right">{fmtCount(f.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>Traded volume</h4>
      <table className="datatable">
        <thead>
          <tr>
            <th>Quote coin</th>
            <th className="right">Notional</th>
            <th className="right">Fills</th>
          </tr>
        </thead>
        <tbody>
          {s.volume.length === 0 && (
            <tr>
              <td colSpan={3} className="muted tablenote">
                No notional could be computed for these fills.
              </td>
            </tr>
          )}
          {s.volume.map((v) => (
            <tr key={v.coin ?? '?'}>
              <td>{v.coin ?? <span className="muted">market not recognised</span>}</td>
              <td className="right">{fmtAmount(v.amount)}</td>
              <td className="right">{fmtCount(v.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* A fill carries only price and quantity - no quote-side field - so this
          number is our own exact multiplication, and says so. */}
      <p className="stats-note">
        {s.volumeSource.derived > 0 && (
          <>Derived as price × quantity on {fmtCount(s.volumeSource.derived)} fills. </>
        )}
        {s.volumeSource.reported > 0 && (
          <>Read from a reported quote quantity on {fmtCount(s.volumeSource.reported)} fills. </>
        )}
        {s.volumeSource.unavailable > 0 && (
          <span className="warn">
            {fmtCount(s.volumeSource.unavailable)} fills had neither, and are excluded.
          </span>
        )}
      </p>

      {s.bySymbol.length > 0 && (
        <details className="stats-details">
          <summary>By market ({s.bySymbol.length})</summary>
          <table className="datatable">
            <thead>
              <tr>
                <th>Market</th>
                <th className="right">Fills</th>
                <th className="right">Notional</th>
              </tr>
            </thead>
            <tbody>
              {s.bySymbol.map((m) => (
                <tr key={m.symbol}>
                  <td>{m.symbol}</td>
                  <td className="right">{fmtCount(m.count)}</td>
                  <td className="right">
                    <Amount value={m.volume} coin={m.volumeCoin} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

// --- panel -------------------------------------------------------------------

export function Stats({ address, showTitle = true }: { address: string | null; showTitle?: boolean }) {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(
    async (rebuild = false) => {
      if (!address) return;
      setLoading(true);
      try {
        const body = await api.statsAllTime(address, rebuild);
        if (alive.current) {
          setData(body);
          setError(null);
        }
      } catch (e) {
        if (alive.current) setError((e as Error).message);
      } finally {
        if (alive.current) setLoading(false);
      }
    },
    [address],
  );

  useEffect(() => {
    setData(null);
    setError(null);
    void load();
  }, [load]);

  /*
   * Poll only while a walk is actually in flight. A completed sync is cached on
   * the server and re-polling it would just burn the shared upstream weight
   * budget that the live trading views need.
   */
  const running = data?.sync.running ?? false;
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(id);
  }, [running, load]);

  const h = data?.headline;

  return (
    <section className="panel stats">
      <div className="panelhead">
        {showTitle && <h2>All-time statistics</h2>}
        <button
          onClick={() => void load(true)}
          disabled={!address || loading || running}
          title="Discard the cached history for this wallet and walk it again from scratch."
        >
          Rebuild
        </button>
      </div>

      {!address && <p className="muted">Connect a wallet.</p>}
      {error && <p className="status err">{error}</p>}

      {data && (
        <>
          <SyncBar scopes={data.sync.scopes} />
          <Coverage scopes={data.sync.scopes} />

          {/* -- the venue's own headline ---------------------------------- */}
          <div className="stats-block">
            <h3>Realized PnL</h3>
            {h?.available ? (
              <>
                <div className="stats-headline">
                  <div className="stats-big">
                    <span className="statlabel">Cumulative, perps</span>
                    <span className={`stats-bigvalue ${signClass(h.cumulativePnl)}`}>
                      {fmtAmount(h.cumulativePnl)}
                    </span>
                  </div>
                  <Sparkline points={h.curve} />
                </div>
                <table className="kv">
                  <tbody>
                    <tr>
                      <th>Unrealized</th>
                      <td className={signClass(h.unrealizedPnl)}>{fmtAmount(h.unrealizedPnl)}</td>
                    </tr>
                    <tr>
                      <th>Cumulative quote volume</th>
                      <td>{fmtAmount(h.cumulativeQuoteVolume)}</td>
                    </tr>
                    {h.firstTradeAt !== null && (
                      <tr>
                        <th>First perps trade</th>
                        <td>{fmtDay(h.firstTradeAt)}</td>
                      </tr>
                    )}
                    <tr>
                      <th>Account</th>
                      <td className="muted">#{h.accountId}</td>
                    </tr>
                  </tbody>
                </table>
                {/*
                  The staleness note is built from the venue's own `ts_ms`, not
                  from a guess: the snapshot lands on a UTC-midnight boundary, so
                  it is normally a day or two behind live activity.
                */}
                <p className="stats-note">
                  Futures only, and quote-denominated in the venue's own accounting — not our walk of
                  your fills, and not directly comparable to the volume below.{' '}
                  {h.asOf ? (
                    <span className={daysAgo(h.asOf) >= 2 ? 'warn' : 'muted'}>
                      Venue snapshot dated {fmtDay(h.asOf)}
                      {daysAgo(h.asOf) > 0 ? ` (${daysAgo(h.asOf)} day${daysAgo(h.asOf) === 1 ? '' : 's'} old)` : ''}
                      ; it does not include today's trading.
                    </span>
                  ) : (
                    <span className="warn">The venue did not report when this snapshot was taken.</span>
                  )}
                </p>
              </>
            ) : (
              <p className="muted">
                No perps PnL headline available{h?.reason ? ` — ${h.reason}` : ''}.
              </p>
            )}

            {/* No spot PnL, and the reason rather than a substitute. */}
            <p className="stats-note">
              <strong>Spot realized PnL is not shown.</strong> {data.spotRealizedPnl.reason}
            </p>
          </div>

          {/* -- funding --------------------------------------------------- */}
          <div className="stats-block">
            <h3>Funding — {fmtCount(data.funding.count)} payment{data.funding.count === 1 ? '' : 's'}</h3>
            <table className="datatable">
              <thead>
                <tr>
                  <th>Coin</th>
                  <th className="right">Net</th>
                  <th className="right">Payments</th>
                </tr>
              </thead>
              <tbody>
                {data.funding.totals.length === 0 && (
                  <tr>
                    <td colSpan={3} className="muted tablenote">
                      No funding recorded for this account.
                    </td>
                  </tr>
                )}
                {data.funding.totals.map((t) => (
                  <tr key={t.coin ?? '?'}>
                    <td>{t.coin ?? <span className="muted">not reported</span>}</td>
                    <td className={`right ${signClass(t.amount)}`}>{fmtAmount(t.amount)}</td>
                    <td className="right">{fmtCount(t.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.funding.count > 0 && (
              <p className="stats-note">
                {/*
                  A funding record is (symbol, positionID, positionSide,
                  fundingFee, feeCoin, timestamp) - there is no rate in it, so no
                  rate is shown, and the sign below is the venue's own.
                */}
                Summed with the venue's own sign, unmodified. {fmtDay(data.funding.firstTime)} –{' '}
                {fmtDay(data.funding.lastTime)}.
              </p>
            )}
          </div>

          {/* -- our walk over the fills ----------------------------------- */}
          <div className="stats-block">
            <h3>Fills, fees and volume</h3>
            {data.trades.spot.count === 0 && data.trades.perps.count === 0 ? (
              <p className="muted">
                {running ? 'Walking this account\'s fill history…' : 'No fills found for this account.'}
              </p>
            ) : (
              <div className="stats-engines">
                <EngineBlock engine="Spot" s={data.trades.spot} />
                <EngineBlock engine="Futures" s={data.trades.perps} />
              </div>
            )}
            <p className="stats-note">
              Walked from this account's own fill history and cached locally, so a
              re-open is instant. Fees are shown per coin because they are charged per
              coin — a spot buy is charged in the base coin, a sell in vUSDC — and adding
              those together would not mean anything.
            </p>
          </div>

          {!data.sync.cache.ok && (
            <p className="status warn">
              History cache unavailable — re-walking on every load.
            </p>
          )}
        </>
      )}

      {!data && address && !error && <p className="muted">Loading…</p>}
    </section>
  );
}

export default Stats;
