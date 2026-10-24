/**
 * "Powered by SoSoValue" with SoSoValue's mark - under the news everywhere it
 * shows (the News widget, the chart's news), "SoSoValue & more" where the
 * official calendars come in too (the Calendar, the chart's releases).
 *
 * Its look is inline so it needs no stylesheet of its own: the chart and the
 * News widget each load their own. The mark is black on clear, so it sits on a
 * light chip to read on the dark panels.
 */
import type { CSSProperties } from 'react';

const WRAP: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--dim)', fontSize: 'var(--fs-micro, 11px)', whiteSpace: 'nowrap' };
const CHIP: CSSProperties = { display: 'inline-grid', placeItems: 'center', width: 14, height: 14, borderRadius: 4, background: '#f2f2f2', flex: 'none' };
const NAME: CSSProperties = { color: 'var(--muted)', fontWeight: 600 };

export function PoweredBy({ more = false }: { more?: boolean }) {
  return (
    <span style={WRAP}>
      Powered by
      <span style={CHIP} aria-hidden>
        <img src="/logos/tokens/soso.png" alt="" width={11} height={11} style={{ display: 'block' }} />
      </span>
      <span style={NAME}>SoSoValue{more ? ' & more' : ''}</span>
    </span>
  );
}
