/**
 * Deck on a phone (localhost version): the book and the ticket side by side on one screen - the depth you price
 * against beside the box you size and send from - and the chart folded into a bar above them, opened with a tap.
 *
 * The same three things the original's carousel holds (registry.tsx): the book with its trades tab (`bookTrades`,
 * whose rows price this ticket), the chart, and the ticket - the same LiveOrderEntry with the same props, so the
 * order is checked, confirmed and signed exactly as it is anywhere else. The chart is mounted only while open: a
 * folded chart costs the phone nothing.
 */
import { useId, type ReactNode } from 'react';
import { useStored } from '../../../hooks';
import { LiveChart, LiveOrderEntry } from '../../livePrice';
import type { TradeContext } from '../../registry';

const Chevron = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const Candles = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
    <path d="M4 2.5v11M8 4v9M12 2v10" /><rect x="2.8" y="5" width="2.4" height="5" rx=".6" fill="currentColor" stroke="none" /><rect x="6.8" y="7" width="2.4" height="4" rx=".6" /><rect x="10.8" y="4" width="2.4" height="5" rx=".6" fill="currentColor" stroke="none" />
  </svg>
);

export function PhoneDeck({ c, bookTrades }: { c: TradeContext; bookTrades: ReactNode }) {
  const [open, setOpen] = useStored<boolean>('vs.dev.deck.chartOpen', false);
  const id = useId();
  return (
    <div className="pdk">
      <div className={`pdk-chart${open ? ' is-open' : ''}`}>
        <button type="button" className="pdk-chart__bar" aria-expanded={open} aria-controls={`${id}-chart`} onClick={() => setOpen(!open)}>
          <Candles />
          <span>Chart</span>
          <span className="pdk-chart__hint">{open ? 'Hide' : 'Show'}</span>
          <Chevron />
        </button>
        {open && (
          <div className="pdk-chart__body" id={`${id}-chart`} role="region" aria-label="Chart">
            <LiveChart
              engine={c.engine}
              symbol={c.symbol}
              sym={c.sym}
              address={c.address}
              unlocked={c.unlocked}
              refreshToken={c.refreshToken}
              onChanged={c.onChanged}
              onPrice={c.onPrice}
            />
          </div>
        )}
      </div>
      <div className="pdk-split">
        <div className="pdk-book" role="region" aria-label="Order book and trades">{bookTrades}</div>
        <div className="pdk-ticket" role="region" aria-label="Order entry">
          <LiveOrderEntry
            engine={c.engine}
            symbol={c.symbol}
            sym={c.sym}
            network={c.network}
            unlocked={c.unlocked}
            showTitle={false}
            connectedAddress={c.address}
            signingAddress={c.signingAddress}
            price={c.price}
            onPrice={c.onPrice}
            onPlaced={c.onChanged}
          />
        </div>
      </div>
    </div>
  );
}
