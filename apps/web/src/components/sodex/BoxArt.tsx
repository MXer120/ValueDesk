/**
 * A blind box: SoDEX's own closed-box picture, self-hosted under public/sodex-art (tools/fetch-sodex-art.mjs).
 * Until those files are in the build, or if one fails to load, a drawn cube stands in: same size, the
 * tier's colours. The colours are the tier's identity in both themes, so they are literals; they sit on
 * this mark only.
 */
import { useId, useState } from 'react';
import { isLevel, type Level } from '../../blindBox';

const COLORS: Record<Level, { top: string; left: string; right: string; ink: string }> = {
  Common: { top: '#d9d2bf', left: '#a79f8b', right: '#8a8371', ink: '#3d3a31' },
  Uncommon: { top: '#7fc4a0', left: '#3f8f6c', right: '#2c6f52', ink: '#e8fff3' },
  Rare: { top: '#7fb0ee', left: '#3a72c4', right: '#27559b', ink: '#eaf3ff' },
  SuperRare: { top: '#c79af0', left: '#8354c2', right: '#633a9c', ink: '#f6edff' },
};

export const boxArtSrc = (level: Level): string => `/sodex-art/box-${level.toLowerCase()}.webp`;

export function BoxArt({ level, size = 56 }: { level: string; size?: number }) {
  const tier: Level = isLevel(level) ? level : 'Common';
  const [failed, setFailed] = useState(false);
  if (!failed) {
    return (
      <img
        className="sdx-box"
        src={boxArtSrc(tier)}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(true)}
      />
    );
  }
  return <DrawnBox tier={tier} size={size} />;
}

function DrawnBox({ tier, size }: { tier: Level; size: number }) {
  const c = COLORS[tier];
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
    </svg>
  );
}
