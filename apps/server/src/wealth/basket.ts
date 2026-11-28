/**
 * What an SSI index token holds, read from its own contract (owner 2026-11-28: "sodex shows breakdowns of the
 * consitutitons for antbssi and all others"; research notes ssi-constituents-logos-2026-11-28.md):
 *
 *   ANT Believers Index  ValueChain 0x1b0c…3139, selector 0x803a50f7 () -> (address[] tokens, uint256[] unitsPerShare),
 *                        units 1e18-scaled per ANTB; the tokens are SoDEX's own (vNVDA, vMSFT…), named by symbol()
 *   MAG7.ssi / DEFI.ssi / MEME.ssi  Base, getTokenset() 0x7b73ff04 -> (string chain, string symbol, string addr,
 *                        uint8 decimals, uint256 amount)[], amount in the coin's own units per one SSI token
 *   USSI                 no basket on chain (its backing is held off chain; SoSoValue publishes it only on a keyed API)
 *
 * Weights are each holding's quantity times its price over the sum, priced at SoDEX's perps mark price (SYMBOL-USD,
 * or 1000SYMBOL-USD / 1000), else SoDEX's spot last price (vSYMBOL_vUSDC). A holding SoDEX does not price is named, not given a weight: nothing is guessed. The sums
 * matched the tokens' own prices on 2026-11-28 (ANTB 9.582 vs NAV 9.558, MAG7 0.38331 vs 0.3833).
 */

export interface BasketRow { name: string; ticker: string; quantity: number; price: number | null; weight: number | null }
export interface Basket { rows: BasketRow[]; unpriced: string[]; value: number | null; chain: 'valuechain' | 'base'; token: string }

export const BASKETS: Readonly<Record<string, { chain: 'valuechain' | 'base'; token: string; kind: 'v2' | 'v1'; name: string }>> = {
  antb: { chain: 'valuechain', token: '0x1b0c2d25f432280882ffbd7da4f5b0597ecc3139', kind: 'v2', name: 'ANT Believers Index' },
  vMAG7ssi: { chain: 'base', token: '0x9E6A46f294bB67c20F1D1E7AfB0bBEf614403B55', kind: 'v1', name: 'MAG7.ssi' },
  vDEFIssi: { chain: 'base', token: '0x164ffdaE2fe3891714bc2968f1875ca4fA1079D0', kind: 'v1', name: 'DEFI.ssi' },
  vMEMEssi: { chain: 'base', token: '0xdd3acDBDc7b358Df453a6CB6bCA56C92aA5743aA', kind: 'v1', name: 'MEME.ssi' },
};

const strip = (h: string) => (h.startsWith('0x') ? h.slice(2) : h);
const word = (d: string, i: number): bigint => BigInt(`0x${d.slice(i * 64, i * 64 + 64) || '0'}`);
const at = (d: string, byte: number): string => d.slice(byte * 2);

/** (address[], uint256[]) */
export function decodeAddrUints(hex: string): { tokens: string[]; units: bigint[] } {
  const d = strip(hex);
  const arr = (off: number) => { const s = at(d, off); const n = Number(word(s, 0)); return Array.from({ length: n }, (_, k) => word(s, k + 1)); };
  const tokens = arr(Number(word(d, 0))).map((v) => `0x${v.toString(16).padStart(40, '0')}`);
  const units = arr(Number(word(d, 1)));
  return { tokens, units };
}

/** An ABI string at a byte offset of `d`. */
function str(d: string, off: number): string {
  const s = at(d, off);
  const n = Number(word(s, 0));
  const hex = s.slice(64, 64 + n * 2);
  return Buffer.from(hex, 'hex').toString('utf8');
}

/** (string chain, string symbol, string addr, uint8 decimals, uint256 amount)[] as one return value. */
export function decodeTokenset(hex: string): Array<{ chain: string; symbol: string; addr: string; decimals: number; amount: bigint }> {
  const d = strip(hex);
  const arrStart = Number(word(d, 0));
  const a = at(d, arrStart);
  const n = Number(word(a, 0));
  const body = a.slice(64);
  const out: Array<{ chain: string; symbol: string; addr: string; decimals: number; amount: bigint }> = [];
  for (let k = 0; k < n; k++) {
    const tOff = Number(word(body, k));
    const t = at(body, tOff);
    out.push({ chain: str(t, Number(word(t, 0))), symbol: str(t, Number(word(t, 1))), addr: str(t, Number(word(t, 2))), decimals: Number(word(t, 3)), amount: word(t, 4) });
  }
  return out;
}

/** symbol() as a string (ABI string return). */
export const decodeString = (hex: string): string => { const d = strip(hex); return d.length >= 128 ? str(d, Number(word(d, 0))) : ''; };

const CHAIN_PREFIX = /^(ETH|SOL|BSC|BASE|ARB|HYPEREVM|POLYGON|AVAX|TRON|SUI|APT)_/;
const ALIAS: Readonly<Record<string, string>> = { UNISWAP: 'UNI' };
/**
 * A holding's ticker: SoDEX's own tokens lose their v (vNVDA -> NVDA); an SSI tokenset's "ETH_LINK" loses its chain,
 * and a trailing 1 that only tells two wrapped copies apart (SOL_TRUMP1) goes too; UNISWAP is UNI.
 */
export function tickerOf(sym: string): string {
  if (CHAIN_PREFIX.test(sym)) {
    const t = sym.replace(CHAIN_PREFIX, '').replace(/([A-Z]{2,})1$/, '$1');
    return ALIAS[t] ?? t;
  }
  return (/^v[A-Z0-9]/.test(sym) ? sym.slice(1) : sym).replace(/\.ssi$/i, '');
}

/** The price of a ticker from SoDEX's perps marks: SYMBOL-USD, or 1000SYMBOL-USD over 1000. */
export function priceOf(ticker: string, marks: ReadonlyMap<string, number>): number | null {
  const t = ticker.toUpperCase();
  const p = marks.get(`${t}-USD`);
  if (p && p > 0) return p;
  const k = marks.get(`1000${t}-USD`);
  if (k && k > 0) return k / 1000;
  // SoDEX's spot book where it has no perp (vAVGO_vUSDC), last price.
  const s = marks.get(`v${t}_vUSDC`);
  return s && s > 0 ? s : null;
}

/** Rows weighted by value among those SoDEX prices; the rest named as unpriced. */
export function weigh(items: Array<{ name: string; ticker: string; quantity: number }>, marks: ReadonlyMap<string, number>): Pick<Basket, 'rows' | 'unpriced' | 'value'> {
  const rows: BasketRow[] = items.map((x) => { const price = priceOf(x.ticker, marks); return { ...x, price, weight: null }; });
  const value = rows.reduce((s, r) => s + (r.price !== null ? r.price * r.quantity : 0), 0);
  for (const r of rows) if (r.price !== null && value > 0) r.weight = (r.price * r.quantity) / value;
  rows.sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1));
  return { rows, unpriced: rows.filter((r) => r.price === null).map((r) => r.ticker), value: value > 0 ? value : null };
}
