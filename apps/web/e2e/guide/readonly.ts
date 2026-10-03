/**
 * Stage B, the pure parts: what a read-only check may send, and how each
 * answer is judged.
 *
 * THE POLICY (readOnlyProblem) is the one gate every request of stage B goes
 * through:
 *   - only hosts the web app itself talks to, and the dev server;
 *   - GET / HEAD / OPTIONS, plus the two kinds of POST that are reads by
 *     definition: Hyperliquid's `/info` queries and JSON-RPC read methods;
 *   - NEVER SoDEX's `/accounts/{a}/trades` or `/orders/history` (nor a route of
 *     our own API that makes the server call them): the pair shares a limit of
 *     about 4 requests per 60 s per IP, and a block lasts a minute and takes the
 *     trading UI down with it (docs/ARCH-traffic.md section 2);
 *   - never ports 5173 / 8787 (another project on this machine).
 * Nothing is signed anywhere in stage B: there is no key in the process.
 */
import { isForbiddenLocal } from './args';

export interface Verdict {
  status: 'PASS' | 'WARN' | 'FAIL';
  detail: string;
}

// --- hosts ------------------------------------------------------------------------------------

export const SODEX_GATEWAY = 'https://mainnet-gw.sodex.dev';
export const SODEX_WS = 'wss://mainnet-gw.sodex.dev';
export const SODEX_DATA = 'https://mainnet-data.sodex.dev';
export const SODEX_BIZ = 'https://alpha-biz.sodex.dev';
export const HL_INFO = 'https://api.hyperliquid.xyz/info';
export const LIGHTER_API = 'https://mainnet.zklighter.elliot.ai';
export const ARCUS_API = 'https://api.arcus.xyz';
export const VALUECHAIN_EXPLORER = 'https://main-scan.valuechain.xyz';

export interface RpcHost {
  name: string;
  url: string;
  chainId: number;
}

/** The public RPCs the funds sheets read balances from (apps/web/src/trading/onboard.ts, rpc.ts). */
export const RPC_HOSTS: readonly RpcHost[] = [
  { name: 'ValueChain', url: 'https://rpc.valuechain.xyz', chainId: 286623 },
  { name: 'Arbitrum One', url: 'https://arb1.arbitrum.io/rpc', chainId: 42161 },
  { name: 'Base', url: 'https://mainnet.base.org', chainId: 8453 },
  { name: 'Ethereum', url: 'https://ethereum-rpc.publicnode.com', chainId: 1 },
  { name: 'BNB Smart Chain', url: 'https://bsc-dataseed.bnbchain.org', chainId: 56 },
  { name: 'Polygon', url: 'https://polygon-bor-rpc.publicnode.com', chainId: 137 },
];

const READ_HOSTS: ReadonlySet<string> = new Set([
  new URL(SODEX_GATEWAY).host,
  new URL(SODEX_DATA).host,
  new URL(SODEX_BIZ).host,
  new URL(HL_INFO).host,
  new URL(LIGHTER_API).host,
  new URL(ARCUS_API).host,
  new URL(VALUECHAIN_EXPLORER).host,
  ...RPC_HOSTS.map((r) => new URL(r.url).host),
]);

/** Hyperliquid `/info` query types that only read public market data. */
const HL_READ_TYPES: ReadonlySet<string> = new Set(['meta', 'allMids', 'metaAndAssetCtxs', 'spotMeta']);
/** JSON-RPC methods that only read. */
const RPC_READ_METHODS: ReadonlySet<string> = new Set(['eth_chainId', 'eth_blockNumber', 'net_version']);

/** SoDEX history reads that share the ~4 per minute limit - on the gateway, or behind a route of our own API. */
const HISTORY_PATH = /\/accounts\/[^/]+\/(trades|orders\/history)(\/|$)/;
const OWN_HISTORY_PATH = /^\/api\/(acct\/[^/]+\/(trades|orders\/history)|vs\/fills|scan\/trades|stats\/)/;

