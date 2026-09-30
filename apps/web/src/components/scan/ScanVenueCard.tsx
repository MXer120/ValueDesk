/**
 * One venue under the scan search. The curve is only the line: no scale,
 * no grid, no "PnL" label. Equity sits on the line, last active on the right.
 */
import { VenueLogo } from '../VenueLogo';
import { DASH, fmtUsd } from '../../format';
import { brandLogo, coinLogo } from '../../logos';
import { useMask } from '../../privacy';
import { VENUE_LABEL, type Venue } from '../../vsApi';
import type { VenueCard } from './addressVenues';
import type { HlCurve } from './hlModel';

function ago(ms: number | null): string {
  if (!ms) return DASH;
  const d = Date.now() - ms;
  if (d < 60 * 60 * 1000) return 'just now';
  if (d < 24 * 60 * 60 * 1000) return `${Math.max(1, Math.round(d / (60 * 60 * 1000)))}h ago`;
  return `${Math.max(1, Math.round(d / (24 * 60 * 60 * 1000)))}d ago`;
}

function Spark({ curve }: { curve: HlCurve }) {
  const pts = curve.points;
  const vs = pts.map((p) => p.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min || 1;
  const w = 320;
  const h = 84;
  const d = pts.map((p, i) => {
    const x = (i / (pts.length - 1)) * w;
    const y = h - 6 - ((p.v - min) / span) * (h - 16);
    return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  const up = (pts[pts.length - 1]?.v ?? 0) >= (pts[0]?.v ?? 0);
  return (
    <svg className="scan-card__spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke={up ? 'var(--pos)' : 'var(--neg)'} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function HlMark({ size = 22 }: { size?: number }) {
  const src = brandLogo('HYPERLIQUID') ?? brandLogo('HYPE') ?? coinLogo('HYPE');
  return src
    ? <img className="scan-card__logo" src={src} alt="" width={size} height={size} />
    : <span className="scan-card__mono" style={{ width: size, height: size }}>H</span>;
}

function Mark({ venue, size = 28 }: { venue: Venue; size?: number }) {
  return <span className="scan-card__mark" aria-hidden="true"><VenueLogo venue={venue} size={size} className="scan-card__logo" /></span>;
}

/** Top right: when it last traded, or which kind of quiet it is. */
function status(card: VenueCard): { text: string; idle: boolean } {
  if (card.pending) return { text: '', idle: false };
  if (card.unknown) return { text: "Couldn't check", idle: true };
  if (!card.exists) return { text: 'No account', idle: true };
  if (card.inactive) return { text: card.lastActive ? `Inactive · ${ago(card.lastActive)}` : 'Inactive', idle: true };
  return { text: ago(card.lastActive), idle: false };
}

export function ScanVenueCard({ card, onPick }: { card: VenueCard; onPick: (venue: Venue) => void }) {
  const mask = useMask('equity');
  const maskPnl = useMask('pnl');
  const last = card.curve?.points[card.curve.points.length - 1]?.v;
  const equity = card.equity === null ? DASH : fmtUsd(card.equity);
  const pnl = last === undefined ? null : fmtUsd(last);
  const idle = !card.pending && (card.inactive || !card.exists);
  const name = VENUE_LABEL[card.venue];
  const st = status(card);
  return (
    <button
      type="button"
      className={`scan-card${idle ? ' is-idle' : ''}${!card.pending && !card.exists ? ' is-none' : ''}${card.pending ? ' is-pending' : ''}`}
      onClick={() => { if (!card.pending) onPick(card.venue); }}
      disabled={card.pending}
    >
      <span className="scan-card__top">
        <span className="scan-card__name">
          <Mark venue={card.venue} />
          <b>
            <span className="scan-card__glow" aria-hidden="true">{name}</span>
            {name}
          </b>
        </span>
        <span className={`scan-card__ago${st.idle ? ' is-idle' : ''}`}>{st.text}</span>
      </span>
      <span className="scan-card__chart" title={pnl ? `PnL ${maskPnl(pnl)}` : card.historyNote ?? undefined}>
        {card.curve ? <Spark curve={card.curve} /> : <span className="scan-card__empty" />}
        {pnl && <span className="scan-card__pnl">{maskPnl(pnl)}</span>}
      </span>
      <span className="scan-card__eq">
        <span>Total equity</span>
        <span>{card.pending ? '' : mask(equity)}</span>
      </span>
    </button>
  );
}
