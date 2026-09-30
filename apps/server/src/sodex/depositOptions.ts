/**
 * Cross-chain deposits - funding from a chain the user already holds assets
 * on - assembled and cross-checked, with every read injected.
 *
 * This is what GET /api/mirror/deposit-options answered (routes/mirror.ts),
 * moved into a module both sides can run: the browser now builds it itself,
 * from sodex.com's API and ValueChain's public views, so no wallet's deposit
 * addresses pass through Valuescan.
 *
 * SoDEX runs a custodial mirror (custodian: Cobo) that issues a dedicated
 * deposit address per wallet per chain. It works for wallets with no SoDEX
 * account and needs no gas on ValueChain, which is what lets a first-time user
 * fund without leaving the app.
 *
 * SAFETY. A wrong deposit address, or the wrong asset on the wrong chain, means
 * funds that cannot be recovered. So nothing here is taken on trust:
 *
 *  1. The address shown is the chain's CURRENT one (custody
 *     `getDepositWallet(account, chain)`, a view function on ValueChain), and
 *     only when every other source that answered agrees with it: the per-coin
 *     registry sodex.com itself reads (`getDepositWalletList(account, coin)`)
 *     must list it, and SoDEX's issuer (the REST rows, or sodex.com's
 *     per-chain `deposit_address`) must name the same one. The rules are
 *     depositAddressCore.ts; a route that fails them is not offered and is
 *     reported in `rejected`.
 *  1b. An address SoDEX has flagged ("Suspicious") is withheld; the route is
 *     returned `flagged`, without an address, and the user can ask SoDEX for a
 *     new one (`requestNewDepositAddress` - sodex.com's "Confirm & Update
 *     Address").
 *  1c. PEPE is never offered: sodex.com deposits it to a PEPE-only address it
 *     gets from REST (token "ETH_PEPE"), which no registry confirms - and PEPE
 *     sent to the shared Ethereum address may never be credited.
 *  2. Asset/chain pairs come from SoDEX's own `depositWhiteList`, intersected
 *     with the chains that actually have an issued address. A pair we cannot
 *     fully verify is not offered at all.
 *  3. `memoWarning` and `contractWarning` flags travel with each route so the
 *     UI can surface them, and `minDepositAmount` from the registry is attached
 *     where the chain has one.
 */
import { pickDepositAddress, issuerStatus, type IssuerStatus } from './depositAddressCore.js';
import type { RemoteNativeToken } from './mirrorCore.js';
import { fromBaseUnits } from './units.js';

interface WhitelistEntry {
  contractWarning?: boolean;
  memoWarning?: boolean;
  depositTime?: number;
  flash?: boolean;
  regular?: boolean;
}
export type DepositWhitelist = Record<string, Record<string, WhitelistEntry>>;

export const CHAIN_LABELS: Record<string, string> = {
  ETH: 'Ethereum',
  BASE_ETH: 'Base',
  ARBITRUM_ETH: 'Arbitrum One',
  MATIC: 'Polygon',
  BSC_BNB: 'BNB Smart Chain',
  AVAXC: 'Avalanche C-Chain',
  HYPEREVM_HYPE: 'HyperEVM',
  SOL: 'Solana',
  VALUECHAIN: 'ValueChain',
  ROBINHOOD_ETH: 'Robinhood Chain',
  ARC: 'Arc',
  BTC: 'Bitcoin',
  LTC: 'Litecoin',
  DOGE: 'Dogecoin',
  ADA: 'Cardano',
  SUI: 'Sui',
  TON: 'TON',
  XLM: 'Stellar',
  XRP: 'XRP Ledger',
};

/** Coins with no shared deposit address - see 1c above. */
const NO_SHARED_ADDRESS = new Set(['PEPE']);
/** Read per chain from the older registry (sodex.com does the same). */
const PER_CHAIN_REGISTRY = new Set(['SOSO', 'SSOSO']);

const NON_EVM = new Set(['SOL', 'BTC', 'ADA', 'DOGE', 'LTC', 'TON', 'XLM', 'XRP', 'SUI']);

