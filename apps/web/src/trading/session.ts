/**
 * Browser trading: the trading key's life on this page.
 *
 * ENABLE (one click, one wallet signature, no network switch) - exactly what
 * sodex.com's own web app does for its `webkey`:
 *   1. a fresh secp256k1 key is generated HERE (sodex-core, CSPRNG);
 *   2. the user's wallet signs ONE typed-data message (UserSignedAddAPIKeyAction)
 *      registering that key's address on their SoDEX account for 7 days. The
 *      EIP-712 domain is the wallet's CURRENT chain, so nothing has to switch;
 *   3. the signed registration goes straight from this browser to both engines'
 *      `/exchange` (spot and perps);
 *   4. the key is kept in this device's vault (vault.ts) for its lifetime.
 *
 * The key NAME is fixed per kind of device (`valuescan-web` / `valuescan-mobile`),
 * like sodex.com's `webkey` / `mobilekey`: enabling again REPLACES the old key
 * instead of adding another, so an account never runs into SoDEX's 5-key limit.
 *
 * WHY NOT THE DOCUMENTED ROUTE. `POST /api/v1/user/{addr}/api-keys` with AddAPIKey
 * is what SoDEX's API page describes, but the engines verify a universal (0x02)
 * registration as UserSignedAddAPIKeyAction; signed as AddAPIKey they recover a
 * stranger and answer "spot: API key error: API key not found" - for every
 * account. See sodex-core/registration.ts.
 *
 * From then on every order is signed here by that key, with no wallet prompt,
 * and sent straight to SoDEX (actions.ts). No Valuescan server ever holds a key
 * that can trade, sees an order, or can place one.
 *
 * WHAT THE KEY CAN DO. SoDEX only lets a restricted key be one that cannot
 * trade, so the trading key is an ORDINARY key: it can trade, cancel, change
 * leverage and margin, and move funds between the owner's own spot account,
 * perps account and the owner's own wallet - never to anyone else.
 *
 * ACCOUNTS. A wallet SoDEX has never seen has no account; the first deposit of
 * USDC or SOSO creates one (CreateAccount.tsx). `accountStatus` says which it is,
 * so the order button can offer "Create account" instead of a dead end.
 *
 * The master wallet's key is never read; the wallet only ever signs typed data.
 */
import {
  MAX_TRADING_KEY_TTL_MS,
  SodexApiError,
  assembleExchangeRequests,
  createMemoryNonceManager,
  createNonceManager,
  destroyTradingKey,
  generateTradingKey,
  nonceKey,
  prepareApiKeyRegistrationExchange,
  prepareApiKeyRevocationExchange,
  signingKeyFrom,
  type Engine,
  type Network,
  type NonceManager,
  type SigningKeyRef,
} from '@sodex-core';
import { tradingConfig } from './config';
import { OutcomeUnknownError, readGateway, sendSigned } from './gateway';
import { openVault, type KeyVault, type StoredKey } from './vault';
import { addOrSwitchChain, getChainId, signTypedData, type Eip1193Provider } from '../wallet';
import { logger } from '../log';

const log = logger('trade');

export type TradingStatus = 'off' | 'restoring' | 'enabled' | 'expired';

/** Does the connected wallet have a SoDEX account? */
export type AccountStatus = 'unknown' | 'checking' | 'none' | 'ready';

export interface TradingState {
  status: TradingStatus;
  /** The wallet this state is about (lower-case), or null when none is connected. */
  owner: string | null;
  network: Network;
  /** The owner's SoDEX (primary) account id, once known. */
  accountId: number | null;
  accountStatus: AccountStatus;
  keyName: string | null;
  keyAddress: string | null;
  /** ms */
  expiresAt: number | null;
  /** The engines the key is registered on (both, unless one refused it). */
  engines: Engine[] | null;
  /** The key survives a reload on this device. */
  remembered: boolean;
  /** The builder approval the key carries. */
  builder: { id: number; maxFeeRate: number } | null;
  /** Why trading went off, when it went off on its own (expired, revoked). */
  reason: string | null;
}

export class TradingError extends Error {
  override name = 'TradingError';
  constructor(
    message: string,
    readonly kind: 'not-enabled' | 'expired' | 'no-account' | 'disabled' | 'writes-off' | 'wrong-wallet' | 'network',
  ) {
    super(message);
  }
}

