/**
 * The wallet connection layer: Reown AppKit (with the ethers adapter) owns the
 * connection - browser-extension wallets (anything that announces itself over
 * EIP-6963) and WalletConnect's QR / mobile pairing.
 *
 * AppKit's modal is NEVER opened straight from a button. Every "Connect wallet"
 * opens OUR Connect dialog first (components/account/ConnectDialog.tsx, via
 * connect.ts:openConnectDialog), and only the row pressed there brings up
 * AppKit - and then only the one view that row needs. That routing lives at the
 * bottom of this file (`routeFor` / `connectVia`).
 *
 * HOW WE GOT HERE, because each step is a constraint on this file.
 *
 *  1. Opentrade drove AppKit in `manualWCControl` mode around its own
 *     `@walletconnect/universal-provider`, and used the modal for its UI only.
 *     That was WalletConnect-ONLY by design: AppKit lists extension wallets
 *     through a chain ADAPTER, and there was none. Extensions were connected
 *     from Valuescan's own wallet sheet instead.
 *  2. Owner request: one modal, and it must offer extension wallets too. So
 *     AppKit now owns the connection, with an adapter.
 *
 * WHY THE ETHERS ADAPTER AND NOT WAGMI. Both are official and both give the same
 * modal. `@reown/appkit-adapter-wagmi` needs wagmi + @wagmi/core + viem +
 * @tanstack/react-query as peers, and @wagmi/connectors optionally drags the
 * Coinbase, MetaMask SDK, Safe and Base SDKs behind it - a second state library
 * and a second connector registry for an app that only needs "an EIP-1193
 * provider and an address". `@reown/appkit-adapter-ethers` added 14 packages to
 * the tree (ethers v6 and its handful of deps), everything else was already here
 * because AppKit itself depends on it. Both adapter and AppKit are pinned to the
 * SAME exact version: the adapter depends on `@reown/appkit` at an exact version,
 * so a drift would install two copies of AppKit's controllers, and AppKit's state
 * is module-level - two copies means two modals that disagree about who is
 * connected.
 *
 * THE CONTRACT WITH THE REST OF THE APP IS UNCHANGED: an EIP-1193 provider (the
 * wallet's own for an extension, the UniversalProvider for WalletConnect), the
 * connected address and chain id. signing.ts, Money, Deposit and trading never
 * see AppKit. App state is fed from `subscribeWallet` by `useWalletBridge` in
 * components/account/useWallet.ts, mounted once in App.tsx.
 *
 * WHERE WE DEPART FROM APPKIT'S DEFAULTS, each for a reason written at the site:
 *  - an extension is never forced onto ValueChain at connect time (the adapter
 *    otherwise fails the connection for any wallet that has not added it);
 *  - a reload reconnects SILENTLY (`eth_accounts`, not `eth_requestAccounts`);
 *  - no balance or identity lookups (CSP-blocked hosts, and an address leak);
 *  - WalletConnect sessions request only the methods this app calls;
 *  - "basic" mode, so the modal is connect-only whatever the Reown dashboard says;
 *  - AppKit's telemetry (event beacons and error reports) is dropped;
 *  - its "Connect Wallet" list names MetaMask, OKX, SafePal and Bitget, shows
 *    the WalletConnect icon, and is redrawn once its wallets have loaded - the
 *    three things basic mode otherwise leaves out of the owner's reference;
 *  - it draws no backdrop of its own (our Connect dialog's scrim, behind it for
 *    the whole session, is the one backdrop), and it LEAVES the way it came -
 *    fading, with its content as it was - where AppKit itself cuts the card
 *    away on the first frame of its exit. See "APPKIT IN FRONT OF OUR DIALOG".
 *
 * A WalletConnect project id is required - AppKit refuses to start without one,
 * even for extension-only use. Create a free project at
 * https://dashboard.reown.com and set VITE_WALLETCONNECT_PROJECT_ID. There is
 * deliberately no fallback id baked in: using someone else's project would
 * silently bill their quota.
 */
import type { AppKit, ChainAdapterConnector } from '@reown/appkit';
import type { EthersAdapter } from '@reown/appkit-adapter-ethers';
/* One exported string (AppKit's own version), not the AppKit chunk: safe to
   import statically on first paint. */
import { PACKAGE_VERSION as APPKIT_VERSION } from '@reown/appkit/constants';
import { api } from './api';
import { startLater } from './startLater';
import { EVM_CHAINS } from './trading/onboard';
import {
  discoverWallets,
  getDiscoveredWallets,
  normaliseChainId,
  setSignPreflight,
  silentReconnect,
  type Eip1193Provider,
  type WalletInfo,
} from './wallet';

export { normaliseChainId } from './wallet';

export const WC_PROJECT_ID: string = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '').trim();

export const hasWalletConnectConfig = (): boolean => WC_PROJECT_ID.length > 0;

export class WalletConnectError extends Error {}

/**
 * Exactly the methods this app calls over WalletConnect, and nothing else.
 *
 * AppKit's default eip155 list is 23 methods, which includes `eth_sign` - raw
 * signing of arbitrary 32 bytes, the classic drainer primitive, and a method
 * this app has no use for - plus `eth_signTransaction`, `eth_sendRawTransaction`
 * and `wallet_sendCalls`. A session grant is a standing capability: whatever is
 * in this list is what a compromised page (or a malicious wallet-side peer) can
 * ask for later, so it should be the true minimum. It reaches AppKit through
 * `universalProviderConfigOverride`, which REPLACES the default list.
 *
 * `wallet_switchEthereumChain` and `wallet_addEthereumChain` are required by the
 * ValueChain deposit path (wallet.ts:addOrSwitchChain). `eth_requestAccounts`
 * and `eth_chainId` are answered locally by the provider and need not be listed.
 */
const WC_METHODS = [
  'eth_sendTransaction',
  'eth_signTypedData_v4',
  'personal_sign',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
] as const;

const WC_EVENTS = ['accountsChanged', 'chainChanged'] as const;

/* ---------------------------------------------------------------------------
 * THE CHAIN.
 * ------------------------------------------------------------------------ */

export interface WalletChain {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string | null;
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

/**
 * ValueChain mainnet, as server/src/sodex/chain.ts defines it. Used only if the
 * backend cannot be asked (it is the source of truth: it knows whether this
 * install runs on mainnet or testnet, and whether VALUECHAIN_RPC overrides the
 * public RPC).
 */
const VALUECHAIN_FALLBACK: WalletChain = {
  chainId: 286623,
  name: 'ValueChain',
  rpcUrl: 'https://rpc.valuechain.xyz',
  explorerUrl: 'https://main-scan.valuechain.xyz',
  nativeCurrency: { name: 'SOSO', symbol: 'SOSO', decimals: 18 },
};

let chainPromise: Promise<WalletChain> | null = null;

function loadChain(): Promise<WalletChain> {
  if (!chainPromise) {
    chainPromise = api.depositChain().then(
      (c) => ({
        chainId: c.chainId,
        name: c.name,
        rpcUrl: c.rpcUrl,
        explorerUrl: c.explorerUrl,
        nativeCurrency: c.nativeCurrency,
      }),
      () => {
        // Do not cache a failure: a backend mid-restart is the usual cause.
        chainPromise = null;
        return VALUECHAIN_FALLBACK;
      },
    );
  }
  return chainPromise;
}

/**
 * The AppKit network list: ValueChain, and only ValueChain.
 *
 * It is the one chain the app ever asks a wallet to be on (deposits, via
 * addOrSwitchChain). Enabling trading signs EIP-712 on whatever chain the wallet
 * is already on, so nothing else is needed - and an earlier version that also
 * listed Ethereum mainnet let a wallet approve mainnet ALONE and have the app
 * adopt it as the active chain, on the network where the user's real assets
 * live. With `allowUnsupportedChain`, a wallet sitting on any other chain is
 * simply connected there.
 */
function toNetwork(c: WalletChain) {
  return {
    id: c.chainId,
    caipNetworkId: `eip155:${c.chainId}` as const,
    chainNamespace: 'eip155' as const,
    name: c.name,
    nativeCurrency: c.nativeCurrency,
    rpcUrls: { default: { http: [c.rpcUrl] } },
    ...(c.explorerUrl
      ? { blockExplorers: { default: { name: `${c.name} explorer`, url: c.explorerUrl } } }
      : {}),
    testnet: c.chainId !== VALUECHAIN_FALLBACK.chainId,
  };
}

/* ---------------------------------------------------------------------------
 * THE THEME: Valuetrade's tokens, read from styles.css at runtime.
 * ------------------------------------------------------------------------ */

/**
 * Read off `:root` rather than copied, so the modal follows styles.css if the
 * accent or type ever changes. Fallbacks are the values at the time of writing.
 *
 * - accent: `--accent`, the app's cyan. AppKit paints its primary buttons, links
 *   and focus accents with it.
 * - font: `--font-text` (IBM Plex Sans, self-hosted). Setting ANY font also stops
 *   AppKit preloading its own KHTeka files from fonts.reown.com.
 * - radius: AppKit's own 4px master (it multiplies it: x4 for rows, x8 for the
 *   sheet). Stated rather than defaulted, and NOT our --radius-xs: the owner's
 *   reference for the two AppKit views we open (the WalletConnect QR and the
 *   "Connect Wallet" list) is AppKit at exactly this roundness. Our own dialog
 *   in front of it carries the site's radii.
 * - z-index: above every popover (1200) and our own Connect dialog (1400), below
 *   the toast rail (2000), so an error raised while the modal is up is readable.
 *
 * The names are AppKit's CURRENT ones (`--apkt-*`, the ThemeVariables type in
 * @reown/appkit-common). The `--w3m-*` spellings are still read as a fallback
 * (appkit-ui ThemeHelperUtil), but only as that.
 *
 * NOT SET, ON PURPOSE:
 * - `--apkt-color-mix` / `-strength`. AppKit mixes that colour into EVERY
 *   colour token, text and icons included, so pulling the sheet towards our
 *   near-black also greys its white text and lowers the QR view's contrast.
 *   Nothing needs pulling: AppKit's dark palette (a #202020 sheet, #252525-
 *   #363636 rows) already sits between our --bg-panel and --bg-hover.
 * - `--apkt-background`: there is no such theme variable (the ThemeVariables
 *   type lists every one AppKit reads).
 */
const MODAL_Z_INDEX = 1500;

function themeVariables() {
  const css = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  const read = (name: string, fallback: string) => css?.getPropertyValue(name).trim() || fallback;
  return {
    '--apkt-accent': read('--accent', '#e6e6e6'),
    '--apkt-font-family': read(
      '--font-text',
      '"IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    ),
    '--apkt-border-radius-master': '4px',
    '--apkt-z-index': MODAL_Z_INDEX,
  };
}

/* ---------------------------------------------------------------------------
 * TELEMETRY.
 * ------------------------------------------------------------------------ */

/**
 * OPT OUT OF APPKIT'S TELEMETRY, which has no configuration switch.
 *
 * `features.analytics: false` does not stop it. AppKit's EventsController sends
 * when analytics is enabled OR when the event is one of a hardcoded
 * MANDATORY_EVENTS list - and `INITIALIZE` and `CONNECT_SUCCESS` are on that
 * list, so they fire regardless of configuration. The payload includes
 * `metadata.url`: it reports the origin this app is deployed at, and the address
 * that connected, to a third party.
 *
 * There are two transports, both in AppKit's FetchUtil: `navigator.sendBeacon`
 * for the event batch, and a plain `fetch` POST for its error reports
 * (TelemetryController, `/e` - it carries a stack trace and the page URL). A
 * narrow guard on each is enough. It drops ONLY requests aimed at the telemetry
 * host and answers the way a delivered one would (`true` from the beacon, an
 * empty 200 JSON from fetch), so the SDK carries on believing it was sent.
 * Every other beacon and fetch on the page, from any other code, is untouched.
 * This is why `pulse.walletconnect.org` is absent from the CSP: the request is
 * never made, rather than made, refused, and logged as a CSP error.
 */
const TELEMETRY_HOSTS = ['pulse.walletconnect.org'];
/* Carried across dev hot reloads (see HOT RELOAD below): a second copy of this
   module must not wrap fetch and sendBeacon a second time. */
let telemetryGuarded = Boolean(hotData()?.telemetryGuarded);

function isTelemetryUrl(url: unknown): boolean {
  try {
    const raw = url instanceof Request ? url.url : String(url);
    return TELEMETRY_HOSTS.includes(new URL(raw, window.location.origin).hostname);
  } catch {
    return false; /* an unparseable URL is not ours to judge - let it through */
  }
}

function blockVendorTelemetry(): void {
  if (telemetryGuarded || typeof window === 'undefined') return;
  telemetryGuarded = true;
  const hot = hotData();
  if (hot) hot.telemetryGuarded = true;
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null): boolean =>
      isTelemetryUrl(url) ? true : beacon(url, data);
  }
  if (typeof window.fetch === 'function') {
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      isTelemetryUrl(input)
        ? Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
        : fetchOriginal(input, init);
  }
}

