/**
 * Fee schedule, opened from the order ticket and the dev panel.
 *
 * The pair at the top is the venue rate plus the ValueDesk fee on that
 * engine. "You're here" on the SoDEX tables is the tier index `/fee-rate`
 * reported for that engine — fee tier, staking tier, maker-rebate tier —
 * kept apart when the two engines disagree. The ValueDesk tab is the
 * futures & spot ladder and the copy-trading ladder. The futures row is the
 * terms' tier index; the copy row is that same counted volume on the copy
 * ladder, which no order is charged yet.
 */
import { fmtFixed, localize } from '../numStyle';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { builderRateToFraction } from '@sodex-core';
import { BOT_FEE_LADDER, BOT_FEE_VIP } from '@copy-engine';
import {
  BUILDER_LADDER,
  COPY_LADDER,
  builderTierIndex,
  builderVolumeLabel,
  copyVolumeLabel,
  ladderIndex,
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
  rebateRows,
  stakingMark,
  withBuilder,
  type FeeEngine,
  type VenueFeeRead,
} from '../fees';
import { currentTerms, ensureTerms, feeNow, subscribeTerms, termsRevision } from '../trading/terms';
import { Modal } from './Modal';
import { CrossFade } from './motion';
import { Seg } from './palette/ui';
import { useVenueFees, type VenueFees } from './useVenueFees';
import './funds/funds.css';
import './FeeSchedule.css';

const badge = (e: FeeEngine): string => (e === 'perps' ? 'Perps' : 'Spot');

/** Header pair, trailing zeros dropped the way the venue ticket prints them. */
function fmtHead(rate: number): string {
  const s = (rate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return `${localize(s)}%`;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** The engine the click came from. Its row is "You're here". */
  engine: FeeEngine;
  address: string | null;
  /** When the ticket already loaded both engines, skip a second fetch. */
  rates?: VenueFees;
  /** Which tables to show when the sheet opens. */
  table?: 'sodex' | 'valuedesk';
}

export function FeeSchedule({ open, onClose, engine, address, rates, table = 'sodex' }: Props) {
  const fetched = useVenueFees(address, open && rates === undefined);
  const live = rates ?? fetched;
  const [which, setWhich] = useState<'sodex' | 'valuedesk'>(table);
  useSyncExternalStore(subscribeTerms, termsRevision, termsRevision);
  useEffect(() => {
    if (open) setWhich(table);
  }, [open, table]);
  useEffect(() => {
    if (!open || !address) return;
    void ensureTerms(address);
  }, [open, address]);
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
            address={address}
          />
        ))}
      </div>
      <div className="fee-sched__switch">
        <Seg
          label="Fee tables"
          value={which}
          onChange={setWhich}
          options={[
            { id: 'sodex', label: 'SoDEX' },
            { id: 'valuedesk', label: 'ValueDesk' },
          ]}
        />
      </div>

      <CrossFade viewKey={which}>
        <div className="fee-sched__tables">
          {which === 'valuedesk' ? (
            <ValueDesk address={address} />
          ) : (
            <Sodex feeRows={feeRows} other={other} stake={stake} rebates={rebates} />
          )}
          {which === 'sodex' && (
            <a className="fee-sched__more" href={FEE_DOC_URL} target="_blank" rel="noreferrer">
              Learn More
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                <path d="M4.5 2.5h5v5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M9.5 2.5 2.5 9.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </a>
          )}
        </div>
      </CrossFade>
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
  address,
}: {
  engine: FeeEngine;
  read: VenueFeeRead | null;
  connected: boolean;
  loading: boolean;
  failed: boolean;
  entry: boolean;
  address: string | null;
}) {
  const base = effectiveFees(0, 0, engine);
  const waiting = connected && loading && !read;
  const taker = read?.taker ?? (!connected ? base?.taker ?? null : null);
  const maker = read?.maker ?? (!connected ? base?.maker ?? null : null);
  const add = builderRateToFraction(feeNow(engine, connected ? address : null));
  const ready = taker !== null && maker !== null;
  return (
    <div className="fee-sched__col">
      <div className="fee-sched__k">
        Effective Taker / Maker Fee
        <span className={entry ? 'fee-sched__eng is-on' : 'fee-sched__eng'}>{badge(engine)}</span>
      </div>
      <div className="fee-sched__pair">
        {waiting ? '…' : ready ? `${fmtHead(withBuilder(taker, add))} / ${fmtHead(withBuilder(maker, add))}` : '—'}
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
                    <td className="num">&gt; {fmtFixed(row.minShare * 100, 2)}%</td>
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

/** The bot ladder's band labels, as the copy ladder's (the milestone belongs to the higher row). */
function botVolumeLabel(index: number): string {
  const row = BOT_FEE_LADDER[index];
  if (!row) return '-';
  const next = BOT_FEE_LADDER[index + 1];
  const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  if (index === 0 && next) return `< ${usd(next.fromUsd)}`;
  return `≥ ${usd(row.fromUsd)}`;
}

function ValueDesk({ address }: { address: string | null }) {
  const held = address ? currentTerms(address) : null;
  const reported = held?.display.tierIndex ?? null;
  const volume = held?.display.volumeUsd ?? null;
  const perpsFee = feeNow('perps', address);
  const inRange = reported !== null && reported >= 0 && reported < BUILDER_LADDER.length;
  const fromVolume = volume !== null ? ladderIndex(volume, BUILDER_LADDER.map((row) => row.minVolumeUsd)) : null;
  const row = inRange ? reported : fromVolume !== null ? fromVolume : address ? builderTierIndex(perpsFee, 'perps', null) : null;
  const copyRow = volume !== null ? ladderIndex(volume, COPY_LADDER.map((r) => r.minVolumeUsd)) : null;
  const botRow = volume !== null ? ladderIndex(volume, BOT_FEE_LADDER.map((r) => r.fromUsd)) : null;

  return (
    <>
      <section className="fee-sched__block">
        <h3>Futures &amp; spot</h3>
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
              {BUILDER_LADDER.map((tier, i) => (
                <tr key={tier.minVolumeUsd} className={row === i ? 'is-you' : undefined}>
                  <td>
                    {i}
                    {row === i && <Here />}
                  </td>
                  <td>{builderVolumeLabel(i)}</td>
                  <td className="num">{fmtRate(builderRateToFraction(tier.perps))}</td>
                  <td className="num">{fmtRate(builderRateToFraction(tier.spot))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="fee-sched__block">
        <h3>Bots</h3>
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
              {BOT_FEE_LADDER.map((tier, i) => (
                <tr key={tier.fromUsd} className={botRow === i ? 'is-you' : undefined}>
                  <td>
                    {i}
                    {botRow === i && <span className="fee-sched__pill">This volume</span>}
                  </td>
                  <td>{botVolumeLabel(i)}</td>
                  <td className="num">{fmtRate(builderRateToFraction(tier.fee))}</td>
                </tr>
              ))}
              <tr>
                <td>VIP</td>
                <td>≥ $1,000,000 own volume, or a VIP program</td>
                <td className="num">{fmtRate(builderRateToFraction(BOT_FEE_VIP))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="fee-sched__block">
        <h3>Copy trading</h3>
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
              {COPY_LADDER.map((tier, i) => (
                <tr key={tier.minVolumeUsd} className={copyRow === i ? 'is-you' : undefined}>
                  <td>
                    {i}
                    {copyRow === i && <span className="fee-sched__pill">This volume</span>}
                  </td>
                  <td>{copyVolumeLabel(i)}</td>
                  <td className="num">{fmtRate(builderRateToFraction(tier.fee))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
