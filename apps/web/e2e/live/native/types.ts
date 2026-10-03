/**
 * The chains the runner signs on WITHOUT an EVM wallet: Bitcoin, Litecoin,
 * Dogecoin, XRP Ledger, Stellar, Solana, Sui, Cardano. One module per chain
 * (bitcoin.ts covers the three UTXO chains), all behind this interface, all
 * from the ONE test key the owner enters (keys.ts):
 *   - secp256k1 chains use it as it is (Bitcoin, Litecoin, Dogecoin, XRP, Sui);
 *   - ed25519 chains use a seed DERIVED from it per chain (HKDF), never the
 *     same bytes on two curves (Solana, Stellar, Cardano).
 *
 * What a module does: the test wallet's address there, balances, what a send
 * costs and what must stay at the address, a signed transfer BUILT but not sent
 * (`prepare`), the broadcast of exactly those bytes (`broadcast` - the network
 * guard lets out only a body the step armed, once), and whether it is final.
 * Amounts are always the chain's own base units (satoshi, drops, stroops,
 * lamports, MIST, lovelace, token base units) as bigint.
 */

export type NativeKind = 'bitcoin' | 'litecoin' | 'dogecoin' | 'xrp' | 'stellar' | 'solana' | 'sui' | 'cardano';

/** SoDEX's chain key (ChainRoute.key) of each chain the runner signs on. */
export const NATIVE_CHAIN_KEY: Readonly<Record<NativeKind, string>> = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE', xrp: 'XRP', stellar: 'XLM', solana: 'SOL', sui: 'SUI', cardano: 'ADA' };
/** The chain keys the runner signs on (pure planners use this; the modules themselves are in native/index.ts). */
export const NATIVE_CHAIN_KEYS: ReadonlySet<string> = new Set(Object.values(NATIVE_CHAIN_KEY));
/** What an account that pays a token transfer must keep afterwards (Solana: its rent-exempt minimum ~650,240 lamports, with room), native base units. */
export const ACCOUNT_MINIMUM: Readonly<Partial<Record<NativeKind, bigint>>> = { solana: 700_000n };
/** The native coin's symbol on SoDEX. */
export const NATIVE_SYMBOL: Readonly<Record<NativeKind, string>> = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE', xrp: 'XRP', stellar: 'XLM', solana: 'SOL', sui: 'SUI', cardano: 'ADA' };
/** The native coin's on-chain decimals. */
export const NATIVE_DECIMALS: Readonly<Record<NativeKind, number>> = { bitcoin: 8, litecoin: 8, dogecoin: 8, xrp: 6, stellar: 7, solana: 9, sui: 9, cardano: 6 };
/** Tokens on those chains SoDEX pays out (Solana USDC / USDT): their on-chain decimals. */
export const TOKEN_DECIMALS: Readonly<Record<string, number>> = { USDC: 6, USDT: 6 };

/** The coin as the chain knows it (from SoDEX's route: `isNativeToken`, `tokenAddress`). */
export interface NativeCoin {
  /** SoDEX's coin name: BTC, LTC, DOGE, XRP, XLM, SOL, USDC, USDT, SUI, ADA. */
  symbol: string;
  /** The chain's own coin (true), or a token on it (false: Solana USDC / USDT). */
  native: boolean;
  /** The token's mint / contract (null for the native coin). */
  token: string | null;
  /** The ON-CHAIN decimals of the amounts below (BTC 8, XRP 6, XLM 7, SOL 9, SUI 9, ADA 6, Solana USDC 6). */
  decimals: number;
}

/** The test key, as the chain modules see it (keys.ts). */
export interface NativeKeys {
  /** The one test key: secp256k1, 32 bytes. */
  readonly secp256k1: Uint8Array;
  /** The ed25519 seed for one chain, derived from the test key (keys.ts deriveEd25519Seed). */
  ed25519(kind: NativeKind): Uint8Array;
}

/** A signed transfer, built but not sent. */
export interface PreparedSend {
  /** Exactly what `broadcast` sends: the network guard lets out only this body, once. */
  request: { url: string; method: 'POST'; headers: Record<string, string>; body: string };
  /** The transaction's id / hash, known before it is sent. */
  txid: string;
  /** What the receiver gets, base units. */
  amount: bigint;
  /** The network fee it pays, base units of the chain's NATIVE coin. */
  fee: bigint;
  /** Where a person can look at it. */
  explorer: string;
}

export interface SendCosts {
  /** The network fee of one transfer of this coin, base units of the NATIVE coin (an estimate on the high side). */
  fee: bigint;
  /**
   * What must stay at the address after the send, base units of THIS coin: the account reserve (XRP, Stellar),
   * the rent-exempt minimum (Solana SOL). 0 where nothing has to stay (UTXO chains, Sui, Cardano: everything can leave).
   */
  keep: bigint;
  /** A token send also needs native coin at the address for its fee (and a receiving token account, when missing). */
  nativeNeeded: bigint;
}

export interface NativeChain {
  readonly kind: NativeKind;
  /** The chain's name, e.g. "Bitcoin". */
  readonly label: string;
  /** SoDEX's chain key for it (ChainRoute.key): BTC, LTC, DOGE, XRP, XLM, SOL, SUI, ADA. */
  readonly chainKey: string;
  /** The public API origins the module talks to (https://...). The runner's network guard allows exactly these. */
  readonly origins: readonly string[];
  /** Is this request to one of `origins` a WRITE (a broadcast)? Everything else there is treated as a read. */
  isWrite(url: URL, method: string, body: string | null): boolean;
  /** The test wallet's address on this chain. Pure: no network. */
  address(keys: NativeKeys): string;
  /** The balance of `coin` at `address`, base units. 0 for an address the chain does not know yet - never throws for that. */
  balance(address: string, coin: NativeCoin): Promise<bigint>;
  /** What one transfer of `coin` from `address` to `to` costs, and what must stay at `address`. */
  costs(address: string, coin: NativeCoin, to: string): Promise<SendCosts>;
  /**
   * Build and sign a transfer of `amount` of `coin` from the test wallet to `to` (a SoDEX deposit address -
   * per wallet, no memo / destination tag). 'max': everything that can leave (balance - fee - keep).
   * Nothing is sent. Throws with a plain reason when it cannot be built (too little balance, below a dust limit ...).
   */
  prepare(keys: NativeKeys, coin: NativeCoin, to: string, amount: bigint | 'max'): Promise<PreparedSend>;
  /** Send exactly `p.request` (global fetch - the runner's guard checks it) and read the node's answer. Returns the txid; throws with the node's words when it refused. */
  broadcast(p: PreparedSend): Promise<string>;
  /** Whether `txid` is final on the chain: true, false (failed / not found after it was seen), null (not yet known). Never throws for "not found". */
  confirmed(txid: string): Promise<boolean | null>;
}
