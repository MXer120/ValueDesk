/**
 * Where this visitor is, as the site's edge sees it - the same source the copy
 * executor uses (Vercel's x-vercel-ip-country, read by the /api function,
 * deploy/vercel/api-proxy.cjs) - and what that allows (jurisdictions.mjs).
 *
 *   GET /api/edge/geo -> {"country":"DE","region":"BY"}   (answered by the function itself)
 *
 * Asked once per page load. In a local dev server, a preview without the
 * function, or when the request fails, the answer is unknown (both null): that
 * restricts nothing here - the edge itself refuses a sanctioned place before
 * the app ever loads, and a wallet's declared country still counts
 * (trading/legalGate.ts). Nothing is stored: the answer lives in this module's
 * memory only.
 */
import { useSyncExternalStore } from 'react';
import { logger } from '../log';
import { normaliseCountry, normaliseRegion, siteAccess, type SiteAccess } from './jurisdictions.mjs';

const log = logger('legal');

export const GEO_PATH = '/api/edge/geo';

export interface ViewerGeo {
  country: string | null;
  region: string | null;
  /** The edge answered (false: unknown - not asked yet, a dev server, a failure). */
  known: boolean;
}

const UNKNOWN: ViewerGeo = { country: null, region: null, known: false };

let geo: ViewerGeo = UNKNOWN;
let access: SiteAccess = siteAccess();
let asked: Promise<ViewerGeo> | null = null;
const listeners = new Set<() => void>();

/** What the edge's own 451 means: a sanctioned place, which one not said. */
const EDGE_REFUSED: SiteAccess = {
  level: 'blocked',
  country: null,
  place: 'your country or region',
  reason: 'ValueDesk is not available in your country or region: the sanctions and legal restrictions that apply there do not allow us to offer it.',
  source: 'observed',
};

function set(next: ViewerGeo, refused = false): void {
  geo = next;
  access = refused ? EDGE_REFUSED : siteAccess({ country: next.country, region: next.region });
  for (const l of listeners) l();
}

/** Read an answer of /api/edge/geo; anything else is unknown. */
export function parseGeo(body: unknown): ViewerGeo {
  if (!body || typeof body !== 'object') return UNKNOWN;
  const b = body as { country?: unknown; region?: unknown };
  if (!('country' in b)) return UNKNOWN;
  return { country: normaliseCountry(b.country), region: normaliseRegion(b.region), known: true };
}

/**
 * A DEV SERVER ONLY: `?geo=IR`, `?geo=US`, `?geo=UA-43` plays the edge's answer,
 * so the restricted states can be seen without Vercel. `import.meta.env.DEV` is
 * false in every build Vite makes for a deployment, which drops this entirely.
 */
function devGeo(): ViewerGeo | null {
  if (!(import.meta as { env?: { DEV?: boolean } }).env?.DEV || typeof window === 'undefined') return null;
  const q = new URLSearchParams(window.location.search).get('geo');
  if (!q) return null;
  const [country, region] = q.split('-');
  return parseGeo({ country: country ?? null, region: region ?? null });
}

/** Ask the edge where this visitor is (once per page load; later calls get the same answer). */
export function loadViewerGeo(fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<ViewerGeo> {
  const dev = devGeo();
  if (dev && !asked) {
    set(dev);
    asked = Promise.resolve(dev);
  }
  asked ??= (async () => {
    try {
      const r = await fetchFn(GEO_PATH, { cache: 'no-store', credentials: 'omit' });
      // 451: the edge refused this place before the function; the page itself was let through (a legal page).
      if (r.status === 451) {
        set({ ...UNKNOWN, known: true }, true);
        return geo;
      }
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return geo;
      set(parseGeo(await r.json()));
    } catch (e) {
      log.debug('viewer geo unknown', { error: String(e) });
    }
    return geo;
  })();
  return asked;
}

export const viewerGeo = (): ViewerGeo => geo;
/** What the visitor's place allows, without a wallet's declaration (legalGate.ts adds that). */
export const viewerAccess = (): SiteAccess => access;

export function subscribeGeo(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The visitor's access, re-rendering when the edge's answer arrives. */
export function useViewerAccess(): SiteAccess {
  return useSyncExternalStore(subscribeGeo, viewerAccess, viewerAccess);
}

/** For tests: forget the answer. */
export function _resetGeoForTests(next: ViewerGeo = UNKNOWN): void {
  asked = null;
  set(next);
}
