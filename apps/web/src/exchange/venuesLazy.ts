/**
 * The browser's own venue reads (venues.ts) for vsApi.ts, without putting them in every page's first render.
 *
 * venues.ts brings the Hyperliquid, Lighter, Arcus and SoDEX trader adapters (apps/server/src/valuedesk): ~31 KB of
 * code (~8 KB brotli) that vsApi.ts, which every page imports, needed only for its trader / fills / account reads.
 * Those reads go through `venues` here: on the module itself once it is in, else after loading it. A view that
 * reads a venue in its first render (Scan, the trader cards, the copy setup, a cohort's price) binds the module
 * statically (bindVenues), so its page's chunk carries it and its first reads leave exactly as before.
 */
import type * as VenuesModule from './venues';

type Venues = typeof VenuesModule.venues;

let bound: Venues | null = null;
let loading: Promise<Venues> | null = null;

/** A view that reads venues in its first render passes a static `import * as m from './venues'` here. */
export function bindVenues(m: { venues: Venues }): void {
  bound ??= m.venues;
}

/** The venue reads, loaded once (again on the next read if the load failed). */
export function loadVenues(): Promise<Venues> {
  if (bound) return Promise.resolve(bound);
  loading ??= import('./venues').then(
    (m) => (bound = m.venues),
    (e: unknown) => {
      loading = null;
      throw e;
    },
  );
  return loading;
}

/** venues.<method>(...): at once when the module is in, else once it is. */
function call<K extends keyof Venues>(k: K): Venues[K] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Fn = (...a: any[]) => Promise<unknown>;
  const run = (v: Venues, a: unknown[]) => (v[k] as unknown as Fn)(...a);
  return ((...a: unknown[]) => (bound ? run(bound, a) : loadVenues().then((v) => run(v, a)))) as unknown as Venues[K];
}

export const venues: Pick<Venues, 'trader' | 'peek' | 'nameFills' | 'fills' | 'openOrders' | 'orderHistory' | 'funding' | 'balances' | 'price'> = {
  trader: call('trader'),
  peek: call('peek'),
  nameFills: call('nameFills'),
  fills: call('fills'),
  openOrders: call('openOrders'),
  orderHistory: call('orderHistory'),
  funding: call('funding'),
  balances: call('balances'),
  price: call('price'),
};