/**
 * The native asset of each chain.
 *
 * `listRemoteNativeTokens` reports `minDepositAmount` for a chain's NATIVE
 * token, so that figure only applies when the asset being deposited IS that
 * token. Attaching it to, say, USDC on Ethereum would advertise a 1 USDC
 * minimum when the real figure is 1 ETH - a wrong minimum is more dangerous
 * than none, because a user would trust it.
 */
const NATIVE_ASSET: Record<string, string> = {
  ETH: 'ETH',
  BASE_ETH: 'ETH',
  ARBITRUM_ETH: 'ETH',
  MATIC: 'POL',
  BSC_BNB: 'BNB',
  AVAXC: 'AVAX',
  SOL: 'SOL',
  HYPEREVM_HYPE: 'HYPE',
  VALUECHAIN: 'SOSO',
};

/** Stablecoins first - they are what people actually onboard with. */
const PRIORITY = ['USDC', 'USDT', 'ETH', 'SOL', 'BNB'];
const rank = (s: string): number => {
  const i = PRIORITY.indexOf(s.toUpperCase());
  return i === -1 ? PRIORITY.length : i;
};

// --- SoDEX's own sources --------------------------------------------------------------------

/** A GET on sodex.com's API, resolving with the parsed body (throws when unreadable or not OK). */
export type BizGet = (path: string, timeoutMs: number) => Promise<unknown>;
/** A POST on sodex.com's API: the parsed body, or null when unreadable. */
export type BizPostBody = (path: string, body: unknown, timeoutMs: number) => Promise<unknown>;

export interface SodexDepositConfig {
  whitelist: DepositWhitelist;
  explorer: Record<string, string>;
}

/** sodex.com's deposit white list and explorers (`/biz/config/symbol`), kept ten minutes. */
export function sodexConfigReader(get: BizGet): () => Promise<SodexDepositConfig> {
  let cached: { at: number; value: SodexDepositConfig } | null = null;
  return async () => {
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.value;
    const body = (await get('/biz/config/symbol', 25_000)) as { data?: { depositWhiteList?: DepositWhitelist; explorer?: Record<string, string> } } | null;
    const value = { whitelist: body?.data?.depositWhiteList ?? {}, explorer: body?.data?.explorer ?? {} };
    cached = { at: Date.now(), value };
    return value;
  };
}

export interface Issued {
  chain: string;
  address: string;
  custodian: string;
  status: string;
}

/**
 * The issuer's addresses for a wallet (`create_deposit_addresses`, which also
 * CREATES a new wallet's addresses). Only a settled set is kept (ten minutes):
 * a brand-new wallet's addresses come back "Processing" first, and caching that
 * would keep a first-time user staring at "being issued" long after SoDEX
 * enabled them. Bounded, like every cache here.
 */
export function issuedAddressesReader(post: BizPostBody): { read(account: string): Promise<Issued[]>; forget(account: string): void } {
  const cache = new Map<string, { at: number; rows: Issued[] }>();
  return {
    async read(account) {
      const key = account.toLowerCase();
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < 10 * 60_000) return hit.rows;
      const body = (await post('/biz/mirror/create_deposit_addresses', { account }, 25_000)) as
        | { code?: string; message?: string; data?: { accountAddresses?: Issued[] } }
        | null;
      if (!body || (body.code !== undefined && body.code !== '0')) {
        throw new Error(body?.message || 'SoDEX mirror service rejected the request');
      }
      const rows = (body.data?.accountAddresses ?? []).filter((r) => r?.chain && r?.address);
      if (rows.length && rows.every((r) => String(r.status).toLowerCase() === 'enabled')) {
        cache.delete(key);
        cache.set(key, { at: Date.now(), rows });
        while (cache.size > 500) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
      } else {
        cache.delete(key);
      }
      return rows;
    },
    forget(account) {
      cache.delete(account.toLowerCase());
    },
  };
}

// --- the assembly ----------------------------------------------------------------------------

export interface MirrorRoute {
  chain: string;
  label: string;
  address: string;
  custodian: string | null;
  verified: boolean;
  /** SoDEX flagged this chain's address: no address is given until the user asks for a new one. */
  flagged: boolean;
  isEvm: boolean;
  needsMemo: boolean;
  contractWarning: boolean;
  depositMinutes: number | null;
  minDeposit: string | null;
  explorerUrl: string | null;
}