const BOTH: Engine[] = ['spot', 'perps'];

/** What we know about each wallet's account, so trading state changes do not forget it. */
const accounts = new Map<string, { status: AccountStatus; id: number | null }>();

const OFF = (owner: string | null, reason: string | null = null): TradingState => {
  const a = owner ? accounts.get(`${tradingConfig().network}:${owner}`) : undefined;
  return {
    status: 'off',
    owner,
    network: tradingConfig().network,
    accountId: a?.id ?? null,
    accountStatus: a?.status ?? 'unknown',
    keyName: null,
    keyAddress: null,
    expiresAt: null,
    engines: null,
    remembered: false,
    builder: null,
    reason,
  };
};

let state: TradingState = OFF(null);
let signer: { key: SigningKeyRef; meta: StoredKey } | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

let vaultP: Promise<KeyVault> | null = null;
const vault = () => (vaultP ??= openVault());
let nonceMgr: NonceManager | null = null;
/** Cross-tab nonces (Web Locks + localStorage + BroadcastChannel); in-memory where those are missing. */
export const nonces = (): NonceManager => {
  if (!nonceMgr) {
    try {
      nonceMgr = createNonceManager();
    } catch {
      nonceMgr = createMemoryNonceManager();
    }
  }
  return nonceMgr;
};

const channel: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('vs-trading') : null;
// Outside a browser (tests, tooling) nothing here may keep the process alive.
(channel as unknown as { unref?: () => void } | null)?.unref?.();
channel?.addEventListener('message', (ev: MessageEvent<{ owner?: string; network?: string }>) => {
  // Another tab enabled or disabled trading for this wallet: follow it.
  const d = ev.data;
  if (d?.owner && d.owner === state.owner && d.network === state.network) void restoreTrading(state.owner);
});
const announce = (owner: string, network: Network) => channel?.postMessage({ owner, network });

function set(next: TradingState): void {
  state = next;
  for (const l of listeners) {
    try {
      l();
    } catch (e) {
      log.error('trading state listener failed', { error: String(e) });
    }
  }
}

