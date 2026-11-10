/**
 * The Copy page's cards as the ValueDesk server read them ahead (GET /api/vs/copy/cards, server
 * valuedesk/copyCards.ts): one request for every card of a window that asks within a few
 * milliseconds of another - a page of cards is 24 - and kept for the page view.
 *
 * Each answer is what the venue said, with its age and whether that is within the server's refresh
 * interval for it (`fresh`). The card shows it at once; a stale one with its age, while the browser
 * reads the venue as before (TraderCard.tsx useTraderPeek). A card the server does not hold, or any
 * failure, answers null: the browser's own read, unchanged.
 */
import type { BoardWindow, Venue } from '@sign/valuedesk/types.js';

const BATCH_MS = 25;
/** The route's own cap. */
export const CARDS_PER_REQUEST = 50;
/** The windows the server reads cards for (the grid's: copy/gridModel.ts GRID_WINDOWS). */
const SERVED: ReadonlySet<BoardWindow> = new Set<BoardWindow>(['7d', '30d', 'all']);

export type ServerCard =
  | { age: number; fresh: boolean; spark: number[] | null; lastActive: number | null }
  | { age: number; fresh: boolean; none: true };

export interface CardDeps {
  getJson: (path: string) => Promise<unknown>;
  wait: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultDeps: CardDeps = {
  getJson: async (path) => {
    const res = await fetch(path, { headers: { Accept: 'application/json' } });
    return res.ok ? res.json() : null;
  },
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** One answer as the route sends it, or null for anything else. `age` is moved on by the time it was kept here. */
export function parseCard(v: unknown): ServerCard | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  if (!finite(c.age) || c.age < 0 || typeof c.fresh !== 'boolean') return null;
  if (c.none === true) return { age: c.age, fresh: c.fresh, none: true };
  const spark = c.spark === null ? null : Array.isArray(c.spark) && c.spark.every(finite) ? (c.spark as number[]) : undefined;
  const last = c.lastActive === null ? null : finite(c.lastActive) ? c.lastActive : undefined;
  if (spark === undefined || last === undefined) return null;
  return { age: c.age, fresh: c.fresh, spark, lastActive: last };
}

export function serverCards(deps: CardDeps = defaultDeps): (venue: Venue, address: string, w: BoardWindow) => Promise<ServerCard | null> {
  const kept = new Map<string, { at: number; card: ServerCard | null }>();
  const pending = new Map<BoardWindow, Map<string, Array<(c: ServerCard | null) => void>>>();

  async function flush(w: BoardWindow, batch: Map<string, Array<(c: ServerCard | null) => void>>): Promise<void> {
    const list = [...batch.keys()];
    for (let i = 0; i < list.length; i += CARDS_PER_REQUEST) {
      const part = list.slice(i, i + CARDS_PER_REQUEST);
      let cards: Record<string, unknown> = {};
      try {
        const body = (await deps.getJson(`/api/vs/copy/cards?w=${w}&keys=${part.join(',')}`)) as { ok?: boolean; cards?: Record<string, unknown> } | null;
        if (body?.ok && body.cards && typeof body.cards === 'object') cards = body.cards;
      } catch { /* none: the venue's own read */ }
      const at = deps.now();
      for (const k of part) {
        const card = parseCard(cards[k]);
        kept.set(`${w}|${k}`, { at, card });
        for (const done of batch.get(k)!) done(card);
      }
    }
  }

  return (venue, addressIn, w) => {
    if (!SERVED.has(w)) return Promise.resolve(null);
    const k = `${venue}:${addressIn.toLowerCase()}`;
    const hit = kept.get(`${w}|${k}`);
    if (hit) return Promise.resolve(hit.card && { ...hit.card, age: hit.card.age + (deps.now() - hit.at) });
    return new Promise<ServerCard | null>((resolve) => {
      let batch = pending.get(w);
      if (!batch) {
        const b = new Map<string, Array<(c: ServerCard | null) => void>>();
        batch = b;
        pending.set(w, b);
        void deps.wait(BATCH_MS).then(() => {
          pending.delete(w);
          return flush(w, b);
        });
      }
      const waiters = batch.get(k);
      if (waiters) waiters.push(resolve);
      else batch.set(k, [resolve]);
    });
  };
}