export interface DepositOptions {
  address: string;
  assets: Array<{ symbol: string; routes: MirrorRoute[] }>;
  rejected: Array<{ chain: string; reason: string }>;
  registry: { address: string; chainId: number };
  /** True only if every whitelisted route had a confirmed address. */
  allVerified: boolean;
}

export interface DepositOptionsIo {
  sodexConfig(): Promise<SodexDepositConfig>;
  issuedAddresses(account: string): Promise<Issued[]>;
  remoteNativeTokens(): Promise<RemoteNativeToken[]>;
  currentDepositWallet(account: string, chain: string): Promise<string | null>;
  issuerDepositStatus(account: string, chain: string): Promise<{ status: IssuerStatus; address: string | null } | null>;
  depositWalletLists(account: string, coinSymbol: string): Promise<Map<string, string[]>>;
  registryInfo(): { address: string; chainId: number };
}

/**
 * Everything the deposit UI needs, already cross-checked, for the address the
 * caller passes (the UI binds it to the connected wallet). Throws only when
 * SoDEX's config cannot be read (there is nothing to offer without it).
 */
export async function buildDepositOptions(io: DepositOptionsIo, address: string): Promise<DepositOptions> {
  const config = await io.sodexConfig();
  const rejected: Array<{ chain: string; reason: string }> = [];
  // The issuer also CREATES a new wallet's addresses; if it does not answer,
  // the on-chain sources alone decide (and a route needing it is withheld).
  const issued = await io.issuedAddresses(address).catch((e: Error) => {
    rejected.push({ chain: '*', reason: `SoDEX's address issuer did not answer: ${e.message}` });
    return [] as Issued[];
  });
  const restByChain = new Map(issued.map((r) => [r.chain.toUpperCase(), r]));

  const registry = await io.remoteNativeTokens().catch(() => [] as RemoteNativeToken[]);
  const disabledOnChain = (chain: string): boolean =>
    registry.find((r) => r.chain.toUpperCase() === chain.toUpperCase())?.custodyDisabled ?? false;
  const chains = [...new Set(Object.values(config.whitelist).flatMap((c) => Object.keys(c).map((k) => k.toUpperCase())))].filter((c) => !disabledOnChain(c));

  // Per chain: the current address on-chain, and the issuer's word on it (its
  // REST row, else sodex.com's per-chain status read - only where there is an
  // address to check).
  const current = new Map<string, string | null>();
  const issuer = new Map<string, { status: IssuerStatus; address: string | null } | null>();
  await Promise.all(
    chains.map(async (chain) => {
      const now = await io.currentDepositWallet(address, chain).catch(() => null);
      current.set(chain, now);
      const row = restByChain.get(chain);
      if (row) issuer.set(chain, { status: issuerStatus(row.status), address: row.address });
      else if (now) issuer.set(chain, await io.issuerDepositStatus(address, chain));
    }),
  );

  // The per-coin registry (every address it lists, empty lists included). A
  // coin whose read fails is judged on the chain and the issuer alone.
  const perCoin = new Map<string, Map<string, string[]>>();
  await Promise.all(
    Object.keys(config.whitelist)
      .filter((symbol) => !PER_CHAIN_REGISTRY.has(symbol.toUpperCase()) && !NO_SHARED_ADDRESS.has(symbol.toUpperCase()))
      .map(async (symbol) => {
        try {
          perCoin.set(symbol, await io.depositWalletLists(address, symbol));
        } catch {
          /* judged without it */
        }
      }),
  );
  type Found = { address: string; custodian: string | null; flagged: false } | { address: ''; custodian: null; flagged: true };
  const addressFor = (symbol: string, chain: string): Found | null => {
    if (NO_SHARED_ADDRESS.has(symbol.toUpperCase())) return null;
    const key = chain.toUpperCase();
    const lists = perCoin.get(symbol);
    const pick = pickDepositAddress({
      chain: key,
      current: current.get(key) ?? null,
      list: PER_CHAIN_REGISTRY.has(symbol.toUpperCase()) || !lists ? undefined : lists.get(key) ?? [],
      issuer: issuer.get(key) ?? null,
    });
    if (pick.ok) return { address: pick.address, custodian: restByChain.get(key)?.custodian ?? null, flagged: false };
    if (pick.flagged) return { address: '', custodian: null, flagged: true };
    rejected.push({ chain, reason: `${symbol}: ${pick.reason}` });
    return null;
  };
  /** Only meaningful for the chain's own native asset - see NATIVE_ASSET. */
  const minFor = (chain: string, symbol: string): string | null => {
    if (NATIVE_ASSET[chain.toUpperCase()] !== symbol.toUpperCase()) return null;
    const t = registry.find((r) => r.chain.toUpperCase() === chain.toUpperCase());
    if (!t || t.minDepositAmount === 0n) return null;
    return fromBaseUnits(t.minDepositAmount, 18);
  };
  // Asset-first: only pairs that are BOTH whitelisted and have a verified
  // address survive. Anything else is simply not offered.
  const assets = Object.entries(config.whitelist)
    .map(([symbol, chainRules]) => {
      const routes = Object.entries(chainRules)
        .filter(([chain]) => !disabledOnChain(chain))
        .flatMap(([chain, rules]): MirrorRoute[] => {
          const row = addressFor(symbol, chain);
          if (!row) return [];
          return [{
            chain,
            label: CHAIN_LABELS[chain] ?? chain,
            address: row.address,
            custodian: row.custodian,
            verified: !row.flagged,
            flagged: row.flagged,
            isEvm: !NON_EVM.has(chain),
            needsMemo: rules.memoWarning === true,
            contractWarning: rules.contractWarning === true,
            depositMinutes: rules.depositTime ?? null,
            minDeposit: minFor(chain, symbol),
            explorerUrl: config.explorer[chain] ?? null,
          }];
        });
      return { symbol, routes };
    })
    .filter((a) => a.routes.length > 0)
    .sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol));

  return {
    address,
    assets,
    rejected,
    registry: io.registryInfo(),
    allVerified: rejected.length === 0,
  };
}