export const getTradingState = (): TradingState => state;
export function subscribeTrading(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function dropSigner(): void {
  if (signer) (signer.key.privateKey as Uint8Array).fill(0);
  signer = null;
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = undefined;
}

function adopt(meta: StoredKey, privateKey: Uint8Array, remembered: boolean): void {
  dropSigner();
  const key = signingKeyFrom({ privateKey, address: meta.keyAddress }, { name: meta.name, expiresAt: meta.expiresAt });
  signer = { key, meta };
  noteAccount(meta.network, meta.owner, meta.accountId);
  set({
    status: 'enabled',
    owner: meta.owner,
    network: meta.network,
    accountId: meta.accountId,
    accountStatus: 'ready',
    keyName: meta.name,
    keyAddress: meta.keyAddress,
    expiresAt: meta.expiresAt,
    engines: meta.engines ?? BOTH,
    remembered,
    builder: meta.builder,
    reason: null,
  });
  // Browsers clamp long timers; re-arm in at most a day.
  const arm = () => {
    const left = meta.expiresAt - Date.now();
    if (left <= 0) {
      expire('Your trading key expired. Enable trading again - it takes one wallet signature.');
      return;
    }
    expiryTimer = setTimeout(arm, Math.min(left, 86_400_000));
    (expiryTimer as unknown as { unref?: () => void }).unref?.();
  };
  arm();
}

function expire(reason: string): void {
  const owner = state.owner;
  const net = state.network;
  dropSigner();
  set({ ...OFF(owner, reason), status: 'expired' });
  if (owner) void vault().then((v) => v.remove(net, owner));
}

// --- the account ---------------------------------------------------------------

function noteAccount(network: Network, owner: string, id: number | null, status?: AccountStatus): void {
  const s: AccountStatus = status ?? (id ? 'ready' : 'none');
  accounts.set(`${network}:${owner}`, { status: s, id: id || null });
  if (state.owner === owner && state.network === network && (state.accountStatus !== s || state.accountId !== (id || null))) {
    set({ ...state, accountStatus: s, accountId: state.status === 'enabled' ? state.accountId : id || null });
  }
}

interface AccountRead {
  primaryAccountID?: number;
}

/**
 * The SoDEX (primary) account id for `owner`: 0 when SoDEX has never seen a
 * deposit from it. `/user/{addr}/subaccounts` is what SoDEX's own SDKs resolve
 * (`primary_account_id`); the engine state is the fallback. Throws only when
 * nothing could be read at all, so "no account" is never a network error.
 */
export async function sodexAccountId(owner: string): Promise<number> {
  let reached = false;
  try {
    const s = await readGateway<AccountRead | null>(`/api/v1/user/${owner}/subaccounts`);
    reached = true;
    if (s && typeof s.primaryAccountID === 'number' && s.primaryAccountID > 0) return s.primaryAccountID;
  } catch (e) {
    // "user not found" is SoDEX saying there is no account: an answer, not a failure.
    if (e instanceof SodexApiError && /user not found/i.test(e.message)) reached = true;
    else log.debug('subaccounts read failed', { error: String(e) });
  }
  for (const engine of ['perps', 'spot'] as const) {
    try {
      const s = await readGateway<{ aid?: number } | null>(`/api/v1/${engine}/accounts/${owner}/state`);
      reached = true;
      if (s && typeof s.aid === 'number' && s.aid > 0) return s.aid;
    } catch (e) {
      log.debug('account state read failed', { engine, error: String(e) });
    }
  }
  if (!reached) throw new TradingError('Could not reach SoDEX to look up your account. Check your connection and try again.', 'network');
  return 0;
}

/**
 * Look the connected wallet's account up again (on connect, and while the
 * Create-account dialog waits for the first deposit to land).
 */
export async function refreshAccount(owner: string | null = state.owner): Promise<AccountStatus> {
  if (!owner) return 'unknown';
  const o = owner.toLowerCase();
  const { network } = tradingConfig();
  const before = accounts.get(`${network}:${o}`);
  if (!before || before.status === 'unknown') noteAccount(network, o, null, 'checking');
  try {
    const id = await sodexAccountId(o);
    noteAccount(network, o, id);
    return id ? 'ready' : 'none';
  } catch (e) {
    // Unreachable is not "no account": keep what was known before.
    log.warn('account lookup failed', { error: String(e) });
    const keep: AccountStatus = before && before.status !== 'checking' ? before.status : 'unknown';
    noteAccount(network, o, before?.id ?? null, keep);
    return keep;
  }
}

// --- restore -------------------------------------------------------------------

/**
 * Follow the connected wallet: load this wallet's key from the vault, or show
 * trading as off. Call on connect and on every account switch.
 */
export async function restoreTrading(address: string | null): Promise<TradingState> {
  const owner = address ? address.toLowerCase() : null;
  const { network } = tradingConfig();
  if (!owner) {
    dropSigner();
    set(OFF(null));
    return state;
  }
  if (state.owner !== owner || state.network !== network) {
    dropSigner();
    set({ ...OFF(owner), status: 'restoring' });
  }
  try {
    const v = await vault();
    const hit = await v.load(network, owner);
    // The wallet may have switched again while the vault was read.
    if ((state.owner ?? owner) !== owner) return state;
    if (hit) {
      adopt(hit.meta, hit.privateKey, v.persistent);
      void confirmKeyStillRegistered(hit.meta);
    } else {
      // Nothing stored: never enabled here, expired, or another tab turned it off.
      const expired = state.status === 'expired';
      const reason = expired ? state.reason : null;
      dropSigner();
      set(expired ? { ...OFF(owner, reason), status: 'expired' } : OFF(owner));
      void refreshAccount(owner);
    }
  } catch (e) {
    log.warn('trading key could not be restored; trading is off on this device', { error: String(e) });
    set(OFF(owner));
    void refreshAccount(owner);
  }
  return state;
}

interface KeyRow {
  name: string;
  publicKey: string;
  expiresAt?: number;
}

/**
 * Is `meta`'s key still what SoDEX has under its name? False when it was
 * replaced (trading enabled on another device), revoked or expired there; null
 * when SoDEX could not be asked.
 */
export async function keyStillRegistered(meta: StoredKey, now = Date.now()): Promise<boolean | null> {
  try {
    for (const engine of meta.engines ?? BOTH) {
      const rows = await readGateway<KeyRow[] | { apiKeys?: KeyRow[] } | null>(`/api/v1/${engine}/accounts/${meta.owner}/api-keys`);
      const list = Array.isArray(rows) ? rows : rows?.apiKeys ?? [];
      const row = list.find((r) => r.name === meta.name);
      if (!row || row.publicKey.toLowerCase() !== meta.keyAddress || (row.expiresAt && row.expiresAt <= now)) return false;
    }
    return true;
  } catch (e) {
    log.debug('key registration check failed', { error: String(e) });
    return null;
  }
}

/** Indexed reads lag a fresh registration: only judge keys older than this. */
const LISTING_LAG_MS = 2 * 60_000;

async function confirmKeyStillRegistered(meta: StoredKey): Promise<void> {
  if (Date.now() - meta.createdAt < LISTING_LAG_MS) return;
  const live = await keyStillRegistered(meta);
  if (live === false && signer?.meta.keyAddress === meta.keyAddress) {
    keyRejected('This trading key is no longer active on SoDEX (it was replaced on another device, revoked or expired). Enable trading again.');
  }
}

// --- enable ----------------------------------------------------------------------

/** ValueChain as a wallet needs it (the backend's /api/deposit/chain). */
export type ChainParams = () => Promise<{
  chainIdHex: string;
  name: string;
  rpcUrl: string;
  explorerUrl: string | null;
  nativeCurrency: { name: string; symbol: string; decimals: number };
}>;

/**
 * Put the wallet on ValueChain. Only the key REVOCATION needs it (an
 * ExchangeAction under the engine domain carries the SoDEX chain id, and
 * wallets refuse typed data for a chain they are not on). Enabling does not.
 */
async function ensureOnSodexChain(provider: Eip1193Provider, chainParams?: ChainParams): Promise<void> {
  const cfg = tradingConfig();
  if ((await getChainId(provider)) === cfg.chainId) return;
  const p = await chainParams?.();
  if (!p || parseInt(p.chainIdHex, 16) !== cfg.chainId) {
    throw new TradingError('Switch your wallet to ValueChain and try again.', 'network');
  }
  await addOrSwitchChain(provider, {
    chainId: p.chainIdHex,
    chainName: p.name,
    rpcUrls: [p.rpcUrl],
    nativeCurrency: p.nativeCurrency,
    blockExplorerUrls: p.explorerUrl ? [p.explorerUrl] : [],
  });
}

/** One key name per kind of device, like sodex.com's webkey / mobilekey. */
export function tradingKeyName(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ? 'valuescan-mobile' : 'valuescan-web';
}

export interface EnableOptions {
  owner: string;
  provider: Eip1193Provider;
  /** Keep the key on this device for its lifetime (default true). */
  remember?: boolean;
}

/** The key's lifetime: the configured TTL, kept inside SoDEX-side and sodex-core limits. */
const keyLifetime = (): number => Math.min(tradingConfig().keyTtlMs, MAX_TRADING_KEY_TTL_MS - 60_000);

/**
 * Register a trading key with one wallet signature. Throws TradingError for a
 * precondition (no account, trading off), SodexApiError when SoDEX refuses,
 * WalletError when the user declines in the wallet.
 */
export async function enableTrading(o: EnableOptions): Promise<TradingState> {
  const cfg = tradingConfig();
  const owner = o.owner.toLowerCase();
  if (cfg.disabled) throw new TradingError('Trading is switched off in this build of Valuescan.', 'disabled');
  if (!cfg.writesAllowed) {
    throw new TradingError(`Trading on ${cfg.network} is switched off for this deployment.`, 'writes-off');
  }
  const accountId = await sodexAccountId(owner);
  noteAccount(cfg.network, owner, accountId);
  if (!accountId) {
    throw new TradingError(
      'This wallet has no SoDEX account yet. Create one with a first deposit of USDC or SOSO, then enable trading.',
      'no-account',
    );
  }

  // The domain is whatever chain the wallet is on: nothing to switch.
  const walletChain = await getChainId(o.provider);
  const tk = generateTradingKey();
  try {
    const name = tradingKeyName();
    const nonce = await nonces().next(nonceKey(owner, cfg.chainId));
    const expiresAt = Date.now() + keyLifetime();
    const prepared = prepareApiKeyRegistrationExchange({
      userAddress: owner,
      accountID: accountId,
      name,
      publicKey: tk.address,
      expiresAt,
      nonce,
      sodexChainId: cfg.chainId,
      signatureChainId: walletChain,
    });
    log.info('enable trading: asking the wallet to sign the key registration', {
      network: cfg.network,
      accountId,
      key: name,
      walletChain,
      expiresAt,
    });
    const signature = await signTypedData(o.provider, owner, prepared.typedData);
    // Recovers the signer first: a signature from any other account is refused here.
    const requests = assembleExchangeRequests(prepared, signature, { base: '' });
    const settled = await Promise.allSettled(requests.map((r) => sendSigned(r, `key registration (${r.engine})`)));

    const accepted: Engine[] = [];
    const refused: { engine: Engine; error: unknown }[] = [];
    for (let i = 0; i < requests.length; i++) {
      const engine = requests[i]!.engine;
      const r = settled[i]!;
      if (r.status === 'fulfilled') accepted.push(engine);
      else refused.push({ engine, error: r.reason });
    }
    // No answer is not a no: ask SoDEX whether the key landed on that engine.
    for (const f of [...refused]) {
      if (!(f.error instanceof OutcomeUnknownError)) continue;
      const landed = await keyStillRegistered(
        { v: 1, network: cfg.network, owner, accountId, name, keyAddress: tk.address.toLowerCase(), expiresAt, createdAt: Date.now(), builder: null, engines: [f.engine] },
      );
      if (landed) {
        accepted.push(f.engine);
        refused.splice(refused.indexOf(f), 1);
      }
    }
    if (!accepted.length) {
      const first = refused[0]!;
      log.error('key registration refused on every engine', {
        refused: refused.map((f) => ({ engine: f.engine, error: String(f.error) })),
      });
      if (first.error instanceof OutcomeUnknownError) {
        throw new TradingError('SoDEX did not confirm the new trading key. Check your connection and enable trading again.', 'network');
      }
      throw first.error;
    }
    if (refused.length) {
      log.warn('trading key registered on some engines only', {
        accepted,
        refused: refused.map((f) => ({ engine: f.engine, error: String(f.error) })),
      });
    }

    const meta: StoredKey = {
      v: 1,
      network: cfg.network,
      owner,
      accountId,
      name,
      keyAddress: tk.address.toLowerCase(),
      expiresAt,
      createdAt: Date.now(),
      builder: null,
      engines: accepted.length === BOTH.length ? undefined : accepted,
    };
    const v = await vault();
    const remember = o.remember !== false && v.persistent;
    await v.save(meta, tk.privateKey, { persist: remember });
    adopt(meta, tk.privateKey.slice(), remember);
    announce(owner, cfg.network);
    log.info('trading enabled', { network: cfg.network, accountId, key: name, engines: accepted, remembered: remember });
    return state;
  } finally {
    destroyTradingKey(tk);
  }
}

// --- disable -----------------------------------------------------------------------

/**
 * Stop trading on this device. The key is deleted here; with `revoke`, the
 * wallet also signs its revocation on SoDEX (one signature per engine, on
 * ValueChain), so no copy of it anywhere can trade.
 */
export async function disableTrading(
  o: { revoke?: boolean; provider?: Eip1193Provider; chainParams?: ChainParams } = {},
): Promise<void> {
  const owner = state.owner;
  const net = state.network;
  const meta = signer?.meta ?? null;
  try {
    if (o.revoke && meta && o.provider) {
      const cfg = tradingConfig();
      await ensureOnSodexChain(o.provider, o.chainParams);
      for (const engine of meta.engines ?? BOTH) {
        const prepared = prepareApiKeyRevocationExchange({
          userAddress: meta.owner,
          engine,
          accountID: meta.accountId,
          name: meta.name,
          nonce: await nonces().next(nonceKey(meta.owner, cfg.chainId)),
          sodexChainId: cfg.chainId,
        });
        const signature = await signTypedData(o.provider, meta.owner, prepared.typedData);
        for (const req of assembleExchangeRequests(prepared, signature, { base: '' })) {
          await sendSigned(req, `key revocation (${engine})`);
        }
      }
      log.info('trading key revoked on SoDEX', { key: meta.name });
    }
  } finally {
    // Turning trading off here always happens, whether or not the revocation
    // was declined or failed part-way.
    dropSigner();
    set(OFF(owner));
    if (owner) {
      await (await vault()).remove(net, owner);
      announce(owner, net);
    }
  }
}

/** SoDEX says the key is unknown (revoked, replaced or expired there): drop it. */
export function keyRejected(reason = 'SoDEX no longer accepts this trading key. Enable trading again.'): void {
  log.warn('trading key rejected by SoDEX; dropping it', { key: state.keyName });
  expire(reason);
}

/**
 * SoDEX refused a signed action in a way that can mean "this key is not the
 * registered one any more" (a signature/key error rather than an order
 * problem): ask the gateway, and drop the key if it was replaced.
 */
export async function checkKeyAfterRejection(): Promise<void> {
  const meta = signer?.meta;
  if (!meta) return;
  if ((await keyStillRegistered(meta)) === false && signer?.meta.keyAddress === meta.keyAddress) {
    keyRejected('This trading key was replaced or revoked on SoDEX (trading was probably enabled on another device). Enable trading again here.');
  }
}

/** What signs the next action: throws when trading is not enabled for `owner` (on `engine`). */
export function requireSigner(owner?: string | null, engine?: Engine): { key: SigningKeyRef; meta: StoredKey } {
  const cfg = tradingConfig();
  if (cfg.disabled) throw new TradingError('Trading is switched off in this build of Valuescan.', 'disabled');
  if (!cfg.writesAllowed) throw new TradingError(`Trading on ${cfg.network} is switched off for this deployment.`, 'writes-off');
  if (!signer || state.status !== 'enabled') {
    throw new TradingError(
      state.status === 'expired' ? state.reason ?? 'Your trading key expired. Enable trading again.' : 'Enable trading first - it takes one wallet signature.',
      state.status === 'expired' ? 'expired' : 'not-enabled',
    );
  }
  if (owner && owner.toLowerCase() !== signer.meta.owner) {
    throw new TradingError('The connected wallet is not the one trading is enabled for.', 'wrong-wallet');
  }
  if (engine && signer.meta.engines && !signer.meta.engines.includes(engine)) {
    throw new TradingError(
      `SoDEX did not accept this trading key on ${engine === 'perps' ? 'perps' : 'spot'} when trading was enabled. Enable trading again to retry.`,
      'not-enabled',
    );
  }
  if (signer.meta.expiresAt <= Date.now() + 5_000) {
    expire('Your trading key expired. Enable trading again - it takes one wallet signature.');
    throw new TradingError('Your trading key expired. Enable trading again.', 'expired');
  }
  return signer;
}

/** What the key may do, in words (the advanced key view). */
export function describeTradingKey(): string[] {
  const days = Math.round(keyLifetime() / 86_400_000);
  const life = days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : `${Math.round(keyLifetime() / 3_600_000)} hours`;
  return [
    'A trading key is created in this browser. Your wallet signs one message that authorises it on your SoDEX account; your wallet’s own key is never read.',
    `It can place and cancel orders and change leverage and margin, without a wallet prompt each time. It expires after ${life}.`,
    'Per SoDEX’s rules it can also move funds between your own spot and perps accounts and your own wallet - never to anyone else.',
  ];
}

/**
 * The trading state in the shape the app's components have always read
 * (api.ts SessionInfo), so the order ticket, footer and menus need no changes.
 */
export function sessionInfoOf(t: TradingState): {
  network: string;
  chainId: number;
  unlocked: boolean;
  session: { apiKeyName: string; accountId: number; address: string; keyAddress: string; permissions: number } | null;
  permissionNames: string[];
  protection: 'memory' | null;
  autoUnlock: boolean;
  legacyKeystore: null;
} {
  const on = t.status === 'enabled' && !!t.owner && !!t.keyName && !!t.keyAddress && t.accountId !== null;
  return {
    network: t.network,
    chainId: tradingConfig().chainId,
    unlocked: on,
    session: on ? { apiKeyName: t.keyName!, accountId: t.accountId!, address: t.owner!, keyAddress: t.keyAddress!, permissions: 0 } : null,
    // An ordinary key: nothing is disabled (see the header).
    permissionNames: on ? ['TRADE', 'CANCEL', 'WITHDRAW', 'TRANSFER'] : [],
    protection: on ? 'memory' : null,
    autoUnlock: on && t.remembered,
    legacyKeystore: null,
  };
}

/** For tests: forget everything. */
export function _resetTradingForTests(v?: KeyVault): void {
  dropSigner();
  accounts.clear();
  state = OFF(null);
  vaultP = v ? Promise.resolve(v) : null;
  nonceMgr = createMemoryNonceManager();
}
