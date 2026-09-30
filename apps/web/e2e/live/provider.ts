/**
 * A REAL EIP-1193 wallet backed by one private key, for the live E2E runner.
 *
 * It answers exactly what the app asks a browser wallet (apps/web/src/wallet.ts),
 * the way MetaMask answers it, so the app's own code paths run unchanged:
 *   eth_chainId / net_version / eth_accounts / eth_requestAccounts
 *   wallet_switchEthereumChain   4902 for a chain it has no RPC for (the app then
 *                                tries wallet_addEthereumChain, which is refused
 *                                for unknown chains too)
 *   wallet_addEthereumChain      known chains only; switches to it. Its OWN RPC
 *                                URL is used, never one handed in by the page.
 *   eth_signTypedData_v4         65-byte r||s||v, v = 27/28; the domain chainId
 *                                must be the ACTIVE chain (MetaMask refuses
 *                                otherwise, and so does this)
 *   personal_sign                EIP-191, v = 27/28
 *   eth_sendTransaction          signed locally with viem and broadcast to the
 *                                current chain's RPC; returns the hash at once
 *                                (no waiting), like a wallet. A `chainId` field
 *                                that is not the active chain is refused.
 *   read calls                   eth_call, eth_getBalance, eth_estimateGas,
 *                                eth_getTransactionReceipt, ... forwarded to the
 *                                current chain's RPC.
 *
 * POLICY. Nothing is signed or sent unless the runner's current policy allows
 * that exact transaction / typed data / message (`setPolicy`). With no policy
 * every signature is refused (EIP-1193 code 4100). So a bug anywhere in the
 * app or the runner cannot make this wallet sign something the running step did
 * not expect.
 *
 * THE KEY. Given once, validated without ever echoing it, and then held only in
 * viem's account closure: no property, no log line, no error message carries
 * it (every message this module throws is scrubbed as a second line of
 * defence). `JSON.stringify` / `util.inspect` of the provider show the address.
 */
import { createPublicClient, createWalletClient, defineChain, http, type Chain, type Transport } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { EVM_CHAINS } from '../../src/trading/onboard';
import { VALUECHAIN_RPC } from '../../src/trading/rpc';
import type { Eip1193Provider } from '../../src/wallet';

export const VALUECHAIN_CHAIN_ID = 286623;

export interface ChainSpec {
  /** SoDEX's chain key (VALUECHAIN, ARBITRUM_ETH, BASE_ETH, ...). */
  key: string;
  id: number;
  name: string;
  rpcUrl: string;
  native: { name: string; symbol: string; decimals: number };
}

export const VALUECHAIN: ChainSpec = {
  key: 'VALUECHAIN',
  id: VALUECHAIN_CHAIN_ID,
  name: 'ValueChain',
  rpcUrl: VALUECHAIN_RPC,
  native: { name: 'SOSO', symbol: 'SOSO', decimals: 18 },
};

/** ValueChain plus every EVM chain the app itself sends from (trading/onboard.ts EVM_CHAINS). */
export const KNOWN_CHAINS: readonly ChainSpec[] = [
  VALUECHAIN,
  ...Object.values(EVM_CHAINS).map((c) => ({ key: c.key, id: c.chainId, name: c.name, rpcUrl: c.rpcUrl, native: c.native })),
];

