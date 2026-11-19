/**
 * THE SETUP'S BUTTONS, ALWAYS IN REACH ON A PHONE (owner's open reminder; phone pass 2026-11-18).
 *
 * On a phone the receipt with Back / Next / Start sits under the whole step, so every step ended in a scroll to the
 * bottom of the page to go on. Below 761px the same buttons (the same elements' props, so the same handlers, labels,
 * disabled states and titles) are drawn in a bar fixed above the tab bar, with the step's one line of why-not; the
 * receipt's own row is hidden there (botsPages.css). Above 760px nothing is drawn.
 */
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from '../../hooks';

export function PhoneActionBar({ step, note, children }: { step: string; note?: ReactNode; children: ReactNode }) {
  const phone = useMediaQuery('(max-width: 760px)');
  if (!phone) return null;
  return createPortal(
    <div className="bots-actbar" role="region" aria-label="Setup actions">
      <div className="bots-actbar__row">
        <span className="bots-actbar__step">{step}</span>
        <div className="bots-actbar__act">{children}</div>
      </div>
      {note && <div className="bots-actbar__note" role="status">{note}</div>}
    </div>,
    document.body,
  );
}
