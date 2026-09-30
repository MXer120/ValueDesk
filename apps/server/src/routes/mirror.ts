/**
 * Cross-chain deposits — funding from a chain the user already holds assets on.
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
 *     registry sodex.com itself reads (`getDepositWalletList(account, coin)`,
 *     sodex/depositWallets.ts - it covers BTC, LTC, DOGE, ADA, SUI, TON, XLM
 *     and XRP) must list it, and SoDEX's issuer (the REST rows, or sodex.com's
 *     per-chain `deposit_address`) must name the same one. The rules are
 *     sodex/depositAddress.ts; a route that fails them is not offered and is
 *     reported in `rejected`.
 *  1b. An address SoDEX has flagged ("Suspicious") is withheld; the route is
 *     returned `flagged`, without an address, and the user can ask SoDEX for a
 *     new one (POST /api/mirror/replace-deposit-address - sodex.com's "Confirm
 *     & Update Address").
 *  1c. PEPE is never offered: sodex.com deposits it to a PEPE-only address it
 *     gets from REST (token "ETH_PEPE"), which no registry confirms - and PEPE
 *     sent to the shared Ethereum address may never be credited.
 *  2. Asset/chain pairs come from SoDEX's own `depositWhiteList`, intersected
 *     with the chains that actually have an issued address. A pair we cannot
 *     fully verify is not offered at all.
 *  3. `memoWarning` and `contractWarning` flags travel with each route so the
 *     UI can surface them, and `minDepositAmount` from the registry is attached
 *     where the chain has one.
 *
 * The registry address and ABI were recovered from ValueChain itself - see
 * sodex/mirrorRegistry.ts for how.
 */
import type { FastifyInstance } from 'fastify';
import { remoteNativeTokens, registryInfo } from '../sodex/mirrorRegistry.js';
import { _forgetDepositWalletLists, depositWalletLists } from '../sodex/depositWallets.js';
import {
  currentDepositWallet,
  forgetDepositReads,
  issuerDepositStatus,
  issuerStatus,
  pickDepositAddress,
  replaceDepositAddress,
  type IssuerStatus,
} from '../sodex/depositAddress.js';
import { fromBaseUnits } from '../sodex/chain.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BIZ_API = process.env.SODEX_BIZ_API?.trim() || 'https://alpha-biz.sodex.dev';

interface WhitelistEntry {
  contractWarning?: boolean;
  memoWarning?: boolean;
  depositTime?: number;
  flash?: boolean;
  regular?: boolean;
}
type DepositWhitelist = Record<string, Record<string, WhitelistEntry>>;

