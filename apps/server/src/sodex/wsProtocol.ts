/**
 * The SoDEX WebSocket protocol, pure: no socket, no Node, no DOM.
 *
 * Shared by the server's upstream manager (sodex/ws.ts, hub.ts) and the
 * browser's own connections (apps/web/src/exchange/ws), so both sides send the
 * gateway exactly the same subscription shapes and route pushes by exactly the
 * same rules. Everything here used to live in sodex/ws.ts and hub.ts, which
 * re-export it unchanged.
 */

export interface SubParams {
  channel: string;
  symbol?: string;
  symbols?: string[];
  interval?: string;
  level?: number;
  user?: string;
}

/**
 * How each channel wants its symbol(s) expressed.
 *
 * DETERMINED EMPIRICALLY against testnet-gw.sodex.dev, because the published
 * reference (references/websocket.md) is wrong for two channels: it documents
 * `trade` and `markPrice` as taking `symbol`, but the gateway rejects that with
 * "symbols cannot be empty" and requires an array. The confusion is easy to hit
 * because the gateway ECHOES a one-element `symbols:[X]` back as `symbol:"X"`
 * in the subscribe ack, which reads like confirmation of the singular form.
 *
 * Verified matrix (subscribe ack, one channel per connection):
 *   trade        symbol=ERR   symbols=OK    none=ERR
 *   l2Book       symbol=OK    symbols=ERR   none=ERR
 *   candle       symbol=OK    symbols=ERR   none=ERR
 *   ticker       symbol=ERR   symbols=OK    none=ERR
 *   bookTicker   symbol=ERR   symbols=OK    none=ERR
 *   markPrice    symbol=ERR   symbols=OK    none=ERR
 *   allTicker    symbol=OK    symbols=OK    none=OK
 *   allMarkPrice symbol=OK    symbols=OK    none=OK
 */
export const CHANNEL_PARAM_STYLE: Record<string, 'symbol' | 'symbols' | 'none'> = {
  trade: 'symbols',
  l2Book: 'symbol',
  candle: 'symbol',
  ticker: 'symbols',
  bookTicker: 'symbols',
  markPrice: 'symbols',
  allTicker: 'none',
  allMarkPrice: 'none',
};

/** Channels whose `data` is an array of per-symbol entries. */
export const ARRAY_CHANNELS = new Set(['ticker', 'allTicker', 'bookTicker', 'markPrice', 'allMarkPrice']);
/** Channels scoped to a wallet rather than a symbol. */
export const ACCOUNT_CHANNELS = new Set([
  'accountOrderUpdate',
  'accountTrade',
  'accountUpdate',
  'accountState',
]);

/** The gateway drops a connection after 60 s of silence; ping at half that. */
export const KEEPALIVE_MS = 30_000;

/*
 * ACCOUNT CHANNELS: ONE CONNECTION PER WALLET.
 *
 * The gateway's account pushes (accountTrade, accountOrderUpdate, accountUpdate,
 * accountState) carry no wallet: only the subscribe ack names it. With two
 * wallets subscribed on one shared connection - your own, and one you are
 * scanning - their fills are indistinguishable. So each wallet gets its own
 * connection and every push is stamped with it.
 *
 * The gateway allows 10 connections per IP: the two market connections plus at
 * most ACCOUNT_CONN_CAP of these. A wallet beyond the cap gets no live stream
 * (the pages poll the same data anyway); idle connections close after
 * ACCOUNT_IDLE_CLOSE_MS so a scan does not hold one for good.
 */
export const ACCOUNT_CONN_CAP = 6;
export const ACCOUNT_IDLE_CLOSE_MS = 30_000;

/**
 * Rewrite caller-supplied params into the shape the gateway actually accepts,
 * so callers may pass either `symbol` or `symbols` for any channel.
 */
export function normaliseSubParams(p: SubParams): SubParams {
  if (ACCOUNT_CHANNELS.has(p.channel)) {
    return { channel: p.channel, user: p.user };
  }
  const style = CHANNEL_PARAM_STYLE[p.channel] ?? 'symbol';
  const list = [p.symbol, ...(p.symbols ?? [])].filter(Boolean) as string[];
  const out: SubParams = { channel: p.channel };

  if (style === 'symbols') out.symbols = [...new Set(list)];
  else if (style === 'symbol' && list[0]) out.symbol = list[0];

  if (p.interval) out.interval = p.interval;
  if (p.level !== undefined) out.level = p.level;
  return out;
}

