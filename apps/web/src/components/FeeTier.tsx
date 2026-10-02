/**
 * What this account actually pays in fees, and what would change it.
 *
 * TWO SOURCES, ONE OF WHICH WINS
 * ------------------------------
 * The venue's `/fee-rate` endpoint reports the rates it will actually charge,
 * plus the three tier indices it resolved the account into. `web/src/fees.ts`
 * holds the published ladder. Those are independent, and where they disagree
 * the venue's number is displayed and the disagreement is called out - a local
 * table can go stale after a schedule change, and quietly showing a computed
 * rate that the exchange does not honour is how someone mis-sizes a trade.
 *
 * So: the headline rates are ALWAYS the venue's. The table is used for the
 * ladder rows, for marking the user's position on it, and for the one thing the
 * venue cannot answer - the counterfactual "what would a different staking tier
 * have cost me".
 *
 * WHAT THE COUNTERFACTUAL IS AND IS NOT
 * -------------------------------------
 * It is arithmetic on fees the user has already paid: the staking discount is a
 * flat multiplier on the whole bill, so re-scaling that bill by another tier's
 * multiplier is exact, not a model. It is scoped to the same window the fee
 * figure covers, and it deliberately does not annualise, extrapolate, or price
 * the token. Acquiring and locking SOSO has a cost and a risk that this panel
 * cannot see and does not net out; the footnote says so.
 *
 * MISSING INPUTS RENDER NOTHING
 * -----------------------------
 * 14-day volume and fees-paid arrive as props from the stats lane. When they are
 * absent the corresponding sections are omitted with a short line saying why.
 * There is no fallback estimate, because estimating a fee bill from volume alone
 * requires inventing a maker/taker split.
 */
import { useEffect, useState } from 'react';
import {
  FEE_DOC_RETRIEVED,
  FEE_DOC_URL,
  FEE_TIERS,
  MAKER_REBATE_TIERS,
  SAVINGS_DISPLAY_FLOOR_USD,
  STAKING_TIERS,
  VOLUME_WINDOW_DAYS,
  fmtRate,
  fmtSoso,
  fmtThreshold,
  makerRebateAt,
  reconcile,
  stakingSavings,
  stakingTierAt,
  tierForVolume,
  type FeeEngine,
  type Reconciliation,
  type VenueFeeRate,
} from '../fees';
import { api } from '../api';
import { fmtUsd } from '../format';
import './FeeTier.css';
import { Private } from '../privacy';
import { LoadFailed, logLoadFailure } from './LoadFailed';
import { useBuilderFee, type BuilderFeeQuote } from './account/useBuilderFee';
import { requestAdvanced } from './account/actions';

interface Props {
  address: string | null;
  /** Which ladder column to show. The TIER is account-wide; only the rates differ. */
  engine?: FeeEngine;
  /**
   * Rolling 14-day USD volume. Optional: supplied by the stats lane.
   * MUST be the 14-day figure - a 30-day total mis-tiers the ladder.
   */
  volume14d?: number | null;
  /** USD fees actually paid over the same window `volume14d` covers. */
  feesPaid14d?: number | null;
  /** Label for the window the fee figure covers, when it is not the standard 14D. */
  feeWindowLabel?: string;
}

/**
 * Your tier and the rates it earns you, behind the `fees` incognito category.
 *
 * Same wrapper convention as the account tables: one seam rather than a masker
 * threaded through every rate, volume and threshold inside.
 */
export function FeeTier(props: Parameters<typeof FeeTierInner>[0]) {
  return <Private k="fees"><FeeTierInner {...props} /></Private>;
}

