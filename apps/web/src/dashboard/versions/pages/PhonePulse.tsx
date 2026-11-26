/**
 * Pulse on a phone (localhost version): chart first, the book under it, and the trade one thumb away - a Long and a
 * Short button held at the foot of the screen, over the tab bar. Either opens the ticket as a sheet with that side
 * chosen; a price picked in the book opens it too, with the price in it (as the original's carousel does).
 *
 * The sheet holds the same LiveOrderEntry with the same props as every other ticket, so the order is checked,
 * confirmed (TradeConfirm opens over the sheet) and signed exactly as anywhere else. The bar only chooses which
 * side the ticket shows; nothing is sent until the ticket's own button is pressed. The ticket stays mounted while
 * the sheet is down, so a size typed and closed is still there when it opens again; its glare rests while hidden.
 *
 * Both the bar and the sheet are portalled to <body>: inside a grid item (transformed) `position: fixed` would be
 * relative to the panel, not the screen. The sheet sits under the ticket's own floating menus (z 50) and over the
 * tab bar (29); the confirmation dialog is over everything.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSheetDrag } from '../../../components/motion';
import { LiveChart, LiveOrderEntry } from '../../livePrice';
import { CarouselPageProvider } from '../../MobileCarousel';
import type { TradeContext } from '../../registry';

type Side = 'buy' | 'sell';

export function PhonePulse({ c, bookTrades }: { c: TradeContext; bookTrades: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [ask, setAsk] = useState<{ side: Side; n: number } | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const perps = c.engine === 'perps';
  const word = (s: Side) => (perps ? (s === 'buy' ? 'Long' : 'Short') : (s === 'buy' ? 'Buy' : 'Sell'));
  const openAs = useCallback((side: Side | null) => {
    if (side) setAsk((a) => ({ side, n: (a?.n ?? 0) + 1 }));
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  useSheetDrag(sheetRef, { enabled: open, onDismiss: close });

  // The book's rows pick a price and open the ticket, the way the carousel's book does (registry.tsx BookPick).
  const nav = useMemo(() => ({ goTo: (key: string) => { if (key === 'exec') openAs(null); } }), [openAs]);

  // Esc closes; the page under an open sheet does not scroll.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) close(); };
    window.addEventListener('keydown', onKey);
    const root = document.documentElement;
    root.classList.add('pls-sheet-open');
    return () => {
      window.removeEventListener('keydown', onKey);
      root.classList.remove('pls-sheet-open');
    };
  }, [open, close]);
  // Down, the sheet is out of reach for the keyboard and for assistive tech, and marked off for the glare.
  useLayoutEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    el.inert = !open;
    el.toggleAttribute('data-off', !open);
  }, [open]);

  return (
    <CarouselPageProvider value={nav}>
      <div className="pls-phone">
        <div className="pls-phone__chart" role="region" aria-label="Chart">
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
        <div className="pls-phone__book" role="region" aria-label="Order book and trades">{bookTrades}</div>
      </div>
      {createPortal(
        <>
          <div className={`pls-bar${open ? ' is-hidden' : ''}`} role="group" aria-label="Trade">
            <button type="button" className="pls-bar__btn is-buy" onClick={() => openAs('buy')}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 10.5 8 6l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              {word('buy')}
            </button>
            <button type="button" className="pls-bar__btn is-sell" onClick={() => openAs('sell')}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 5.5 8 10l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              {word('sell')}
            </button>
          </div>
          <div className={`pls-scrim${open ? ' is-open' : ''}`} onClick={close} aria-hidden="true" />
          <div ref={sheetRef} className={`pls-sheet${open ? ' is-open' : ''}`} role="dialog" aria-modal={open} aria-label="Order entry">
            <div className="pls-sheet__head" data-sheet-handle="">
              <span className="sheet-grip" aria-hidden="true" />
              <b>{c.sym?.displayName ?? c.symbol}</b>
              <span className="pls-sheet__kind">{perps ? 'Perpetual' : 'Spot'}</span>
              <button type="button" className="pls-sheet__x" aria-label="Close the ticket" onClick={close}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              </button>
            </div>
            <div className="pls-sheet__body">
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
                sideRequest={ask}
              />
            </div>
          </div>
        </>,
        document.body,
      )}
    </CarouselPageProvider>
  );
}
