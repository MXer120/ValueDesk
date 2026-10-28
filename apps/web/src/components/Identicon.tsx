/**
 * A wallet's identicon: a 5x5 mirrored grid in one hue, both from the address
 * (identicon.ts - FNV-1a, written in-house), so the same address
 * always gets the same face. Drawn for things that have no logo of their own -
 * a contact the user made for a bare address, an X account - instead of a
 * letter (owner, 2026-10-28: "no letter badges, logos everywhere").
 */
import { identicon } from '../identicon';

export function Identicon({ seed, size = 20, className = '', title }: { seed: string; size?: number; className?: string; title?: string }) {
  const { hue, cells } = identicon(seed || '?');
  return (
    <svg
      className={`identicon ${className}`}
      viewBox="0 0 5 5"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <rect width="5" height="5" fill={`hsl(${hue} 30% 18%)`} />
      {cells.map((on, i) => (on ? <rect key={i} x={i % 5} y={Math.floor(i / 5)} width="1" height="1" fill={`hsl(${hue} 65% 58%)`} /> : null))}
    </svg>
  );
}