/**
 * Stable identity for a subscription, so refcounts and re-subscribes line up.
 * Computed on the NORMALISED params, so `{symbol:'X'}` and `{symbols:['X']}`
 * resolve to the same upstream subscription rather than opening two.
 */
export function subKey(raw: SubParams): string {
  const p = normaliseSubParams(raw);
  const parts = [p.channel];
  if (p.symbol) parts.push(`s=${p.symbol}`);
  if (p.symbols?.length) parts.push(`ss=${[...p.symbols].sort().join('|')}`);
  if (p.interval) parts.push(`i=${p.interval}`);
  if (p.level !== undefined) parts.push(`l=${p.level}`);
  if (p.user) parts.push(`u=${p.user.toLowerCase()}`);
  return parts.join(',');
}

/** Every symbol referenced by a push message. */
export function symbolsIn(msg: any): string[] {
  const d = msg?.data;
  if (Array.isArray(d)) return [...new Set(d.map((e: any) => e?.s).filter(Boolean))] as string[];
  return d?.s ? [d.s] : [];
}

/**
 * The subscription keys a push message could satisfy.
 *
 * Note this reconstructs keys from the PAYLOAD, because the gateway does not
 * echo the subscription parameters on pushes.
 */
export function routeKeys(msg: any): string[] {
  const channel = msg?.channel;
  if (!channel) return [];
  if (ACCOUNT_CHANNELS.has(channel)) {
    // The gateway's account pushes name no wallet (verified live: a bare array of
    // fills / order updates, envelope {channel, type} only). `msg.user` is stamped
    // by the single-wallet connection that received it.
    const user = msg?.user ?? msg?.data?.user;
    return [subKey({ channel, user: user ?? undefined })];
  }
  const interval = Array.isArray(msg.data) ? undefined : msg?.data?.i;
  return symbolsIn(msg).map((s) => subKey({ channel, symbol: s, interval }));
}

/**
 * Whether an account push belongs to a subscription: only when the wallet that
 * received it is exactly the one subscribed. A push that names no wallet goes
 * nowhere - one wallet's fills must never reach another wallet's listeners.
 */
export function accountPushFor(subUser: string | undefined, msgUser: unknown): boolean {
  const want = subUser?.trim().toLowerCase();
  const got = typeof msgUser === 'string' ? msgUser.trim().toLowerCase() : '';
  return !!want && !!got && want === got;
}

/** The symbols one subscription asked for; empty means "everything on the channel". */
export const wantedSymbols = (params: SubParams): Set<string> =>
  new Set<string>([params.symbol, ...(params.symbols ?? [])].filter(Boolean) as string[]);

/**
 * What one subscriber receives of one upstream push, or null for nothing.
 *
 * - account channels: the push only when it was received for exactly this
 *   subscription's wallet (accountPushFor), tagged with that wallet;
 * - array channels: narrowed to the symbols asked for (a client watching
 *   BTC-USD neither receives nor discards forty other symbols);
 * - object channels: only for a symbol asked for, and a candle only for the
 *   interval asked for.
 */
export function pushFor(
  params: SubParams,
  wanted: ReadonlySet<string>,
  msg: any,
): { data: unknown; user?: string } | null {
  const channel = msg?.channel;
  if (!channel || params.channel !== channel) return null;
  if (ACCOUNT_CHANNELS.has(channel)) {
    if (!accountPushFor(params.user, msg?.user ?? msg?.data?.user)) return null;
    return { data: msg.data, user: params.user?.toLowerCase() };
  }
  if (Array.isArray(msg.data) && ARRAY_CHANNELS.has(channel)) {
    const data = wanted.size ? msg.data.filter((e: any) => wanted.has(e?.s)) : msg.data;
    return data.length ? { data } : null;
  }
  const syms = symbolsIn(msg);
  if (wanted.size && !syms.some((s) => wanted.has(s))) return null;
  if (params.interval && msg?.data?.i && msg.data.i !== params.interval) return null;
  return { data: msg.data };
}
