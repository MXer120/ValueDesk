/**
 * The ValueDesk mark: a "V" of five rounded blocks, a dot-matrix letter, the
 * two arms in white and the point in the app's green. Drawn bare - no tile, no
 * ring - for the rail and the navbar; public/favicon.svg (the tab icon) is the
 * same five blocks on a dark tile, so it reads on a light tab bar too.
 * Decorative: the wordmark or the link around it carries the name.
 */
const COLS = [0, 4, 1, 3, 2] as const;
const ROWS = [0, 0, 1, 1, 2] as const;
const W = 5.6;
const H = 7.2;
const GAP = 1;
const TOP = 4.2;

export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      {COLS.map((c, i) => (
        <rect
          key={i}
          x={c * (W + GAP)}
          y={TOP + ROWS[i]! * (H + GAP)}
          width={W}
          height={H}
          rx={1.5}
          fill={ROWS[i] === 2 ? '#00b481' : '#f4f4f4'}
        />
      ))}
    </svg>
  );
}
