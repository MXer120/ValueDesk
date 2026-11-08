/**
 * Ask which venue, once an address is on more than one.
 *
 * Each row is the venue, its total equity, the same PnL curve the explorer
 * draws, and last active. An inactive venue (no equity, nothing recent) stays
 * in the list, grayed, and can still be opened.
 */
import { EquityCurve, fmtDay } from '../portfolio/parts';
import { DASH, fmtUsd } from '../../format';
import { useMask } from '../../privacy';
import { VENUE_LABEL, type Venue } from '../../vsApi';
import { nettedEquity, type NettedEquity, type VenueCard } from './addressVenues';
import './scan.css';

export function VenueChooser({
  cards,
  lead,
  onPick,
  activeVenue,
  onHover,
}: {
  cards: VenueCard[];
  lead: string;
  onPick: (venue: Venue) => void;
  activeVenue?: Venue | null;
  onHover?: (venue: Venue) => void;
}) {
  const maskEquity = useMask('equity');
  const net = nettedEquity(cards);
  const both = cards.some((c) => c.venue === 'sodex') && cards.some((c) => c.venue === 'hyperliquid');
  if (!cards.length) return null;
  return (
    <div className="scan-choose" role="listbox" aria-label="Venue">
      {lead && <p className="scan-choose__lead">{lead}</p>}
      {both && <Netted net={net} />}
      {cards.map((card) => {
        const idle = card.inactive || card.unknown || !card.exists;
        const tag = card.unknown ? "Couldn't check" : !card.exists ? 'No account' : card.inactive ? 'Inactive' : null;
        const eq = card.equity === null ? DASH : fmtUsd(card.equity);
        return (
          <button
            key={card.venue}
            type="button"
            role="option"
            aria-selected={card.venue === activeVenue}
            data-nav-id={`x:open:${card.venue}`}
            className={`scan-choose__row${idle ? ' is-inactive' : ''}${card.venue === activeVenue ? ' is-on' : ''}`}
            onMouseEnter={() => onHover?.(card.venue)}
            onClick={() => onPick(card.venue)}
          >
            <span className="scan-choose__name">
              {VENUE_LABEL[card.venue]}
              {tag && <span className="scan-choose__tag">{tag}</span>}
            </span>
            <span className="scan-choose__eq">
              <span className="scan-choose__meta">Total equity</span>
              {maskEquity(eq)}
            </span>
            <span className="scan-choose__chart">
              <span className="scan-choose__meta">PnL</span>
              {card.curve ? <EquityCurve win={card.curve} compactAxis privacy="pnl" /> : <span className="scan-choose__dash">{DASH}</span>}
            </span>
            <span className="scan-choose__when">
              <span className="scan-choose__meta">Last active</span>
              {fmtDay(card.lastActive)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Netted({ net }: { net: NettedEquity }) {
  const mask = useMask('equity');
  const value = net.equity === null ? DASH : fmtUsd(net.equity);
  const note = net.unread > 0
    ? 'One venue did not answer, so this is only the balance we could read.'
    : 'SoDEX and Hyperliquid added together.';
  return (
    <div className="scan-choose__net">
      <span className="scan-choose__name">Both venues</span>
      <span className="scan-choose__eq">
        <span className="scan-choose__meta">Netted equity</span>
        {mask(value)}
      </span>
      <span className="scan-choose__netnote">{note}</span>
    </div>
  );
}