/* ---------------------------------------------------------------------------
 * THE ADAPTER, with three behaviours changed.
 * ------------------------------------------------------------------------ */

type EthersAdapterClass = typeof EthersAdapter;
type ConnectParams = Parameters<EthersAdapter['connect']>[0];
type SyncConnectionParams = Parameters<EthersAdapter['syncConnection']>[0];
type BalanceResult = Awaited<ReturnType<EthersAdapter['getBalance']>>;

const isExtensionType = (type: string | undefined): boolean =>
  type !== 'WALLET_CONNECT' && type !== 'AUTH';

/**
 * Built at runtime because the base class arrives by dynamic import - AppKit and
 * ethers are a large chunk that must not sit on first paint.
 *
 * The overrides lean on the adapter's internals at the pinned version
 * (package.json holds it EXACTLY at 1.8.24; re-read against that version's
 * EthersAdapter when it was upgraded). Each says what it guards against, so
 * an upgrade can re-check them one by one.
 */
function defineAdapter(Base: EthersAdapterClass) {
  return class ValuescanEthersAdapter extends Base {
    /**
     * DO NOT DRAG AN EXTENSION ONTO VALUECHAIN AT CONNECT TIME.
     *
     * `EthersAdapter.connect` compares the wallet's `eth_chainId` - a hex STRING -
     * with AppKit's active network id - a NUMBER - using `!==`, so it is always
     * "different", and it then sends `wallet_switchEthereumChain` to ValueChain.
     * A wallet that has never added ValueChain answers 4902, and the adapter
     * turns that into "Switch network failed" and FAILS THE CONNECTION. That is
     * every MetaMask on first use.
     *
     * The old flow asked for accounts and nothing else, and that is restored
     * here: the target chain passed down is the wallet's own current one, so no
     * switch is requested. When that chain is one AppKit knows (ValueChain) it
     * is passed as a number so AppKit records the network properly; the switch
     * it then sends is to the chain the wallet is already on, which wallets
     * answer silently. ValueChain is added/switched later, by the deposit flow,
     * at the moment it is actually needed.
     */
    override async connect(params: ConnectParams) {
      if (isExtensionType(params.type)) {
        const id = params.id.toLowerCase();
        /* A connection record left without a network (possible after a connect
           on an unlisted chain) makes the adapter's fast path throw "could not
           find the caipNetwork to connect"; forget it and connect normally. */
        const stale = this.connections.find((c) => c.connectorId.toLowerCase() === id && !c.caipNetwork);
        if (stale) this.deleteConnection(stale.connectorId);

        const provider = this.connectors.find((c) => c.id.toLowerCase() === id)?.provider as
          | Eip1193Provider
          | undefined;
        if (provider?.request) {
          let current: unknown;
          try {
            current = await provider.request({ method: 'eth_chainId' });
          } catch {
            current = undefined;
          }
          if (typeof current === 'string' || typeof current === 'number') {
            let listed = false;
            try {
              const n = normaliseChainId(current);
              listed = this.getCaipNetworks().some((net) => Number(net.id) === n);
              if (listed) return await super.connect({ ...params, chainId: n });
            } catch {
              /* unreadable id: fall through with the raw value */
            }
            return await super.connect({ ...params, chainId: current });
          }
        }
      }
      return super.connect(params);
    }

    /**
     * A RELOAD RECONNECTS SILENTLY.
     *
     * AppKit restores an extension connection with `eth_requestAccounts`, which
     * pops a locked MetaMask's unlock window the moment the page loads. Asking
     * with `eth_accounts` first never shows UI; if it finds nothing the wallet is
     * locked or has revoked this site, and the restore stops there - the app
     * keeps the address read-only and offers "Reconnect wallet".
     */
    override async syncConnection(params: SyncConnectionParams) {
      const connector = this.connectors.find((c) => c.id === params.id);
      if (connector?.provider && isExtensionType(connector.type)) {
        const found = await silentReconnect(connector.provider as Eip1193Provider);
        if (!found) throw new Error('The wallet has no unlocked account authorised for this site.');
      }
      return super.syncConnection(params);
    }

    /**
     * NO BALANCE LOOKUP.
     *
     * The stock implementation builds an ethers JsonRpcProvider on the network's
     * RPC URL. The page's CSP does not allow the ValueChain RPC, and ethers v6
     * answers a refused connection by retrying every second, forever, logging
     * each time. The balance only feeds AppKit's own account view, which this
     * app never opens - Money and Deposit read balances through the backend.
     */
    override async getBalance(): Promise<BalanceResult> {
      return { balance: '', symbol: '' };
    }

    /**
     * WALLETCONNECT'S ICON IN APPKIT'S OWN LIST.
     *
     * Basic mode skips AppKit's connector-image download, so the WalletConnect
     * entry of the "Connect Wallet" list drew an empty tile. It is given the
     * very image AppKit would have fetched (same explorer asset), as a URL on
     * the connector - the first thing AppKit's AssetUtil.getConnectorImage reads.
     * Set on the instance, not copied: the connector is a class with methods.
     */
    protected override addConnector(...connectors: ChainAdapterConnector[]): void {
      for (const c of connectors) {
        if (c.type === 'WALLET_CONNECT' && !c.imageUrl) {
          const url = connectorImageUrl(WALLETCONNECT_IMAGE_ID);
          if (url) c.imageUrl = url;
        }
      }
      super.addConnector(...connectors);
    }
  };
}

/* ---------------------------------------------------------------------------
 * THE APPKIT INSTANCE.
 * ------------------------------------------------------------------------ */

/**
 * The module imports, started EARLY and shared.
 *
 * AppKit is a large chunk, and a modal that appears a second after the click
 * reads as a broken button. So the code is fetched before anyone presses
 * Connect - see `preloadWalletModal()` for when.
 * Kept as promises rather than booleans: a click that lands mid-download waits on
 * the same import instead of starting a second one. Nothing here talks to a
 * third party - that starts only when AppKit is created (first Connect click, or
 * a reload with a connection to restore).
 */
let appkitModule: Promise<typeof import('@reown/appkit')> | null = null;
let adapterModule: Promise<typeof import('@reown/appkit-adapter-ethers')> | null = null;

function loadModules() {
  appkitModule ??= import('@reown/appkit');
  adapterModule ??= import('@reown/appkit-adapter-ethers');
  // A failed prefetch must not become an unhandled rejection, nor stick: the
  // real import at connect time will surface the error where it can be shown.
  appkitModule.catch(() => { appkitModule = null; });
  adapterModule.catch(() => { adapterModule = null; });
  return Promise.all([appkitModule, adapterModule]);
}

/**
 * WHEN the wallet code is fetched: the moment the header mounts. It is 1.8 MB
 * of script (0.55 MB on the wire), and starting it later (after the page's
 * first data) was measured: the data appeared up to a second sooner on a slow
 * connection, but the page became idle 0.6-2 s later, so a click in that window
 * waited. The owner's rule is that nothing gets worse for anyone, slow machines
 * and slow connections included - so it starts at once, as it always did.
 * `startLater` stays as the one place that would change if that is revisited.
 */
const WALLET_CODE_AFTER_MS = 2_000;
const WALLET_CODE_IDLE_WITHIN_MS = 1_000;
const walletCode = startLater(() => {
  void loadModules().catch(() => {});
  void loadChain();
}, WALLET_CODE_AFTER_MS, WALLET_CODE_IDLE_WITHIN_MS);

/** The header mounted: have the wallet modal's code in memory before anyone presses Connect. */
export function preloadWalletModal(): void {
  discoverWallets();
  if (!hasWalletConnectConfig()) return;
  walletCode.now();
}

