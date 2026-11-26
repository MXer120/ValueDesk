/**
 * LOCALHOST ONLY (the switch's "Sample"): a made-up wallet's boxes, to judge the filled "Your boxes" parts without a
 * wallet that holds any. Never in a build (only BoxVersions.tsx imports it, behind import.meta.env.DEV). The ids are
 * invented; the page says "Sample" wherever they show.
 */
import type { WalletBoxes } from '../../../../blindBox';

const ids = (from: number, n: number, step: number): string[] => Array.from({ length: n }, (_, i) => String(from + i * step));

export const SAMPLE_ADDRESS = '0x5a1e…90c2';

export const sampleBoxes = (): WalletBoxes => ({
  count: 37,
  exact: true,
  byLevel: { Common: ids(180_412, 23, 137), Uncommon: ids(181_006, 11, 211), Rare: ids(188_431, 3, 503), SuperRare: [] },
});
