/**
 * The kept answer of an index path (serverFetch.ts KEPT ANSWERS) for a read that has no answer of its own yet: what a
 * page reopened within the route's cache window draws in its first render, with the answer's own as-of time, until its
 * first read - asked of the server - replaces it. It leaves the screen the moment no cache may hand it out any more.
 */
import { useEffect, useMemo, useState } from 'react';
import { peekJson } from '../serverFetch';

export function useHeld<T>(key: string | null, path: string | null, answered: boolean, keep: boolean): { body: T; at: number } | null {
  const [tick, setTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const held = useMemo(() => (keep && key && path && !answered ? peekJson<T>(path) : null), [keep, key, path, answered, tick]);
  useEffect(() => {
    if (!held) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(0, held.until - Date.now()));
    return () => clearTimeout(t);
  }, [held]);
  return held;
}