const CHAIN_LABELS: Record<string, string> = {
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

// --- SoDEX config (whitelist + explorers) -----------------------------------

let configCache: { at: number; whitelist: DepositWhitelist; explorer: Record<string, string> } | null = null;
const CONFIG_TTL = 10 * 60_000;

async function sodexConfig() {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL) return configCache;
  const res = await fetch(`${BIZ_API}/biz/config/symbol`, { signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`SoDEX config unavailable (HTTP ${res.status})`);
  const body = (await res.json()) as { data?: { depositWhiteList?: DepositWhitelist; explorer?: Record<string, string> } };
  configCache = {
    at: Date.now(),
    whitelist: body.data?.depositWhiteList ?? {},
    explorer: body.data?.explorer ?? {},
  };
  return configCache;
}

// --- issued addresses --------------------------------------------------------

interface Issued {
  chain: string;
  address: string;
  custodian: string;
  status: string;
}

const addrCache = new Map<string, { at: number; rows: Issued[] }>();
const ADDR_TTL = 10 * 60_000;

async function issuedAddresses(account: string): Promise<Issued[]> {
  const key = account.toLowerCase();
  const hit = addrCache.get(key);
  if (hit && Date.now() - hit.at < ADDR_TTL) return hit.rows;

  const res = await fetch(`${BIZ_API}/biz/mirror/create_deposit_addresses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account }),
    signal: AbortSignal.timeout(25_000),
  });
  const body = (await res.json().catch(() => null)) as
    | { code?: string; message?: string; data?: { accountAddresses?: Issued[] } }
    | null;
  if (!body || (body.code !== undefined && body.code !== '0')) {
    throw new Error(body?.message || 'SoDEX mirror service rejected the request');
  }
  const rows = (body.data?.accountAddresses ?? []).filter((r) => r?.chain && r?.address);
  // Only a settled set is worth keeping: a brand-new wallet's addresses come
  // back "Processing" first, and caching that for ten minutes would keep a
  // first-time user staring at "being issued" long after SoDEX enabled them.
  if (rows.length && rows.every((r) => String(r.status).toLowerCase() === 'enabled')) {
    addrCache.set(key, { at: Date.now(), rows });
  } else {
    addrCache.delete(key);
  }
  return rows;
}

export async function mirrorRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Everything the deposit UI needs, already cross-checked.
   *
   * Scoped to the address the caller passes, which the UI binds to the
   * connected wallet - this never enumerates anyone else's.
   */
  app.get('/api/mirror/deposit-options', async (req, reply) => {
    const { address } = req.query as { address?: string };
    if (!address || !ADDRESS_RE.test(address)) {
      return reply.code(400).send({ error: 'a valid 0x wallet address is required' });
    }

    let config: Awaited<ReturnType<typeof sodexConfig>>;
    try {
      config = await sodexConfig();
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
    const rejected: Array<{ chain: string; reason: string }> = [];
    // The issuer also CREATES a new wallet's addresses; if it does not answer,
    // the on-chain sources alone decide (and a route needing it is withheld).
    const issued = await issuedAddresses(address).catch((e: Error) => {
      rejected.push({ chain: '*', reason: `SoDEX's address issuer did not answer: ${e.message}` });
      return [] as Issued[];
    });
    const restByChain = new Map(issued.map((r) => [r.chain.toUpperCase(), r]));

    const registry = await remoteNativeTokens().catch(() => []);
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
        const now = await currentDepositWallet(address, chain).catch(() => null);
        current.set(chain, now);
        const row = restByChain.get(chain);
        if (row) issuer.set(chain, { status: issuerStatus(row.status), address: row.address });
        else if (now) issuer.set(chain, await issuerDepositStatus(address, chain));
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
            perCoin.set(symbol, await depositWalletLists(address, symbol));
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
      .map(([symbol, chains]) => {
        const routes = Object.entries(chains)
          .filter(([chain]) => !disabledOnChain(chain))
          .flatMap(([chain, rules]) => {
            const row = addressFor(symbol, chain);
            if (!row) return [];
            return [{
              chain,
              label: CHAIN_LABELS[chain] ?? chain,
              address: row.address,
              custodian: row.custodian,
              verified: !row.flagged,
              /** SoDEX flagged this chain's address: no address is given until the user asks for a new one. */
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
      registry: registryInfo(),
      /** True only if every whitelisted route had a confirmed address. */
      allVerified: rejected.length === 0,
    };
  });

  /**
   * sodex.com's "Confirm & Update Address": ask SoDEX for a new deposit address
   * on one chain. Only for an address SoDEX itself has flagged (read fresh) -
   * a healthy address is never replaced through here. The UI then re-reads
   * /deposit-options until the new address is confirmed on-chain.
   */
  const lastReplace = new Map<string, number>();
  app.post('/api/mirror/replace-deposit-address', async (req, reply) => {
    const { address, chain } = (req.body ?? {}) as { address?: string; chain?: string };
    if (!address || !ADDRESS_RE.test(address)) return reply.code(400).send({ error: 'a valid 0x wallet address is required' });
    if (!chain || !/^[A-Z][A-Z0-9_]{1,31}$/.test(chain)) return reply.code(400).send({ error: 'a SoDEX chain key is required' });
    const key = `${address.toLowerCase()}:${chain}`;
    if (Date.now() - (lastReplace.get(key) ?? 0) < 30_000) return reply.code(429).send({ error: 'already requested - SoDEX is issuing the new address' });
    forgetDepositReads(address);
    const status = await issuerDepositStatus(address, chain);
    if (status?.status !== 'Suspicious') return reply.code(409).send({ error: 'SoDEX has not flagged this address - nothing to replace' });
    lastReplace.set(key, Date.now());
    try {
      await replaceDepositAddress(address, chain);
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    } finally {
      addrCache.delete(address.toLowerCase());
      _forgetDepositWalletLists(address);
    }
    req.log.info({ address, chain }, 'deposit address replacement requested');
    return { ok: true };
  });
}

/** Stablecoins first - they are what people actually onboard with. */
const PRIORITY = ['USDC', 'USDT', 'ETH', 'SOL', 'BNB'];
const rank = (s: string): number => {
  const i = PRIORITY.indexOf(s.toUpperCase());
  return i === -1 ? PRIORITY.length : i;
};
