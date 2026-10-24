/**
 * "Powered by SoSoValue" with SoSoValue's mark - under the news everywhere it
 * shows (the News widget, the chart's news), "SoSoValue & more" where the
 * official calendars come in too (the Calendar, the chart's releases).
 *
 * Its look is inline so it needs no stylesheet of its own: the chart and the
 * News widget each load their own. The mark is SoSoValue's own app icon
 * (sosovalue.com/img/manifest/192x192.png: the white cube on its dark tile),
 * the version made for dark grounds, so it needs no chip behind it.
 */
import type { CSSProperties } from 'react';

const WRAP: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--dim)', fontSize: 'var(--fs-micro, 11px)', whiteSpace: 'nowrap' };
const MARK: CSSProperties = { display: 'block', flex: 'none', borderRadius: 4 };
const NAME: CSSProperties = { color: 'var(--muted)', fontWeight: 600 };

export function PoweredBy({ more = false }: { more?: boolean }) {
  return (
    <span style={WRAP}>
      Powered by
      <img src="/logos/brand/sosovalue.png" alt="" width={14} height={14} style={MARK} />
      <span style={NAME}>SoSoValue{more ? ' & more' : ''}</span>
    </span>
  );
}