/** The pointer or the focus reached a Connect control: fetch the wallet modal's code now. */
export function warmWalletModal(): void {
  if (!hasWalletConnectConfig()) return;
  walletCode.now();
}

/** Minimal shape of the UniversalProvider instance we depend on. */
type Universal = Eip1193Provider & {
  disconnect(): Promise<void>;
  session?: {
    /** What the wallet ACTUALLY granted, which is not what we asked for. */
    namespaces?: Record<string, { accounts?: string[]; methods?: string[] }>;
    /** The relay topic this session speaks on - what `ping` addresses. */
    topic?: string;
    /** The paired wallet's own metadata ("Trust Wallet", "SafePal", ...). */
    peer?: { metadata?: { name?: string; icons?: string[] } };
  } | undefined;
  /* The underlying sign-client. Optional because it is the SDK's shape, not
     ours: a version that renames it must degrade to "we cannot check". */
  client?: { ping?: (opts: { topic: string }) => Promise<void> };
};

let kitPromise: Promise<AppKit> | null = null;
let kit: AppKit | null = null;
let universal: Universal | null = null;

/*
 * HOT RELOAD (dev only): ONE APPKIT, HOWEVER OFTEN THIS FILE IS EDITED.
 *
 * Vite runs an edited module again as a FRESH copy, with an empty `kitPromise`,
 * while AppKit's controllers - module state inside @reown/appkit-controllers,
 * which is not reloaded - still hold the first instance. The next Connect then
 * called createAppKit a second time over them ("WalletConnect Core is already
 * initialized", every listener twice). So each copy hands its instance to the
 * next in `import.meta.hot.data`, and the next ADOPTS it (initWallet; the end of
 * this file does it at once, so the wallet state is live again straight after
 * the reload). It hands over its `letGo` too, and the next copy calls it before
 * adopting: what a copy attached - AppKit subscriptions, page listeners, the
 * modal hooks below - must not outlive it, and Vite never calls this module's
 * own `dispose` (it disposes only the module that ACCEPTS an update, and this
 * one is updated through the components that import it).
 * `import.meta.hot` does not exist in a production build.
 */
interface HotData {
  kit?: Promise<AppKit>;
  letGo?: () => void;
  telemetryGuarded?: boolean;
}
function hotData(): HotData | undefined {
  return import.meta.hot?.data as HotData | undefined;
}

/** Undone when this copy of the module is replaced by a hot reload (letGo). */
const detach: Array<() => void> = [];
/** Aborts every listener this copy added to the page or to AppKit's element. */
const attached = new AbortController();
detach.push(() => attached.abort());

/** Release everything this copy attached. Idempotent. */
function letGo(): void {
  for (const undo of detach.splice(0).reverse()) {
    try {
      undo();
    } catch {
      /* keep letting go */
    }
  }
}

/**
 * Create AppKit once, and resolve when its first sync (including the silent
 * restore of a previous connection) has finished.
 */
export function initWallet(): Promise<AppKit> {
  if (!kitPromise) {
    const hot = hotData();
    const inherited = hot?.kit;
    const p: Promise<AppKit> = (inherited ? inherited.then(adoptKit) : createKit()).catch((e: unknown) => {
      if (kitPromise === p) kitPromise = null;
      if (hot?.kit === p) delete hot.kit;
      throw e;
    });
    kitPromise = p;
    if (hot) hot.kit = p;
  }
  return kitPromise;
}

/**
 * A previous copy of this module created `k` (hot reload): use it, do not make
 * another - and put this copy's hooks on its modal, in case it is up right now.
 */
async function adoptKit(k: AppKit): Promise<AppKit> {
  kit = k;
  watchKit(k);
  const el = modalElement();
  if (el) hookModal(k, el);
  universal = ((await k.getUniversalProvider().catch(() => undefined)) ?? null) as Universal | null;
  registerPreflight();
  return k;
}

async function createKit(): Promise<AppKit> {
  if (!hasWalletConnectConfig()) {
    throw new WalletConnectError(
      'Wallet connection needs a WalletConnect project id. Create one free at https://dashboard.reown.com, set VITE_WALLETCONNECT_PROJECT_ID in apps/web/.env.local, then restart the dev server.',
    );
  }
  // Before the import: AppKit fires its INITIALIZE beacon during createAppKit.
  blockVendorTelemetry();
  discoverWallets();

  const [[{ createAppKit }, { EthersAdapter: Base }], chain] = await Promise.all([loadModules(), loadChain()]);
  const Adapter = defineAdapter(Base);
  const network = toNetwork(chain);

  /* `basic` is left out of the PUBLIC `createAppKit` type (it is how
     @walletconnect/ethereum-provider drives the same client), but createAppKit
     passes its options through untouched. See the note at the property. */
  type Options = Parameters<typeof createAppKit>[0] & { basic: boolean };
  const options: Options = {
    projectId: WC_PROJECT_ID,
    adapters: [new Adapter()],
    networks: [network],
    defaultNetwork: network,
    metadata: {
      name: 'ValueDesk',
      description: 'Copy trading on SoDEX',
      url: window.location.origin,
      // A real icon so the wallet's approval prompt can show WHICH dapp is
      // asking. An empty list renders a blank card, which is exactly the
      // ambiguity a phishing dapp benefits from.
      icons: [window.location.origin + '/favicon.svg'],
    },
    themeMode: 'dark',
    themeVariables: themeVariables(),

    /*
     * CONNECT-ONLY, DECIDED HERE AND NOT ON A DASHBOARD.
     *
     * Outside basic mode AppKit fetches the project's remote config and lets it
     * OVERRIDE `features` - email and social login, swaps and onramp switch on
     * from reown.com whatever this file says, and each of them calls Reown's
     * servers. Basic mode skips that fetch and turns every remote feature off,
     * and it also stops AppKit drawing its own "unsupported network" screen.
     * Extension wallets are unaffected: they are adapter connectors, not
     * remote features.
     */
    basic: true,
    features: {
      analytics: false,
      email: false,
      socials: false,
      emailShowWallets: false,
      onramp: false,
      swaps: false,
      send: false,
      receive: false,
      history: false,
      pay: false,
      smartSessions: false,
      reownAuthentication: false,
      legalCheckbox: false,
      /* Installed extensions first: on a desktop that is the one-click path.
         The QR option sits right under them. */
      connectorTypeOrder: ['injected', 'walletConnect', 'recent', 'featured', 'custom', 'external', 'recommended'],
    },

    /* The wallets AppKit's "Connect Wallet" list (Other Wallet) shows by name,
       in the owner's reference order. Without this the list is whatever the
       explorer ranks highest that day. Installed extensions still come first. */
    featuredWalletIds: LIST_FEATURED_IDS,

    enableEIP6963: true,
    enableInjected: true,
    enableWalletConnect: true,
    enableReconnect: true,
    /* The Coinbase and Base SDK connectors are separate downloads that talk to
       Coinbase's servers; the Coinbase Wallet EXTENSION still appears, through
       EIP-6963, like every other extension. */
    enableCoinbase: false,
    enableBaseAccount: false,
    enableAuthLogger: false,
    /* See toNetwork(): any chain is acceptable at connect time. */
    allowUnsupportedChain: true,
    enableNetworkSwitch: false,
    defaultAccountTypes: { eip155: 'eoa' },

    /*
     * WHAT A WALLETCONNECT SESSION MAY DO. The target chain is OPTIONAL (AppKit
     * always sends `optionalNamespaces`): ValueChain is a custom network, and
     * requiring it makes wallets that do not know it refuse the whole session.
     */
    universalProviderConfigOverride: {
      methods: { eip155: [...WC_METHODS] },
      events: { eip155: [...WC_EVENTS] },
      chains: { eip155: [`eip155:${chain.chainId}`] },
      /* Every chain the app asks a wallet to be on gets an RPC the page's CSP
         allows: ValueChain, and the EVM chains a first deposit comes from
         (trading/onboard.ts). Without an entry the universal provider falls
         back to rpc.walletconnect.org, which the CSP blocks - so reading USDC
         through a phone wallet after switching to Arbitrum failed. */
      rpcMap: {
        [`eip155:${chain.chainId}`]: chain.rpcUrl,
        ...Object.fromEntries(Object.values(EVM_CHAINS).map((c) => [`eip155:${c.chainId}`, c.rpcUrl])),
      },
    },
  };
  const k = createAppKit(options);

  /*
   * NO IDENTITY LOOKUP. On every connect AppKit asks rpc.walletconnect.org for
   * the address's ENS name and avatar: the address goes to a third party, the
   * host is outside the CSP (so it logs a violation), and the result only
   * decorates AppKit's account view, which this app does not use. Replaced on
   * the instance before any of AppKit's async init can reach it - the
   * constructor only starts that work, it cannot have got this far yet.
   */
  (k as unknown as { syncIdentity: () => Promise<void> }).syncIdentity = async () => {};

  kit = k;
  watchKit(k);

  /* ready() covers the adapter's connector discovery and the silent restore.
     Bounded: a slow network must not leave the Connect button hanging. */
  await Promise.race([k.ready(), new Promise((r) => setTimeout(r, 6_000))]);

  universal = ((await k.getUniversalProvider().catch(() => undefined)) ?? null) as Universal | null;
  registerPreflight();
  replayAnnouncements();
  return k;
}

/**
 * Hand AppKit every wallet that announced BEFORE it was listening.
 *
 * AppKit is created lazily, and EIP-6963 only guarantees a re-announce to wallets
 * that answer `requestProvider` - most do, but a wallet that announced once at
 * page load and not again would be missing from the modal. wallet.ts has been
 * listening since the header mounted; its snapshot is replayed here. AppKit
 * de-duplicates by name, so a wallet it already heard is not listed twice.
 */
function replayAnnouncements(): void {
  for (const w of getDiscoveredWallets()) {
    if (w.uuid === 'legacy') continue; // window.ethereum: AppKit has its own connector for it
    const { provider, ...info } = w;
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }),
    );
  }
}

/* ---------------------------------------------------------------------------
 * THE STATE THE APP SEES.
 * ------------------------------------------------------------------------ */

