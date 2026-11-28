/**
 * ValueChain NFT floor prices, overall and per rarity tier (owner 2026-11-28: "use valuemint.store for valuechain nfts
 * floor prices and floor price of rarity"). The Portfolio values a wallet's ValueChain NFTs with it; NFTs on other
 * chains stay unvalued (no source without a key).
 *
 * SOURCE. valuemint.store, ValueChain's NFT market, publishes two public reads (its own pages use them): a summary with
 * every collection's floor (`floorWei`, SOSO with 18 decimals) and the open listings (Seaport orders). Its server sends
 * no CORS header, so a browser cannot read it: this server does, every ten minutes, and answers one small document.
 *
 * TIERS. A listing's tier is the listed token's own: a SoDEX Treasure Box's from its token URI (`.../sobox/<n>`, the
 * level named by SoDEX's metadata for n), any other collection's from a Tier, Rarity, Level or Grade trait in its
 * metadata on ValueChain's explorer. A token's tier never changes, so it is read once and kept; a collection whose first
 * tokens carry no such trait is not asked again (it has no tiers). A tier's floor is the lowest open listing of it.
 *
 * A listing's price is everything its buyer pays (the seller's part and the market's fee), per unit: the same number
 * valuemint.store shows and calls the floor (checked 2026-11-28: SoDEXTreasureBox 7.02 + 0.18 = 7.2 SOSO = its floorWei).
 */

const MARKET = 'https://www.valuemint.store';
const EXPLORER = 'https://main-scan.valuechain.xyz';
const RPC = 'https://rpc.valuechain.xyz';
const SOBOX = '0x371c4f7f68be3e558b89cc1f0fb113851c76e750';
const TIER_TRAITS = ['tier', 'rarity', 'level', 'grade'];
/** After this many tokens of a collection without a tier trait, the collection is taken to have none. */
const PROBE = 12;

export interface TierFloor { floor: number; listed: number }
export interface CollectionFloor {
  name: string;
  symbol: string | null;
  /** Lowest open listing, SOSO (valuemint.store's floor). */
  floor: number | null;
  listed: number;
  /** The trait the tiers come from ("Tier", "Level"), null when the collection has none. */
  trait: string | null;
  tiers: Record<string, TierFloor>;
  /** The best open offer for any NFT of the collection (a collection offer), SOSO; null with none. */
  bestOffer: number | null;
  offers: number;
}
export interface FloorsDoc {
  ok: true; at: number; source: 'valuemint.store'; currency: 'SOSO'; collections: Record<string, CollectionFloor>;
  /** SoDEX boxes: the level of each token-URI number (`.../sobox/<n>`), so a page can tell a held box's tier. */
  soboxLevels?: Record<string, string>;
  /** Per NFT: its lowest asking price and its best offer made for it alone, SOSO ([ask, bid], either null). */
  tokens?: Record<string, Record<string, [number | null, number | null]>>;
}

/** An open offer (wrapped SOSO for an NFT): for any NFT of a collection, or for one token. Null for anything else. */
export function offerOf(o: Order, nowSec: number): { collection: string; tokenId: string | null; price: number } | null {
  const p = o.params;
  const pay = p?.offer?.[0];
  const want = p?.consideration?.[0];
  if (!p || !pay || pay.itemType !== 1 || !want?.token || (want.itemType !== 2 && want.itemType !== 4)) return null;
  if (Number(p.startTime ?? 0) > nowSec || (p.endTime && Number(p.endTime) <= nowSec)) return null;
  /* An offer can ask for several NFTs at once (225 SOSO for 5 Cybereators, 2026-11-28): its price is per NFT. */
  const units = /^\d{1,6}$/.test(want.startAmount ?? '1') ? Math.max(1, Number(want.startAmount ?? '1')) : 1;
  const price = wei(pay.startAmount) / units;
  if (!(price > 0)) return null;
  const any = want.itemType === 4 && (want.identifierOrCriteria ?? '0') === '0';
  if (want.itemType === 4 && !any) return null; // a criteria list (some tokens): not read
  return { collection: want.token.toLowerCase(), tokenId: any ? null : String(want.identifierOrCriteria), price };
}

interface Summary { collections?: Array<{ address?: string; name?: string; symbol?: string; floorWei?: string | null; listed?: number }> }
interface Order { params?: { offer?: Array<{ token?: string; itemType?: number; identifierOrCriteria?: string; startAmount?: string }>; consideration?: Array<{ token?: string; itemType?: number; identifierOrCriteria?: string; startAmount?: string }>; startTime?: string; endTime?: string } }

