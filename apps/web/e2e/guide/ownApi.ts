/**
 * Our own API, as a public server will serve it: every route of the
 * hosted-mode allow-list (apps/server/src/hosted.ts HOSTED_ROUTES), with the
 * request the web app itself makes and a rule for "a sane answer".
 *
 * The allow-list is read from the server's source as TEXT - the guide imports
 * nothing from the server - so a route added there shows up here by itself,
 * and one this file has no probe for is reported instead of silently skipped.
 * Pure.
 */
import type { Verdict } from './readonly';

export interface RouteDef {
  method: string;
  url: string;
}

/** The hosted allow-list as of 2026-10-02, used only when hosted.ts cannot be read. */
export const FALLBACK_ROUTES: readonly RouteDef[] = [
  '/api/health',
  '/api/vs/leaderboard',
  '/api/vs/explore',
  '/api/vs/cohorts',
  '/api/vs/cohorts/detail',
  '/api/vs/cohorts/map',
  '/api/vs/cohorts/focus',
  '/api/vs/cohorts/wallets',
  '/api/vs/screener',
  '/api/vs/whales',
  '/api/vs/positioning',
  '/api/vs/news',
  '/api/vs/lbrow',
  '/api/feed/account',
  '/api/external/maintenance/status',
  '/api/external/announcements',
  '/api/external/announcements/:id',
].map((url) => ({ method: 'GET', url }));