/** An EIP-1193 error: `code` 4001/4100/4200/4902/-32602/-32000, like a browser wallet's. */
export class ProviderRpcError extends Error {
  override name = 'ProviderRpcError';
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface TxSeen {
  chainId: number;
  chainKey: string;
  from: string;
  to: string;
  data: string;
  value: bigint;
}

export interface TypedDataSeen {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** Return null to allow, or the reason to refuse. Missing hooks refuse. */
export interface ProviderPolicy {
  tx?: (tx: TxSeen) => string | null;
  typedData?: (td: TypedDataSeen, chainId: number) => string | null;
  message?: (hex: string, chainId: number) => string | null;
}

export type ProviderEvent =
  | { type: 'switch'; from: number; to: number }
  | { type: 'signed-typed-data'; chainId: number; primaryType: string }
  | { type: 'signed-message'; chainId: number }
  | { type: 'tx-sent'; chainId: number; chainKey: string; hash: string; to: string; value: string; selector: string }
  | { type: 'refused'; method: string; reason: string };

export interface KeyProviderOptions {
  /** 0x + 64 hex. Never echoed, never stored outside viem's account closure. */
  privateKey: string;
  chains?: readonly ChainSpec[];
  /** The chain the wallet starts on (default: ValueChain). */
  startChainId?: number;
  policy?: ProviderPolicy | null;
  onEvent?: (e: ProviderEvent) => void;
  /** For tests: the transport per chain (default: viem `http` to the chain's own RPC). */
  transport?: (chain: ChainSpec) => Transport;
}

export interface KeyProvider extends Eip1193Provider {
  /** The wallet address, lower-case. */
  readonly address: string;
  /** The active chain id. */
  readonly chainId: number;
  readonly chain: ChainSpec;
  setPolicy(p: ProviderPolicy | null): void;
  knownChains(): readonly ChainSpec[];
  /** `text` with the private key (hex, any case, with or without 0x) replaced by [redacted] - for reports and logs. */
  redact(text: string): string;
}

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/** Methods that only read chain state: forwarded to the current chain's RPC. */
export const READ_METHODS = new Set([
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
  'eth_syncing',
  'web3_clientVersion',
]);

const hexId = (id: number): string => `0x${id.toString(16)}`;

function parseChainId(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) return raw;
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) return Number.parseInt(s, 16);
    if (/^\d+$/.test(s)) return Number.parseInt(s, 10);
  }
  return null;
}

const isAddr = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const isHexData = (v: unknown): v is string => typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v);