const ZERO = /^0x0{40}$/i;
const wei = (s: string | null | undefined): number => {
  if (!s || !/^\d+$/.test(s)) return 0;
  const n = BigInt(s);
  return Number(n / 10n ** 12n) / 1e6;
};

/** An open listing: the NFT (collection, token, units) and what its buyer pays per unit, in SOSO. Null for anything else. */
export function listingOf(o: Order, nowSec: number): { collection: string; tokenId: string; price: number } | null {
  const p = o.params;
  const item = p?.offer?.[0];
  if (!p || !item?.token || (item.itemType !== 2 && item.itemType !== 3) || !item.identifierOrCriteria) return null;
  if (Number(p.startTime ?? 0) > nowSec || (p.endTime && Number(p.endTime) <= nowSec)) return null;
  // Summed in base units (exact), then turned into SOSO once.
  const raw = (p.consideration ?? []).filter((c) => c.itemType === 0 && (!c.token || ZERO.test(c.token)) && /^\d+$/.test(c.startAmount ?? ''))
    .reduce((t, c) => t + BigInt(c.startAmount!), 0n);
  const units = Math.max(1, Number(item.startAmount ?? 1) || 1);
  const paid = wei(raw.toString());
  if (!(paid > 0)) return null;
  return { collection: item.token.toLowerCase(), tokenId: item.identifierOrCriteria, price: paid / units };
}

/** The tier in a token's metadata attributes, by the first tier-like trait. */
export function tierOf(attrs: unknown): { trait: string; value: string } | null {
  if (!Array.isArray(attrs)) return null;
  for (const want of TIER_TRAITS) {
    for (const a of attrs as Array<{ trait_type?: unknown; value?: unknown }>) {
      if (String(a?.trait_type ?? '').trim().toLowerCase() === want && a.value !== undefined && a.value !== null && String(a.value).trim()) {
        return { trait: String(a.trait_type).trim(), value: String(a.value).trim() };
      }
    }
  }
  return null;
}

/** Floors per collection and tier from the summary, the listings and each listed token's tier. */
export function buildFloors(summary: Summary, listings: Array<{ collection: string; tokenId: string; price: number }>, tiers: (collection: string, tokenId: string) => { trait: string; value: string } | null | undefined, at: number): FloorsDoc {
  const collections: Record<string, CollectionFloor> = {};
  for (const c of summary.collections ?? []) {
    if (!c.address) continue;
    const f = wei(c.floorWei ?? null);
    collections[c.address.toLowerCase()] = { name: c.name ?? c.address, symbol: c.symbol ?? null, floor: f > 0 ? f : null, listed: c.listed ?? 0, trait: null, tiers: {}, bestOffer: null, offers: 0 };
  }
  for (const l of listings) {
    const col = collections[l.collection];
    if (!col) continue;
    const t = tiers(l.collection, l.tokenId);
    if (!t) continue;
    col.trait = col.trait ?? t.trait;
    const cur = col.tiers[t.value];
    col.tiers[t.value] = cur ? { floor: Math.min(cur.floor, l.price), listed: cur.listed + 1 } : { floor: l.price, listed: 1 };
  }
  return { ok: true, at, source: 'valuemint.store', currency: 'SOSO', collections };
}

/** Per NFT asks and token offers, and each collection's best collection offer (written into `doc`). */
export function priceTokens(doc: FloorsDoc, listings: Array<{ collection: string; tokenId: string; price: number }>, offers: Array<{ collection: string; tokenId: string | null; price: number }>): NonNullable<FloorsDoc['tokens']> {
  const t: NonNullable<FloorsDoc['tokens']> = {};
  const at = (c: string, id: string) => ((t[c] ??= {})[id] ??= [null, null]);
  for (const l of listings) { const x = at(l.collection, l.tokenId); x[0] = x[0] === null ? l.price : Math.min(x[0], l.price); }
  for (const o of offers) {
    const col = doc.collections[o.collection];
    if (o.tokenId === null) {
      if (col) { col.offers += 1; col.bestOffer = col.bestOffer === null ? o.price : Math.max(col.bestOffer, o.price); }
    } else {
      if (col) col.offers += 1;
      const x = at(o.collection, o.tokenId); x[1] = x[1] === null ? o.price : Math.max(x[1], o.price);
    }
  }
  return t;
}

/* ------------------------------------------------------------------------------------------- reading ----- */

