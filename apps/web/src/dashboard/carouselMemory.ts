/**
 * What the phone's trade carousel (MobileCarousel.tsx) remembers in this browser: the page last used, so the trade
 * page opens on it again (it unmounts on every page change), and whether the swipe hint has played - once per
 * browser, not on every visit. Storage that throws or is empty (a private window) only means the defaults: the
 * chart page, and the hint once per page load.
 */
export const PAGE_KEY = 'vs.mcarousel.page';
export const HINT_KEY = 'vs.mcarousel.hinted';

/** Test seam: the browser's storage. */
export const carouselEnv = {
  storage: (): Pick<Storage, 'getItem' | 'setItem'> | null => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  },
};

function read(key: string): string | null {
  try {
    return carouselEnv.storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    carouselEnv.storage()?.setItem(key, value);
  } catch {
    /* private mode: this page load only */
  }
}

/** Set when storage could not keep the hint: it still plays only once for this page load. */
let hintedHere = false;

export const carouselStore = {
  /** The index of the page last used among `keys`; 0 (the first page) when none is remembered or it is gone. */
  startIndex(keys: readonly string[]): number {
    const k = read(PAGE_KEY);
    const i = k === null ? -1 : keys.indexOf(k);
    return i < 0 ? 0 : i;
  },
  remember(key: string | undefined): void {
    if (key && read(PAGE_KEY) !== key) write(PAGE_KEY, key);
  },
  /** The swipe hint has not played in this browser yet. */
  hintDue(): boolean {
    return !hintedHere && read(HINT_KEY) === null;
  },
  hinted(): void {
    hintedHere = true;
    write(HINT_KEY, '1');
  },
  /** Tests only. */
  resetForTest(): void {
    hintedHere = false;
  },
};
