/**
 * Where algo orders run, chosen once on the ticket and kept: ValueDesk's
 * hosted executor (24/7, the default), this browser, or the trader's own
 * self-hosted copier. Stored under its own key, apart from the draft, so it
 * survives reloads and switching kinds.
 *
 * The draft used to carry it (`place` in vs.algo.draft.v1): the first read
 * with no key of its own moves that value over, once.
 *
 * From a close-only place an algo runs in this browser whatever is stored
 * (browserOnly, runPlace), and the stored choice is left as it was.
 */
import { DRAFT_KEY } from './draft';

export type Place = 'hosted' | 'browser' | 'self';

export const EXECUTOR_KEY = 'vs.algo.executor.v1';
export const DEFAULT_PLACE: Place = 'hosted';

export const PLACES: ReadonlyArray<readonly [Place, string, string]> = [
  ['hosted', 'ValueDesk', 'On the ValueDesk executor, 24/7: keeps running with your browser closed'],
  ['browser', 'Browser', 'In this browser, signed with your trading key: keep a ValueDesk tab open'],
];

/** What the executor cards say where only this browser may run an algo (browserOnly). */
export const BROWSER_ONLY_LINE = 'From your region, algos run in this browser and can only close or reduce positions.';

/**
 * Whether only this browser may run an algo for a wallet in `st` (trading/legalGate.ts legalStateFor):
 * a close-only place (the US and its territories, the UK, Canada: legal/jurisdictions.mjs), or a
 * country the edge could not tell, which the order button treats as close-only (useTradeGate.ts).
 * An algo that only closes may run there (copy-engine algoClosesOnly; an opening one stays refused
 * by the legal gate), but not on the ValueDesk executor or a self-hosted copier: both need the copy
 * terms, which a close-only place cannot sign (owner, 2026-10-29). A blocked place runs nothing,
 * so this is not the thing to say there.
 */
export function browserOnly(st: { access: { level: string }; located?: boolean } | null | undefined): boolean {
  if (!st) return false;
  return st.access.level === 'close-only' || (st.access.level === 'open' && st.located === false);
}

/** Where the algo runs: the stored choice, or this browser where only it may (the stored choice is kept for later). */
export function runPlace(stored: Place, onlyBrowser: boolean): Place {
  return onlyBrowser ? 'browser' : stored;
}

/**
 * Whether the ticket is blocked because the chosen executor cannot start the
 * algo: a short reason for the button and the message for the notification.
 * Applies with or without a wallet: an unreachable or unset executor is the
 * thing to fix, not the wallet. Only the generic "connect your wallet" reason
 * is not this, nor is the browser (it fails only for a wallet).
 */
export function blockedState(place: Place, where: { ready: boolean; why: string | null }, _hasWallet?: boolean): { short: string; message: string } | null {
  if (where.ready || !where.why || place === 'browser') return null;
  const why = where.why;
  if (/connect your wallet/i.test(why)) return null;
  const name = place === 'hosted' ? 'ValueDesk executor' : 'Self-hosted copier';
  const short = /not reachable/i.test(why)
    ? `${name} unreachable`
    : /does not run algo/i.test(why)
      ? `${name} needs an update`
      : /connect your self-hosted/i.test(why)
        ? `${name} not connected`
        : /register the key/i.test(why)
          ? `${name} key missing`
          : `${name} not set up`;
  const fix = /Copy → Set up/.test(why) ? 'Or open Advanced to run it elsewhere.' : 'Open Advanced to run it elsewhere.';
  return { short, message: `${why} ${fix}` };
}

/**
 * The notification to raise for a blocked state, once: when it begins or its
 * message changes, never again while it stays the same; null when it clears.
 */
export function noticeFor(prev: string | null, cur: string | null): string | null {
  return cur !== null && cur !== prev ? cur : null;
}

const isPlace =(v: unknown): v is Place => v === 'hosted' || v === 'browser' || v === 'self';

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
      // Self-hosted is no longer offered (owner 2026-11-07): picked before, it is the executor now.
      return isPlace(v) && v !== 'self' ? v : DEFAULT_PLACE;
    }
    // Once: the choice the old draft held - only Self-hosted, which someone picked.
    // Browser was the old default, saved into every draft unasked, so it is not
    // a choice to keep: those traders start on ValueDesk too (owner, 2026-10-26).
    const draft = store.getItem(DRAFT_KEY);
    const old: unknown = draft ? (JSON.parse(draft) as { place?: unknown }).place : undefined;
    void old;
    const v: Place = DEFAULT_PLACE;
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
