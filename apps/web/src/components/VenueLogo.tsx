/**
 * A venue's own mark, from our self-hosted copies (tools/fetch-logos.mjs for
 * SoDEX, tools/fetch-venue-logos.mjs for the rest). A venue without a file
 * yet gets its first letter.
 */
import type { CSSProperties } from 'react';
import { brandLogo } from '../logos';
import type { Venue } from '../vsApi';
import { SodexMark } from './funds/ui';

const BRAND_KEY: Record<Venue, string> = {
  sodex: 'SODEX',
  hyperliquid: 'HYPERLIQUID',
  tradexyz: 'TRADEXYZ',
  lighter: 'LIGHTER',
  arcus: 'ARCUS',
};

export function VenueLogo({ venue, size = 16, className = '' }: { venue: Venue; size?: number; className?: string }) {
  if (venue === 'sodex') return <SodexMark size={size} />;
  const src = brandLogo(BRAND_KEY[venue]);
  const style: CSSProperties = { width: size, height: size, borderRadius: '50%', objectFit: 'cover', flex: 'none' };
  if (src) return <img className={`venue-logo ${className}`} src={src} alt="" width={size} height={size} style={style} draggable={false} />;
  return (
    <span className={`venue-logo venue-logo--mono ${className}`} style={{ ...style, display: 'inline-grid', placeItems: 'center', fontSize: Math.round(size * 0.55), fontWeight: 700 }}>
      {BRAND_KEY[venue].charAt(0)}
    </span>
  );
}