export interface WalletSnapshot {
  /** `connecting` covers AppKit's own reconnecting state on load. */
  status: 'idle' | 'connecting' | 'connected' | 'disconnected';
  provider: Eip1193Provider | null;
  address: string | null;
  chainId: number | null;
  /** "MetaMask", "Rabby Wallet", or the phone wallet's name over WalletConnect. */
  walletName: string;
  walletIcon: string;
  kind: 'extension' | 'walletconnect' | null;
}

const EMPTY: WalletSnapshot = {
  status: 'idle', provider: null, address: null, chainId: null, walletName: '', walletIcon: '', kind: null,
};

let snap: WalletSnapshot = EMPTY;
const subscribers = new Set<() => void>();

export function getWalletSnapshot(): WalletSnapshot {
  return snap;
}

/** For `useSyncExternalStore`: notified on every change, read with getWalletSnapshot. */
export function subscribeWallet(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

function setSnap(next: WalletSnapshot): void {
  const same = (Object.keys(next) as (keyof WalletSnapshot)[]).every((k) => next[k] === snap[k]);
  if (same) return;
  snap = next;
  for (const cb of subscribers) {
    try {
      cb();
    } catch {
      /* one bad subscriber must not stop the others */
    }
  }
}

/** Notified when the WALLET or relay ends the session, so the UI can reset. */
const teardownHandlers = new Set<() => void>();
export function onWalletConnectClosed(cb: () => void): () => void {
  teardownHandlers.add(cb);
  return () => teardownHandlers.delete(cb);
}

/** Notified when a connection the user asked for (not a silent restore) lands. */
const connectedHandlers = new Set<(s: WalletSnapshot) => void>();
export function onWalletConnected(cb: (s: WalletSnapshot) => void): () => void {
  connectedHandlers.add(cb);
  return () => connectedHandlers.delete(cb);
}

let userDisconnecting = false;
let connectRequested = false;
let chainWatch: { provider: Eip1193Provider; off: () => void } | null = null;
let teardownTimer: ReturnType<typeof setTimeout> | undefined;
let syncSeq = 0;

function watchKit(k: AppKit): void {
  const refresh = () => { void syncFromKit(k); };
  detach.push(
    k.subscribeAccount(refresh, 'eip155'),
    k.subscribeProviders(refresh),
    k.subscribeWalletInfo(refresh, 'eip155'),
  );
  refresh();
}

function watchChain(provider: Eip1193Provider): void {
  if (chainWatch?.provider === provider) return;
  chainWatch?.off();
  const onChain = (raw: unknown) => {
    try {
      const chainId = normaliseChainId(raw);
      if (snap.provider === provider) setSnap({ ...snap, chainId });
    } catch {
      /* an unreadable id changes nothing */
    }
  };
  provider.on?.('chainChanged', onChain);
  chainWatch = { provider, off: () => provider.removeListener?.('chainChanged', onChain) };
}

/**
 * Fold AppKit's account, provider and wallet-info state into one snapshot.
 *
 * The chain id is read from the PROVIDER, not from AppKit's network state: AppKit
 * reports an unlisted chain as "Unknown Network", and it is the provider's answer
 * that travels into the EIP-712 domain the user signs.
 */
async function syncFromKit(k: AppKit): Promise<void> {
  const seq = ++syncSeq;
  const acc = k.getAccount('eip155');
  const provider = (k.getWalletProvider() ?? null) as Eip1193Provider | null;
  const address = acc?.address ?? null;

  if (!acc?.isConnected || !address || !provider?.request) {
    const wasConnected = snap.status === 'connected';
    const pending = acc?.status === 'connecting' || acc?.status === 'reconnecting';
    if (pending && wasConnected) return; // mid-switch: keep what we have until it settles
    chainWatch?.off();
    chainWatch = null;
    setSnap({ ...EMPTY, status: pending ? 'connecting' : 'disconnected' });
    if (wasConnected && !pending) scheduleTeardown();
    return;
  }

  clearTimeout(teardownTimer);
  let chainId = snap.provider === provider ? snap.chainId : null;
  if (chainId === null) {
    try {
      chainId = normaliseChainId(await provider.request({ method: 'eth_chainId' }));
    } catch {
      chainId = null;
    }
    if (seq !== syncSeq) return; // a newer state arrived while we waited
  }
  watchChain(provider);

  const type = k.getWalletProviderType();
  const info = k.getWalletInfo('eip155');
  const kind = type === 'WALLET_CONNECT' ? 'walletconnect' : 'extension';
  const wasConnected = snap.status === 'connected';
  // A phone paired over WalletConnect names itself in the session even when
  // AppKit's own record of the pick is empty (a QR scanned from any wallet).
  const peer = kind === 'walletconnect' ? universal?.session?.peer?.metadata : undefined;
  setSnap({
    status: 'connected',
    provider,
    address,
    chainId,
    walletName: info?.name || peer?.name?.trim() || (kind === 'walletconnect' ? 'WalletConnect' : 'Browser wallet'),
    walletIcon: typeof info?.icon === 'string' && info.icon ? info.icon : peer?.icons?.find((u) => u.startsWith('data:image/')) ?? '', // other hosts are outside img-src
    kind,
  });
  if (!wasConnected && connectRequested) {
    connectRequested = false;
    for (const cb of connectedHandlers) {
      try {
        cb(snap);
      } catch {
        /* keep going */
      }
    }
  }
}

/**
 * The session ended and WE did not end it: the wallet disconnected this site,
 * the relay expired the session, or the extension's account list went empty.
 *
 * Debounced, because AppKit passes through "disconnected" for a moment when it
 * swaps one wallet for another; only a disconnect that is still true a beat later
 * is the wallet's doing.
 */
function scheduleTeardown(): void {
  if (userDisconnecting) return;
  clearTimeout(teardownTimer);
  teardownTimer = setTimeout(() => {
    if (userDisconnecting || snap.status === 'connected') return;
    for (const cb of teardownHandlers) {
      try {
        cb();
      } catch {
        /* one bad listener must not stop the others */
      }
    }
  }, 600);
}

/* ---------------------------------------------------------------------------
 * ACTIONS.
 * ------------------------------------------------------------------------ */

/*
 * There is deliberately NO "open the AppKit modal" export here any more. AppKit
 * is opened only by `connectVia` below, on behalf of a row in our Connect
 * dialog - never straight from a button. Its result still arrives through
 * `subscribeWallet`: AppKit closes the modal itself when a wallet connects.
 */

/**
 * A modal closed WITHOUT a wallet is a cancelled connect: stop treating the next
 * connection as one the user just asked for (it would otherwise toast "Wallet
 * connected" for some later restore). Checked a beat after close, because AppKit
 * closes its modal a moment BEFORE the account state that says "connected" has
 * been folded into our snapshot (syncFromKit awaits the chain id).
 */
let disarmWatch: (() => void) | null = null;
function disarmOnCancel(k: AppKit): void {
  disarmWatch?.();
  let unsub: (() => void) | null = null;
  disarmWatch = () => {
    unsub?.();
    unsub = null;
    disarmWatch = null;
  };
  // Only an open -> closed TRANSITION counts; a first callback that still
  // reports the pre-open state must not disarm a connect that is under way.
  let wasOpen = k.isOpen();
  unsub = k.subscribeState((s) => {
    if (s.open) { wasOpen = true; return; }
    if (!wasOpen) return;
    disarmWatch?.();
    setTimeout(() => {
      if (snap.status !== 'connected') connectRequested = false;
    }, 2_000);
  });
}

/* ---------------------------------------------------------------------------
 * THE CONNECT DIALOG'S ROUTES.
 *
 * AppKit never opens by itself any more. Every Connect button in the app opens
 * OUR dialog first (components/account/ConnectDialog.tsx, via connect.ts:
 * openConnectDialog), and the row pressed there decides which part of AppKit,
 * if any, the user sees next. That decision, and every AppKit call it needs,
 * lives here, so the dialog knows nothing about AppKit's internals.
 *
 *   row              desktop +        desktop, no       phone
 *                    extension        extension
 *   ---------------  ---------------  ----------------  -----------------------------
 *   SafePal, Bitget, the extension's  AppKit's          the wallet APP, by deep link
 *   MetaMask         own prompt; no   WalletConnect QR  (AppKit's wallet-specific
 *                    AppKit UI        view (8.png)      connecting view). Inside that
 *                                                       wallet's own in-app browser
 *                                                       its injected provider is
 *                                                       used instead, like an extension
 *   WalletConnect    the QR view (8.png)                AppKit's wallet list
 *                                                       ('AllWallets', searchable)
 *   Other Wallet     AppKit's 'Connect' list (9.png), on every device
 *
 * WALLETCONNECT ON A PHONE opens the wallet list, not a QR: a phone cannot scan
 * a code it is itself displaying, and a WalletConnect pairing on a phone always
 * needs an app to be handed to. It is what AppKit's own WalletConnect row does
 * on mobile (w3m-connector-list pushes 'AllWallets'), so the row behaves exactly
 * as AppKit would have.
 * ------------------------------------------------------------------------ */

export type FeaturedWalletKey = 'safepal' | 'bitget' | 'metamask';
export type ConnectChoice = FeaturedWalletKey | 'walletconnect' | 'other';
/**
 * extension  a browser-extension / in-app-browser prompt, no AppKit UI;
 * qr         AppKit's WalletConnect QR view;
 * deeplink   AppKit's wallet-specific view, which hands off to the wallet app;
 * wallets    AppKit's full wallet list ('AllWallets');
 * list       AppKit's 'Connect' list.
 */
export type ConnectRoute = 'extension' | 'qr' | 'deeplink' | 'wallets' | 'list';

type InjectedFlags = Record<string, unknown>;

export interface FeaturedWallet {
  key: FeaturedWalletKey;
  /** The label on our row (the owner's reference, 7.png). */
  label: string;
  /** WalletGuide's name for it - what AppKit's own header shows. */
  name: string;
  /** WalletGuide (Reown explorer) id, the key AppKit files wallets under. */
  explorerId: string;
  /** Explorer image id: the same icon AppKit draws for this wallet. */
  imageId: string;
  /** The app's WalletConnect deep-link scheme, as the explorer lists it. */
  mobileLink: string;
  /** EIP-6963 reverse-DNS ids the extension (or in-app browser) announces. */
  rdns: readonly string[];
  /** Fallback for an announcement whose rdns we have not seen. */
  announcedName: RegExp;
  /** Pre-EIP-6963 flag on `window.ethereum` (old extensions, in-app browsers). */
  legacy: (eth: InjectedFlags) => boolean;
}

/**
 * Wallets that ALSO set `isMetaMask` on window.ethereum, so that dapps written
 * for MetaMask only would still offer them. None of them is MetaMask.
 */
const METAMASK_IMPOSTORS = [
  'isBraveWallet', 'isRabby', 'isOkxWallet', 'isOKExWallet', 'isBitKeep', 'isBitgetWallet',
  'isSafePal', 'isTrust', 'isTrustWallet', 'isCoinbaseWallet', 'isPhantom', 'isTokenPocket',
  'isZerion', 'isFrame', 'isRainbow', 'isExodus', 'isOneInchIOSWallet',
] as const;

/**
 * The three wallets with a row of their own.
 *
 * Ids, image ids and deep-link schemes are the Reown explorer's records
 * (api.web3modal.org/getWallets, read with this app's project id); MetaMask's
 * and Bitget's ids are also the ones AppKit itself hardcodes
 * (appkit-common PresetsUtil.ConnectorExplorerIds). The explorer lists no rdns
 * for SafePal; `com.safepal` is what its extension announces.
 */
export const FEATURED_WALLETS: readonly FeaturedWallet[] = [
  {
    key: 'safepal',
    label: 'SafePal',
    name: 'SafePal',
    explorerId: '0b415a746fb9ee99cce155c2ceca0c6f6061b1dbca2d722b3ba16381d0562150',
    imageId: '252753e7-b783-4e03-7f77-d39864530900',
    mobileLink: 'safepalwallet://',
    rdns: ['com.safepal'],
    announcedName: /safepal/i,
    legacy: (eth) => eth.isSafePal === true,
  },
  {
    key: 'bitget',
    label: 'Bitget',
    name: 'Bitget Wallet',
    explorerId: '38f5d18bd8522c244bdd70cb4a68e0e718865155811c043f052fb9f1c51de662',
    imageId: '2b569b7f-e6c6-4faa-8e5a-ecd4dec8cf00',
    mobileLink: 'bitkeep://',
    rdns: ['com.bitget.web3'],
    announcedName: /bitget|bitkeep/i,
    legacy: (eth) => eth.isBitKeep === true || eth.isBitgetWallet === true,
  },
  {
    key: 'metamask',
    label: 'MetaMask',
    name: 'MetaMask',
    explorerId: 'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96',
    imageId: 'eebe4a7f-7166-402f-92e0-1f64ca2aa800',
    mobileLink: 'metamask://',
    // The extension, and MetaMask Mobile's in-app browser.
    rdns: ['io.metamask', 'io.metamask.mobile'],
    announcedName: /^metamask$/i,
    legacy: (eth) => eth.isMetaMask === true && !METAMASK_IMPOSTORS.some((f) => eth[f] === true),
  },
];

/** AppKit's own WalletConnect connector image (PresetsUtil.ConnectorImageIds). */
export const WALLETCONNECT_IMAGE_ID = 'ef1a1fcf-7fe8-4d69-bd6d-fda1345b4400';

/** OKX Wallet's explorer id: in AppKit's list (9.png), not a row of ours. */
const OKX_EXPLORER_ID = '971e689d0a5be527bac79629b4ee9b925e82208e5168b733496a09c0faed0709';

/** AppKit's "Connect Wallet" list order: MetaMask, OKX Wallet, SafePal, Bitget Wallet. */
const LIST_FEATURED_IDS: string[] = [
  'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96', // MetaMask
  OKX_EXPLORER_ID,
  '0b415a746fb9ee99cce155c2ceca0c6f6061b1dbca2d722b3ba16381d0562150', // SafePal
  '38f5d18bd8522c244bdd70cb4a68e0e718865155811c043f052fb9f1c51de662', // Bitget Wallet
];

const featured = (key: FeaturedWalletKey): FeaturedWallet =>
  FEATURED_WALLETS.find((w) => w.key === key) ?? FEATURED_WALLETS[0]!;

/* --- icons ------------------------------------------------------------- */

/**
 * The image host AppKit draws its wallet icons from. It answers 403 without a
 * project id, so with none configured there is no URL and the dialog falls back
 * to a monogram. `st`/`sv` are the SDK-type/version pair AppKit sends with every
 * call; the version is read from the installed AppKit, so it follows an upgrade
 * without an edit here.
 */
const REOWN_API = 'https://api.web3modal.org';
const APPKIT_SDK_VERSION = `html-ethers-${APPKIT_VERSION}`;

function reownImage(path: string): string | null {
  if (!hasWalletConnectConfig()) return null;
  const q = new URLSearchParams({ projectId: WC_PROJECT_ID, st: 'appkit', sv: APPKIT_SDK_VERSION });
  return `${REOWN_API}/${path}?${q.toString()}`;
}

/** A wallet's icon, exactly as AppKit's own list shows it. */
export const walletImageUrl = (imageId: string): string | null =>
  reownImage(`getWalletImage/${encodeURIComponent(imageId)}`);

/** A connector's icon (WalletConnect's), as AppKit shows it. */
export const connectorImageUrl = (imageId: string): string | null =>
  reownImage(`public/getAssetImage/${encodeURIComponent(imageId)}`);

/* --- where are we ------------------------------------------------------ */

/**
 * "Phone", decided EXACTLY the way AppKit decides it (appkit-controllers
 * CoreHelperUtil.isMobile). It has to be the same test, not a better one: AppKit
 * picks QR versus deep link inside its views with its own copy, and a route
 * chosen here on a different answer would open a view that then does the other
 * thing.
 */
export function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer:coarse)').matches;
  return coarse || /Android|webOS|iPhone|iPad|iPod|BlackBerry|Opera Mini/u.test(navigator.userAgent);
}