function FeeTierInner({
  address,
  engine = 'perps',
  volume14d,
  feesPaid14d,
  feeWindowLabel,
}: Props) {
  const [venue, setVenue] = useState<VenueFeeRate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Bumped by Retry. */
  const [attempt, setAttempt] = useState(0);
  /*
   * Valuescan's builder fee on orders placed here - null unless a builder is
   * configured and applies on this engine. It is NOT one of the venue's rates:
   * SoDEX charges it on top of them, so it is shown as its own figure. 'sell',
   * because spot charges it on sells only and the sentence below says so.
   */
  const builderFee = useBuilderFee(engine, 'sell', address);

  // Called directly rather than through api.ts: that file belongs to the
  // orchestrator, which will fold this into `api.feeRate` (it already declares
  // the signature). See integrationNotes.
  useEffect(() => {
    if (!address) {
      setVenue(null);
      setError(null);
      return;
    }
    // Clear on EVERY re-fetch, not just when the address goes away. Switching
    // engine while a fetch is in flight otherwise leaves the previous engine's
    // rates on screen underneath the new engine's heading and ladder - perps
    // taker fees labelled "Spot". Blank-then-load is honest; wrong-and-
    // confident is not.
    setVenue(null);
    let cancelled = false;
    setLoading(true);
    // Straight from the gateway, in this browser: { engine, feeRate }.
    api
      .feeRate(engine, address)
      .then((body) => {
        if (cancelled) return;
        // The route wraps the gateway payload as { engine, feeRate }. Tolerate
        // an unwrapped body too rather than blanking the panel on a shape change.
        const rate = (body?.feeRate ?? body) as VenueFeeRate | null;
        if (rate && rate.makerFeeRate !== undefined && rate.takerFeeRate !== undefined) {
          setVenue(rate);
          setError(null);
        } else {
          setVenue(null);
          logLoadFailure('Fee rate', 'the fee-rate endpoint returned no rates for this account');
          setError('no rates');
        }
      })
      .catch((e) => {
        if (cancelled) return;
        logLoadFailure('Fee rate', e);
        setVenue(null);
        setError((e as Error).message);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [address, engine, attempt]);

  if (!address) {
    return (
      <div className="panel feetier">
        <div className="panelhead"><h2>Fees</h2></div>
        <p className="muted small">Connect a wallet to see the fee tier this account is on.</p>
      </div>
    );
  }

  const rec: Reconciliation | null = venue ? reconcile(venue, engine, volume14d ?? undefined) : null;
  const windowLabel = feeWindowLabel ?? `${VOLUME_WINDOW_DAYS}D`;

  return (
    <div className="panel feetier">
      <div className="panelhead">
        <h2>Fees</h2>
        <span className="muted small">{engine === 'perps' ? 'Futures' : 'Spot'}</span>
      </div>

      {loading && !venue && <p className="muted small">Loading fee rate…</p>}
      {error && !loading && <LoadFailed what="Fee rate" onRetry={() => setAttempt((n) => n + 1)} />}

      {venue && rec && (
        <>
          <Current venue={venue} rec={rec} engine={engine} volume14d={volume14d ?? null} builderFee={builderFee} />
          <Ladder venueTier={venue.feeTier} engine={engine} volume14d={volume14d ?? null} />
          <Staking
            venue={venue}
            feesPaid={feesPaid14d ?? null}
            windowLabel={windowLabel}
          />
          <Rebate venue={venue} />
          <p className="feetier-src small muted">
            Ladder from{' '}
            <a href={FEE_DOC_URL} target="_blank" rel="noreferrer">SoDEX fee documentation</a>, read{' '}
            {FEE_DOC_RETRIEVED}. Tiers use a rolling {VOLUME_WINDOW_DAYS}-day window of combined spot
            and perps volume, and one tier applies account-wide. Rates shown at the top are the
            venue's own, not computed.
          </p>
        </>
      )}
    </div>
  );
}

// --- current position --------------------------------------------------------

function Current({
  venue,
  rec,
  engine,
  volume14d,
  builderFee,
}: {
  venue: VenueFeeRate;
  rec: Reconciliation;
  engine: FeeEngine;
  volume14d: number | null;
  builderFee: BuilderFeeQuote | null;
}) {
  const stake = stakingTierAt(venue.stakingTier);

  return (
    <>
      <div className="feetier-now">
        <Stat label="Taker" value={fmtRate(rec.venueTaker)} strong />
        <Stat label="Maker" value={fmtRate(rec.venueMaker)} strong />
        <Stat label="Volume tier" value={`${venue.feeTier}`} />
        <Stat
          label="Staking tier"
          value={stake ? `${venue.stakingTier} · ${(stake.discount * 100).toFixed(0)}% off` : `${venue.stakingTier}`}
        />
        {builderFee && <Stat label="Valuescan fee" value={`+${fmtRate(builderFee.fraction)}`} />}
      </div>

      {builderFee && (
        <p className="muted small feetier-note">
          Orders placed on Valuescan also carry its builder fee: {fmtRate(builderFee.fraction)} of each fill
          {engine === 'perps' ? ', buys and sells' : ' on sells (spot buys are not charged)'}, maker or taker. SoDEX
          charges it on top of the rates above and pays it to Valuescan (builder account #{builderFee.builderId}).
          {builderFee.status === 'required' ? ' It applies once you have approved it.' : ''}{' '}
          <button type="button" className="link" onClick={requestAdvanced}>
            {builderFee.status === 'required' ? 'Approve it, or see what is approved' : 'See or revoke your approval'}
          </button>
        </p>
      )}

      {/* Only worth saying when the discount actually did something. */}
      {rec.computed && rec.computed.discount > 0 && rec.mismatches.length === 0 && (
        <p className="muted small feetier-note">
          Base {engine === 'perps' ? 'perps' : 'spot'} taker at tier {venue.feeTier} is{' '}
          {fmtRate(rec.computed.baseTaker)}; your staking tier takes{' '}
          {(rec.computed.discount * 100).toFixed(0)}% off it.
        </p>
      )}

      {rec.mismatches.length > 0 && (
        <div className="feetier-flag" role="status">
          <strong>Rates shown are the venue's.</strong> The published ladder does not reproduce them
          for tier {venue.feeTier} / staking tier {venue.stakingTier}:
          {rec.mismatches.map((m) => (
            <span key={m.field} className="feetier-flag-row">
              {m.field}: venue {fmtRate(m.venue)}, table says {fmtRate(m.computed)}
            </span>
          ))}
          <span className="feetier-flag-row muted">
            The fee schedule has probably changed since {FEE_DOC_RETRIEVED}. Treat the ladder below
            as out of date.
          </span>
        </div>
      )}

      {rec.volumeTierDisagrees && (
        <div className="feetier-flag" role="status">
          <strong>Volume figure disagrees with the venue's tier.</strong> The supplied volume
          ({fmtUsd(volume14d ?? 0, 0)}) lands in tier {rec.volumeTierDisagrees.fromVolume}, but the
          venue has this account in tier {rec.volumeTierDisagrees.fromVenue}. Tiers are measured over
          a rolling {VOLUME_WINDOW_DAYS}-day window — a figure covering a different span will not
          match.
        </div>
      )}
    </>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="feetier-stat">
      <span className="feetier-stat-label">{label}</span>
      <span className={`feetier-stat-value${strong ? ' strong' : ''}`}>{value}</span>
    </div>
  );
}

// --- the ladder --------------------------------------------------------------

function Ladder({
  venueTier,
  engine,
  volume14d,
}: {
  venueTier: number;
  engine: FeeEngine;
  volume14d: number | null;
}) {
  // Where the supplied volume WOULD land, drawn only when it differs from the
  // venue's tier - otherwise it is a second marker on the same row.
  const volTier =
    volume14d !== null && volume14d > 0 ? tierForVolume(volume14d).tier : null;

  return (
    <div className="feetier-section">
      <h3>Volume ladder · rolling {VOLUME_WINDOW_DAYS}D</h3>
      <div className="feetier-scroll">
        <table className="feetier-table">
          <thead>
            <tr>
              <th>Tier</th>
              <th className="num">{VOLUME_WINDOW_DAYS}D volume</th>
              <th className="num">Maker</th>
              <th className="num">Taker</th>
            </tr>
          </thead>
          <tbody>
            {FEE_TIERS.map((t) => {
              const here = t.tier === venueTier;
              return (
                <tr key={t.tier} className={here ? 'here' : ''}>
                  <td>
                    {t.tier}
                    {here && <span className="feetier-you">you</span>}
                    {!here && volTier === t.tier && (
                      <span className="feetier-you alt">by volume</span>
                    )}
                  </td>
                  <td className="num">
                    {t.tier === 0 ? `≤ ${fmtThreshold(FEE_TIERS[1]!.minVolume)}` : `> ${fmtThreshold(t.minVolume)}`}
                  </td>
                  <td className="num">{fmtRate(engine === 'perps' ? t.perpsMaker : t.spotMaker)}</td>
                  <td className="num">{fmtRate(engine === 'perps' ? t.perpsTaker : t.spotTaker)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {volume14d === null && (
        <p className="muted small feetier-note">
          Your {VOLUME_WINDOW_DAYS}-day volume is not available here, so the row marked is the tier
          the venue reports rather than one computed from volume.
        </p>
      )}
    </div>
  );
}

// --- staking ladder + counterfactual ----------------------------------------

function Staking({
  venue,
  feesPaid,
  windowLabel,
}: {
  venue: VenueFeeRate;
  feesPaid: number | null;
  windowLabel: string;
}) {
  const savings = feesPaid !== null ? stakingSavings(feesPaid, venue.stakingTier) : null;

  // The rebate caveat from fees.ts: a bill containing negative (rebate) lines
  // does not scale cleanly, and the docs do not say whether the discount applies
  // to rebates. Say so rather than quietly presenting an approximation as exact.
  const rebateCaveat = venue.makerRebateTier > 0;

  /**
   * Magnitude, not signed value. `savedInWindow` is NEGATIVE for every tier
   * BELOW the user's current one - i.e. what they would have paid EXTRA. A user
   * already on the top staking tier therefore has no positive row at all, and a
   * signed `>=` comparison concluded "no tier changes this by more than $1"
   * while the true spread between their tier and tier 0 ran into six figures.
   * The comparison is interesting in both directions: what a higher tier would
   * have saved, and what the user's current tier is already saving them.
   */
  const meaningful =
    savings?.some((r) => Math.abs(r.savedInWindow) >= SAVINGS_DISPLAY_FLOOR_USD) ?? false;

  return (
    <div className="feetier-section">
      <h3>SOSO staking discount</h3>
      <div className="feetier-scroll">
        <table className="feetier-table">
          <thead>
            <tr>
              <th>Tier</th>
              <th className="num">SOSO staked</th>
              <th className="num">Discount</th>
              {meaningful && <th className="num">Fees over {windowLabel}</th>}
              {meaningful && <th className="num">Difference</th>}
            </tr>
          </thead>
          <tbody>
            {STAKING_TIERS.map((t) => {
              const row = savings?.find((s) => s.stakingTier === t.tier);
              const here = t.tier === venue.stakingTier;
              return (
                <tr key={t.tier} className={here ? 'here' : ''}>
                  <td>
                    {t.tier}
                    {here && <span className="feetier-you">you</span>}
                  </td>
                  <td className="num">{t.soso === 0 ? '0' : `≥ ${fmtSoso(t.soso)}`}</td>
                  <td className="num">{(t.discount * 100).toFixed(0)}%</td>
                  {meaningful && (
                    <td className="num">{row ? fmtUsd(row.feesAtTier) : '-'}</td>
                  )}
                  {meaningful && (
                    <td className={`num ${row && row.savedInWindow > 0 ? 'pos' : row && row.savedInWindow < 0 ? 'neg' : 'muted'}`}>
                      {!row || row.isCurrent
                        ? '—'
                        : `${row.savedInWindow > 0 ? '-' : '+'}${fmtUsd(Math.abs(row.savedInWindow))}`}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {feesPaid === null && (
        <p className="muted small feetier-note">
          Fees paid over the window are not available here, so there is nothing to compare tiers
          against. The ladder above is the published schedule only.
        </p>
      )}

      {feesPaid !== null && !meaningful && (
        <p className="muted small feetier-note">
          Fees over {windowLabel} came to {fmtUsd(feesPaid)}. No staking tier would have changed that
          by more than {fmtUsd(SAVINGS_DISPLAY_FLOOR_USD)}, so the comparison is not shown.
        </p>
      )}

      {meaningful && savings && (
        <Counterfactual
          savings={savings}
          feesPaid={feesPaid ?? 0}
          windowLabel={windowLabel}
          rebateTier={rebateCaveat ? venue.makerRebateTier : null}
        />
      )}
    </div>
  );
}

function Counterfactual({
  savings,
  feesPaid,
  windowLabel,
  rebateTier,
}: {
  savings: NonNullable<ReturnType<typeof stakingSavings>>;
  feesPaid: number;
  windowLabel: string;
  /** Non-null when the account earns maker rebates, which makes the scaling approximate. */
  rebateTier: number | null;
}) {
  // The cheapest tier the user is not already on that clears the display floor.
  const next = savings.find(
    (r) => !r.isCurrent && r.additionalSoso > 0 && r.savedInWindow >= SAVINGS_DISPLAY_FLOOR_USD,
  );

  return (
    <div className="feetier-cf">
      <p className="feetier-cf-line">
        You paid <strong>{fmtUsd(feesPaid)}</strong> in fees over {windowLabel}.
        {next && (
          <>
            {' '}At the same volume and the same maker/taker mix, staking tier {next.stakingTier} (
            {fmtSoso(next.sosoRequired)} SOSO, {(next.discount * 100).toFixed(0)}% off) would have
            made that <strong>{fmtUsd(next.feesAtTier)}</strong> — a difference of{' '}
            <strong className="pos">{fmtUsd(next.savedInWindow)}</strong> over the same window.
          </>
        )}
      </p>
      <p className="muted small feetier-cf-note">
        This is arithmetic on fees you already paid over a window that has closed, not a projection.
        It excludes the cost of acquiring {next ? fmtSoso(next.additionalSoso) : 'any'} SOSO, the fact
        that staked tokens are locked, and any change in what the token is worth — none of which this
        panel can see. It is a cost comparison, not advice about buying anything.
        {rebateTier !== null && (
          <>
            {' '}Your account is on maker rebate tier {rebateTier}, so part of your fee total may be
            rebates rather than charges. The documentation does not state whether the staking
            discount applies to rebates, so treat these figures as approximate.
          </>
        )}
      </p>
    </div>
  );
}

// --- maker rebate ------------------------------------------------------------

/**
 * Reports the venue's resolved rebate tier and nothing more.
 *
 * The published thresholds are a "maker volume share" whose denominator is never
 * stated, so the user's share cannot be computed here. The thresholds are listed
 * for reference with that gap spelled out.
 */
function Rebate({ venue }: { venue: VenueFeeRate }) {
  const row = makerRebateAt(venue.makerRebateTier);

  return (
    <div className="feetier-section">
      <h3>Maker rebate</h3>
      {venue.makerRebateTier === 0 ? (
        <p className="muted small">
          The venue reports no maker rebate tier for this account.
        </p>
      ) : (
        <p className="small">
          The venue reports maker rebate tier <strong>{venue.makerRebateTier}</strong>
          {row ? <> — {fmtRate(Math.abs(row.rebate))} paid to you on maker fills.</> : '.'}
        </p>
      )}
      <p className="muted small feetier-note">
        Thresholds are published as a {VOLUME_WINDOW_DAYS}-day maker volume share of{' '}
        {MAKER_REBATE_TIERS.map((t) => `${(t.minShare * 100).toFixed(2)}%`).join(' / ')} for tiers{' '}
        {MAKER_REBATE_TIERS.map((t) => t.tier).join('/')}. The documentation does not say what that
        share is measured against, so your share is not computed here — only the tier the venue
        itself reports.
      </p>
    </div>
  );
}
