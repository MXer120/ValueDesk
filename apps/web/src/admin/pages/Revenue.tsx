/** Volume routed through ValueDesk and the builder fees it earned (admin/builderStats.ts). */
import { useState } from 'react';
import { BarChart } from '../BarChart';
import { bp, dayLabel, int, usd, usdShort, when } from '../format';
import { Note, PageHead, Panel, Tile, useAdmin } from '../ui';
import type { BuilderOverview } from '../types';

export function Revenue() {
  const [days, setDays] = useState(30);
  const r = useAdmin<{ builder: BuilderOverview | null; volumeDays: number | null }>('builder', { days }, 120_000);
  const b = r.data?.builder ?? null;
  return (
    <>
      <PageHead title="Volume & fees" loaded={r}>
        <select className="ad-input ad-input--small" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Days shown">
          {[7, 30, 90].map((d) => <option key={d} value={d}>last {d} days</option>)}
        </select>
      </PageHead>
      {r.error && <Note kind="error">{r.error}</Note>}
      {r.data && !b && <Note>The builder ledger is off on this server (no builder-tiers.json, or no builder.db yet).</Note>}
      {b && (
        <>
          <div className="ad-tiles">
            <Tile label="Fees earned, today (UTC)" value={usd(b.fees.d1)} sub={`7 d ${usd(b.fees.d7)} · 30 d ${usd(b.fees.d30)}`} />
            <Tile label="Fees earned, all time" value={usd(b.fees.lifetime.perps + b.fees.lifetime.spot)} sub={`perps ${usd(b.fees.lifetime.perps)} · spot ${usd(b.fees.lifetime.spot)}`} />
            <Tile label="Volume, today (UTC)" value={usdShort(b.volume.d1)} sub={`7 d ${usdShort(b.volume.d7)} · 30 d ${usdShort(b.volume.d30)}`} />
            <Tile label="Volume, all time" value={usdShort(b.volume.lifetime.perps + b.volume.lifetime.spot)} sub={`perps ${usdShort(b.volume.lifetime.perps)} · spot ${usdShort(b.volume.lifetime.spot)}`} />
            <Tile label="Wallets" value={int(b.wallets.total)} sub={`traded 7 d ${b.wallets.traded7d} · 30 d ${b.wallets.traded30d}`} />
            <Tile label="Flagged wallets" value={int(b.wallets.flagged)} tone={b.wallets.flagged ? 'warn' : undefined} sub="underpaid or tampered orders" />
          </div>
          <div className="ad-grid2">
            <Panel title="Counted volume per day">
              <BarChart title="Volume" bars={b.days.map((d) => ({ key: d.day, label: dayLabel(d.day), value: d.perps + d.spot }))} fmt={usd} fmtAxis={usdShort} />
            </Panel>
            <Panel title="Builder fees per day">
              <BarChart title="Fees" bars={b.days.map((d) => ({ key: d.day, label: dayLabel(d.day), value: d.feePerps + d.feeSpot }))} fmt={usd} fmtAxis={usdShort} />
            </Panel>
          </div>
          <Panel title={`Fee tiers (by ${r.data?.volumeDays ? `${r.data.volumeDays}-day` : 'lifetime'} counted volume)`}>
            <table className="ad-table ad-table--compact">
              <thead><tr><th>Tier</th><th className="num">From</th><th className="num">Perps</th><th className="num">Spot</th><th className="num">Wallets</th></tr></thead>
              <tbody>{b.tiers.map((t) => <tr key={t.index}><td>{t.index}</td><td className="num">${int(t.minVolumeUsd)}</td><td className="num">{bp(t.perps)}</td><td className="num">{bp(t.spot)}</td><td className="num">{int(t.wallets)}</td></tr>)}</tbody>
            </table>
          </Panel>
          <p className="ad-dim">Builder {b.builderId}; ledger since {when(b.ledgerSince)}. Counted = fills that paid our builder fee on orders the SoDEX explorer shows naming our builder at the fee owed; fee = counted notional × the order's fee / 100 000, exactly what SoDEX charges. Days are UTC; an order's fee goes on the day of its latest fill.</p>
        </>
      )}
    </>
  );
}
