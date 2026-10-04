/**
 * Fee schedule, opened from the order ticket and the dev panel.
 *
 * The sheet follows SoDEX's trade-ticket schedule: an effective pair for both
 * engines, then the three published tables. The pair is SoDEX's own rate plus
 * the ValueDesk builder fee on this account. The "You" marks are the indices
 * `/fee-rate` reported — volume tier and maker rebate per engine, staking from
 * both engines without collapsing them. A ValueDesk switch shows our builder
 * ladder; the header stays the combined rate either way.
 */
import { useState } from 'react';
import { builderRateToFraction } from '@sodex-core';
import {
  BUILDER_LADDER,
  builderTierIndex,
  builderVolumeLabel,
} from '../builderSchedule';
import {
  FEE_DOC_URL,
  FEE_TIERS,
  MAKER_REBATE_TIERS,
  STAKING_TIERS,
  VOLUME_WINDOW_DAYS,
  effectiveFees,
  feeTierRows,
  fmtRate,
  fmtSoso,
  fmtThreshold,
  makerRebateAt,
  rebateRows,
  stakingMark,
  withBuilder,
  type FeeEngine,
  type VenueFeeRead,
} from '../fees';
import { fmtUsd } from '../format';
import { currentTerms, feeNow, termsView } from '../trading/terms';
import { tradingConfig } from '../trading/config';
import { useBuilderFee } from './account/useBuilderFee';
import { Modal } from './Modal';
import { useVenueFees, type VenueFees } from './useVenueFees';
import './funds/funds.css';
import './FeeSchedule.css';

const near = (a: number, b: number): boolean =>
  Math.abs(a - b) <= Math.max(1e-12, Math.abs(b) * 1e-9);

const word = (e: FeeEngine): string => (e === 'perps' ? 'perps' : 'spot');
const badge = (e: FeeEngine): string => (e === 'perps' ? 'Perps' : 'Spot');

