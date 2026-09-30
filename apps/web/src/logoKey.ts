/**
 * Which logo a SoDEX coin or market name uses.
 *
 * SoDEX spells one asset many ways: `vBTC` (its ValueChain token), `BTC-USD`
 * (perps market), `vBTC_vUSDC` / `BTC/USDC` (spot), `vsMAG7.ssi`, `aCXMT`,
 * `vXAUt`, `sSOSO`... The logo manifest is keyed the way sodex.com keys its own
 * icons (upper-cased), and this turns any of those spellings into the keys to
 * try, most specific first - the same order sodex.com resolves them in, so a
 * name shows the icon sodex.com would show.
 *
 * Shared by the app (logos.ts) and tools/fetch-logos.mjs, which refuses to
 * write a manifest that leaves a listed asset unresolved. Plain erasable
 * TypeScript on purpose: Node runs it directly.
 */

const QUOTE_SUFFIXES = ['USDT', 'USDC', 'USD', 'PERP'];
const K_UNITS = new Set(['KPEPE', 'KSHIB', 'KBONK', 'KFLOKI', 'KNEIRO', 'KLUNC', 'KDOGS']);

export function logoCandidates(name: string | null | undefined): string[] {
  const raw = (name ?? '').trim();
  if (!raw) return [];
  // A dex-prefixed market (Hyperliquid HIP-3 `xyz:TSLA`) is the coin after the colon.
  const tail = raw.includes(':') ? (raw.split(':').pop() ?? '') : '';
  const tailHead = tail.split(/[/_\s-]/)[0] ?? '';
  const head = raw.split(/[/:_\s-]/)[0] ?? '';
  const out: string[] = [];
  for (const x of [raw, tail, tailHead, head]) {
    if (!x) continue;
    out.push(x);
    // ValueChain spellings: vBTC -> BTC, vsMAG7.ssi -> sMAG7.ssi (then MAG7.ssi), aCXMT -> CXMT.
    if (/^vs[A-Z0-9]/.test(x)) out.push(x.slice(1), x.slice(2));
    else if (/^[va][A-Z0-9]/.test(x)) out.push(x.slice(1));
  }
  const upper = out.map((x) => x.toUpperCase());
  // Last resorts: a pair written without a separator (BTCUSDT), a 1000x meme unit (1000FOO).
  for (const x of upper.filter((u) => !/[/:_\s-]/.test(u))) {
    for (const q of QUOTE_SUFFIXES) if (x.endsWith(q) && x.length > q.length) upper.push(x.slice(0, -q.length));
    const unit = /^1000(.+)$/.exec(x);
    if (unit?.[1]) upper.push(unit[1]);
  }
  // A staked sFOO; Hyperliquid's 1000x units (kPEPE, kBONK).
  for (const x of out) if (/^[sk][A-Z0-9]/.test(x)) upper.push(x.slice(1).toUpperCase());
  // The same 1000x units once a name was upper-cased (KPEPE): only Hyperliquid's own
  // k-coins, so a real ticker that starts with K never borrows another coin's logo.
  for (const x of upper.slice()) if (K_UNITS.has(x)) upper.push(x.slice(1));
  return [...new Set(upper)];
}

/** The first candidate the table has, or undefined. */
export function resolveKey<T>(name: string | null | undefined, table: Record<string, T>): T | undefined {
  for (const k of logoCandidates(name)) {
    const hit = table[k];
    if (hit !== undefined) return hit;
  }
  return undefined;
}
