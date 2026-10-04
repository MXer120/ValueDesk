/**
 * Fee schedule, opened from the order ticket and the dev panel.
 *
 * The sheet follows the venue trade-ticket layout: an effective taker/maker
 * pair for both engines, then the three published tables. The pair is the
 * rate `/fee-rate` reported. "You're here" is that report's tier index, on
 * all three tables, per engine, without collapsing a disagreement. The
 * ValueDesk switch replaces the tables with the futures & spot ladder and
 * the copy-trading ladder. The header stays the venue pair.
 */
import { useState } from 'react';
import { builderRateToFraction } from '@sodex-core';
import {
  BUILDER_LADDER,
  COPY_LADDER,
  builderTierIndex,
  builderVolumeLabel,
  copyVolumeLabel,
} from '../builderSchedule';
import {
  FEE_DOC_URL,
  FEE_TIERS,
  MAKER_REBATE_TIERS,
  STAKING_TIERS,
  VOLUME_WINDOW_DAYS,
  effectiveFees,
  feeTierRows,
  feeVolumeLabel,
  fmtRate,
  fmtSoso,
  makerRebateAt,
  rebateRows,
  stakingMark,
  type FeeEngine,
  type VenueFeeRead,
} from '../fees';
import { fmtUsd } from '../format';
import { currentTerms, feeNow, termsView } from '../trading/terms';
import { Modal } from './Modal';
import { useVenueFees, type VenueFees } from './useVenueFees';
import './funds/funds.css';
import './FeeSchedule.css';

const near = (a: number, b: number): boolean =>
  Math.abs(a - b) <= Math.max(1e-12, Math.abs(b) * 1e-9);

const word = (e: FeeEngine): string => (e === 'perps' ? 'perps' : 'spot');
const badge = (e: FeeEngine): string => (e === 'perps' ? 'Perps' : 'Spot');

