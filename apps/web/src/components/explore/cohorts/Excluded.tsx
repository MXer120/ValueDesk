/**
 * The wallets left out of the cohorts and the liquidation heatmap (server internalWallets.ts,
 * /api/vs/excluded), listed with why and what they hold now: nothing is left out unsaid (owner
 * 2026-10-31). A venue's own accounts (SoDEX's mirrored BTC pair) and hedged desks (Abraxas
 * Capital on Hyperliquid) - neither is a view on the market, and each was large enough to tilt
 * a cohort or paint a band across the map.
 */
import { useState } from 'react';
import { VENUE_LABEL, vsApi, type ExcludedWallet } from '../../../vsApi';
import { shortAddr } from '../../../format';
import { Modal } from '../../Modal';
import { VenueLogo } from '../../VenueLogo';
import { fmtUsdShort } from '../model';
import { usePolled } from './parts';

const KIND_LABEL: Record<ExcludedWallet['kind'], string> = { internal: 'Venue account', hedged: 'Hedged desk' };

export function ExcludedButton() {
  const [open, setOpen] = useState(false);
  // Read once the list is asked for; it changes only with a release (the figures with the books).
  const r = usePolled(open ? 'excluded' : null, (signal) => vsApi.excluded(signal));
  const rows = r.data?.wallets ?? [];
  return (
    <>
      <button type="button" className="coh-excl" onClick={() => setOpen(true)} title="Wallets left out of the cohorts and the liquidation heatmap, and why">
        Excluded wallets
      </button>
      <Modal open={open} title="Excluded wallets" size="lg" onClose={() => setOpen(false)}>
        <p className="coh-excl__lead">
          Left out of every cohort and the liquidation heatmap: a venue's own accounts and hedged desks hold
          positions that are no view on the market. Their open interest is also taken off the venue's,
          so coverage still compares like with like.
        </p>
        {r.error && !r.data ? <p className="coh-excl__lead">The list could not be read: {r.error}</p> : null}
        {!r.data && !r.error ? <p className="coh-excl__lead">Loading…</p> : null}
        {rows.length > 0 && (
          <table className="acct-table coh-excl__table">
            <thead>
              <tr><th>Wallet</th><th>Type</th><th className="num">Equity</th><th className="num">Long</th><th className="num">Short</th><th>Largest</th></tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={`${w.venue}|${w.address}`} title={w.why}>
                  <td>
                    <span className="coh-excl__who">
                      <VenueLogo venue={w.venue} size={16} />
                      <span>
                        <b>{w.label ?? shortAddr(w.address)}</b>
                        <small>{VENUE_LABEL[w.venue]} · {shortAddr(w.address)} · since {w.since}</small>
                        <small className="coh-excl__why">{w.why}</small>
                      </span>
                    </span>
                  </td>
                  <td>{KIND_LABEL[w.kind]}</td>
                  <td className="num">{w.equity === null ? '–' : fmtUsdShort(w.equity)}</td>
                  <td className="num">{w.at === null ? '–' : fmtUsdShort(w.long)}</td>
                  <td className="num">{w.at === null ? '–' : fmtUsdShort(w.short)}</td>
                  <td>{w.coins.slice(0, 3).map((c) => `${c.coin} ${c.usd < 0 ? '−' : '+'}${fmtUsdShort(Math.abs(c.usd))}`).join(', ') || '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>
    </>
  );
}
