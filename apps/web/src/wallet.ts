/**
 * Browser wallet integration: the EIP-1193 layer every signing path talks to.
 *
 * WHICH wallet is connected is decided in our Connect dialog and the Reown
 * AppKit step behind it (walletconnect.ts) - an extension found over EIP-6963,
 * or a phone paired by WalletConnect. Whatever it picks arrives here as a plain
 * EIP-1193 provider, and
 * the ONLY things we ever ask it to do are:
 *   - report accounts and chain id
 *   - sign EIP-712 typed data (`eth_signTypedData_v4`) to authorise an API key
 *   - switch/add ValueChain and send a deposit, when the user deposits
 *
 * We never request the private key, and we never ask it to sign an order - order
 * signing uses the restricted API key held by the backend.
 *
 * This module imports nothing from walletconnect.ts. It used to take
 * `normaliseChainId` from there while walletconnect.ts took `setSignPreflight`
 * from here, and that cycle is what made module evaluation order matter (see the
 * note at the bottom of walletconnect.ts). The helper lives here now and
 * walletconnect.ts re-exports it.
 */

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<any>;
  on?(event: string, handler: (...args: any[]) => void): void;
  removeListener?(event: string, handler: (...args: any[]) => void): void;
}

export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
  provider: Eip1193Provider;
}

const discovered = new Map<string, WalletInfo>();
const listeners = new Set<(w: WalletInfo[]) => void>();

function emit() {
  const list = [...discovered.values()];
  for (const l of listeners) l(list);
}

let listening = false;

/**
 * Start EIP-6963 discovery. Safe to call repeatedly: the listener is bound once,
 * and every call re-asks wallets to announce.
 *
 * AppKit runs its own discovery for the modal. This one exists because AppKit is
 * loaded LAZILY, on the first Connect click, and a wallet that announced before
 * then - and does not answer a later `requestProvider` - would otherwise be
 * missing from the modal. walletconnect.ts replays what was heard here once
 * AppKit is listening.
 */
export function discoverWallets(): void {
  if (!listening) {
    listening = true;
    window.addEventListener('eip6963:announceProvider', (ev) => {
      const d = (ev as CustomEvent).detail;
      if (!d?.info?.uuid || !d.provider) return;
      discovered.set(d.info.uuid, { ...d.info, provider: d.provider });
      emit();
    });
  }
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  // Legacy injection, for wallets that never announce.
  const legacy = (window as any).ethereum as Eip1193Provider | undefined;
  if (legacy && ![...discovered.values()].some((w) => w.provider === legacy)) {
    discovered.set('legacy', {
      uuid: 'legacy',
      name: (legacy as any).isMetaMask ? 'MetaMask' : 'Injected wallet',
      icon: '',
      rdns: 'legacy',
      provider: legacy,
    });
    emit();
  }
}

/** A snapshot of every wallet heard so far. */
export function getDiscoveredWallets(): WalletInfo[] {
  return [...discovered.values()];
}

export function onWallets(cb: (w: WalletInfo[]) => void): () => void {
  listeners.add(cb);
  cb([...discovered.values()]);
  return () => listeners.delete(cb);
}

export class WalletError extends Error {
  /** The wallet's EIP-1193 error code, when it gave one (4001 = the user said no). */
  constructor(message?: string, readonly code?: number) {
    super(message);
  }
}

/**
 * Did the USER decline in the wallet? Only then may a caller stay silent: any
 * other failure - SoDEX "rejecting" something, a revert - must be shown, even
 * when its text happens to contain "rejected".
 */
export const isUserRejection = (e: unknown): boolean =>
  e instanceof WalletError &&
  (e.code === 4001 || e.code === 5000 || /^(you rejected|user rejected|user denied|user cancel)/i.test(e.message));

/**
 * Read the wallet's current chain id, whatever shape it arrives in.
 *
 * An injected wallet returns a hex string ("0x1"). WalletConnect's eip155
 * provider answers `eth_chainId` LOCALLY and returns a decimal NUMBER
 * (`parseInt(getDefaultChain())`). Running `Number.parseInt(value, 16)` over
 * that re-reads decimal digits as hex - chain 8080 becomes 32896 - and the wrong
 * id then travels into the EIP-712 domain the user is asked to sign. Normalise
 * once, here, and use it everywhere.
 */
export function normaliseChainId(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw ?? '').trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return Number.parseInt(s, 16);
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n)) throw new WalletError(`wallet returned an unreadable chain id: ${String(raw)}`);
  return n;
}

/** Map the wallet's own error codes onto something a user can act on. */
function wrap(e: any): never {
  if (e instanceof WalletError) throw e;
  const code = typeof e?.code === 'number' ? e.code : undefined;
  if (code === 4001) throw new WalletError('You rejected the request in your wallet.', 4001);
  if (code === -32002) throw new WalletError('Your wallet already has a pending request - open it and respond.', code);
  throw new WalletError(e?.message ?? String(e), code);
}

