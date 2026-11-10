/**
 * Stale-while-revalidate for the admin suite's slow outside reads (server 2's health and user list, the
 * builder account on SoDEX's gateway): each took 2.5-5 s when its one-minute cache had run out, and the
 * page waited for it (prod logs 2026-11-07: /api/admin/status 2.7 s, /users 3.6 s, /builder up to 4.9 s).
 *
 * Now a read answers at once from the last value while it is younger than `maxStaleMs`, and fetches a
 * new one in the background once it is older than `freshMs`. Only the very first read (or one after a
 * long quiet spell) waits. One fetch at a time. `at` is when the value was read, for the page's age label.
 */
export interface Swr<T> {
  get(now?: number): Promise<{ value: T; at: number }>;
}

export function swr<T>(read: () => Promise<T>, o: { freshMs: number; maxStaleMs: number }): Swr<T> {
  let last: { value: T; at: number } | null = null;
  let inflight: Promise<{ value: T; at: number }> | null = null;
  const refresh = (): Promise<{ value: T; at: number }> => {
    inflight ??= read()
      .then((value) => (last = { value, at: Date.now() }))
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
  return {
    async get(now = Date.now()) {
      if (last && now - last.at < o.maxStaleMs) {
        if (now - last.at >= o.freshMs) void refresh().catch(() => null);
        return last;
      }
      return refresh();
    },
  };
}