/** How a featured wallet is present in this browser, if it is. */
export type InstalledWallet =
  | { via: 'announced'; rdns: string; name: string; icon: string }
  | { via: 'injected' };

/**
 * Is this wallet's extension here (or are we inside its in-app browser)?
 *
 * EIP-6963 first - an announcement is the wallet naming itself. `window.ethereum`
 * flags only as a fallback, for wallets or in-app browsers that inject without
 * announcing, and only on `window.ethereum` itself, because that is the single
 * provider AppKit's `injected` connector can reach.
 */
export function findInstalled(
  w: FeaturedWallet,
  discovered: readonly WalletInfo[] = getDiscoveredWallets(),
): InstalledWallet | null {
  const announced = discovered.filter((d) => d.uuid !== 'legacy');
  const hit =
    announced.find((d) => w.rdns.includes(String(d.rdns ?? '').toLowerCase())) ??
    announced.find((d) => w.announcedName.test(String(d.name ?? '')));
  if (hit) return { via: 'announced', rdns: hit.rdns, name: hit.name, icon: hit.icon };
  const eth = typeof window !== 'undefined' ? (window as unknown as { ethereum?: unknown }).ethereum : undefined;
  if (eth && typeof eth === 'object' && w.legacy(eth as InjectedFlags)) return { via: 'injected' };
  return null;
}

/** Where a row goes on this device, right now. Pure: it opens nothing. */
export function routeFor(choice: ConnectChoice, discovered?: readonly WalletInfo[]): ConnectRoute {
  if (choice === 'other') return 'list';
  const mobile = isMobileDevice();
  if (choice === 'walletconnect') return mobile ? 'wallets' : 'qr';
  if (findInstalled(featured(choice), discovered)) return 'extension';
  return mobile ? 'deeplink' : 'qr';
}

/* --- going there ------------------------------------------------------- */

/** A connect the user refused (or closed) in the extension. Not a fault. */
export class ConnectRejectedError extends WalletConnectError {}

type KitConnector = ReturnType<AppKit['getConnectors']>[number];
type KitWalletItem = Parameters<AppKit['connectWallet']>[0];

function kitConnectorFor(k: AppKit, found: InstalledWallet): KitConnector | undefined {
  const list = k.getConnectors('eip155');
  if (found.via === 'injected') return list.find((c) => c.id === 'injected');
  const rdns = found.rdns.toLowerCase();
  return (
    list.find((c) => String(c.info?.rdns ?? c.id).toLowerCase() === rdns) ??
    list.find((c) => c.name === found.name)
  );
}

/**
 * Connect an extension (or an in-app browser's injected provider) DIRECTLY:
 * AppKit's public headless `connectWallet`, which for an injected wallet with a
 * connector goes straight to that connector - the wallet's own prompt appears
 * and no AppKit view is drawn. The connect runs through our adapter
 * (defineAdapter above), so it keeps every rule written there.
 *
 * Resolves once the wallet is connected. Rejects with ConnectRejectedError when
 * the user refuses or closes the prompt - AppKit reports every such failure as
 * the same "Connection rejected", so that is all that can be said about it.
 */
async function connectExtension(k: AppKit, w: FeaturedWallet, c: KitConnector): Promise<void> {
  const item: KitWalletItem = {
    id: c.id,
    name: c.name || w.name,
    imageUrl: c.imageUrl ?? '',
    imageId: c.imageId,
    connectors: [{ id: c.id, chain: 'eip155' }],
    walletInfo: {},
    isInjected: true,
    isRecent: false,
  };
  connectRequested = true;
  let off: (() => void) | undefined;
  try {
    await Promise.race([
      k.connectWallet(item, 'eip155'),
      /* AppKit's promise waits for its OWN address to change. Our snapshot
         saying "connected" is the same fact, and it is the one the app acts on. */
      new Promise<void>((resolve) => {
        off = subscribeWallet(() => { if (snap.status === 'connected') resolve(); });
      }),
    ]);
  } catch {
    connectRequested = false;
    throw new ConnectRejectedError(
      `${w.label} did not connect: the request was rejected or closed in the wallet.`,
    );
  } finally {
    off?.();
    k.resetConnectingWallet();
  }
}

/** The explorer record AppKit's wallet-specific views read (a WcWallet). */
type WcWalletData = {
  id: string;
  name: string;
  image_id?: string;
  image_url?: string;
  mobile_link?: string | null;
  link_mode?: string | null;
};

/**
 * Deliberately WITHOUT `rdns`/`injected`: given those, AppKit's view adds an
 * "unsupported browser" tab next to the mobile hand-off on a phone without the
 * extension - noise, since the injected case never reaches this view.
 */