/** `{ method: 'GET', url: '/api/health', cls: 'read' }` entries of HOSTED_ROUTES, in file order. */
export function parseHostedRoutes(source: string): RouteDef[] {
  // The declaration itself - the name also appears in comments above it.
  const decl = /\bconst HOSTED_ROUTES\b[^=]*=\s*\[/.exec(source);
  if (!decl) return [];
  const open = decl.index + decl[0].length - 1;
  const close = source.indexOf('];', open);
  const block = source.slice(open, close < 0 ? undefined : close);
  const out: RouteDef[] = [];
  for (const m of block.matchAll(/\{\s*method:\s*'([A-Z]+)'\s*,\s*url:\s*'([^']+)'/g)) out.push({ method: m[1]!, url: m[2]! });
  return out;
}

/** The venues with a leaderboard (apps/server/src/valuedesk/types.ts VENUES), from its text; else the five of 2026-10-02. */
export function parseVenues(typesSource: string | null): string[] {
  const m = typesSource ? /export const VENUES[^=]*=\s*\[([^\]]*)\]/.exec(typesSource) : null;
  const list = m ? [...m[1]!.matchAll(/'([a-z0-9]+)'/g)].map((x) => x[1]!) : [];
  return list.length ? list : ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus'];
}

/** What earlier answers taught the later probes (a cohort id, an address on a board, ...). */
export interface ProbeContext {
  venues: string[];
  cohortId?: string;
  hlAddress?: string;
  sodexAccountId?: number;
  announcementId?: string;
}

export interface Probe {
  id: string;
  title: string;
  /** The path to GET; null: this probe cannot run yet (`needs` says why). */
  path: (ctx: ProbeContext) => string | null;
  needs?: string;
  judge: (status: number, body: unknown) => Verdict;
  /** Remember something for later probes. */
  learn?: (body: unknown, ctx: ProbeContext) => void;
  /** The answer may be "still being computed" right after a restart: ask again a few times. */
  retryIfNotReady?: boolean;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);

/** The routes' own failure answer is HTTP 200 `{ok:false, error}`; this reads either kind. */
function failure(status: number, body: unknown): string | null {
  const o = obj(body);
  if (status !== 200) return `HTTP ${status}${o && typeof o.error === 'string' ? `: ${o.error}` : ''}`;
  if (!o) return 'the answer is not a JSON object';
  if (o.ok === false) return `ok:false${typeof o.code === 'string' ? ` (${o.code})` : ''}: ${String(o.error ?? 'no message')}`;
  return null;
}

/** Does this failure only say "not computed yet"? */
export const isNotReady = (detail: string): boolean => /still being computed|is starting|not running yet|try again in a minute/i.test(detail);

/** `ok:true` and a list under `key`; an empty list is `empty` (FAIL, or WARN where emptiness is normal). */
function list(key: string, what: string, empty: 'FAIL' | 'WARN' = 'FAIL', emptyNote = '') {
  return (status: number, body: unknown): Verdict => {
    const bad = failure(status, body);
    if (bad) return { status: 'FAIL', detail: bad };
    const o = obj(body)!;
    if (o.ok !== true) return { status: 'FAIL', detail: 'the answer has no ok:true' };
    const rows = arr(o[key]);
    if (!rows) return { status: 'FAIL', detail: `the answer has no "${key}" list` };
    if (!rows.length) return { status: empty, detail: `0 ${what}${emptyNote ? ` - ${emptyNote}` : ''}` };
    return { status: 'PASS', detail: `${rows.length} ${what}${typeof o.total === 'number' ? ` of ${o.total}` : ''}` };
  };
}

/** The probes of one route, or null when none is written for it. */
function probesOf(url: string): Probe[] | null {
  switch (url) {
    case '/api/health':
      return [{
        id: 'health',
        title: '/api/health',
        path: () => '/api/health',
        judge: (status, body) => {
          const bad = failure(status, body);
          if (bad) return { status: 'FAIL', detail: bad };
          const o = obj(body)!;
          if (o.ok !== true) return { status: 'FAIL', detail: 'health does not say ok:true' };
          if (o.network !== 'mainnet') return { status: 'WARN', detail: `the server runs on ${String(o.network)}, not mainnet` };
          if (o.chainId !== 286623) return { status: 'FAIL', detail: `chain id ${String(o.chainId)}, expected 286623` };
          return { status: 'PASS', detail: `ok, mainnet, chain 286623, app mainnet writes ${o.mainnetWritesAllowed === true ? 'allowed' : 'OFF (the app will not trade)'}` };
        },
      }];
    // '/api/vs/leaderboard' has one probe per venue: leaderboardProbes().
    case '/api/vs/explore':
      return [{ id: 'explore', title: '/api/vs/explore', path: () => '/api/vs/explore', judge: list('segments', 'ranking sections') }];
    case '/api/vs/cohorts':
      return [{
        id: 'cohorts',
        title: '/api/vs/cohorts',
        path: () => '/api/vs/cohorts',
        judge: list('cohorts', 'cohorts'),
        learn: (body, ctx) => {
          const id = obj(arr(obj(body)?.cohorts)?.[0])?.id;
          if (typeof id === 'string') ctx.cohortId = id;
        },
        retryIfNotReady: true,
      }];
    case '/api/vs/cohorts/detail':
      return [{
        id: 'cohorts-detail',
        title: '/api/vs/cohorts/detail',
        needs: 'a cohort id from /api/vs/cohorts',
        path: (c) => (c.cohortId ? `/api/vs/cohorts/detail?cohort=${encodeURIComponent(c.cohortId)}&range=7d` : null),
        judge: (status, body) => {
          const bad = failure(status, body);
          if (bad) return { status: 'FAIL', detail: bad };
          const c = obj(obj(body)!.cohort);
          if (!c || typeof c.id !== 'string') return { status: 'FAIL', detail: 'the answer has no cohort' };
          return { status: 'PASS', detail: `cohort ${c.id}: ${String(c.wallets)} wallets` };
        },
        retryIfNotReady: true,
      }];
    case '/api/vs/cohorts/map':
      return [{ id: 'cohorts-map', title: '/api/vs/cohorts/map', path: () => '/api/vs/cohorts/map', judge: list('sectors', 'sectors'), retryIfNotReady: true }];
    case '/api/vs/cohorts/focus':
      return [{ id: 'cohorts-focus', title: '/api/vs/cohorts/focus', path: () => '/api/vs/cohorts/focus?coin=BTC&range=7d', judge: list('cohorts', 'cohorts holding BTC'), retryIfNotReady: true }];
    case '/api/vs/cohorts/wallets':
      return [{
        id: 'cohorts-wallets',
        title: '/api/vs/cohorts/wallets',
        needs: 'a cohort id from /api/vs/cohorts',
        path: (c) => (c.cohortId ? `/api/vs/cohorts/wallets?cohort=${encodeURIComponent(c.cohortId)}&sort=equity&dir=desc&offset=0&limit=5` : null),
        judge: list('rows', 'wallets'),
        retryIfNotReady: true,
      }];
    case '/api/vs/screener':
      return [{ id: 'screener', title: '/api/vs/screener', path: () => '/api/vs/screener?venue=all&limit=5', judge: list('rows', 'traders') }];
    case '/api/vs/whales':
      // An empty tape is possible in a quiet minute, and right after the server started (it fills from the streams).
      return [{ id: 'whales', title: '/api/vs/whales', path: () => '/api/vs/whales?venue=all&limit=5', judge: list('trades', 'whale trades', 'WARN', 'the route answers, the tape is empty: normal in a quiet minute or shortly after the server started; look again later') }];
    case '/api/vs/positioning':
      return [{ id: 'positioning', title: '/api/vs/positioning', path: () => '/api/vs/positioning?venue=all', judge: list('rows', 'markets'), retryIfNotReady: true }];
    case '/api/vs/news':
      // Stories when SOSOVALUE_API_KEY is set. Without it the route says so, which is the configured answer.
      return [{
        id: 'news',
        title: '/api/vs/news',
        path: () => '/api/vs/news?limit=5',
        judge: (status, body) => {
          const bad = failure(status, body);
          if (bad && obj(body)?.code === 'not_available') return { status: 'WARN', detail: 'SoSoValue news is not configured (SOSOVALUE_API_KEY)' };
          if (bad) return { status: 'FAIL', detail: bad };
          const items = arr(obj(body)?.items);
          if (!items) return { status: 'FAIL', detail: 'the answer has no "items" list' };
          return items.length ? { status: 'PASS', detail: `${items.length} stories` } : { status: 'WARN', detail: '0 stories' };
        },
      }];
    case '/api/vs/lbrow':
      return [{
        id: 'lbrow',
        title: '/api/vs/lbrow',
        needs: 'an address from the Hyperliquid leaderboard',
        path: (c) => (c.hlAddress ? `/api/vs/lbrow?venue=hyperliquid&address=${c.hlAddress}` : null),
        judge: (status, body) => {
          const bad = failure(status, body);
          if (bad) return { status: 'FAIL', detail: bad };
          const row = obj(obj(body)!.row);
          if (!row) return { status: 'FAIL', detail: 'an address taken from the Hyperliquid board has no leaderboard row' };
          return { status: 'PASS', detail: `rank ${String(row.rank)} for an address on the board` };
        },
      }];
    case '/api/feed/account':
      return [{
        id: 'feed-account',
        title: '/api/feed/account',
        needs: 'an account id from the SoDEX leaderboard',
        path: (c) => (c.sodexAccountId ? `/api/feed/account?id=${c.sodexAccountId}` : null),
        judge: (status, body) => {
          const bad = failure(status, body);
          if (bad) return { status: 'FAIL', detail: bad };
          const o = obj(body)!;
          if (o.resolved !== true || typeof o.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(o.address)) return { status: 'FAIL', detail: 'the account id was not resolved to a wallet' };
          return { status: 'PASS', detail: `account #${String(o.account_id)} resolved (${String(o.source ?? 'index')})` };
        },
      }];
    case '/api/external/maintenance/status':
      return [{
        id: 'maintenance',
        title: '/api/external/maintenance/status',
        path: () => '/api/external/maintenance/status',
        judge: (status, body) => {
          const o = obj(body);
          if (status !== 200 || !o) return { status: 'FAIL', detail: `HTTP ${status}` };
          if (o.reachable !== true) return { status: 'FAIL', detail: `SoDEX's status could not be read: ${String(o.error ?? 'unreachable')}` };
          if (o.maintenance === true) return { status: 'WARN', detail: `SoDEX reports MAINTENANCE: ${String(o.reason ?? o.status ?? '')}` };
          return { status: 'PASS', detail: `SoDEX status ${String(o.status ?? 'normal')}, no maintenance` };
        },
      }];
    case '/api/external/announcements':
      return [{
        id: 'announcements',
        title: '/api/external/announcements',
        path: () => '/api/external/announcements?page=1&size=5&lang=en',
        judge: (status, body) => {
          const o = obj(body);
          if (status !== 200 || !o) return { status: 'FAIL', detail: `HTTP ${status}` };
          const items = arr(o.items);
          if (!items) return { status: 'FAIL', detail: 'the answer has no "items" list' };
          return items.length ? { status: 'PASS', detail: `${items.length} announcements of ${String(o.count ?? '?')}` } : { status: 'WARN', detail: '0 announcements' };
        },
        learn: (body, ctx) => {
          const id = obj(arr(obj(body)?.items)?.[0])?.id;
          if (typeof id === 'number' || typeof id === 'string') ctx.announcementId = String(id);
        },
      }];
    case '/api/external/announcements/:id':
      return [{
        id: 'announcement',
        title: '/api/external/announcements/:id',
        needs: 'an id from /api/external/announcements',
        path: (c) => (c.announcementId ? `/api/external/announcements/${encodeURIComponent(c.announcementId)}?lang=en` : null),
        judge: (status, body) => {
          const o = obj(body);
          if (status !== 200 || !o) return { status: 'FAIL', detail: `HTTP ${status}` };
          if (o.id === undefined || typeof o.title !== 'string') return { status: 'FAIL', detail: 'the answer has no id / title' };
          return { status: 'PASS', detail: `announcement ${String(o.id)} read` };
        },
      }];
    case '/api/vs/builder/terms':
      // The signed fee terms (docs/BUILDER-TIERS.md section 3). Stage C verifies the signature; here: does it answer.
      return [{
        id: 'builder-terms',
        title: '/api/vs/builder/terms',
        path: () => `/api/vs/builder/terms?address=0x0000000000000000000000000000000000000001&nonce=guide_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12).padEnd(10, '0')}`,
        judge: (status, body) => {
          const bad = failure(status, body);
          if (bad) return { status: 'FAIL', detail: bad };
          const o = obj(body)!;
          if (o.ok !== true) return { status: 'FAIL', detail: 'the answer has no ok:true' };
          if (o.builderId === null || o.builderId === undefined) return { status: 'PASS', detail: 'fee tiers are off (no tiers file): the app charges the fees of its build' };
          const fee = obj(o.fee);
          if (o.sig === null || o.sig === undefined) return { status: 'WARN', detail: `fee tiers are on for builder #${String(o.builderId)}, but the answer is not signed (no terms key): every app pays the default fee` };
          return { status: 'PASS', detail: `fee tiers on for builder #${String(o.builderId)}: perps ${String(fee?.perps)} / spot ${String(fee?.spot)} now, signed (key ${String(o.keyId)})` };
        },
      }];
    default:
      return null; // no probe written for this route: probesFor reports it
  }
}

/** One probe per venue with a board, and the netted view over all of them. */
export function leaderboardProbes(venues: readonly string[]): Probe[] {
  const perVenue = venues.map((v): Probe => ({
    id: `leaderboard-${v}`,
    title: `/api/vs/leaderboard (${v})`,
    path: () => `/api/vs/leaderboard?venue=${v}&window=30d&limit=5`,
    judge: list('rows', 'board rows'),
    learn: (body, ctx) => {
      const row = obj(arr(obj(body)?.rows)?.[0]);
      if (v === 'hyperliquid' && typeof row?.address === 'string') ctx.hlAddress = row.address;
      if (v === 'sodex' && typeof row?.accountId === 'number' && row.accountId > 0) ctx.sodexAccountId = row.accountId;
    },
    retryIfNotReady: true,
  }));
  return [
    ...perVenue,
    {
      id: 'leaderboard-net',
      title: '/api/vs/leaderboard (all venues, netted)',
      path: () => `/api/vs/leaderboard?venues=${venues.join(',')}&window=30d&limit=5`,
      judge: list('rows', 'netted rows'),
      retryIfNotReady: true,
    },
  ];
}

/**
 * The probes for the allow-list, in an order where each finds what it needs:
 * boards and lists first, the routes that take an id from them after.
 * `unknown` lists routes of the allow-list this file has no probe for.
 */
export function probesFor(routes: readonly RouteDef[], venues: readonly string[]): { probes: Probe[]; unknown: RouteDef[] } {
  const probes: Probe[] = [];
  const unknown: RouteDef[] = [];
  const later: Probe[] = [];
  for (const r of routes) {
    if (r.method !== 'GET') {
      unknown.push(r); // a state-changing route is never probed here
      continue;
    }
    if (r.url === '/api/vs/leaderboard') {
      probes.push(...leaderboardProbes(venues));
      continue;
    }
    const ps = probesOf(r.url);
    if (!ps) {
      unknown.push(r);
      continue;
    }
    for (const p of ps) (p.needs ? later : probes).push(p);
  }
  return { probes: [...probes, ...later], unknown };
}
