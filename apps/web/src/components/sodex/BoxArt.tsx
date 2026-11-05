/**
 * A blind box, drawn here (an isometric cube in the tier's colours). SoDEX's own art stays SoDEX's.
 * The colours are the tier's identity, in both themes, so they are literals; they sit on this mark only.
 */
import { useId } from 'react';
import { isLevel, type Level } from '../../blindBox';

const COLORS: Record<Level, { top: string; left: string; right: string; ink: string }> = {
  Common: { top: '#d9d2bf', left: '#a79f8b', right: '#8a8371', ink: '#3d3a31' },
  Uncommon: { top: '#7fc4a0', left: '#3f8f6c', right: '#2c6f52', ink: '#e8fff3' },
  Rare: { top: '#7fb0ee', left: '#3a72c4', right: '#27559b', ink: '#eaf3ff' },
  SuperRare: { top: '#c79af0', left: '#8354c2', right: '#633a9c', ink: '#f6edff' },
};

export function BoxArt({ level, size = 56 }: { level: string; size?: number }) {
  const c = COLORS[isLevel(level) ? level : 'Common'];
  const id = useId();
  return (
    <svg className="sdx-box" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.35" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M32 6 56 19.500 32 33 8 19.500z" fill={c.top} />
      <path d="M32 6 56 19.500 32 33 8 19.500z" fill={`url(#${id}t)`} />
      <path d="M8 19.500 32 33v25L8 44.500z" fill={c.left} />
      <path d="M56 19.500 32 33v25l24-13.500z" fill={c.right} />
      <path d="M20 12.750 44 26.250v6.500M44 12.750 20 26.250v6.500" fill="none" stroke={c.ink} strokeOpacity="0.28" strokeWidth="2" />
      <path d="M32 33v25" stroke="#000" strokeOpacity="0.18" strokeWidth="1" />
      <text x="20" y="45" textAnchor="middle" fontSize="13" fontWeight="700" fill={c.ink} opacity="0.85" transform="skewY(29)" style={{ transformOrigin: '20px 39px' }}>?</text>
      <text x="44" y="45" textAnchor="middle" fontSize="13" fontWeight="700" fill={c.ink} opacity="0.85" transform="skewY(-29)" style={{ transformOrigin: '44px 39px' }}>?</text>
    </svg>
  );
}