function toWcWallet(w: FeaturedWallet): WcWalletData {
  return {
    id: w.explorerId,
    name: w.name,
    image_id: w.imageId,
    image_url: walletImageUrl(w.imageId) ?? undefined,
    mobile_link: w.mobileLink,
    link_mode: null,
  };
}

/**
 * THE ONE AppKit CALL THAT STEPS PAST ITS TYPES, isolated here.
 *
 * `appKit.open()` is typed to a subset of views and takes no `data`, but it
 * hands its options unchanged to ModalController.open, which does
 * `RouterController.reset(options.view, options.data)` (1.8.23 and 1.8.24).
 * 'ConnectingWalletConnect' is the view AppKit itself pushes when its
 * WalletConnect row is pressed: with no wallet it is the plain QR (8.png: title
 * "WalletConnect", no back button when it is the first view); with a wallet it
 * is that wallet's connecting view, which on a phone deep-links into the app.
 *
 * FALLBACK, should a later AppKit refuse it: the typed views that come closest
 * - 'ConnectingWalletConnectBasic' (the same QR, plus an "all wallets" button)
 * on a desktop, the wallet list on a phone.
 */
async function openWalletConnectView(k: AppKit, wallet?: WcWalletData): Promise<void> {
  type LooseOpen = (o: { view: 'ConnectingWalletConnect'; data?: { wallet: WcWalletData } }) => Promise<unknown>;
  try {
    await (k.open as unknown as LooseOpen).call(k, wallet ? { view: 'ConnectingWalletConnect', data: { wallet } } : { view: 'ConnectingWalletConnect' });
  } catch {
    await k.open({ view: isMobileDevice() ? 'AllWallets' : 'ConnectingWalletConnectBasic' });
  }
}

/**
 * APPKIT'S FIRST "Connect Wallet" LIST OF A PAGE LOAD COMES UP HALF EMPTY.
 *
 * In basic mode AppKit starts downloading the named wallets (featured, then
 * recommended) as the modal opens and does not wait for them, and its list
 * element draws once and is not subscribed to that data - so the first open
 * showed only "WalletConnect" and "Search Wallet", and the reference list (9.png)
 * appeared only from the second open on.
 *
 * The data is watched through the public headless `getWalletList()` (the very
 * list the view draws, ConnectorUtil.connectorList); each time it grows, the
 * list element is asked to draw again with `requestUpdate()`, Lit's public
 * re-render call. The element is reached through the modal's OPEN shadow roots.
 * That lookup is the one private detail here: if AppKit renames the element,
 * nothing is found and the list simply stays as AppKit drew it. Stops when the
 * modal closes or after a few seconds.
 */
function redrawListAsItLoads(k: AppKit): void {
  const size = (): number => {
    try {
      return k.getWalletList().wallets.length;
    } catch {
      return -1;
    }
  };
  let last = size();
  const started = Date.now();
  const timer = window.setInterval(() => {
    if (!k.isOpen() || Date.now() - started > 6_000) {
      window.clearInterval(timer);
      return;
    }
    const now = size();
    if (now === last) return;
    last = now;
    for (const el of findInShadow(document.querySelector('w3m-modal'), 'w3m-connector-list')) {
      (el as Element & { requestUpdate?: () => void }).requestUpdate?.();
    }
  }, 120);
}

/* ---------------------------------------------------------------------------
 * APPKIT IN FRONT OF OUR DIALOG: ONE BACKDROP, A REAL EXIT, AND THE KEYS.
 *
 * Our Connect dialog keeps its scrim up for the whole session; only its CARD
 * steps aside for AppKit and comes back (ConnectDialog.tsx). AppKit, for its
 * part:
 *  - draws no backdrop of its own while it is in front of that scrim
 *    (shareBackdrop);
 *  - LEAVES the way it came in - fading, with its content as it was - instead
 *    of cutting its card away on the first frame (leaveModal, holdCardOnClose),
 *    and our dialog hears about it on that first frame, so our card comes back
 *    while AppKit's fades (onWalletModalClosed);
 *  - keeps the keys pressed in it to itself, and takes Esc from the page only to
 *    leave that same way (keepKeysInModal).
 * What leans on AppKit's internals is named at the site, and each piece does
 * nothing if what it looks for has gone: AppKit then behaves as AppKit does,
 * over our continuous scrim.
 * ------------------------------------------------------------------------ */

/** AppKit's modal element, and the members of it (1.8.24, W3mModalBase) used here. */
type ModalElement = HTMLElement & {
  onOpen?: () => void;
  onClose?: () => void;
  onScrollUnlock?: () => void;
  onRemoveKeyboardListener?: () => void;
};

const modalElement = (): ModalElement | null =>
  typeof document === 'undefined' ? null : document.querySelector<ModalElement>('w3m-modal');

/**
 * ONE BACKDROP FOR THE WHOLE CONNECT SESSION.
 *
 * AppKit's overlay (rgba(0,0,0,.5) and an 8px blur, on the <w3m-modal> host
 * itself) used to take over from our scrim: ours faded out as AppKit's faded
 * in, which dipped the blur and then darkened the page past our --scrim; and on
 * the way back AppKit's had faded out before ours came back - no blur at all,
 * for a moment. Now our scrim never leaves, and AppKit's is switched off by the
 * attribute account.css keys on. AppKit's theme API has no variable for it (the
 * ThemeVariables type lists every one it reads, and the blur is hard-coded),
 * but a page rule on a shadow HOST beats the component's own `:host` rules, so
 * nothing has to reach into its shadow root.
 *
 * Set for every view connectVia opens - it is the only opener, and our dialog is
 * always behind it - and cleared once AppKit has gone. FALLBACK: should a later
 * AppKit move its overlay off the host, the rule matches nothing and that
 * overlay just adds to ours while AppKit is open - darker, never missing.
 */
function shareBackdrop(el: ModalElement | null, shared: boolean): void {
  el?.toggleAttribute('data-shared-backdrop', shared);
}

/** The longest transition on `el` (duration + delay), in ms, as computed now. */
function longestTransitionMs(el: Element): number {
  const cs = getComputedStyle(el);
  const ms = (v: string): number => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? (/ms\s*$/.test(v) ? n : n * 1000) : 0;
  };
  const durations = cs.transitionDuration.split(',').map(ms);
  const delays = cs.transitionDelay.split(',').map(ms);
  return Math.max(0, ...durations.map((d, i) => d + (delays[i] ?? delays[0] ?? 0)));
}

/**
 * Run `done` once `el` has faded: on its `opacity` transitionend or, should that
 * never come (no transition to run), a beat after the longest transition it
 * declares. Returns a cancel.
 *
 * That beat is wall-clock time, and a fade is not: in a busy or background tab
 * frames come late or not at all, and ending "on time" there un-rendered a
 * card still at 98% and gave AppKit its overlay back while it was still up -
 * the page darkened twice. So the beat only LOOKS: a fade still running on a
 * visible element is waited for, however slowly its frames come; only one that
 * never started, or has nothing left to show, ends there.
 *
 * AppKit's host fades over --apkt-durations-lg (200ms). Under
 * prefers-reduced-motion the backstop at the end of styles.css - a PAGE rule,
 * so it reaches the host - makes that 0.01ms, and this runs a frame later.
 */
function afterFade(el: HTMLElement, done: () => void): () => void {
  let timer = 0;
  const onEnd = (e: TransitionEvent): void => {
    if (e.target === el && e.propertyName === 'opacity') finish();
  };
  const stop = (): void => {
    el.removeEventListener('transitionend', onEnd);
    window.clearTimeout(timer);
  };
  const finish = (): void => {
    stop();
    done();
  };
  const look = (): void => {
    const fading =
      typeof el.getAnimations === 'function' && el.getAnimations().some((a) => a.playState === 'running');
    if (fading && parseFloat(getComputedStyle(el).opacity) > 0.01) timer = window.setTimeout(look, 100);
    else finish();
  };
  el.addEventListener('transitionend', onEnd);
  timer = window.setTimeout(look, longestTransitionMs(el) + 60);
  return stop;
}

/** An exit leaveModal started that has not finished yet. */
let leaving: Promise<void> | null = null;
/** Told at the first frame of an exit the USER asked for (see onWalletModalClosed). */
const leaveListeners = new Set<() => void>();

/** AppKit is open, in front, and not already on its way out. */
function modalInFront(k: AppKit, el: ModalElement | null = modalElement()): boolean {
  return k.isOpen() && !leaving && !!el?.classList.contains('open');
}

/**
 * The user's ways out of AppKit by pointer: its header's close button, or a
 * press on the overlay around its card - both carry AppKit's own `data-testid`
 * (1.8.24). The overlay counts only when the press landed on it and not inside
 * the card, the same test w3m-modal's `onOverlayClick` makes.
 */
function isCloseGesture(el: ModalElement, e: Event): boolean {
  const path = e.composedPath();
  if (path.some((n) => n instanceof Element && n.getAttribute('data-testid') === 'w3m-header-close')) return true;
  const own = path.find((n): n is Element => n instanceof Element && n.getRootNode() === el.shadowRoot);
  return own?.getAttribute('data-testid') === 'w3m-modal-overlay';
}

/**
 * THE USER CLOSED APPKIT: FADE IT OUT FIRST, THEN CLOSE IT.
 *
 * AppKit's own close is a cut. ModalController.close() makes w3m-modal drop its
 * `open` class AND stop rendering the card in the same tick, so the card
 * vanished on the first frame while only the (now invisible) overlay faded. It
 * also resets what the card shows as it goes (the view back to 'Connect', the
 * QR's URI cleared), so merely keeping the card through the fade would show it
 * changing.
 *
 * So a close the user asks for is caught before AppKit sees it
 * (catchCloseGestures, keepKeysInModal) and run in the other order: the host
 * drops `open` - AppKit's own entrance transition, run backwards, over the card
 * exactly as it was - our dialog is told on this same frame and brings its card
 * back during the fade, and AppKit is closed for real once the fade has run, on
 * a card nobody can see. The host stops taking the pointer and the keys at once:
 * from the first frame, the page is our dialog's again.
 */
