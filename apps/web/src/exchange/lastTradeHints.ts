/**
 * The copy cards' hint for a Hyperliquid trader's last trade: when the ValueDesk index last saw them
 * fill (GET /api/vs/last-trades, server indexer/walletFills.ts lastTrades). One request for every card
 * that asks within a few milliseconds of another - a page of cards is 24 - and kept a minute.
 *
 * Only a hint: hlPeek asks Hyperliquid for the fills since then and shows the newest of those, so a
 * missing or wrong hint costs the old search, never a wrong figure. Any failure answers null.
 */
const BATCH_MS = 25;
const TTL_MS = 60_000;
/** The route's own cap. */
export const HINTS_PER_REQUEST = 50;

export interface HintDeps {
  getJson: (path: string) => Promise<unknown>;
  now: () => number;
  wait: (ms: number) => Promise<void>;
}

const defaultDeps: HintDeps = {
  getJson: async (path) => {
    const res = await fetch(path, { headers: { Accept: 'application/json' } });
    return res.ok ? res.json() : null;
  },
  now: () => Date.now(),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export function lastTradeHints(deps: HintDeps = defaultDeps): (address: string) => Promise<number | null> {
  const kept = new Map<string, { at: number; t: number | null }>();
  let pending: Map<string, Array<(t: number | null) => void>> | null = null;

  async function flush(batch: Map<string, Array<(t: number | null) => void>>): Promise<void> {
    const list = [...batch.keys()];
    for (let i = 0; i < list.length; i += HINTS_PER_REQUEST) {
      const part = list.slice(i, i + HINTS_PER_REQUEST);
      let at: Record<string, unknown> = {};
      try {
        const body = (await deps.getJson(`/api/vs/last-trades?venue=hyperliquid&addresses=${part.join(',')}`)) as { ok?: boolean; at?: Record<string, unknown> } | null;
        if (body?.ok && body.at && typeof body.at === 'object') at = body.at;
      } catch { /* no hint */ }
      const now = deps.now();
      for (const a of part) {
        const v = at[a];
        const t = typeof v === 'number' && Number.isFinite(v) ? v : null;
        kept.set(a, { at: now, t });
        for (const done of batch.get(a)!) done(t);
      }
    }
  }

  return (addressIn: string) => {
    const address = addressIn.toLowerCase();
    const hit = kept.get(address);
    if (hit && deps.now() - hit.at < TTL_MS) return Promise.resolve(hit.t);
    return new Promise<number | null>((resolve) => {
      if (!pending) {
        const batch = new Map<string, Array<(t: number | null) => void>>();
        pending = batch;
        void deps.wait(BATCH_MS).then(() => {
          pending = null;
          return flush(batch);
        });
      }
      const waiters = pending.get(address);
      if (waiters) waiters.push(resolve);
      else pending.set(address, [resolve]);
    });
  };
}