export function createKeyProvider(o: KeyProviderOptions): KeyProvider {
  const secret = typeof o.privateKey === 'string' ? o.privateKey.trim() : '';
  if (!KEY_RE.test(secret)) {
    // Never echo the input, even a malformed one: it may be a real key with a typo.
    throw new Error('The private key must be 0x followed by 64 hex characters (VS_E2E_KEY).');
  }
  let account: PrivateKeyAccount;
  try {
    account = privateKeyToAccount(secret as `0x${string}`);
  } catch {
    throw new Error('The private key is not a valid secp256k1 key (VS_E2E_KEY).');
  }
  const address = account.address.toLowerCase();
  /** Anything this module throws is scrubbed of the key, however unlikely it is to be there. */
  const needleRe = new RegExp(`(0x)?${secret.slice(2)}`, 'gi');
  const scrub = (s: string): string => String(s).replace(needleRe, '[redacted]');
  const fail = (code: number, message: string): ProviderRpcError => new ProviderRpcError(code, scrub(message));

  const chains = [...(o.chains ?? KNOWN_CHAINS)];
  const byId = new Map(chains.map((c) => [c.id, c]));
  let current = byId.get(o.startChainId ?? VALUECHAIN_CHAIN_ID) ?? chains[0];
  if (!current) throw new Error('createKeyProvider: no chains configured');
  let policy: ProviderPolicy | null = o.policy ?? null;
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  const emit = (event: string, ...args: unknown[]) => {
    for (const fn of listeners.get(event) ?? []) {
      try {
        fn(...args);
      } catch {
        /* a listener must not break the wallet */
      }
    }
  };
  const note = (e: ProviderEvent) => {
    try {
      o.onEvent?.(e);
    } catch {
      /* ignore */
    }
  };

  const viemChains = new Map<number, Chain>();
  const viemChain = (c: ChainSpec): Chain => {
    let v = viemChains.get(c.id);
    if (!v) {
      v = defineChain({ id: c.id, name: c.name, nativeCurrency: c.native, rpcUrls: { default: { http: [c.rpcUrl] } } });
      viemChains.set(c.id, v);
    }
    return v;
  };
  const transportFor = (c: ChainSpec): Transport => (o.transport ? o.transport(c) : http(c.rpcUrl, { timeout: 20_000, retryCount: 1 }));
  const publics = new Map<number, ReturnType<typeof createPublicClient>>();
  const wallets = new Map<number, ReturnType<typeof createWalletClient>>();
  const publicClient = (c: ChainSpec) => {
    let p = publics.get(c.id);
    if (!p) {
      p = createPublicClient({ chain: viemChain(c), transport: transportFor(c) });
      publics.set(c.id, p);
    }
    return p;
  };
  const walletClient = (c: ChainSpec) => {
    let w = wallets.get(c.id);
    if (!w) {
      w = createWalletClient({ account, chain: viemChain(c), transport: transportFor(c) });
      wallets.set(c.id, w);
    }
    return w;
  };

  const refuse = (method: string, reason: string): never => {
    note({ type: 'refused', method, reason });
    throw fail(4100, `The E2E wallet refused ${method}: ${reason}`);
  };

  const switchTo = (id: number, method: string) => {
    const next = byId.get(id);
    if (!next) {
      throw fail(4902, `Unrecognized chain ID "${hexId(id)}". This test wallet only has RPCs for: ${chains.map((c) => `${c.name} (${c.id})`).join(', ')}.`);
    }
    if (next.id !== current!.id) {
      note({ type: 'switch', from: current!.id, to: next.id });
      current = next;
      emit('chainChanged', hexId(next.id));
    }
    void method;
    return null;
  };

  const sameAccount = (v: unknown) => typeof v === 'string' && v.toLowerCase() === address;

  async function signTypedData(params: unknown[]): Promise<string> {
    const [who, raw] = params;
    if (!sameAccount(who)) throw fail(4100, 'eth_signTypedData_v4: that account is not this wallet.');
    let td: TypedDataSeen;
    try {
      td = (typeof raw === 'string' ? JSON.parse(raw) : raw) as TypedDataSeen;
    } catch {
      throw fail(-32602, 'eth_signTypedData_v4: the typed data is not valid JSON.');
    }
    if (!td || typeof td !== 'object' || typeof td.primaryType !== 'string' || !td.types || !td.message || !td.domain) {
      throw fail(-32602, 'eth_signTypedData_v4: typed data needs domain, types, primaryType and message.');
    }
    const domainChain = td.domain.chainId === undefined ? null : parseChainId(td.domain.chainId);
    if (td.domain.chainId !== undefined && domainChain !== current!.id) {
      // MetaMask: "Provided chainId must match the active chainId".
      throw fail(-32602, `Provided chainId "${String(td.domain.chainId)}" must match the active chainId "${current!.id}".`);
    }
    const why = policy?.typedData ? policy.typedData(td, current!.id) : 'no policy allows signing typed data right now';
    if (why) refuse('eth_signTypedData_v4', why);
    try {
      // Exactly what the page handed over (EIP712Domain included), as MetaMask hashes it.
      const definition = { domain: td.domain, types: td.types, primaryType: td.primaryType, message: td.message };
      const sig = await account.signTypedData(definition as unknown as Parameters<PrivateKeyAccount['signTypedData']>[0]);
      note({ type: 'signed-typed-data', chainId: current!.id, primaryType: td.primaryType });
      return sig;
    } catch (e) {
      throw fail(-32602, `eth_signTypedData_v4 failed: ${shortMessage(e)}`);
    }
  }

  async function personalSign(params: unknown[]): Promise<string> {
    // The app sends [hexMessage, address]; some callers reverse it.
    const [a, b] = params;
    const msg = sameAccount(b) ? a : sameAccount(a) ? b : null;
    if (msg === null || typeof msg !== 'string') throw fail(4100, 'personal_sign: that account is not this wallet.');
    const hex = isHexData(msg) ? msg : `0x${Buffer.from(msg, 'utf8').toString('hex')}`;
    const why = policy?.message ? policy.message(hex, current!.id) : 'no policy allows signing messages right now';
    if (why) refuse('personal_sign', why);
    const sig = await account.signMessage({ message: { raw: hex as `0x${string}` } });
    note({ type: 'signed-message', chainId: current!.id });
    return sig;
  }

  async function sendTransaction(params: unknown[]): Promise<string> {
    const tx = (params[0] ?? {}) as Record<string, unknown>;
    if (!sameAccount(tx.from)) throw fail(4100, 'eth_sendTransaction: `from` is not this wallet.');
    if (tx.chainId !== undefined && parseChainId(tx.chainId) !== current!.id) {
      throw fail(-32602, `eth_sendTransaction: chainId ${String(tx.chainId)} is not the active chain ${current!.id} - nothing was sent.`);
    }
    if (!isAddr(tx.to)) throw fail(-32602, 'eth_sendTransaction: `to` must be an address (this wallet never deploys contracts).');
    const data = tx.data === undefined ? '0x' : tx.data;
    if (!isHexData(data)) throw fail(-32602, 'eth_sendTransaction: `data` must be hex.');
    let value = 0n;
    if (tx.value !== undefined && tx.value !== null) {
      if (typeof tx.value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(tx.value)) throw fail(-32602, 'eth_sendTransaction: `value` must be a hex quantity.');
      value = BigInt(tx.value);
    }
    let gas: bigint | undefined;
    if (tx.gas !== undefined) {
      if (typeof tx.gas !== 'string' || !/^0x[0-9a-fA-F]+$/.test(tx.gas)) throw fail(-32602, 'eth_sendTransaction: `gas` must be a hex quantity.');
      gas = BigInt(tx.gas);
    }
    const chain = current!;
    const seen: TxSeen = { chainId: chain.id, chainKey: chain.key, from: address, to: tx.to.toLowerCase(), data: data.toLowerCase(), value };
    const why = policy?.tx ? policy.tx(seen) : 'no policy allows sending transactions right now';
    if (why) refuse('eth_sendTransaction', why);
    let hash: string;
    try {
      hash = await walletClient(chain).sendTransaction({
        account,
        chain: viemChain(chain),
        to: seen.to as `0x${string}`,
        data: seen.data as `0x${string}`,
        value,
        ...(gas !== undefined ? { gas } : {}),
      } as never);
    } catch (e) {
      throw fail(-32000, `eth_sendTransaction on ${chain.name} failed: ${shortMessage(e)}`);
    }
    note({ type: 'tx-sent', chainId: chain.id, chainKey: chain.key, hash, to: seen.to, value: value.toString(), selector: seen.data.slice(0, 10) });
    return hash;
  }

  const provider: KeyProvider = {
    get address() {
      return address;
    },
    get chainId() {
      return current!.id;
    },
    get chain() {
      return current!;
    },
    setPolicy(p) {
      policy = p;
    },
    knownChains: () => chains,
    redact: (text: string) => scrub(text),
    on(event, handler) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(handler);
    },
    removeListener(event, handler) {
      listeners.get(event)?.delete(handler);
    },
    async request({ method, params }) {
      const p = Array.isArray(params) ? params : [];
      switch (method) {
        case 'eth_chainId':
          return hexId(current!.id);
        case 'net_version':
          return String(current!.id);
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return [address];
        case 'wallet_switchEthereumChain': {
          const id = parseChainId((p[0] as { chainId?: unknown } | undefined)?.chainId);
          if (id === null) throw fail(-32602, 'wallet_switchEthereumChain: expected [{ chainId }].');
          return switchTo(id, method);
        }
        case 'wallet_addEthereumChain': {
          const id = parseChainId((p[0] as { chainId?: unknown } | undefined)?.chainId);
          if (id === null) throw fail(-32602, 'wallet_addEthereumChain: expected [{ chainId, ... }].');
          if (!byId.has(id)) throw fail(4902, `This test wallet refuses to add chain ${hexId(id)}: it only uses its own RPCs for known chains.`);
          return switchTo(id, method);
        }
        case 'eth_signTypedData_v4':
          return signTypedData(p);
        case 'personal_sign':
          return personalSign(p);
        case 'eth_sendTransaction':
          return sendTransaction(p);
        case 'eth_sign':
        case 'eth_signTransaction':
        case 'eth_signTypedData':
        case 'eth_signTypedData_v3':
          throw fail(4200, `${method} is not supported by this test wallet.`);
        default:
          if (READ_METHODS.has(method)) {
            try {
              return await publicClient(current!).request({ method, params: p } as never);
            } catch (e) {
              const code = typeof (e as { code?: unknown }).code === 'number' ? ((e as { code: number }).code) : -32603;
              throw fail(code, `${method} on ${current!.name}: ${shortMessage(e)}`);
            }
          }
          throw fail(4200, `The E2E wallet does not support ${method}.`);
      }
    },
  };
  // What a JSON dump or util.inspect of the provider shows: its address, nothing else.
  Object.defineProperty(provider, 'toJSON', { value: () => ({ address, chainId: current!.id }), enumerable: false });
  Object.defineProperty(provider, Symbol.for('nodejs.util.inspect.custom'), {
    value: () => `KeyProvider { address: '${address}', chainId: ${current!.id} }`,
    enumerable: false,
  });
  return provider;
}

/** viem's one-line message when it has one (its long form repeats request details). */
function shortMessage(e: unknown): string {
  const s = (e as { shortMessage?: unknown }).shortMessage;
  if (typeof s === 'string' && s) {
    const details = (e as { details?: unknown }).details;
    return typeof details === 'string' && details && !s.includes(details) ? `${s} (${details})` : s;
  }
  return e instanceof Error ? e.message.split('\n')[0] ?? e.message : String(e);
}