// --- "Confirm & Update Address" ----------------------------------------------------------------

export class DepositAddressRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 409 | 429 | 502,
  ) {
    super(message);
    this.name = 'DepositAddressRequestError';
  }
}

export interface ReplaceIo {
  issuerDepositStatus(account: string, chain: string): Promise<{ status: IssuerStatus; address: string | null } | null>;
  replaceDepositAddress(account: string, chain: string): Promise<void>;
  /** Forget every cached read for the account (issuer, chain, registry lists). */
  forget(account: string): void;
}

/**
 * sodex.com's "Confirm & Update Address": ask SoDEX for a new deposit address
 * on one chain. Only for an address SoDEX itself has flagged (read fresh) - a
 * healthy address is never replaced through here - and at most once per
 * wallet and chain every 30 s. The UI then re-reads the options until the new
 * address is confirmed on-chain.
 */
export function newDepositAddressRequester(io: ReplaceIo): (address: string, chain: string) => Promise<void> {
  const lastReplace = new Map<string, number>();
  return async (address, chain) => {
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new DepositAddressRequestError('a valid 0x wallet address is required', 400);
    if (!chain || !/^[A-Z][A-Z0-9_]{1,31}$/.test(chain)) throw new DepositAddressRequestError('a SoDEX chain key is required', 400);
    const key = `${address.toLowerCase()}:${chain}`;
    if (Date.now() - (lastReplace.get(key) ?? 0) < 30_000) throw new DepositAddressRequestError('already requested - SoDEX is issuing the new address', 429);
    io.forget(address);
    const status = await io.issuerDepositStatus(address, chain);
    if (status?.status !== 'Suspicious') throw new DepositAddressRequestError('SoDEX has not flagged this address - nothing to replace', 409);
    lastReplace.set(key, Date.now());
    try {
      await io.replaceDepositAddress(address, chain);
    } catch (e) {
      throw new DepositAddressRequestError((e as Error).message, 502);
    } finally {
      io.forget(address);
    }
  };
}