function volumeBand(index: number): string {
  const row = FEE_TIERS[index];
  if (!row) return '-';
  if (index === 0) {
    const next = FEE_TIERS[1];
    return next ? `≤ ${fmtThreshold(next.minVolume)}` : fmtThreshold(row.minVolume);
  }
  return `> ${fmtThreshold(row.minVolume)}`;
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

function formulaLine(engine: FeeEngine, read: VenueFeeRead): string | null {
  if (tableAgrees(engine, read) !== true) return null;
  if (read.feeTier === null || read.stakingTier === null) return null;
  const computed = effectiveFees(read.feeTier, read.stakingTier, engine);
  if (!computed) return null;
  const off = Math.round(computed.discount * 100);
  if (read.makerRebateTier !== null && read.makerRebateTier > 0) {
    return `Maker rebate ${fmtRate(read.maker)} stands in for the volume maker fee. Taker ${fmtRate(computed.baseTaker)} × (1 − ${off}%) = ${fmtRate(read.taker)}.`;
  }
  if (off <= 0) return null;
  return `${fmtRate(computed.baseTaker)} / ${fmtRate(computed.baseMaker)} × (1 − ${off}%) = ${fmtRate(read.taker)} / ${fmtRate(read.maker)}`;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** The engine the click came from. Its columns lead. */
  engine: FeeEngine;
  address: string | null;
  /** When the ticket already loaded both engines, skip a second fetch. */
  rates?: VenueFees;
}

export function FeeSchedule({ open, onClose, engine, address, rates }: Props) {
  const fetched = useVenueFees(address, open && rates === undefined);
  const live = rates ?? fetched;
  const [which, setWhich] = useState<'valuedesk' | 'sodex'>('sodex');
  const perpsQuote = useBuilderFee('perps', 'sell', address);
  const spotQuote = useBuilderFee('spot', 'sell', address);
  const builder = tradingConfig().builder;
  const showValueDesk = !!builder && (builder.fee.perps > 0 || builder.fee.spot > 0);
  const table = showValueDesk ? which : 'sodex';
  const connected = !!address;
  const other: FeeEngine = engine === 'spot' ? 'perps' : 'spot';
  const order: FeeEngine[] = engine === 'spot' ? ['spot', 'perps'] : ['perps', 'spot'];
  const entry = connected ? live[engine] : null;
  const otherRead = connected ? live[other] : null;

  const quoteOf = (e: FeeEngine) => (e === 'perps' ? perpsQuote : spotQuote);
  // Same addend the order row uses: the fee this side would be charged now.
  // A quote that is not charged (a spot buy, or a builder not on the order yet) adds nothing.
  const addOf = (e: FeeEngine) => {
    const q = quoteOf(e);
    if (!q || !q.charged) return { now: 0, full: 0, pending: showValueDesk && !q };
    return {
      now: q.fraction,
      full: builderRateToFraction(q.fullRate ?? q.rate),
      pending: q.status === 'required',
    };
  };

  const pending = order.some((e) => addOf(e).pending);
  const feeRows = feeTierRows(entry?.feeTier ?? null, otherRead?.feeTier ?? null);
  const stake = stakingMark(connected ? live.spot?.stakingTier ?? null : null, connected ? live.perps?.stakingTier ?? null : null);
  const rebates = rebateRows(entry?.makerRebateTier ?? null, otherRead?.makerRebateTier ?? null);

  const notes: string[] = [];
  if (connected && !live.loading && stake.split && live.spot?.stakingTier != null && live.perps?.stakingTier != null) {
    notes.push(`SoDEX reports staking tier ${live.perps.stakingTier} on perps and tier ${live.spot.stakingTier} on spot.`);
  }
  if (entry && otherRead && entry.makerRebateTier != null && otherRead.makerRebateTier != null && entry.makerRebateTier !== otherRead.makerRebateTier) {
    notes.push(`SoDEX reports maker rebate tier ${entry.makerRebateTier} on ${word(engine)} and tier ${otherRead.makerRebateTier} on ${word(other)}.`);
  }
  for (const e of order) {
    const read = e === engine ? entry : otherRead;
    if (!read) continue;
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
    <Modal open={open} onClose={onClose} title="Fee schedule" size="md" className="fx fee-sched">
      <div className="fee-sched__card">
        {order.map((e) => (
          <EffectCol
            key={e}
            engine={e}
            read={e === engine ? entry : otherRead}
            connected={connected}
            loading={connected && live.loading}
            failed={connected && (e === 'perps' ? !!live.perpsError : !!live.spotError)}
            add={addOf(e)}
            builderOn={showValueDesk}
          />
        ))}
      </div>

      {showValueDesk && (
        <p className="fee-sched__note">
          Spot buys carry no ValueDesk fee. The figures above include it on perps and on spot sells.
          {pending ? ' It applies once it is approved.' : ''}
        </p>
      )}

      {showValueDesk && (
        <div className="segmented fee-sched__switch">
          <button type="button" className={table === 'valuedesk' ? 'active' : ''} aria-pressed={table === 'valuedesk'} onClick={() => setWhich('valuedesk')}>
            ValueDesk
          </button>
          <button type="button" className={table === 'sodex' ? 'active' : ''} aria-pressed={table === 'sodex'} onClick={() => setWhich('sodex')}>
            SoDEX
          </button>
        </div>
      )}

      {table === 'valuedesk' ? (
        <ValueDesk address={address} />
      ) : (
        <Sodex
          order={order}
          feeRows={feeRows}
          other={other}
          stake={stake}
          rebates={rebates}
        />
      )}

      {notes.map((n) => <p key={n} className="fee-sched__note">{n}</p>)}

      {table === 'sodex' && (
        <a className="fee-sched__more" href={FEE_DOC_URL} target="_blank" rel="noreferrer">Learn more</a>
      )}
    </Modal>
  );
}

function EffectCol({
  engine,
  read,
  connected,
  loading,
  failed,
  add,
  builderOn,
}: {
  engine: FeeEngine;
  read: VenueFeeRead | null;
  connected: boolean;
  loading: boolean;
  failed: boolean;
  add: { now: number; full: number; pending: boolean };
  builderOn: boolean;
}) {
  const base = effectiveFees(0, 0, engine);
  const waiting = connected && loading && !read;
  const missing = connected && !loading && !read;
  const taker = read?.taker ?? (!connected ? base?.taker ?? null : null);
  const maker = read?.maker ?? (!connected ? base?.maker ?? null : null);
  const show = taker !== null && maker !== null && base;
  const wasT = base ? withBuilder(base.taker, add.full) : null;
  const wasM = base ? withBuilder(base.maker, add.full) : null;
  const nowT = show ? withBuilder(taker, add.now) : null;
  const nowM = show ? withBuilder(maker, add.now) : null;
  const strike = show && wasT !== null && wasM !== null && nowT !== null && nowM !== null
    && (nowT < wasT - 1e-9 || nowM < wasM - 1e-9);
  const venuePair = (t: number, m: number) => {
    if (!builderOn) return `SoDEX ${fmtRate(t)} / ${fmtRate(m)}`;
    if (add.pending && add.now === 0) return `SoDEX ${fmtRate(t)} / ${fmtRate(m)}. The ValueDesk fee applies once it is approved.`;
    return `SoDEX ${fmtRate(t)} / ${fmtRate(m)} + ValueDesk ${fmtRate(add.now)}`;
  };
  const line = read
    ? venuePair(read.taker, read.maker)
    : !connected && base
      ? venuePair(base.taker, base.maker)
      : failed
        ? 'The fee-rate request failed.'
        : 'SoDEX returned no rate for this account.';
  const formula = read ? formulaLine(engine, read) : null;

  return (
    <div className="fee-sched__col">
      <div className="fee-sched__k">
        <span>Effective taker / maker</span>
        <span className="fee-sched__badge">{badge(engine)}</span>
      </div>
      <div className="fee-sched__pair">
        {waiting || missing || nowT === null || nowM === null ? (
          <span>{waiting ? '…' : '—'}</span>
        ) : (
          <>
            {strike && wasT !== null && wasM !== null && (
              <s className="fee-sched__was">{fmtRate(wasT)} / {fmtRate(wasM)}</s>
            )}
            <span>{fmtRate(nowT)} / {fmtRate(nowM)}</span>
          </>
        )}
      </div>
      {!waiting && <p className="fee-sched__sub">{line}</p>}
      {formula && <p className="fee-sched__sub">{formula}</p>}
    </div>
  );
}

function Sodex({
  order,
  feeRows,
  other,
  stake,
  rebates,
}: {
  order: FeeEngine[];
  feeRows: { highlight: number | null; also: number | null };
  other: FeeEngine;
  stake: { highlight: number | null; split: boolean };
  rebates: { highlight: number | null; also: number | null };
}) {
  return (
    <>
      <section className="fee-sched__block">
        <h3>Fee tiers</h3>
        <div className="fee-sched__scroll">
          <table className="fee-sched__table">
            <thead>
              <tr>
                <th rowSpan={2}>Tier</th>
                <th className="num" rowSpan={2}>{VOLUME_WINDOW_DAYS}D volume</th>
                {order.map((e) => (
                  <th key={e} className="grp" colSpan={2}>{badge(e)}</th>
                ))}
              </tr>
              <tr>
                {order.flatMap((e) => [
                  <th key={`${e}-t`} className="num">Taker</th>,
                  <th key={`${e}-m`} className="num">Maker</th>,
                ])}
              </tr>
            </thead>
            <tbody>
              {FEE_TIERS.map((row) => {
                const you = feeRows.highlight === row.tier;
                const also = feeRows.also === row.tier;
                return (
                  <tr key={row.tier} className={you || also ? 'is-you' : undefined}>
                    <td>
                      {row.tier}
                      {you && <span className="fee-sched__you">You</span>}
                      {also && <span className="fee-sched__also">{badge(other)}</span>}
                    </td>
                    <td className="num">{volumeBand(row.tier)}</td>
                    {order.flatMap((e) => {
                      const taker = e === 'perps' ? row.perpsTaker : row.spotTaker;
                      const maker = e === 'perps' ? row.perpsMaker : row.spotMaker;
                      return [
                        <td key={`${row.tier}-${e}-t`} className="num">{fmtRate(taker)}</td>,
                        <td key={`${row.tier}-${e}-m`} className="num">{fmtRate(maker)}</td>,
                      ];
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="fee-sched__block">
        <h3>Staking tiers</h3>
        <div className="fee-sched__scroll">
          <table className="fee-sched__table">
            <thead>
              <tr>
                <th>Tier</th>
                <th className="num">Trading fee discount</th>
                <th className="num">SOSO staked</th>
              </tr>
            </thead>
            <tbody>
              {STAKING_TIERS.map((row) => {
                const you = !stake.split && stake.highlight === row.tier;
                return (
                  <tr key={row.tier} className={you ? 'is-you' : undefined}>
                    <td>
                      {row.tier}
                      {you && <span className="fee-sched__you">You</span>}
                    </td>
                    <td className="num">{Math.round(row.discount * 100)}%</td>
                    <td className="num">{row.tier === 0 ? '0' : `≥ ${fmtSoso(row.soso)}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="fee-sched__block">
        <h3>Maker rebate tiers</h3>
        <p className="fee-sched__note">A maker rebate replaces the volume-based maker fee. These rates stand on their own:</p>
        <div className="fee-sched__scroll">
          <table className="fee-sched__table">
            <thead>
              <tr>
                <th>Tier</th>
                <th className="num">{VOLUME_WINDOW_DAYS}D maker volume share</th>
                <th className="num">Maker</th>
              </tr>
            </thead>
            <tbody>
              {MAKER_REBATE_TIERS.map((row) => {
                const you = rebates.highlight === row.tier;
                const also = rebates.also === row.tier;
                return (
                  <tr key={row.tier} className={you || also ? 'is-you' : undefined}>
                    <td>
                      {row.tier}
                      {you && <span className="fee-sched__you">You</span>}
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

  const mark = (i: number): string | null => {
    const p = perpsIdx === i;
    const s = spotIdx === i;
    if (p && s) return 'You';
    if (p) return 'Perps';
    if (s) return 'Spot';
    return null;
  };

  return (
    <section className="fee-sched__block">
      <h3>ValueDesk fee</h3>
      <p className="fee-sched__note">
        SoDEX charges this on top of its own fee, on perps and on spot sells.
        {' '}{address ? 'On orders now' : 'Default on orders'}: perps {fmtRate(builderRateToFraction(perpsFee))}, spot {fmtRate(builderRateToFraction(spotFee))}.
      </p>
      <div className="fee-sched__scroll">
        <table className="fee-sched__table">
          <thead>
            <tr>
              <th>Tier</th>
              <th className="num">{VOLUME_WINDOW_DAYS}D volume</th>
              <th className="num">Perps</th>
              <th className="num">Spot</th>
            </tr>
          </thead>
          <tbody>
            {BUILDER_LADDER.map((row, i) => {
              const who = mark(i);
              return (
                <tr key={row.minVolumeUsd} className={who ? 'is-you' : undefined}>
                  <td>
                    {i}
                    {who && <span className={who === 'You' ? 'fee-sched__you' : 'fee-sched__also'}>{who}</span>}
                  </td>
                  <td className="num">{builderVolumeLabel(i)}</td>
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
            ? ` Next rate from ${fmtThreshold(view.next.atUsd)}: perps ${fmtRate(builderRateToFraction(view.next.fee.perps))}, spot ${fmtRate(builderRateToFraction(view.next.fee.spot))}.`
            : ''}
        </p>
      )}
    </section>
  );
}