/** Why this request may not be sent in the read-only stage (null: it may). */
export function readOnlyProblem(method: string, url: string, body: string | null, o: { backend: string }): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'not a URL';
  }
  const m = method.toUpperCase();
  if (isForbiddenLocal(url)) return `port ${u.port} belongs to another project on this machine`;
  const backend = new URL(o.backend);
  const own = u.origin === backend.origin;
  if (!own && u.protocol !== 'https:') return `${u.protocol}//${u.host} is not https`;
  if (!own && !READ_HOSTS.has(u.host)) return `${u.host} is not a host the app talks to`;
  if (HISTORY_PATH.test(u.pathname)) return 'SoDEX history reads (/trades, /orders/history) are never sent in this stage: they share a limit of about 4 per minute';
  if (own && OWN_HISTORY_PATH.test(u.pathname)) return 'this route makes the server read SoDEX history, which is never done in this stage';
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return null;
  if (m !== 'POST') return `${m} is a write`;
  // Two kinds of POST are reads by definition.
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? '');
  } catch {
    return 'a POST without a readable JSON body is treated as a write';
  }
  if (u.origin + u.pathname === HL_INFO) {
    const type = parsed && typeof parsed === 'object' ? (parsed as { type?: unknown }).type : undefined;
    return typeof type === 'string' && HL_READ_TYPES.has(type) ? null : `Hyperliquid /info type ${JSON.stringify(type)} is not on the read list`;
  }
  if (RPC_HOSTS.some((r) => r.url.replace(/\/+$/, '') === (u.origin + u.pathname).replace(/\/+$/, ''))) {
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    const methods = calls.map((c) => String((c as { method?: unknown } | null)?.method ?? ''));
    const bad = methods.filter((x) => !RPC_READ_METHODS.has(x));
    return bad.length ? `JSON-RPC ${bad.join(', ')} is not on the read list` : null;
  }
  return `POST ${u.pathname} is a write`;
}

/** The only WebSocket endpoints stage B opens. */
export function wsProblem(url: string): string | null {
  return url === `${SODEX_WS}/ws/perps` || url === `${SODEX_WS}/ws/spot` ? null : `${url} is not a SoDEX market stream`;
}

const WS_MARKET_CHANNELS: ReadonlySet<string> = new Set(['l2Book', 'trade', 'ticker']);

/** The only messages stage B sends on a socket: a ping, or a subscription to a public market channel. */
export function wsMessageProblem(msg: unknown): string | null {
  const o = msg && typeof msg === 'object' ? (msg as Record<string, unknown>) : null;
  if (!o) return 'not an object';
  if (o.op === 'ping') return null;
  if (o.op !== 'subscribe' && o.op !== 'unsubscribe') return `op ${JSON.stringify(o.op)} is not allowed`;
  const p = o.params && typeof o.params === 'object' ? (o.params as Record<string, unknown>) : null;
  if (!p || typeof p.channel !== 'string' || !WS_MARKET_CHANNELS.has(p.channel)) return 'only the public market channels l2Book, trade and ticker are subscribed';
  if ('user' in p) return 'account channels are never subscribed';
  return null;
}

// --- judging answers ----------------------------------------------------------------------------

/** Does the host let a page on `origin` read its answer? */
export function judgeCors(allowOrigin: string | null, origin: string): { ok: boolean; how: string } {
  if (allowOrigin === null || allowOrigin.trim() === '') return { ok: false, how: 'no Access-Control-Allow-Origin header: a browser would refuse the answer' };
  const v = allowOrigin.trim();
  if (v === '*') return { ok: true, how: 'any origin' };
  if (v === origin) return { ok: true, how: 'echoes the calling origin' };
  return { ok: false, how: `allows only ${v}` };
}

/** Does a preflight answer allow this method and these headers? */
export function judgePreflight(h: { allowOrigin: string | null; allowMethods: string | null; allowHeaders: string | null }, origin: string, method: string, headers: readonly string[]): { ok: boolean; how: string } {
  const cors = judgeCors(h.allowOrigin, origin);
  if (!cors.ok) return cors;
  const methods = (h.allowMethods ?? '').split(',').map((s) => s.trim().toUpperCase());
  if (!methods.includes('*') && !methods.includes(method.toUpperCase())) return { ok: false, how: `${method} is not in Access-Control-Allow-Methods (${h.allowMethods ?? 'none'})` };
  const allowed = (h.allowHeaders ?? '').split(',').map((s) => s.trim().toLowerCase());
  const missing = allowed.includes('*') ? [] : headers.filter((x) => !allowed.includes(x.toLowerCase()));
  if (missing.length) return { ok: false, how: `header ${missing.join(', ')} is not in Access-Control-Allow-Headers` };
  return { ok: true, how: `${method} allowed from ${cors.how}` };
}