/** Header pair, trailing zeros dropped the way the venue ticket prints them. */
function fmtHead(rate: number): string {
  const s = (rate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return `${s}%`;
}

/** True when the published formula reproduces the venue's rate. Null when a tier is missing. */
function tableAgrees(engine: FeeEngine, read: VenueFeeRead): boolean | null {
  if (read.feeTier === null || read.stakingTier === null) return null;
  const computed = effectiveFees(read.feeTier, read.stakingTier, engine);
  if (!computed || !near(computed.taker, read.taker)) return false;
  if (read.makerRebateTier !== null && read.makerRebateTier > 0) {
    const reb = makerRebateAt(read.makerRebateTier);
    return !!reb && near(reb.rebate, read.maker);
  }
  return near(computed.maker, read.maker);
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** The engine the click came from. Its row is "You're here". */
  engine: FeeEngine;
  address: string | null;
  /** When the ticket already loaded both engines, skip a second fetch. */
  rates?: VenueFees;
}

export function FeeSchedule({ open, onClose, engine, address, rates }: Props) {
  const fetched = useVenueFees(address, open && rates === undefined);
  const live = rates ?? fetched;
  const [which, setWhich] = useState<'sodex' | 'valuedesk'>('sodex');
  const connected = !!address;
  const other: FeeEngine = engine === 'spot' ? 'perps' : 'spot';
  const entry = connected ? live[engine] : null;
  const otherRead = connected ? live[other] : null;

  const feeRows = feeTierRows(entry?.feeTier ?? null, otherRead?.feeTier ?? null);
  const stake = stakingMark(
    connected ? live.spot?.stakingTier ?? null : null,
    connected ? live.perps?.stakingTier ?? null : null,
  );
  const rebates = rebateRows(entry?.makerRebateTier ?? null, otherRead?.makerRebateTier ?? null);

  const notes: string[] = [];
  if (connected && !live.loading && stake.split && live.spot?.stakingTier != null && live.perps?.stakingTier != null) {
    notes.push(`SoDEX reports staking tier ${live.perps.stakingTier} on perps and tier ${live.spot.stakingTier} on spot.`);
  }
  if (entry && otherRead && entry.makerRebateTier != null && otherRead.makerRebateTier != null && entry.makerRebateTier !== otherRead.makerRebateTier) {
    notes.push(`SoDEX reports maker rebate tier ${entry.makerRebateTier} on ${word(engine)} and tier ${otherRead.makerRebateTier} on ${word(other)}.`);
  }
  for (const e of ['perps', 'spot'] as const) {
    const read = e === engine ? entry : otherRead;
    if (!read || live.loading) continue;
    if (tableAgrees(e, read) === false) {
      notes.push(`${badge(e)}: SoDEX reports ${fmtRate(read.taker)} / ${fmtRate(read.maker)}. The published table for this tier differs, so the rate above is SoDEX's.`);
    }
    const outside = (kind: string, raw: number | null, max: number) => {
      if (raw != null && Number.isInteger(raw) && (raw < 0 || raw > max)) {
        notes.push(`SoDEX reports ${kind} ${raw} on ${word(e)}, outside this table.`);
      }
    };
    outside('fee tier', read.feeTier, FEE_TIERS.length - 1);
    outside('staking tier', read.stakingTier, STAKING_TIERS.length - 1);
    outside('maker rebate tier', read.makerRebateTier, MAKER_REBATE_TIERS.length);
  }

  return (
    <Modal open={open} onClose={onClose} title="Fee Schedule" size="md" className="fx fee-sched">
      <div className="fee-sched__card">
        {(['perps', 'spot'] as const).map((e) => (
          <EngineHead
            key={e}
            engine={e}
            read={connected ? live[e] : null}
            connected={connected}
            loading={connected && live.loading}
            failed={connected && (e === 'perps' ? !!live.perpsError : !!live.spotError)}
            entry={e === engine}
          />
        ))}
      </div>

      <div className="segmented fee-sched__switch" role="group" aria-label="Fee tables">
        <button type="button" className={which === 'sodex' ? 'active' : ''} aria-pressed={which === 'sodex'} onClick={() => setWhich('sodex')}>
          SoDEX
        </button>
        <button type="button" className={which === 'valuedesk' ? 'active' : ''} aria-pressed={which === 'valuedesk'} onClick={() => setWhich('valuedesk')}>
          ValueDesk
        </button>
      </div>

      {which === 'valuedesk' ? (
        <ValueDesk address={address} />
      ) : (
        <Sodex feeRows={feeRows} other={other} stake={stake} rebates={rebates} />
      )}

      {which === 'sodex' && notes.map((n) => <p key={n} className="fee-sched__note">{n}</p>)}

      {which === 'sodex' && (
        <a className="fee-sched__more" href={FEE_DOC_URL} target="_blank" rel="noreferrer">
          Learn More
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M4.5 2.5h5v5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M9.5 2.5 2.5 9.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </a>
      )}
    </Modal>
  );
}

function Here() {
  return <span className="fee-sched__pill">You're here</span>;
}

function EngineHead({
  engine,
  read,
  connected,
  loading,
  failed,
  entry,
}: {
  engine: FeeEngine;
  read: VenueFeeRead | null;
  connected: boolean;
  loading: boolean;
  failed: boolean;
  entry: boolean;
}) {
  const base = effectiveFees(0, 0, engine);
  const waiting = connected && loading && !read;
  const taker = read?.taker ?? (!connected ? base?.taker ?? null : null);
  const maker = read?.maker ?? (!connected ? base?.maker ?? null : null);
  const ready = taker !== null && maker !== null;
  return (
    <div className="fee-sched__col">
      <div className="fee-sched__k">
        Effective Taker / Maker Fee
        <span className={entry ? 'fee-sched__eng is-on' : 'fee-sched__eng'}>{badge(engine)}</span>
      </div>
      <div className="fee-sched__pair">
        {waiting ? '…' : ready ? `${fmtHead(taker)} / ${fmtHead(maker)}` : '—'}
      </div>
      {!waiting && !ready && (
        <p className="fee-sched__note">
          {failed ? 'The fee-rate request failed.' : 'SoDEX returned no rate for this account.'}
        </p>
      )}
    </div>
  );
}

function Sodex({
  feeRows,
  other,
  stake,
  rebates,
}: {
  feeRows: { highlight: number | null; also: number | null };
  other: FeeEngine;
  stake: { highlight: number | null; split: boolean };
  rebates: { highlight: number | null; also: number | null };
}) {
  return (
    <>
      <section className="fee-sched__block">
        <h3>Fee Tiers</h3>
        <div className="fee-sched__frame">
          <table className="fee-sched__table">
            <thead>
              <tr>
                <th>Tier</th>
                <th>{VOLUME_WINDOW_DAYS}d Volume</th>
                <th className="num">Perps Taker</th>
                <th className="num">Perps Maker</th>
                <th className="num">Spot Taker</th>
                <th className="num">Spot Maker</th>
              </tr>
            </thead>
            <tbody>
              {FEE_TIERS.map((row) => {
                const you = feeRows.highlight === row.tier;
                const also = feeRows.also === row.tier;
                return (
                  <tr key={row.tier} className={you ? 'is-you' : undefined}>
                    <td>
                      {row.tier}
                      {you && <Here />}
                      {also && <span className="fee-sched__also">{badge(other)}</span>}
                    </td>
                    <td>{feeVolumeLabel(row.tier)}</td>
                    <td className="num">{fmtRate(row.perpsTaker)}</td>
                    <td className="num">{fmtRate(row.perpsMaker)}</td>
                    <td className="num">{fmtRate(row.spotTaker)}</td>
                    <td className="num">{fmtRate(row.spotMaker)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="fee-sched__block">
        <h3>Staking Tiers</h3>
        <div className="fee-sched__frame">
          <table className="fee-sched__table">
            <thead>
              <tr>
                <th>Trading Fee Discount</th>
                <th className="num">SOSO Staked</th>
              </tr>
            </thead>
            <tbody>
              {STAKING_TIERS.map((row) => {
                const you = !stake.split && stake.highlight === row.tier;
                return (
                  <tr key={row.tier} className={you ? 'is-you' : undefined}>
                    <td>
                      {Math.round(row.discount * 100)}%
                      {you && <Here />}
                    </td>
                    <td className="num">{row.tier === 0 ? '0 SOSO' : `≥${fmtSoso(row.soso)} SOSO`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="fee-sched__block">
        <h3>Maker Rebate Tiers</h3>
        <p className="fee-sched__lead">
          Maker rebates are excluded from the Fee Tier &amp; Staking Discount system. Fee rates as follows:
        </p>
        <div className="fee-sched__frame">
          <table className="fee-sched__table">
            <thead>
              <tr>
                <th>Tier</th>
                <th className="num">{VOLUME_WINDOW_DAYS}D Maker Volume Share</th>
                <th className="num">Maker</th>
              </tr>
            </thead>
            <tbody>
              {MAKER_REBATE_TIERS.map((row) => {
                const you = rebates.highlight === row.tier;
                const also = rebates.also === row.tier;
                return (
                  <tr key={row.tier} className={you ? 'is-you' : undefined}>
                    <td>
                      {row.tier}
                      {you && <Here />}
                      {also && <span className="fee-sched__also">{badge(other)}</span>}
                    </td>
                    <td className="num">&gt; {(row.minShare * 100).toFixed(2)}%</td>
                    <td className="num">{fmtRate(row.rebate)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function ValueDesk({ address }: { address: string | null }) {
  const reported = address ? currentTerms(address)?.display.tierIndex ?? null : null;
  const perpsFee = feeNow('perps', address);
  const spotFee = feeNow('spot', address);
  const perpsIdx = address ? builderTierIndex(perpsFee, 'perps', reported) : null;
  const spotIdx = address ? builderTierIndex(spotFee, 'spot', reported) : null;
  const view = address ? termsView(address) : null;
  const off: string[] = [];
  if (address && perpsIdx === null && perpsFee > 0) off.push(`perps ${fmtRate(builderRateToFraction(perpsFee))}`);
  if (address && spotIdx === null && spotFee > 0) off.push(`spot ${fmtRate(builderRateToFraction(spotFee))}`);

  const mark = (i: number): 'both' | 'perps' | 'spot' | null => {
    const p = perpsIdx === i;
    const s = spotIdx === i;
    if (p && s) return 'both';
    if (p) return 'perps';
    if (s) return 'spot';
    return null;
  };

  return (
    <>
      <section className="fee-sched__block">
        <h3>Futures &amp; spot</h3>
        <p className="fee-sched__lead">
          SoDEX charges this on top of its own fee, on perps and on spot sells.
          {' '}{address ? 'On orders now' : 'Default on orders'}: perps {fmtRate(builderRateToFraction(perpsFee))}, spot {fmtRate(builderRateToFraction(spotFee))}.
        </p>
        <div className="fee-sched__frame">
          <table className="fee-sched__table">
            <thead>
              <tr>
                <th>Tier</th>
                <th>{VOLUME_WINDOW_DAYS}d Volume</th>
                <th className="num">Perps</th>
                <th className="num">Spot</th>
              </tr>
            </thead>
            <tbody>
              {BUILDER_LADDER.map((row, i) => {
                const who = mark(i);
                return (
                  <tr key={row.minVolumeUsd} className={who === 'both' ? 'is-you' : undefined}>
                    <td>
                      {i}
                      {who === 'both' && <Here />}
                      {who && who !== 'both' && <span className="fee-sched__also">{badge(who)}</span>}
                    </td>
                    <td>{builderVolumeLabel(i)}</td>
                    <td className="num">{fmtRate(builderRateToFraction(row.perps))}</td>
                    <td className="num">{fmtRate(builderRateToFraction(row.spot))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {off.length > 0 && (
          <p className="fee-sched__note">
            Orders carry {off.join(' and ')}. The table has no row at that rate.
          </p>
        )}
        {view && view.volumeUsd !== null && (
          <p className="fee-sched__note">
            Counted volume {fmtUsd(view.volumeUsd, 0)}
            {view.volumeDays ? ` over the last ${view.volumeDays} days` : ''}.
            {view.next
              ? ` Next rate from $${Math.round(view.next.atUsd).toLocaleString('en-US')}: perps ${fmtRate(builderRateToFraction(view.next.fee.perps))}, spot ${fmtRate(builderRateToFraction(view.next.fee.spot))}.`
              : ''}
          </p>
        )}
      </section>

      <section className="fee-sched__block">
        <h3>Copy trading</h3>
        <p className="fee-sched__lead">No order is charged this rate yet.</p>
        <div className="fee-sched__frame">
          <table className="fee-sched__table">
            <thead>
              <tr>
                <th>Tier</th>
                <th>{VOLUME_WINDOW_DAYS}d Volume</th>
                <th className="num">Fee</th>
              </tr>
            </thead>
            <tbody>
              {COPY_LADDER.map((row, i) => (
                <tr key={row.minVolumeUsd}>
                  <td>{i}</td>
                  <td>{copyVolumeLabel(i)}</td>
                  <td className="num">{fmtRate(builderRateToFraction(row.fee))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
