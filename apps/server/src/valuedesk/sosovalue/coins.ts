/**
 * Which coins a piece of text is about, read against SoSoValue's own currency
 * list (/currencies) - so a coin it starts listing is recognised without a
 * change here. A story that carries no coins of its own (the hot list, a post
 * SoSoValue did not tag) gets them this way.
 *
 * A ticker counts in capitals as a word of its own ("BTC", "$SOL"); a name counts
 * whole and in any case ("Bitcoin", "solana"), and only for the better-known
 * coins, whose names are not everyday words. Two short lists keep out what
 * looks like a coin and is not: capitalised words of finance and tech news
 * (ETF, SEC, CEO...) and coin names that are ordinary words.
 *
 * SoSoValue lists stocks too, their names as JSON ({"EN": "HSBC HOLDINGS PLC
 * ADR"}); those are not coins and are left out.
 */

export interface Coin {
  /** The ticker, in capitals: BTC. */
  symbol: string;
  name: string;
}

export interface CoinIndex {
  coins: Coin[];
  /** A ticker as a word: $BTC or BTC. Null when the list is empty. */
  tickers: RegExp | null;
  /** A known coin's name as a word, any case. */
  names: RegExp | null;
  bySymbol: Map<string, Coin>;
  byName: Map<string, string>;
}

/** Capitalised words of finance and tech news that are also somebody's ticker. */
const NOT_COINS = new Set([
  'AI', 'API', 'APP', 'ATH', 'ATM', 'AUM', 'CEO', 'CFO', 'CFTC', 'CEX', 'CPI', 'CTO', 'DAO', 'DEX', 'DOJ', 'ETF', 'ETFS', 'EU',
  'FBI', 'FED', 'FOMC', 'FUD', 'GDP', 'IMF', 'IPO', 'IRS', 'KYC', 'AML', 'LLC', 'NFT', 'NFTS', 'NYSE', 'OTC', 'PCE', 'PMI', 'SEC',
  'TVL', 'UK', 'US', 'USA', 'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'HKD', 'UAE', 'UN', 'VC', 'WEB', 'X', 'OK', 'NEW', 'ONE', 'ALL',
  'FOR', 'THE', 'AND', 'NOT', 'NOW', 'BIG', 'TOP', 'BUY', 'SELL', 'CEOS', 'LIVE', 'NEWS', 'HOT', 'GAS', 'FREE', 'REAL', 'OPEN',
]);
/** Coin names that are everyday words: as a ticker in capitals they still count. */
const COMMON_NAMES = new Set([
  'maker', 'story', 'sonic', 'movement', 'flow', 'gas', 'gala', 'core', 'harmony', 'theta', 'stacks', 'mantle', 'sun', 'one',
  'chain', 'dash', 'render', 'optimism', 'polygon', 'near', 'cosmos', 'stellar', 'jupiter', 'aurora', 'oasis', 'kava', 'zora',
]);

/** A name that SoSoValue gives as JSON ({"EN": "..."}) is a stock's; null otherwise. */
export function stockName(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim().startsWith('{')) return null;
  try {
    const o = JSON.parse(v) as Record<string, unknown>;
    const en = o.EN ?? o.en ?? Object.values(o)[0];
    return typeof en === 'string' ? en.trim() : '';
  } catch {
    return null;
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The index for a currency list as SoSoValue sends it ({currency_id, symbol,
 * name}, best-known first). Tickers count from the first `top` coins, names
 * from the first `topNames`.
 */
export function coinIndex(rows: readonly unknown[], top = 300, topNames = 120): CoinIndex {
  const coins: Coin[] = [];
  const bySymbol = new Map<string, Coin>();
  for (const row of rows) {
    if (coins.length >= top) break;
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (stockName(r.name) !== null) continue;
    const symbol = typeof r.symbol === 'string' ? r.symbol.trim().toUpperCase() : '';
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!/^[A-Z0-9]{2,12}$/.test(symbol) || bySymbol.has(symbol)) continue;
    const coin = { symbol, name: name || symbol };
    coins.push(coin);
    bySymbol.set(symbol, coin);
  }
  const tickers = coins.map((c) => c.symbol).filter((s) => !NOT_COINS.has(s) && /[A-Z]/.test(s));
  const byName = new Map<string, string>();
  for (const c of coins.slice(0, topNames)) {
    const n = c.name.toLowerCase();
    if (n.length >= 4 && /^[a-z][a-z ]+$/.test(n) && !COMMON_NAMES.has(n) && n !== c.symbol.toLowerCase() && !byName.has(n)) byName.set(n, c.symbol);
  }
  // Longest first, so "Bitcoin Cash" wins over "Bitcoin".
  const longest = (a: string, b: string) => b.length - a.length;
  return {
    coins,
    bySymbol,
    byName,
    tickers: tickers.length ? new RegExp(`(?<![A-Za-z0-9])\\$?(${tickers.sort(longest).map(escape).join('|')})(?![A-Za-z0-9])`, 'g') : null,
    names: byName.size ? new RegExp(`(?<![A-Za-z0-9])(${[...byName.keys()].sort(longest).map(escape).join('|')})(?![A-Za-z0-9])`, 'gi') : null,
  };
}

/** The coins in a text, in the order they first appear, at most `max`. */
export function coinsIn(text: string, index: CoinIndex, max = 4): string[] {
  if (!text) return [];
  const found: Array<{ at: number; symbol: string }> = [];
  if (index.tickers) for (const m of text.matchAll(index.tickers)) found.push({ at: m.index ?? 0, symbol: m[1]! });
  if (index.names) for (const m of text.matchAll(index.names)) {
    const symbol = index.byName.get(m[1]!.toLowerCase());
    if (symbol) found.push({ at: m.index ?? 0, symbol });
  }
  const out: string[] = [];
  for (const f of found.sort((a, b) => a.at - b.at)) {
    if (!out.includes(f.symbol)) out.push(f.symbol);
    if (out.length >= max) break;
  }
  return out;
}
