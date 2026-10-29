/**
 * What a polled read shows once a refresh fails.
 *
 * A refresh that fails under data already on screen is not "couldn't load":
 * the data stays, with a quiet "Updating…" under it - the next poll (or the
 * account stream) usually lands within seconds, and a blip on SoDEX's side
 * must not blank a table that was right a moment ago. "<What> couldn't load."
 * (LoadFailed.tsx) is only for a read with nothing to show. Pure, so
 * readState.test.ts pins it.
 */

export type ReadShown = 'ok' | 'updating' | 'failed';

/** 'failed' only when there is no data to keep; 'updating' when the last good data is still shown. */
export function readShown(r: { data: unknown; error: unknown }): ReadShown {
  if (!r.error) return 'ok';
  return r.data === null || r.data === undefined ? 'failed' : 'updating';
}

/** The read's error when the reader is to see it (a LoadFailed, a toast), else null. */
export function shownError<E>(r: { data: unknown; error: E | null }): E | null {
  return readShown(r) === 'failed' ? r.error : null;
}

/** Kept data at least this old says how old it is. */
export const SAY_AGE_MS = 60_000;

/** "Updating…" - and once the kept copy is a minute old, how old ("Updating… read 3 min ago"). */
export function updatingLine(now: number, at: number | null | undefined): string {
  const age = at ? now - at : 0;
  if (!(age >= SAY_AGE_MS)) return 'Updating…';
  const min = Math.floor(age / 60_000);
  if (min < 60) return `Updating… read ${min} min ago`;
  const h = Math.floor(min / 60);
  return `Updating… read ${h} h ago`;
}
