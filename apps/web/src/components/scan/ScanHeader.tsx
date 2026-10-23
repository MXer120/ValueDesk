/**
 * The Scan header: which venue you are reading, and the way to copy this trader.
 *
 * The venue switch sits on the right of the same `.dash-tabs__bar` band, same
 * 14px `.dash-tab` labels and the same 16x3 accent stub. Each venue carries its
 * logo. Switching is another view of this address: it only changes `?venue=`.
 * A venue with activity carries a small --pos dot. One without is grayed, logo
 * included, and says which kind of quiet it is: "Inactive" (an account with no
 * equity and nothing in 30 days) or "No account". Both can still be opened.
 *
 * COPY OR COUNTER-TRADE are the page's actions: the copy page's two buttons
 * (copy/TraderCard.tsx CopyButton), opening the copy setup for this trader on
 * the copy page (/copy?address=&venue=&direction=). Scan is the one trader page:
 * a trader picked on the copy page opens here. A venue a copy cannot follow
 * (Lighter, Arcus, trade.xyz) says so in their place.
 */
import { VenueLogo } from '../VenueLogo';
import { SCAN_VENUES, VENUE_LABEL, type Venue } from '../../vsApi';
import type { Presence } from './useVs';
import { CopyButton } from '../copy/TraderCard';
import { isCopyable } from '../copy/gridModel';
import './scan.css';

export interface ScanHeaderProps {
  venue: Venue;
  onVenue: (v: Venue) => void;
  presence: Partial<Record<Venue, Presence>>;
  /** The scanned address; null while nothing is scanned. */
  scanned: string | null;
  onNewSearch?: () => void;
}

/** The sentence beside the tabs, or null when there is nothing worth saying. */
export function presenceNote(venue: Venue, presence: Partial<Record<Venue, Presence>>): string | null {
  const here = presence[venue];
  const active = SCAN_VENUES.filter((v) => presence[v] === 'active');
  const elsewhere = active.filter((v) => v !== venue).map((v) => VENUE_LABEL[v]);
  if (here === 'active') {
    if (active.length > 1) return `Active on ${active.length} venues`;
    return SCAN_VENUES.every((v) => v === venue || (presence[v] && presence[v] !== 'loading')) ? `Active on ${VENUE_LABEL[venue]} only` : null;
  }
  if ((here === 'none' || here === 'inactive') && elsewhere.length) {
    return `${here === 'none' ? 'No account here' : 'Inactive here'} · active on ${elsewhere.join(', ')}`;
  }
  return null;
}

const TITLE: Record<Presence, string> = {
  active: 'This address has traded here',
  inactive: 'An account, but no equity and no trades in 30 days',
  none: 'No account for this address',
  unknown: 'Could not check this venue',
  loading: 'Checking…',
};

export function ScanHeader({ venue, onVenue, presence, scanned, onNewSearch }: ScanHeaderProps) {
  const note = scanned ? presenceNote(venue, presence) : null;
  const copy = (direction: 'copy' | 'counter') => {
    if (!scanned) return;
    window.location.href = `/copy?address=${encodeURIComponent(scanned)}&venue=${venue}&direction=${direction}`;
  };

  return (
    <div className="pf scan-head">
      <div className="dash-tabs__bar scan-head__bar">
        {note && <span className="scan-head__note">{note}</span>}
        <div className="dash-tabs__actions">
          <div className="scan-head__tabs" role="tablist" aria-label="Venue">
            {SCAN_VENUES.map((v) => {
              const here = presence[v] ?? 'unknown';
              const idle = !!scanned && (here === 'none' || here === 'inactive');
              return (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={v === venue}
                  className={`dash-tab scan-head__tab${v === venue ? ' is-active' : ''}${idle ? ' is-inactive' : ''}`}
                  title={scanned ? TITLE[here] : undefined}
                  onClick={() => onVenue(v)}
                >
                  <span className="scan-head__logo" aria-hidden="true"><VenueLogo venue={v} size={16} /></span>
                  {VENUE_LABEL[v]}
                  {scanned && here === 'active' && (
                    <span className="scan-head__dot" role="img" aria-label="active" />
                  )}
                  {idle && <span className="scan-head__idle">{here === 'none' ? 'No account' : 'Inactive'}</span>}
                </button>
              );
            })}
          </div>
          {onNewSearch && (
            <button type="button" className="dash-tab" onClick={onNewSearch}>New search</button>
          )}
          {scanned && (isCopyable(venue) ? (
            <span className="scan-head__copy">
              <CopyButton kind="counter" label="Counter-trade" title="Take the other side of every trade" onClick={() => copy('counter')} />
              <CopyButton kind="copy" label="Copy trader" title={`Set up copying ${VENUE_LABEL[venue]} trades from this address`} onClick={() => copy('copy')} />
            </span>
          ) : (
            <span className="scan-head__nocopy">Copying {VENUE_LABEL[venue]} traders is not supported yet</span>
          ))}
        </div>
      </div>
    </div>
  );
}