/**
 * Reattach to a wallet the user already authorised, without prompting.
 *
 * `eth_accounts` (unlike `eth_requestAccounts`) never opens the wallet UI: it
 * returns the accounts already granted to this origin, or an empty array. This
 * closes a real hole - after a page reload the address was restored from
 * localStorage but the provider object was not, so the UI showed "connected"
 * while every action failed with "Connect a wallet first".
 *
 * AppKit's own reload path asks with `eth_requestAccounts`, which pops a locked
 * MetaMask's unlock window on page load. walletconnect.ts runs this first and
 * only lets AppKit proceed when it finds an account, so a reload stays silent.
 */
export async function silentReconnect(
  provider: Eip1193Provider,
  timeoutMs = SILENT_RECONNECT_MS,
): Promise<{ address: string; chainId: number } | null> {
  /*
   * WITH A TIME LIMIT. An extension can simply not answer (asleep, two wallets fighting over
   * window.ethereum). Without one, this never returned and the app said "Reconnecting wallet…"
   * for good, its Reconnect button disabled.
   */
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  const ask = (async () => {
    const accounts: string[] = await provider.request({ method: 'eth_accounts' });
    const address = accounts?.[0];
    if (!address) return null;
    return { address, chainId: await getChainId(provider) };
  })();
  try {
    return await Promise.race([ask, late]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** How long a wallet gets to answer the silent reconnect on load. */
export const SILENT_RECONNECT_MS = 5_000;

/**
 * The wallet's current chain id, normalised.
 *
 * Injected wallets return a hex string ("0x1"). WalletConnect's eip155 provider
 * answers this call locally and returns a decimal NUMBER, so the obvious
 * `parseInt(value, 16)` re-reads decimal digits as hex - chain 8080 becomes
 * 32896. That mattered here in two ways: the wrong id was displayed, and it was
 * sent to the backend as the EIP-712 `signatureChainId` for the authorisation
 * the user signs. Every read goes through this one function.
 */
export async function getChainId(provider: Eip1193Provider): Promise<number> {
  return normaliseChainId(await provider.request({ method: 'eth_chainId' }));
}

/**
 * Sign EIP-712 typed data. Returns the raw 65-byte signature hex; the backend
 * converts it to SoDEX's wire format (v 27/28 -> 0/1, 0x02 type prefix).
 */
/**
  * How long to wait on a wallet before calling it dead.
  *
  * SIXTY SECONDS, not the three minutes this used to be. The old figure was
  * sized for a world with no liveness check at all, where the only way to tell a
  * dead session from a slow human was to outwait the human. A relay probe now
  * runs before every signature (see `setSignPreflight`), so a dead session is
  * reported in about a second and this bound only has to cover someone genuinely
  * walking to their phone. Three minutes of silence is indistinguishable from a
  * hang, and that is how it was read.
  *
  * Over WalletConnect a request is a message to a relay, and a session the
  * wallet has already dropped absorbs it silently: the promise simply never
  * settles. That is what "I signed it and nothing happened" was - not a failure
  * anyone could see, just a spinner with no end. Injected wallets answer in
  * seconds; a human approving on a phone can take much longer, so this is
  * generous. It exists to convert an infinite hang into a message.
  */
const WALLET_REQUEST_TIMEOUT_MS = 60_000;

async function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new WalletError(
            `${what} timed out after ${Math.round(WALLET_REQUEST_TIMEOUT_MS / 1000)}s. `
            + 'If you approved it in your wallet, the connection to this page was already dead - '
            + 'disconnect, reconnect, and try again.',
          )),
          WALLET_REQUEST_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------------------
 * A PREFLIGHT, BECAUSE "CONNECTED" CAN BE A LIE.
 *
 * `eth_accounts` and `eth_chainId` are answered LOCALLY by a WalletConnect
 * provider - from state it persisted to localStorage. So a session the relay has
 * long since dropped still reports an address, still restores on reload, and
 * still leaves the header saying Connected. Nothing notices until a request that
 * actually needs the wallet goes out, and that request simply never comes back:
 * the user approves something in their wallet and this page waits the full
 * WALLET_REQUEST_TIMEOUT_MS in silence.
 *
 * The check itself has to live in walletconnect.ts - it is the only module that
 * knows about sessions and relays - and this file is the layer BELOW that one.
 * So walletconnect.ts registers it here at load, rather than this file importing
 * upward and creating a cycle. Unregistered (or an injected wallet, which has no
 * session to go stale) it is a no-op, which is the right default: a preflight
 * that cannot run must not block a signature that would have worked.
 * ------------------------------------------------------------------------ */

let signPreflight: ((provider: Eip1193Provider, method: string) => Promise<void>) | null = null;

export function setSignPreflight(
  fn: ((provider: Eip1193Provider, method: string) => Promise<void>) | null,
): void {
  signPreflight = fn;
}

/**
 * `personal_sign` of a plain-text message.
 *
 * Distinct from `signTypedData` because the two are not interchangeable: EIP-712
 * signs a structured payload a contract can verify, while this signs a string a
 * SERVER hands you and then checks. SoDEX's sign-in uses the latter - their auth
 * host issues a nonce message and verifies the signature over it.
 *
 * The message goes as a hex-encoded string. `personal_sign` accepts UTF-8 too,
 * but wallets disagree about which of the two arguments is the address, and
 * hex-first-address-second is the ordering every one of them reads correctly.
 */
export async function signMessage(
  provider: Eip1193Provider,
  address: string,
  message: string,
): Promise<string> {
  const hex = `0x${Array.from(new TextEncoder().encode(message))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
  await signPreflight?.(provider, 'personal_sign');
  try {
    return await withTimeout(
      provider.request({ method: 'personal_sign', params: [hex, address] }),
      'The signature request',
    );
  } catch (e) {
    if (e instanceof WalletError) throw e;
    wrap(e);
  }
}

export async function signTypedData(
  provider: Eip1193Provider,
  address: string,
  typedData: unknown,
): Promise<string> {
  await signPreflight?.(provider, 'eth_signTypedData_v4');
  try {
    return await withTimeout(
      provider.request({
        method: 'eth_signTypedData_v4',
        // Some wallets require the JSON string form rather than an object.
        params: [address, JSON.stringify(typedData)],
      }),
      'The signature request',
    );
  } catch (e) {
    if (e instanceof WalletError) throw e;
    wrap(e);
  }
}

export interface AddChainParams {
  chainId: string; // hex
  chainName: string;
  rpcUrls: string[];
  blockExplorerUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

/**
 * Point the wallet at ValueChain, adding it first if the wallet has never seen
 * it. 4902 ("unrecognized chain") is the documented signal to fall back to
 * wallet_addEthereumChain; some wallets instead report -32603 or a plain
 * message, so those are treated the same way.
 */
export async function addOrSwitchChain(provider: Eip1193Provider, chain: AddChainParams): Promise<void> {
  // Compared as NUMBERS, not lowercased strings. Over WalletConnect the reply is
  // a number, so `current.toLowerCase()` threw TypeError and took the whole
  // deposit path with it.
  const want = normaliseChainId(chain.chainId);
  if ((await getChainId(provider)) === want) return;

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chain.chainId }],
    });
    return;
  } catch (e: any) {
    const unknownChain =
      e?.code === 4902 || e?.code === -32603 || /unrecognized|unknown chain|not added/i.test(e?.message ?? '');
    if (!unknownChain) wrap(e);
  }

  try {
    await provider.request({ method: 'wallet_addEthereumChain', params: [chain] });
  } catch (e) {
    wrap(e);
  }

  const after = await getChainId(provider);
  if (after !== want) {
    throw new WalletError(
      `Your wallet is still on chain ${after}. Switch it to ${chain.chainName} (${chain.chainId}) and try again.`,
    );
  }
}

export interface TxRequest {
  from: string;
  to: string;
  data: string;
  value: string;
  /**
   * The chain this transaction is for. Checked against the wallet right before
   * sending and passed along, so a network switch in between (the user, or a
   * wallet quirk) can never send it - native value included - on another chain.
   */
  chainId?: number;
}

/** Ask the wallet to sign and broadcast one transaction. Returns its hash. */
export async function sendTransaction(provider: Eip1193Provider, tx: TxRequest): Promise<string> {
  if (tx.chainId !== undefined) {
    const now = await getChainId(provider);
    if (now !== tx.chainId) {
      throw new WalletError(`Your wallet is on chain ${now}, not ${tx.chainId}. Nothing was sent - switch back and try again.`);
    }
  }
  try {
    const hash: string = await provider.request({
      method: 'eth_sendTransaction',
      // Gas is deliberately left to the wallet to estimate.
      params: [{
        from: tx.from,
        to: tx.to,
        data: tx.data,
        value: tx.value === '0x0' ? undefined : tx.value,
        ...(tx.chainId !== undefined ? { chainId: `0x${tx.chainId.toString(16)}` } : {}),
      }],
    });
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new WalletError(`Wallet returned an unexpected transaction hash: ${hash}`);
    }
    return hash;
  } catch (e) {
    wrap(e);
  }
}

export function watchAccount(
  provider: Eip1193Provider,
  onAccounts: (a: string[]) => void,
  onChain: (id: number) => void,
): () => void {
  const acc = (a: string[]) => onAccounts(a);
  const ch = (v: unknown) => onChain(normaliseChainId(v));
  provider.on?.('accountsChanged', acc);
  provider.on?.('chainChanged', ch);
  return () => {
    provider.removeListener?.('accountsChanged', acc);
    provider.removeListener?.('chainChanged', ch);
  };
}