/**
 * The origins the page's own Content-Security-Policy lets it connect to: the
 * `connect-src` list of the `<meta http-equiv="Content-Security-Policy">` in
 * index.html (comments above it mention the directive too - they are not it).
 * null: the page has no such policy.
 */
export function cspConnectSources(html: string): string[] | null {
  const meta = /<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i.exec(html)?.[0];
  const content = meta ? /\bcontent=(["'])([\s\S]*?)\1/i.exec(meta)?.[2] : undefined;
  if (content === undefined) return null;
  const directive = content.split(';').map((d) => d.trim()).find((d) => /^connect-src\b/i.test(d));
  if (!directive) return null;
  return directive.split(/\s+/).slice(1).filter((s) => /^(https|wss):\/\//.test(s));
}

/** Which of `needed` (origins) the policy does not list. */
export function missingFromCsp(allowed: readonly string[], needed: readonly string[]): string[] {
  const set = new Set(allowed);
  return needed.filter((o) => !set.has(o));
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const posNum = (v: unknown): number | null => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** SoDEX's envelope: `code === 0` is its only success signal. */
export function unwrapSodex(body: unknown): { ok: true; data: unknown } | { ok: false; problem: string } {
  const o = obj(body);
  if (!o) return { ok: false, problem: 'the answer is not a JSON object' };
  if (o.code !== 0) return { ok: false, problem: `SoDEX answered code ${JSON.stringify(o.code)}: ${String(o.error ?? o.message ?? o.msg ?? 'no message')}` };
  return { ok: true, data: o.data };
}

export function judgeSymbols(data: unknown, engine: string): Verdict {
  if (!Array.isArray(data) || data.length === 0) return { status: 'FAIL', detail: `the ${engine} market list is empty` };
  const trading = data.filter((s) => obj(s)?.status === 'TRADING').length;
  const named = data.every((s) => typeof obj(s)?.name === 'string');
  if (!named) return { status: 'FAIL', detail: `the ${engine} market list has entries without a name` };
  if (trading === 0) return { status: 'FAIL', detail: `${data.length} ${engine} markets, none of them TRADING` };
  return { status: 'PASS', detail: `${data.length} ${engine} markets, ${trading} trading` };
}

/** Best bid and ask of a book: REST (`bids`/`asks`) or stream (`b`/`a`) shape, best level first. */
export function bestBidAsk(book: unknown): { bid: number; ask: number; bids: number; asks: number } | null {
  const o = obj(book);
  if (!o) return null;
  const side = (v: unknown): Array<[number, number]> =>
    Array.isArray(v) ? v.flatMap((l) => (Array.isArray(l) && posNum(l[0]) !== null ? [[posNum(l[0])!, Number(l[1])] as [number, number]] : [])) : [];
  const bids = side(o.bids ?? o.b);
  const asks = side(o.asks ?? o.a);
  if (!bids.length || !asks.length) return null;
  // Do not trust the order: the best bid is the highest, the best ask the lowest.
  return { bid: Math.max(...bids.map((l) => l[0])), ask: Math.min(...asks.map((l) => l[0])), bids: bids.length, asks: asks.length };
}

export function judgeBook(book: unknown, symbol: string): Verdict {
  const b = bestBidAsk(book);
  if (!b) return { status: 'FAIL', detail: `${symbol}: the order book has no bids or no asks` };
  if (!(b.bid < b.ask)) return { status: 'FAIL', detail: `${symbol}: best bid ${b.bid} is not below best ask ${b.ask} (a crossed book)` };
  const spreadPct = ((b.ask - b.bid) / b.ask) * 100;
  return { status: 'PASS', detail: `${symbol}: bid ${b.bid} < ask ${b.ask} (spread ${spreadPct.toFixed(3)} %)` };
}

export function judgeMark(data: unknown, symbol: string, mid: number | null): Verdict {
  if (!Array.isArray(data) || !data.length) return { status: 'FAIL', detail: 'the mark-price list is empty' };
  const row = data.map(obj).find((r) => r?.symbol === symbol || r?.s === symbol);
  if (!row) return { status: 'FAIL', detail: `no mark price for ${symbol} (${data.length} markets listed)` };
  const mark = posNum(row.markPrice ?? row.p);
  if (mark === null) return { status: 'FAIL', detail: `${symbol}: the mark price is missing or not positive` };
  if (mid !== null) {
    const off = (Math.abs(mark - mid) / mid) * 100;
    if (off > 2) return { status: 'WARN', detail: `${symbol}: mark ${mark} is ${off.toFixed(2)} % away from the book's mid ${mid}` };
  }
  return { status: 'PASS', detail: `${symbol}: mark ${mark}${posNum(row.indexPrice) !== null ? `, index ${posNum(row.indexPrice)}` : ''} (${data.length} markets)` };
}

/** Candles of one interval: no hole, no duplicate, and the newest one is current. */
export function judgeKlines(data: unknown, intervalMs: number, now: number, symbol: string): Verdict {
  if (!Array.isArray(data) || data.length < 2) return { status: 'FAIL', detail: `${symbol}: fewer than two candles came back` };
  const ts = data.map((k) => Number(obj(k)?.t ?? (Array.isArray(k) ? k[0] : NaN)));
  if (ts.some((t) => !Number.isFinite(t))) return { status: 'FAIL', detail: `${symbol}: a candle has no open time` };
  const sorted = [...ts].sort((a, b) => a - b);
  const holes: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i]! - sorted[i - 1]!;
    if (d !== intervalMs) holes.push(d === 0 ? `duplicate at ${new Date(sorted[i]!).toISOString()}` : `${Math.round(d / intervalMs - 1)} missing after ${new Date(sorted[i - 1]!).toISOString()}`);
  }
  if (holes.length) return { status: 'FAIL', detail: `${symbol}: candles are not continuous (${holes.slice(0, 3).join('; ')}${holes.length > 3 ? `; +${holes.length - 3} more` : ''})` };
  const age = now - sorted.at(-1)!;
  if (age > 3 * intervalMs) return { status: 'FAIL', detail: `${symbol}: the newest candle is ${Math.round(age / 1000)} s old` };
  const bad = data.map(obj).find((k) => k && !(posNum(k.l) !== null && posNum(k.h) !== null && posNum(k.l)! <= posNum(k.h)!));
  if (bad) return { status: 'FAIL', detail: `${symbol}: a candle has low above high (or no prices)` };
  return { status: 'PASS', detail: `${symbol}: ${sorted.length} candles, continuous, newest ${Math.max(0, Math.round(age / 1000))} s old` };
}

// --- the indexer's status -----------------------------------------------------------------------

export interface IndexerVerdict extends Verdict {
  /** One line per stream and per lane, for the log. */
  lines: string[];
}

const STATUS_STALE_MS = 120_000;
const BUILD_WARN_MS = 15 * 60_000;
const BUILD_FAIL_MS = 45 * 60_000;

/**
 * `GET /api/vs/index/status` -> are the streams up, is any lane failing?
 *   stream up ........ the venue's socket is connected (and, once every market is
 *                      subscribed, `streams[v]` says since when it has been gap-free)
 *   still subscribing  the socket is not counted yet but subscriptions are being
 *                      confirmed (Lighter takes minutes after a restart): a warning
 *   lane failing ..... nothing done and something failed, a failure rate above one
 *                      in five, or a back-off of a minute or more (three failures
 *                      in a row). A lane that is backing off right now, or failed
 *                      2 % of its tasks or more, is a warning; a stray failure
 *                      among hundreds is neither
 */
export function judgeIndexerStatus(raw: unknown, now: number): IndexerVerdict {
  const s = obj(raw);
  if (!s) return { status: 'FAIL', detail: 'the indexer has published no status (is it running?)', lines: [] };
  const out: string[] = [];
  const fails: string[] = [];
  const warns: string[] = [];
  const at = Number(s.at);
  if (!Number.isFinite(at)) fails.push('the status has no timestamp');
  else if (now - at > STATUS_STALE_MS) fails.push(`the status is ${Math.round((now - at) / 1000)} s old - the indexer is not running`);

  const sockets = obj(s.sockets) ?? {};
  const streams = obj(s.streams) ?? {};
  const venues = obj(s.venues) ?? {};
  const names = [...new Set([...Object.keys(sockets), ...Object.keys(streams)])];
  if (!names.length) fails.push('the status lists no streams');
  let up = 0;
  for (const v of names) {
    const sock = posNum(sockets[v]);
    const since = posNum(streams[v]);
    const sub = obj(obj(venues[v])?.subscribed);
    if (sock !== null) {
      up++;
      out.push(`stream ${v}: up${since !== null ? `, gap-free for ${fmtAge(now - since)}` : ''}`);
    } else if (sub && Number(sub.confirmed) > 0 && Number(sub.confirmed) < Number(sub.markets)) {
      warns.push(`${v} stream is still subscribing (${sub.confirmed} of ${sub.markets} markets confirmed)`);
      out.push(`stream ${v}: subscribing ${sub.confirmed}/${sub.markets}`);
    } else {
      fails.push(`${v} stream is down`);
      out.push(`stream ${v}: DOWN`);
    }
  }

  const lane = (name: string, l: Record<string, unknown>): void => {
    const done = Number(l.done) || 0;
    const failed = Number(l.failed) || 0;
    const backoff = Number(l.backoffMs) || 0;
    const err = typeof l.lastError === 'string' && l.lastError ? ` (last error: ${l.lastError.slice(0, 120)})` : '';
    out.push(`lane ${name}: done ${done}, failed ${failed}, queued ${Number(l.queued) || 0}${backoff ? `, backing off ${Math.round(backoff / 1000)} s` : ''}${err}`);
    if (failed > 0 && done === 0) fails.push(`lane ${name}: ${failed} failed and nothing done${err}`);
    else if (failed >= 5 && failed / (failed + done) > 0.2) fails.push(`lane ${name}: ${failed} of ${failed + done} tasks failed${err}`);
    else if (backoff >= 60_000) fails.push(`lane ${name} is backing off for ${Math.round(backoff / 1000)} s${err}`);
    // A stray failure among hundreds of tasks is an upstream hiccup, not a failing lane: 2 % or a back-off is a warning.
    else if (backoff > 0 || (failed > 0 && failed / (failed + done) >= 0.02)) warns.push(`lane ${name}: ${failed} failed of ${failed + done}${backoff ? `, backing off ${Math.round(backoff / 1000)} s` : ''}${err}`);
  };
  const lanes = obj(s.lanes) ?? {};
  for (const [name, l] of Object.entries(lanes)) if (obj(l)) lane(name, obj(l)!);
  // The other venues run their own queue; the same counters, under `venues`.
  for (const [name, l] of Object.entries(venues)) if (obj(l) && ('done' in obj(l)! || 'failed' in obj(l)!)) lane(name, obj(l)!);
  if (!Object.keys(lanes).length) fails.push('the status lists no lanes');

  const built = Number(s.lastBuildAt);
  if (Number.isFinite(built) && built > 0) {
    const age = now - built;
    out.push(`boards: last built ${fmtAge(age)} ago (the build took ${fmtAge(Number(s.lastBuildMs) || 0)})`);
    if (age > BUILD_FAIL_MS) fails.push(`the boards were last rebuilt ${fmtAge(age)} ago`);
    else if (age > BUILD_WARN_MS) warns.push(`the boards were last rebuilt ${fmtAge(age)} ago`);
  } else {
    warns.push('no board has been built yet (a cold start)');
  }
  if (typeof s.lastError === 'string' && s.lastError) warns.push(`last build error: ${s.lastError.slice(0, 160)}`);

  const laneCount = Object.keys(lanes).length + Object.values(venues).filter((l) => obj(l) && ('done' in obj(l)! || 'failed' in obj(l)!)).length;
  if (fails.length) return { status: 'FAIL', detail: fails.join('; '), lines: out };
  if (warns.length) return { status: 'WARN', detail: `${up} of ${names.length} streams up, ${laneCount} lanes - ${warns.join('; ')}`, lines: out };
  return { status: 'PASS', detail: `${up} of ${names.length} streams up, ${laneCount} lanes, none failing`, lines: out };
}

function fmtAge(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 90) return `${sec} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 48 * 3600) return `${(sec / 3600).toFixed(1)} h`;
  return `${Math.round(sec / 86400)} d`;
}