function leaveModal(k: AppKit, el: ModalElement): void {
  if (leaving) return;
  let settle!: () => void;
  leaving = new Promise<void>((resolve) => {
    settle = () => resolve();
  });
  el.style.pointerEvents = 'none';
  if (typeof el.onRemoveKeyboardListener === 'function') el.onRemoveKeyboardListener();
  el.classList.remove('open');
  for (const tell of [...leaveListeners]) tell();
  afterFade(el, () => {
    void (async () => {
      try {
        if (k.isOpen()) await k.close();
      } catch {
        /* it is closing anyway */
      }
      el.style.pointerEvents = '';
      shareBackdrop(el, false);
      /* AppKit hears about its own close a microtask later; let that land
         before anything opens it again (connectVia waits on `leaving`). */
      await new Promise((r) => window.setTimeout(r, 0));
      leaving = null;
      settle();
    })();
  });
}

/**
 * APPKIT CLOSED ITSELF (a wallet connected; closeWalletModal): KEEP ITS CARD
 * DRAWN WHILE IT FADES.
 *
 * Such a close cannot be caught before it happens, so the element's close is
 * split instead. Everything w3m-modal's `onClose` does happens at once - the host
 * drops `open` and starts its fade, the page gets its scroll, pointer and keys
 * back - EXCEPT un-rendering the card, which waits for the fade to have run.
 * (AppKit does all of it in one tick: the card is a cut.) Its state has already
 * moved on, so the content may play AppKit's own page-out animation while it
 * fades; nothing jumps. A re-open during the fade finishes the held close
 * first, then opens exactly as AppKit would.
 *
 * Instance members of w3m-modal (1.8.24): onOpen, onClose, onScrollUnlock,
 * onRemoveKeyboardListener. If any is missing, nothing is patched and AppKit
 * closes the way it always did.
 */
function holdCardOnClose(el: ModalElement): void {
  if (Object.prototype.hasOwnProperty.call(el, 'onClose')) return; /* held already */
  const { onOpen, onClose, onScrollUnlock, onRemoveKeyboardListener } = el;
  if (
    typeof onOpen !== 'function' ||
    typeof onClose !== 'function' ||
    typeof onScrollUnlock !== 'function' ||
    typeof onRemoveKeyboardListener !== 'function'
  ) {
    return;
  }
  let held: (() => void) | null = null;
  const closeNow = (): void => {
    onClose.call(el);
    shareBackdrop(el, false);
  };
  el.onClose = () => {
    held?.();
    held = null;
    /* Already invisible - leaveModal faded it before closing it: nothing to hold. */
    if (parseFloat(getComputedStyle(el).opacity) < 0.01) {
      closeNow();
      return;
    }
    el.classList.remove('open');
    onScrollUnlock.call(el);
    onRemoveKeyboardListener.call(el);
    held = afterFade(el, () => {
      held = null;
      closeNow();
    });
  };
  el.onOpen = () => {
    if (held) {
      held();
      held = null;
      onClose.call(el);
    }
    onOpen.call(el);
  };
  detach.push(() => {
    if (held) {
      held();
      held = null;
      closeNow();
    }
    delete el.onClose;
    delete el.onOpen;
  });
}

/** A press on AppKit's X or on its overlay leaves by leaveModal. Bound once per element. */
const gesturesCaught = new WeakSet<Element>();
function catchCloseGestures(k: AppKit, el: ModalElement): void {
  if (gesturesCaught.has(el)) return;
  gesturesCaught.add(el);
  el.addEventListener(
    'click',
    (e) => {
      if (!modalInFront(k, el) || !isCloseGesture(el, e)) return;
      /* Capture phase, on the host: AppKit's own click handlers, inside its
         shadow root, never see this press. */
      e.stopPropagation();
      e.preventDefault();
      leaveModal(k, el);
    },
    { capture: true, signal: attached.signal },
  );
}

/**
 * KEYS PRESSED IN APPKIT STAY IN APPKIT - AND ESC LEAVES LIKE THE X.
 *
 * App.tsx binds single-key shortcuts on window: digits switch tabs and any
 * other printable key opens the market search, which takes focus. Its "is the
 * user typing?" test reads `document.activeElement`, and for AppKit's wallet
 * search field that is the `<w3m-modal>` host, not the input in its shadow
 * root. So typing a name into "Search Wallet" (Other Wallet) opened the command
 * palette behind AppKit on the first letter, and the rest of the name went there.
 *
 * A keydown leaving the modal is stopped at its host, so the page behind never
 * sees it. Escape and Tab go on. Bound once per modal element.
 *
 * Focus is often NOT inside the modal, though: the row of our dialog that
 * opened it has just stepped aside, so it sits on <body>, and a key pressed
 * over the QR view went straight to the page's shortcuts. So, while AppKit is
 * in front, a key aimed at the page is also stopped, at window in the capture
 * phase - before any page listener. Escape is taken there too, from wherever
 * focus is: AppKit's own Esc handler is a window listener in the BUBBLE phase,
 * so it never runs, and the modal leaves by leaveModal - faded, like the X -
 * rather than by AppKit's cut. Tab is AppKit's own focus handling. Bound once.
 */
const keysKeptIn = new WeakSet<Element>();
let pageKeysHeld = false;
function keepKeysInModal(k: AppKit, el: ModalElement): void {
  if (!pageKeysHeld) {
    pageKeysHeld = true;
    window.addEventListener(
      'keydown',
      (e) => {
        const host = modalElement();
        if (!host || !modalInFront(k, host)) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          leaveModal(k, host);
          return;
        }
        if (e.key === 'Tab') return;
        if (e.composedPath().includes(host)) return; /* AppKit's own: the host listener below */
        e.stopPropagation();
      },
      { capture: true, signal: attached.signal },
    );
  }
  if (keysKeptIn.has(el)) return;
  keysKeptIn.add(el);
  el.addEventListener(
    'keydown',
    (e) => {
      const { key } = e as KeyboardEvent;
      if (key !== 'Escape' && key !== 'Tab') e.stopPropagation();
    },
    { signal: attached.signal },
  );
}

/** The exit and key hooks above, on AppKit's element. Idempotent. */
function hookModal(k: AppKit, el: ModalElement): void {
  holdCardOnClose(el);
  catchCloseGestures(k, el);
  keepKeysInModal(k, el);
}

/** AppKit about to open in front of our dialog. Idempotent; nothing to do before the element exists. */
function prepareModal(k: AppKit): void {
  const el = modalElement();
  if (!el) return;
  shareBackdrop(el, true);
  hookModal(k, el);
}

/** One AppKit at a time: an exit still fading out finishes before the next open. */
async function modalGone(): Promise<void> {
  while (leaving) await leaving;
}

/** Every `tag` element under `host`, through open shadow roots. */
function findInShadow(host: Element | null, tag: string): Element[] {
  const found: Element[] = [];
  const walk = (root: ParentNode): void => {
    for (const el of root.querySelectorAll('*')) {
      if (el.localName === tag) found.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  if (host?.shadowRoot) walk(host.shadowRoot);
  return found;
}

/**
 * Go where the row goes. Resolves with the route actually taken:
 *  - 'extension': the wallet is CONNECTED (or this rejects);
 *  - anything else: that AppKit view is now OPEN, and the rest happens in it -
 *    unless `stillWanted` said no when it was asked, right before opening: a
 *    dialog closed (or a row superseded) while AppKit was still loading opens
 *    nothing at all.
 *
 * An extension we saw announce itself but AppKit has not registered (it can lag
 * a fresh announcement) takes the no-extension route instead of failing.
 */
export async function connectVia(
  choice: ConnectChoice,
  route: ConnectRoute = routeFor(choice),
  stillWanted: () => boolean = () => true,
): Promise<ConnectRoute> {
  const k = await initWallet();

  if (route === 'extension' && choice !== 'walletconnect' && choice !== 'other') {
    const w = featured(choice);
    const found = findInstalled(w);
    const connector = found ? kitConnectorFor(k, found) : undefined;
    if (connector) {
      await connectExtension(k, w, connector);
      return 'extension';
    }
    route = isMobileDevice() ? 'deeplink' : 'qr';
  }

  await modalGone();
  if (!stillWanted()) return route;
  /* Before opening, so AppKit's first frame already draws no overlay of its
     own; and again after, for an element that open() itself had to create. */
  prepareModal(k);
  connectRequested = true;
  if (route === 'deeplink' && choice !== 'walletconnect' && choice !== 'other') {
    await openWalletConnectView(k, toWcWallet(featured(choice)));
  } else if (route === 'qr' || route === 'deeplink') {
    await openWalletConnectView(k);
  } else if (route === 'wallets') {
    await k.open({ view: 'AllWallets' });
  } else {
    await k.open({ view: 'Connect' });
    redrawListAsItLoads(k);
  }
  prepareModal(k);
  disarmOnCancel(k);
  return route;
}

/**
 * Called ONCE, on the first frame of AppKit's exit - whether the user closed it
 * (leaveModal says so before its fade) or AppKit closed itself - with whether a
 * wallet connected while it was up. Our dialog brings its card back during
 * AppKit's fade, or leaves together with it.
 *
 * "Connected" is known at that moment, not a beat later. An extension picked in
 * AppKit's list has its address before AppKit closes. A WalletConnect pairing
 * does NOT - AppKit closes its modal first and folds the address in after
 * (appkit-base-client connectWalletConnect) - but it does have its session: a
 * topic that was not there when AppKit opened.
 *
 * A no-op subscription if AppKit has not been created. If AppKit is already
 * closed when this is called, the callback is told so straight away.
 */
export function onWalletModalClosed(cb: (connected: boolean) => void): () => void {
  const k = kit;
  if (!k) return () => {};
  const topicAtOpen = universal?.session?.topic ?? null;
  let wasOpen = k.isOpen();
  let told = false;
  const tell = (): void => {
    if (told) return;
    told = true;
    stop();
    const topic = universal?.session?.topic ?? null;
    cb(isWalletConnected() || (topic !== null && topic !== topicAtOpen));
  };
  const offState = k.subscribeState((s) => {
    if (s.open) {
      wasOpen = true;
      return;
    }
    if (wasOpen) tell();
  });
  leaveListeners.add(tell);
  const stop = (): void => {
    offState();
    leaveListeners.delete(tell);
  };
  if (!wasOpen && !leaving) queueMicrotask(tell);
  return stop;
}

/** AppKit's modal is open and not on its way out. */
export const isWalletModalUp = (): boolean => Boolean(kit?.isOpen()) && !leaving;

/** Connected, as far as either AppKit or our snapshot can tell yet. */
export const isWalletConnected = (): boolean =>
  snap.status === 'connected' || Boolean(kit?.getCaipAddress('eip155'));

/** Close AppKit's modal if it is up (a connect the user already walked away from). */
export function closeWalletModal(): void {
  if (kit?.isOpen()) void kit.close();
}

/**
 * Storage keys the WalletConnect SDK owns. Purged only as a BACKSTOP, when AppKit
 * could not be started to tear its own session down properly.
 */
function purgeWalletConnectStorage(): void {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('wc@2:') || k.startsWith('@appkit/') || k === 'WALLETCONNECT_DEEPLINK_CHOICE') localStorage.removeItem(k);
    }
  } catch {
    /* private mode, or storage disabled - nothing to purge */
  }
  /* The session keys themselves live in IndexedDB, not localStorage: without
     this, the next Connect on a shared machine could adopt the old session. */
  try {
    indexedDB.deleteDatabase('WALLET_CONNECT_V2_INDEXED_DB');
  } catch {
    /* no IndexedDB here - nothing kept there either */
  }
}

