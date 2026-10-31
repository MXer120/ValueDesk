/** Volume routed through ValueDesk and the builder fees it earned (admin/builderStats.ts). */
import { useState } from 'react';
import { BarChart } from '../BarChart';
import { bp, dayLabel, int, usd, usdShort, when } from '../format';
import { Empty, Figure, Figures, Note, Page, Section, Seg, useAdmin } from '../ui';
import { accountEarnedMicro, type BuilderAccount, type BuilderOverview } from '../types';

export function Revenue() {
  const [days, setDays] = useState(30);
  const r = useAdmin<{ builder: BuilderOverview | null; account?: BuilderAccount | null; volumeDays: number | null }>('builder', { days }, 120_000);
  const b = r.data?.builder ?? null;
  const acct = r.data?.account ?? null;
  return (
    <Page
      title={acct ? `${usd(accountEarnedMicro(acct))} earned` : b ? `${usd(b.fees.lifetime.perps + b.fees.lifetime.spot)} counted` : 'Volume & fees'}
      line="Volume routed through ValueDesk's SoDEX builder and the builder fees it earned - counted from SoDEX fills, each order checked on SoDEX's explorer."
      tone={b ? 'pos' : 'unknown'}
      loaded={r}
      wide
      tools={<Seg label="Days shown" value={days} onChange={setDays} options={[7, 30, 90].map((d) => ({ value: d, label: `${d} days` }))} />}
    >
      {r.error && <Section><Note kind="error">{r.error}</Note></Section>}
      {r.data && !b && <Section><Empty>The builder ledger is off on this server (no builder-tiers.json, or no builder.db yet).</Empty></Section>}
      {b && (
        <>
          <Section>
            <Figures>
              <Figure label="Earned, builder account" value={acct ? usd(accountEarnedMicro(acct)) : '–'} tone={acct ? 'pos' : undefined} sub={acct ? `perps ${acct.perps.toFixed(2)} · spot ${acct.spot.toFixed(2)} vUSDC, ${acct.funded} put in` : 'SoDEX did not answer'} />
              <Figure label="Counted per wallet (ledger)" value={usd(b.fees.lifetime.perps + b.fees.lifetime.spot)} sub={`7 days ${usd(b.fees.d7)} · today ${usd(b.fees.d1)}`} />
              <Figure label="Volume, today (UTC)" value={usdShort(b.volume.d1)} sub={`7 days ${usdShort(b.volume.d7)} · 30 days ${usdShort(b.volume.d30)}`} />
              <Figure label="Volume, all time" value={usdShort(b.volume.lifetime.perps + b.volume.lifetime.spot)} sub={`perps ${usdShort(b.volume.lifetime.perps)} · spot ${usdShort(b.volume.lifetime.spot)}`} />
            </Figures>
          </Section>
          <Section title="Per day">
            <div className="dv-charts">
              <BarChart title="Volume" bars={b.days.map((d) => ({ key: d.day, label: dayLabel(d.day), value: d.perps + d.spot }))} fmt={usd} fmtAxis={usdShort} />
              <BarChart title="Fees" bars={b.days.map((d) => ({ key: d.day, label: dayLabel(d.day), value: d.feePerps + d.feeSpot }))} fmt={usd} fmtAxis={usdShort} />
            </div>
          </Section>
          <Section title="Wallets">
            <Figures>
              <Figure label="On the builder ledger" value={int(b.wallets.total)} />
              <Figure label="Traded, 7 days" value={int(b.wallets.traded7d)} />
              <Figure label="Traded, 30 days" value={int(b.wallets.traded30d)} />
              <Figure label="Flagged" value={int(b.wallets.flagged)} tone={b.wallets.flagged ? 'warn' : undefined} sub="underpaid or tampered orders" />
            </Figures>
          </Section>
          <Section title={`Fee tiers, by ${r.data?.volumeDays ? `${r.data.volumeDays}-day` : 'lifetime'} counted volume`} flush>
            <div className="dv-sheet">
              <table className="dv-table">
                <thead><tr><th>Tier</th><th className="right">From</th><th className="right">Perps</th><th className="right">Spot</th><th className="right">Wallets</th></tr></thead>
                <tbody>{b.tiers.map((t) => <tr key={t.index}><td>Tier {t.index}</td><td className="right">${int(t.minVolumeUsd)}</td><td className="right">{bp(t.perps)}</td><td className="right">{bp(t.spot)}</td><td className="right">{int(t.wallets)}</td></tr>)}</tbody>
              </table>
            </div>
          </Section>
          <div className="st-foot">
            Earned = the builder account's vUSDC on SoDEX (every builder fee is credited there at once) minus what was put in. The ledger counts only wallets it was told about (a trade from the app leaves a hint); hosted copies and other trades are in the account's total but not per wallet. Builder {b.builderId}; ledger since {when(b.ledgerSince)}. Counted = fills that paid our builder fee on orders the SoDEX explorer shows naming our builder at the fee owed; fee = counted notional × the order's fee / 100 000, exactly what SoDEX charges. Days are UTC; an order's fee goes on the day of its latest fill.
          </div>
        </>
      )}
    </Page>
  );
}
