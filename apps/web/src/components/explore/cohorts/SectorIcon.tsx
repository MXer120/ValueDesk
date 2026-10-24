/**
 * One line icon per sector (cohorts model.ts SECTORS), drawn like CohortIcon:
 * a 24-unit box, a 1.6 stroke in the current colour.
 */
import type { Sector } from '@sign/valuescan/cohorts/model.js';

const PATHS: Record<Sector, string> = {
  // A crown: the largest coins.
  majors: 'M4 17 5.5 8l4.5 4 2-6 2 6 4.5-4L20 17zM4.5 20h15',
  // Stacked layers.
  layer1: 'M12 4l8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4',
  // A swap.
  defi: 'M5 8h13M15 4.5 18.5 8 15 11.5M19 16H6M9 12.5 5.5 16 9 19.5',
  // A grin.
  memes: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM9 10h.01M15 10h.01M8.5 14c.9 1.4 2 2 3.5 2s2.6-.6 3.5-2',
  // A spark.
  ai: 'M12 3.5l1.7 5 5 1.7-5 1.7-1.7 5-1.7-5-5-1.7 5-1.7zM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
  // An exchange building.
  equities: 'M4 9l8-4.5L20 9M5.5 9.5v8M9.8 9.5v8M14.2 9.5v8M18.5 9.5v8M3.5 20h17',
  // A rising line.
  indices: 'M4 16.5l5-5 3.5 3 7.5-7.5M15 7h5v5M4 20h16',
  // A drop of oil.
  commodities: 'M12 3.5c3.2 4.2 5.5 7 5.5 10a5.5 5.5 0 0 1-11 0c0-3 2.3-5.8 5.5-10z',
  // A globe.
  fx: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5M12 3.5C9.7 5.9 8.6 8.7 8.6 12s1.1 6.1 3.4 8.5',
  // Everything else.
  other: 'M5 5h5v5H5zM14 5h5v5h-5zM5 14h5v5H5zM14 14h5v5h-5z',
};

export function SectorIcon({ sector, size = 16 }: { sector: Sector; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[sector]} />
    </svg>
  );
}
