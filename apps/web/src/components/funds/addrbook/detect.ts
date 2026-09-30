/**
 * What a saved address LOOKS like in the address book: the main logo (the
 * exchange / wallet / protocol it belongs to, else the coin) and the small
 * badge, which is always the CHAIN.
 *
 * Worked out from the contact's name and address - "bitget eth deposit" is
 * Bitget on Ethereum, "usdc arb" is USDC on Arbitrum, a "bc1…" address is
 * Bitcoin whatever it is called - and overridden by whatever the user picked
 * (contacts.ts ContactLook). Pure: the catalog and the coin list are passed in.
 */
import type { AddressKind } from '../../../trading/addresses';

export type PlatformKind = 'cex' | 'dex' | 'wallet' | 'defi' | 'bridge';

export interface CatalogPlatform {
  id: string;
  name: string;
  kind: PlatformKind;
  aliases: string[];
}

export interface CatalogChain {
  id: string;
  name: string;
  /** SoDEX's key for it, when SoDEX routes there (ETH, ARBITRUM_ETH, SOL…). */
  sodexKey: string | null;
  aliases: string[];
  /** Which addresses live on it; chains of another kind are never offered for an address. */
  addressKind: AddressKind | 'other';
}

export interface Catalog {
  platforms: CatalogPlatform[];
  chains: CatalogChain[];
}

export interface Look {
  platform: string | null;
  coin: string | null;
  chain: string | null;
}

/** Words that name what an address is FOR, never which platform/coin/chain it is. */
const STOP = new Set([
  'my', 'main', 'mine', 'wallet', 'wallets', 'address', 'addr', 'account', 'acc', 'deposit', 'withdraw', 'withdrawal', 'hot',
  'cold', 'savings', 'saving', 'trading', 'trade', 'personal', 'business', 'old', 'new', 'test', 'the', 'to', 'for', 'on', 'of',
  'and', 'from', 'with', 'in', 'at', 'a', 'an', 'me', 'friend', 'mom', 'dad', 'vault', 'safe box', 'backup', 'spare', 'second',
  'first', 'primary', 'secondary', 'usd', 'eur', 'payout', 'payouts', 'exchange', 'cex', 'dex', 'l2', 'network', 'chain', 'net',
]);

/** The name's words, lower-case, accents and punctuation dropped ("OKX-Arb." -> okx, arb). */
export function words(name: string): string[] {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
}

interface Index {
  platform: Map<string, CatalogPlatform>;
  chain: Map<string, CatalogChain>;
}
const indexes = new WeakMap<Catalog, Index>();
function indexOf(catalog: Catalog): Index {
  let ix = indexes.get(catalog);
  if (!ix) {
    ix = { platform: new Map(), chain: new Map() };
    for (const p of catalog.platforms) for (const a of [p.id, p.name, ...p.aliases]) ix.platform.set(a.toLowerCase(), p);
    for (const c of catalog.chains) for (const a of [c.id, c.name, ...c.aliases]) ix.chain.set(a.toLowerCase(), c);
    indexes.set(catalog, ix);
  }
  return ix;
}

/**
 * Platform, coin and chain named in `name`, read left to right taking the
 * LONGEST phrase that names something ("binance smart chain" is a chain, not
 * Binance; "trust wallet" beats "trust"). A phrase that names both a chain and
 * a platform is the chain. A word that is a chain may also be the coin ("eth",
 * "sol", "bnb") - but a coin named on its own wins: "arb usdc" is USDC on
 * Arbitrum.
 */
export function detectFromName(name: string, catalog: Catalog, coins: ReadonlySet<string>): Look {
  const ix = indexOf(catalog);
  const w = words(name);
  let platform: string | null = null;
  let chain: string | null = null;
  const coinWords: Array<{ word: string; isChain: boolean }> = [];
  for (let i = 0; i < w.length; ) {
    let used = 0;
    for (let n = Math.min(3, w.length - i); n >= 1 && !used; n--) {
      const run = w.slice(i, i + n);
      for (const key of n > 1 ? [run.join(' '), run.join('')] : [run[0]!]) {
        if (STOP.has(key)) continue;
        const ch = ix.chain.get(key);
        if (ch) {
          chain ??= ch.id;
          if (n === 1) coinWords.push({ word: key, isChain: true });
          used = n;
          break;
        }
        const pl = ix.platform.get(key);
        if (pl) {
          platform ??= pl.id;
          used = n;
          break;
        }
      }
    }
    if (!used) {
      if (!STOP.has(w[i]!)) coinWords.push({ word: w[i]!, isChain: false });
      used = 1;
    }
    i += used;
  }
  const isCoin = (x: { word: string }) => x.word.length >= 2 && coins.has(x.word.toUpperCase());
  const coin = coinWords.find((x) => !x.isChain && isCoin(x)) ?? coinWords.find(isCoin);
  return { platform, coin: coin ? coin.word.toUpperCase() : null, chain };
}

/** Chains an address of this kind can be on (every EVM chain for a 0x address). */
export function chainsForKind(kind: AddressKind | null, catalog: Catalog): CatalogChain[] {
  return kind ? catalog.chains.filter((c) => c.addressKind === kind) : [];
}

/**
 * The look to draw: the user's picks first, then what the name says, then
 * what the address allows. The chain is only ever one the address can be on;
 * an EVM address with no chain named or picked gets no specific chain (the
 * avatar draws a generic EVM badge).
 */
export function resolveLook(
  c: { name: string; kind: AddressKind; look?: { platform?: string | null; coin?: string | null; chain?: string | null } },
  catalog: Catalog,
  coins: ReadonlySet<string>,
): Look & { chains: CatalogChain[] } {
  const auto = detectFromName(c.name, catalog, coins);
  const chains = chainsForKind(c.kind, catalog);
  const allowed = (id: string | null | undefined) => (id && chains.some((x) => x.id === id) ? id : null);
  const picked = c.look ?? {};
  // Unnamed: the one chain the address can be on; of several (a 0x…64-hex is
  // Sui or Aptos) the one SoDEX pays out to. An EVM address stays generic.
  const fallback = chains.length === 1 ? chains[0]!.id : c.kind !== 'evm' ? chains.find((x) => x.sodexKey)?.id ?? null : null;
  const chain = picked.chain !== undefined ? allowed(picked.chain) : allowed(auto.chain) ?? fallback;
  return {
    platform: picked.platform !== undefined ? picked.platform : auto.platform,
    coin: picked.coin !== undefined ? picked.coin : auto.coin,
    chain,
    chains,
  };
}