const json = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(url, { ...init, headers: { Accept: 'application/json', 'User-Agent': 'ValueDesk', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return (await r.json()) as T;
};

/** Known tiers: `collection:tokenId` -> tier (null: has none). Kept for the process's life (a tier never changes). */
const tierCache = new Map<string, { trait: string; value: string } | null>();
/** Collections found to carry no tier trait. */
const noTiers = new Set<string>();
const probed = new Map<string, number>();
let soboxLevels: Map<string, string> | null = null;

async function readSoboxLevels(): Promise<Map<string, string>> {
  if (soboxLevels) return soboxLevels;
  const m = new Map<string, string>();
  for (let n = 0; n < 8; n++) {
    // SoDEX's gateway answers this metadata with status 501 and the document itself (checked 2026-11-28): the body is read
    // whatever the status.
    const meta = await fetch(`https://mainnet-gw.sodex.dev/api/v1/nft/token/sobox/${n}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
      .then((r) => r.json() as Promise<{ attributes?: unknown }>).catch(() => null);
    const t = meta ? tierOf(meta.attributes) : null;
    if (!t) break;
    m.set(String(n), t.value);
  }
  soboxLevels = m;
  return m;
}

/** SoDEX boxes: tokenURI(id) for each, in batches of 50 (one JSON-RPC request each). */
async function resolveSobox(ids: string[]): Promise<void> {
  const levels = await readSoboxLevels();
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    const calls = part.map((id, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_call', params: [{ to: SOBOX, data: `0xc87b56dd${BigInt(id).toString(16).padStart(64, '0')}` }, 'latest'] }));
    const res = await json<Array<{ id: number; result?: string }>>(RPC, { method: 'POST', body: JSON.stringify(calls) }).catch(() => []);
    for (const r of res) {
      const id = part[r.id];
      if (!id || !r.result || r.result.length < 130) continue;
      const hex = r.result.slice(2);
      const len = parseInt(hex.slice(64, 128), 16);
      const uri = Buffer.from(hex.slice(128, 128 + len * 2), 'hex').toString('utf8');
      const n = /\/sobox\/(\d+)\b/.exec(uri)?.[1];
      const level = n !== undefined ? levels.get(n) : undefined;
      tierCache.set(`${SOBOX}:${id}`, level ? { trait: 'Level', value: level } : null);
    }
  }
}

/** Other collections: the token's metadata on ValueChain's explorer, four at a time. */
async function resolveExplorer(todo: Array<{ collection: string; tokenId: string }>): Promise<void> {
  let at = 0;
  const work = async () => {
    while (at < todo.length) {
      const { collection, tokenId } = todo[at++]!;
      if (noTiers.has(collection)) continue;
      const d = await json<{ metadata?: { attributes?: unknown } | null }>(`${EXPLORER}/api/v2/tokens/${collection}/instances/${tokenId}`).catch(() => null);
      if (!d) continue; // not answered: asked again next time
      const t = tierOf(d.metadata?.attributes);
      tierCache.set(`${collection}:${tokenId}`, t);
      if (!t) {
        const n = (probed.get(collection) ?? 0) + 1;
        probed.set(collection, n);
        if (n >= PROBE && ![...tierCache.entries()].some(([k, v]) => v && k.startsWith(`${collection}:`))) noTiers.add(collection);
      }
    }
  };
  await Promise.all([work(), work(), work(), work()]);
}

const REFRESH_MS = 10 * 60_000;
let doc: FloorsDoc | null = null;
let running: Promise<FloorsDoc> | null = null;

async function refresh(): Promise<FloorsDoc> {
  const [summary, orders] = await Promise.all([
    json<Summary>(`${MARKET}/api/index/summary`),
    json<{ orders?: Order[] }>(`${MARKET}/api/index/orders`),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const listings = (orders.orders ?? []).map((o) => listingOf(o, now)).filter((x): x is NonNullable<typeof x> => x !== null);
  const unknown = listings.filter((l) => !tierCache.has(`${l.collection}:${l.tokenId}`) && !noTiers.has(l.collection));
  await resolveSobox(unknown.filter((l) => l.collection === SOBOX).map((l) => l.tokenId));
  await resolveExplorer(unknown.filter((l) => l.collection !== SOBOX));
  const base = buildFloors(summary, listings, (c, id) => tierCache.get(`${c}:${id}`), Date.now());
  doc = { ...base, soboxLevels: Object.fromEntries(await readSoboxLevels()), tokens: priceTokens(base, listings, (orders.orders ?? []).map((o) => offerOf(o, now)).filter((x): x is NonNullable<typeof x> => x !== null)) };
  return doc;
}

/** The floors, at most ten minutes old; the last good answer while a refresh runs or fails. */
export async function nftFloors(): Promise<FloorsDoc | null> {
  if (doc && Date.now() - doc.at < REFRESH_MS) return doc;
  running ??= refresh().finally(() => { running = null; });
  if (doc) { running.catch(() => undefined); return doc; }
  return running.catch(() => null);
}
