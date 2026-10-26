/**
 * Where algo orders run, chosen once on the ticket and kept: ValueDesk's
 * hosted executor (24/7, the default), this browser, or the trader's own
 * self-hosted copier. Stored under its own key, apart from the draft, so it
 * survives reloads and switching kinds.
 *
 * The draft used to carry it (`place` in vs.algo.draft.v1): the first read
 * with no key of its own moves that value over, once.
 */
import { DRAFT_KEY } from './draft';

export type Place = 'hosted' | 'browser' | 'self';

export const EXECUTOR_KEY = 'vs.algo.executor.v1';
export const DEFAULT_PLACE: Place = 'hosted';

export const PLACES: ReadonlyArray<readonly [Place, string, string]> = [
  ['hosted', 'ValueDesk', 'On the ValueDesk executor, 24/7: keeps running with your browser closed'],
  ['browser', 'Browser', 'In this browser, signed with your trading key: keep a ValueDesk tab open'],
  ['self', 'Self-hosted', 'On the copier you run yourself'],
];

const isPlace = (v: unknown): v is Place => v === 'hosted' || v === 'browser' || v === 'self';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const local = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export function readExecutor(store: Store | null = local()): Place {
  if (!store) return DEFAULT_PLACE;
  try {
    const own = store.getItem(EXECUTOR_KEY);
    if (own !== null) {
      const v: unknown = JSON.parse(own);
      return isPlace(v) ? v : DEFAULT_PLACE;
    }
    // Once: the choice the old draft held - only Self-hosted, which someone picked.
    // Browser was the old default, saved into every draft unasked, so it is not
    // a choice to keep: those traders start on ValueDesk too (owner, 2026-10-26).
    const draft = store.getItem(DRAFT_KEY);
    const old: unknown = draft ? (JSON.parse(draft) as { place?: unknown }).place : undefined;
    const v: Place = old === 'self' ? 'self' : DEFAULT_PLACE;
    store.setItem(EXECUTOR_KEY, JSON.stringify(v));
    return v;
  } catch {
    return DEFAULT_PLACE;
  }
}

export function writeExecutor(v: Place, store: Store | null = local()): void {
  try {
    store?.setItem(EXECUTOR_KEY, JSON.stringify(v));
  } catch {
    /* storage blocked: kept for this session only */
  }
}