/** Is there a connection on disk that AppKit would restore? */
function hasPersistedConnection(): boolean {
  try {
    if (localStorage.getItem('@appkit/connection_status') === 'connected') return true;
    return Object.keys(localStorage).some(
      (k) => k.startsWith('wc@2:client:') && k.endsWith('//session') && (localStorage.getItem(k) ?? '[]') !== '[]',
    );
  } catch {
    return false;
  }
}

/**
 * Should AppKit be started at load, to restore a connection silently?
 *
 * Only when there is one to restore. Starting AppKit opens a relay socket and
 * calls Reown's API, which a visitor who never connected has not asked for.
 */
export const shouldRestoreOnLoad = (): boolean => hasWalletConnectConfig() && hasPersistedConnection();

/**
 * End the connection, INCLUDING one this page load never saw.
 *
 * The bug this exists to fix (inherited from the manual-WalletConnect era): the
 * SDK persists the approved session in localStorage and restores it on the next
 * start, so returning early because nothing was loaded left a live session on
 * disk while the UI said "Disconnected" - and the next Connect adopted it with no
 * wallet prompt at all. So if AppKit is not running but a connection is on disk,
 * it is started FOR THE PURPOSE OF ENDING IT. Disconnect must be authoritative or
 * it is not a disconnect.
 *
 * For an extension, AppKit also revokes this site's account permission in the
 * wallet (where the wallet supports it), so the next Connect asks again.
 */
export async function disconnectWallet(): Promise<void> {
  userDisconnecting = true;
  clearTimeout(teardownTimer);
  try {
    let k: AppKit | null = kitPromise ? await kitPromise.catch(() => null) : null;
    if (!k && shouldRestoreOnLoad()) k = await initWallet().catch(() => null);
    if (k) {
      try {
        await k.disconnect();
      } catch {
        /* already gone */
      }
    }
    // A WalletConnect session that survived AppKit's own teardown.
    if (universal?.session) {
      try {
        await universal.disconnect();
      } catch {
        /* already gone */
      }
    }
    if (!k) purgeWalletConnectStorage();
  } finally {
    connectRequested = false;
    chainWatch?.off();
    chainWatch = null;
    setSnap({ ...EMPTY, status: 'disconnected' });
    // AppKit's own "disconnected" notifications land after this; do not read
    // them as the wallet hanging up on us.
    setTimeout(() => { userDisconnecting = false; }, 1_000);
  }
}

/** The name the rest of the app has always called. */
export const disconnectWalletConnect = disconnectWallet;

/** True when a WalletConnect session is currently held. */
export const hasWalletConnectSession = (): boolean => !!universal?.session;

/**
 * Render a string as a QR data URL.
 *
 * NOT part of the pairing flow - the official modal draws that QR itself. This
 * survives because the Transfer Crypto sheet (funds/DepositModal.tsx) renders a deposit ADDRESS as a QR, which has
 * nothing to do with WalletConnect and still needs it. It lives here only because
 * that is where its one caller already imports it from; it would be better off in
 * a small qr module if a third caller ever appears.
 */
export async function toQrDataUrl(text: string): Promise<string> {
  const QRCode = (await import('qrcode')).default;
  return QRCode.toDataURL(text, {
    width: 260,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#111111', light: '#ffffff' },
  });
}

/* ---------------------------------------------------------------------------
 * IS THE PAIRING STILL THERE, OR ONLY IN OUR LOCALSTORAGE?
 * ------------------------------------------------------------------------ */

/**
 * Fail fast when the session is dead.
 *
 * THE BUG THIS EXISTS FOR. A WalletConnect provider answers `eth_accounts` and
 * `eth_chainId` from its own persisted state, without touching the relay. So a
 * session the relay dropped - phone rebooted, app evicted, session expired,
 * pairing swept - still restores on reload, still reports the right address, and
 * still leaves the header saying Connected. The first thing to notice is a
 * request that genuinely needs the wallet, and what the user sees then is the
 * worst version of the failure: they get a prompt from somewhere, approve it,
 * and this page sits in silence for the full request timeout. The relay
 * meanwhile logs `Pending session not found for topic ...` - an answer arriving
 * for a conversation neither side is holding open any more.
 *
 * `ping` is the SDK's own liveness probe and the only honest test: it is a real
 * round-trip to the relay over this session's topic, so it fails when the
 * session is gone and succeeds when it is not.
 *
 * WHAT IT DOES NOT DO. Nothing at all for an extension wallet - there is no
 * session to go stale, and MetaMask answers or does not answer on its own. It
 * also stays silent if the SDK does not expose `ping`: a preflight that cannot
 * run must not manufacture a failure for a signature that would have worked.
 */
export async function assertSessionAlive(
  signing: Eip1193Provider,
  method: string,
  timeoutMs = 6_000,
): Promise<void> {
  const provider = universal;
  /*
   * ONLY THE PROVIDER THAT IS ACTUALLY SIGNING.
   *
   * AppKit keeps a UniversalProvider alive whichever wallet is connected, so an
   * extension signature must not be judged by the liveness of a WalletConnect
   * session it has nothing to do with.
   */
  if (!provider || signing !== provider) return;

  /*
   * A WALLETCONNECT PROVIDER WITH NO SESSION IS BROKEN, and provably so - this
   * runs only before a signature, never during pairing, so there is no
   * legitimate moment to sign through it without a session. Dispatching into
   * that is exactly how a request goes out with nothing to carry it back.
   */
  const topic = provider.session?.topic;
  if (!topic) {
    await disconnectWallet().catch(() => {});
    throw new WalletConnectError(
      'There is no live wallet session on this page any more. Connect the wallet again and retry.',
    );
  }

  /*
   * A LIVE SESSION CAN STILL BE THE WRONG SESSION.
   *
   * The method list is a standing grant fixed at pairing time, and a session
   * that survived a reload is REUSED without being re-proposed. A session paired
   * before a method joined `WC_METHODS` is alive, reports the right account, and
   * simply does not carry that permission - and UniversalProvider does not fail
   * loudly on that. It falls through to a plain HTTP JSON-RPC POST at the chain
   * node, which has no idea what a signature request is.
   *
   * Deterministic, so it is a hard failure. Checked per method rather than for
   * the whole list: a wallet is entitled to grant a subset, and blocking a
   * signature it DID grant because some other method is missing would invent a
   * failure. No teardown - the session is fine, it just cannot do this.
   */
  const granted = provider.session?.namespaces?.eip155?.methods;
  if (granted && granted.length > 0 && !granted.includes(method)) {
    throw new WalletConnectError(
      `This wallet session does not permit ${method}. It was paired before this app `
      + 'asked for that permission — disconnect and connect again to grant it.',
    );
  }

  /*
   * THE PING IS ADVISORY. IT MUST NEVER BLOCK A SIGNATURE OR KILL A SESSION.
   *
   * A first version treated a failed `ping` as proof the session was dead: it
   * disconnected and refused to sign. That is far worse than the hang it was
   * written to replace. A relay round-trip fails for transient reasons - a slow
   * network, a wallet that has backgrounded itself on a phone, a relay hiccup -
   * and destroying a working pairing on that evidence breaks signing for people
   * whose wallet would have answered perfectly well.
   *
   * So the probe only RECORDS what it saw. If the signature then times out,
   * `lastPingFailed` lets the caller say why instead of guessing.
   */
  const ping = provider.client?.ping;
  if (typeof ping !== 'function') return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ping.call(provider.client, { topic }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('ping timed out')), timeoutMs);
      }),
    ]);
    lastPingFailed = false;
  } catch {
    lastPingFailed = true;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Did the last liveness probe fail?
 *
 * Read only to explain a timeout after the fact. It is never a reason to refuse
 * a signature - see the note in `assertSessionAlive`.
 */
let lastPingFailed = false;
export const sessionProbeFailed = (): boolean => lastPingFailed;

/*
 * Registered once AppKit exists, from inside `createKit`.
 *
 * The probe only has anything to check once a UniversalProvider exists, and
 * AppKit is what creates one. (It was also once a module-cycle workaround: wallet
 * and walletconnect imported from each other, and calling `setSignPreflight` at
 * this file's top level hit wallet.ts's `let` in its temporal dead zone. The cycle
 * is gone - wallet.ts imports nothing from here now - but registering lazily
 * costs nothing and keeps it that way.)
 */
function registerPreflight(): void {
  setSignPreflight((p, method) => assertSessionAlive(p, method));
}

/* HOT RELOAD (dev only; see initWallet). The previous copy is released first -
   its listeners, subscriptions and modal hooks - then its AppKit is adopted at
   once, so the wallet state is live again without waiting for a Connect. An
   AppKit on the page WITHOUT that full hand-over (instance and letGo, i.e. made
   by a copy from before the hand-over existed) can be neither adopted cleanly
   nor released, and a second createAppKit over it is exactly the double
   initialisation this avoids: the page is reloaded instead, once - what Vite
   itself does with an update it cannot apply. */
if (import.meta.hot) {
  const hot = hotData() ?? {};
  const handedOver = Boolean(hot.kit && hot.letGo);
  hot.letGo?.();
  hot.letGo = letGo;
  import.meta.hot.dispose(letGo);
  if (handedOver) void initWallet().catch(() => {});
  else if (typeof document !== 'undefined' && document.querySelector('w3m-modal')) window.location.reload();
}
