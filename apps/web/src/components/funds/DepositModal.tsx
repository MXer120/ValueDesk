/**
 * Deposit - the owner's reference sheets, in this app's tokens.
 *
 *   choose    Transfer from ValueChain - "Transfer from your connected wallet."
 *             Deposit [Recommended] - "Transfer crypto from any wallet."
 *   wallet    "Transfer": the Transfer sheet's own panel (TransferModal.tsx),
 *             starting at EVM -> Spot - Spot, Perps and EVM all selectable.
 *             Out of the wallet it is sodex.com's own deposit: a token is two
 *             signatures and no gas, SOSO one transaction
 *             (trading/funds.ts:depositFromWallet).
 *   transfer  "Deposit": token + chain, then the wallet's own verified SoDEX
 *             deposit address and QR (routes/mirror.ts) - drawn from the start
 *             but blurred under a red warning until it has been read; min and
 *             ETA from SoDEX's asset config. A chain SoDEX has under
 *             maintenance cannot be picked and shows no address (as sodex.com).
 *
 * Every view is complete the moment it opens: whatever is still loading shows
 * its own spinner in place. Views fade into one another and the sheet's height
 * follows its content (motion.tsx).
 *
 * A wallet SoDEX has never seen opens its account with this first deposit (1
 * USDC / 1 SOSO activation fee); the sheet then carries on in place: account
 * ready -> Enable trading (one signature) -> move the deposit to Perps.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Modal } from '../Modal';
import { AutoHeight, Collapse, FadeView } from '../motion';
import { api, type MirrorAsset } from '../../api';
import { getTradingState, refreshAccount, subscribeTrading } from '../../trading/session';
import { cachedAssetConfigs, chainLabel, type CoinConfig } from '../../trading/funds';
import { formatUnits, parseUnits } from '../../trading/onboard';
import { readGateway } from '../../trading/gateway';
import { maintenanceFor, maintenanceNote, type Maintenance } from '../../trading/relay';
import { refreshWallet, subscribeWallet, walletRead } from '../../trading/walletBalances';
import { toQrDataUrl } from '../../walletconnect';
import type { Eip1193Provider } from '../../wallet';
import { NO_ACCOUNT_TRANSFER } from '../account/useAccountExists';
import { TransferPanel } from './TransferModal';
import { useDepositWatch, type DepositStage, type DepositWatch } from './depositWatch';
import { ApproveLabel, Arrow, Avatar, Chevron, CopyIcon, FxSelect, Info, Label, ONE_CONFIRM, QrIcon, Spinner, WalletMark, short, useStepLabel } from './ui';
import './funds.css';

interface Props {
  open: boolean;
  onClose: () => void;
  address: string | null;
  provider: Eip1193Provider | null;
  walletName: string | null;
  /** AccountController's enable flow; resolves true once trading is on. */
  onEnable: () => Promise<boolean>;
}

type View = 'choose' | 'wallet' | 'transfer';
/** "Transfer from ValueChain" starts at the wallet, into Spot. */
const WALLET_PRESET = { from: 'evm', to: 'spot' } as const;
const ACCOUNT_POLL_MS = 5000;
const ADDRESS_POLL_MS = 8000;
/** How many more reads while SoDEX issues a new chain's address (sodex.com: every 5 s, about 30 times). */
const ISSUING_MAX_POLLS = 30;

const minutes = (s: number | null | undefined): string => (s ? `~${Math.max(1, Math.round(s / 60))} min` : '');
/** A balance for display: at most `dp` decimals, CUT (a rounded-up balance would promise more than is there). */
const cutTo = (v: string | null | undefined, dp: number): string => {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(v ?? '').trim());
  if (!m) return '0';
  const f = (m[2] ?? '').slice(0, dp).padEnd(dp, '0');
  return dp > 0 ? `${m[1]}.${f}` : m[1]!;
};

/** Free vUSDC in Spot, rounded DOWN to 6 decimals (null: unknown). */
async function spotUsdc(owner: string): Promise<string | null> {
  try {
    const st = await readGateway<{ B?: Array<{ a?: string; t?: string; l?: string }> } | null>(`/api/v1/spot/accounts/${owner}/state`);
    const row = st?.B?.find((b) => (b.a ?? '').toUpperCase() === 'VUSDC');
    if (!row) return '0';
    const cut = (v: string) => {
      const m = /^(\d+)(?:\.(\d+))?$/.exec(v.trim());
      return m ? `${m[1]}${m[2] ? `.${m[2].slice(0, 6)}` : ''}` : '0';
    };
    const free = parseUnits(cut(row.t ?? '0'), 6) - parseUnits(cut(row.l ?? '0'), 6);
    return formatUnits(free > 0n ? free : 0n, 6);
  } catch {
    return null;
  }
}

export function DepositModal({ open, onClose, address, provider, onEnable }: Props) {
  const trading = useSyncExternalStore(subscribeTrading, getTradingState, getTradingState);
  const owner = address?.toLowerCase() ?? null;
  const mine = !!owner && trading.owner === owner;
  const noAccount = mine && trading.accountStatus === 'none';
  const enabled = mine && trading.status === 'enabled';

  const [view, setView] = useState<View>('choose');
  /** This sheet opened the account (the carry-on steps show until closed). */
  const [opening, setOpening] = useState(false);
  const [mirror, setMirror] = useState<MirrorAsset[] | null>(null);
  const [configs, setConfigs] = useState<CoinConfig[] | null>(null);

  // Opening the sheet starts at the chooser.
  useEffect(() => {
    if (open) setView('choose');
  }, [open]);
  // A first deposit is remembered - also when the account check answers only
  // after the sheet opened.
  useEffect(() => {
    if (open && noAccount) setOpening(true);
  }, [open, noAccount]);
  useEffect(() => {
    setOpening(false);
    setMirror(null);
  }, [owner]);

  // The wallet's ValueChain USDC (the address menu's read, usually already there) and SoDEX's config.
  useEffect(() => {
    if (!open || !owner) return;
    let stop = false;
    refreshWallet(owner);
    if (!configs) cachedAssetConfigs().then((c) => !stop && setConfigs(c)).catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [open, owner, configs]);
  const wallet = useSyncExternalStore(subscribeWallet, () => (owner ? walletRead(owner) : null));

  // Verified deposit addresses; a new wallet's take a moment to be issued.
  useEffect(() => {
    if (!open || !owner || view !== 'transfer') return;
    let stop = false;
    let timer: number | undefined;
    // While SoDEX issues an address on a chain the wallet had none on, keep reading (as sodex.com does), a while.
    let issuingPolls = 0;
    const load = async () => {
      try {
        const r = await api.depositOptions(owner);
        if (!stop) setMirror(r.assets);
        const issuing = r.issuing ?? [];
        if (!stop && r.assets.some((a) => a.routes.length) && (issuing.length === 0 || ++issuingPolls > ISSUING_MAX_POLLS)) return;
      } catch {
        /* not ready yet */
      }
      if (!stop) timer = window.setTimeout(load, ADDRESS_POLL_MS);
    };
    void load();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [open, owner, view]);

  // A first deposit: watch for the account to open (also while closed).
  useEffect(() => {
    if (!owner || !opening || (mine && trading.accountStatus === 'ready')) return;
    let stop = false;
    let timer: number | undefined;
    const tick = async () => {
      await refreshAccount(owner);
      if (!stop) timer = window.setTimeout(tick, ACCOUNT_POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [owner, opening, mine, trading.accountStatus]);

  const vcUsdc = wallet?.rows.find((r) => r.chain === 'VALUECHAIN' && r.symbol === 'USDC');
  /** Known once ValueChain answered (a chain with nothing on it has no row). */
  const usdcKnown = !!vcUsdc || (!!wallet && wallet.pending === 0);
  const accountReady = opening && mine && trading.accountStatus === 'ready';
  const title = accountReady ? 'Your account is ready' : view === 'wallet' ? 'Transfer' : 'Deposit';

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      size="md"
      className="fx"
      onBack={view !== 'choose' && !accountReady ? () => setView('choose') : undefined}
    >
      {!owner ? (
        <p className="fx-note">Connect a wallet to deposit.</p>
      ) : (
        <AutoHeight>
          <FadeView viewKey={accountReady ? 'ready' : view} className="fx-stack">
            {accountReady ? (
              <AccountReady owner={owner} accountId={trading.accountId} enabled={enabled} provider={provider} onEnable={onEnable} onClose={onClose} />
            ) : view === 'choose' ? (
              <>
                {noAccount && (
                  <p className="fx-note fx-note--warn">
                    This wallet has no SoDEX account yet - your first deposit opens it. SoDEX keeps 1 USDC (or 1 SOSO) of it as a one-time activation fee.
                  </p>
                )}
                <button type="button" className="fx-opt" onClick={() => setView('wallet')} disabled={!provider || noAccount} title={noAccount ? NO_ACCOUNT_TRANSFER : undefined}>
                  <span className="fx-opt__icon"><WalletMark /></span>
                  <span>
                    <span className="fx-opt__t">Transfer from ValueChain</span>
                    <span className="fx-opt__d">{noAccount ? 'Available once your first deposit has opened your account.' : 'Transfer from your connected wallet.'}</span>
                  </span>
                  <span className="fx-opt__r">
                    <strong>{usdcKnown ? `${cutTo(vcUsdc?.amount ?? '0', 2)} USDC` : <Spinner />}</strong>
                  </span>
                </button>
                <button type="button" className="fx-opt" onClick={() => setView('transfer')}>
                  <span className="fx-opt__icon"><QrIcon /></span>
                  <span>
                    <span className="fx-opt__t">
                      Deposit <span className="fx-badge">Recommended</span>
                    </span>
                    <span className="fx-opt__d">Transfer crypto from any wallet.</span>
                  </span>
                  <span className="fx-opt__r fx-coins">
                    {['USDC', 'USDT', 'ETH', 'SOL', 'BNB'].map((c) => <Avatar key={c} seed={c} size={18} />)}
                  </span>
                </button>
                {!provider && !noAccount && <p className="fx-note">Reconnect your wallet to transfer from it.</p>}
              </>
            ) : view === 'wallet' ? (
              <TransferPanel owner={owner} provider={provider} onEnable={onEnable} preset={WALLET_PRESET} />
            ) : (
              <TransferCrypto owner={owner} mirror={mirror} onMirror={setMirror} configs={configs} firstDeposit={noAccount} />
            )}
          </FadeView>
        </AutoHeight>
      )}
    </Modal>
  );
}

// --- deposit from any wallet ----------------------------------------------------------------

function TransferCrypto({ owner, mirror, onMirror, configs, firstDeposit }: {
  owner: string;
  mirror: MirrorAsset[] | null;
  onMirror: (assets: MirrorAsset[]) => void;
  configs: CoinConfig[] | null;
  firstDeposit: boolean;
}) {
  // A first deposit must be USDC; otherwise every verified asset is offered -
  // but only on a route SoDEX's asset config has OPEN for deposits right now
  // (the whitelist our backend reads still lists routes the config has closed,
  // e.g. the .ssi index tokens on Base; money sent to a closed route is not
  // credited). Until the config is in, nothing is offered.
  // XRP and Stellar carry SoDEX's "memo" flag, which means the opposite of what
  // it sounds like: SoDEX needs NO memo (the address is the account's own);
  // the warning below says what to type if a sending exchange insists on one.
  // PEPE is never offered: sodex.com deposits it to a PEPE-only address it
  // fetches separately (token "ETH_PEPE"), NOT the account's shared Ethereum
  // address - PEPE sent to the shared one may never be credited, and the
  // PEPE-only address has no on-chain record to verify it against.
  const tokens = useMemo(() => {
    if (!configs) return [];
    const open = (symbol: string, chain: string) =>
      symbol.toUpperCase() !== 'PEPE' &&
      configs.find((c) => c.coin.toUpperCase() === symbol.toUpperCase())?.chains.find((c) => c.key === chain)?.deposit.allowed === true;
    return (mirror ?? [])
      .map((a) => ({ ...a, routes: a.routes.filter((r) => open(a.symbol, r.chain)) }))
      .filter((a) => a.routes.length && (!firstDeposit || a.symbol.toUpperCase() === 'USDC'));
  }, [mirror, configs, firstDeposit]);
  const [symbol, setSymbol] = useState('USDC');
  const [chainKey, setChainKey] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  /** token:chain pairs whose warning was read - the address is readable only after it. */
  const [acked, setAcked] = useState<ReadonlySet<string>>(() => new Set());
  /** A deposit that arrived while this sheet was open (SoDEX's own deposit history). */
  const watch = useDepositWatch(owner, true);
  /** SoDEX's maintenance for the chosen token (null: being read). */
  const [maint, setMaint] = useState<Maintenance | null>(null);

  const token = tokens.find((t) => t.symbol === symbol) ?? tokens[0];
  const offNote = (chain: string) => maintenanceNote(maint, chain, 'deposit');
  const isOff = (chain: string) => offNote(chain)?.severity === 'unavailable';
  // The chosen chain, else the first one SoDEX has open.
  const route = token?.routes.find((r) => r.chain === chainKey) ?? token?.routes.find((r) => !isOff(r.chain) && !r.flagged) ?? token?.routes[0];
  /** SoDEX flagged this chain's address: none is shown until the user asks SoDEX for the new one. */
  const flagged = !!route?.flagged;
  const [replacing, setReplacing] = useState(false);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const down = route ? offNote(route.chain) : null;
  const paused = down?.severity === 'unavailable';
  /** Not even blurred while SoDEX has the route paused. */
  const shownAddress = paused || flagged ? null : route?.address || null;
  const cfg = configs?.find((c) => c.coin.toUpperCase() === token?.symbol.toUpperCase());
  const chainCfg = cfg?.chains.find((c) => c.key === route?.chain);
  const min = chainCfg?.deposit.min ?? route?.minDeposit ?? null;
  const eta = chainCfg?.deposit.etaSeconds ?? (route?.depositMinutes ? route.depositMinutes * 60 : null);
  const loading = !token || !route;
  const key = token && route ? `${token.symbol}:${route.chain}` : '';
  const readable = !!key && acked.has(key) && !paused && !flagged;
  const sym = token?.symbol ?? symbol;
  const chainName = route ? route.label || chainLabel(route.chain) : '';

  useEffect(() => setChainKey(null), [symbol]);
  useEffect(() => {
    if (!token) return;
    let stop = false;
    setMaint(null);
    maintenanceFor(token.symbol, owner).then((m) => !stop && setMaint(m)).catch(() => !stop && setMaint({ known: false, global: {}, coinWide: {}, byChain: {} }));
    return () => {
      stop = true;
    };
  }, [token?.symbol, owner]);
  useEffect(() => {
    if (!shownAddress) return setQr(null);
    let stop = false;
    toQrDataUrl(shownAddress).then((d) => !stop && setQr(d)).catch(() => !stop && setQr(null));
    return () => {
      stop = true;
    };
  }, [shownAddress]);

  /** sodex.com's replace flow: ask SoDEX, then re-read (every 5 s, up to 30 times) until the new address is confirmed. */
  async function replace() {
    if (!route) return;
    setReplacing(true);
    setReplaceError(null);
    try {
      await api.replaceDepositAddress(owner, route.chain);
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const next = await api.depositOptions(owner).catch(() => null);
        if (!next) continue;
        onMirror(next.assets);
        const again = next.assets.find((a) => a.symbol === token?.symbol)?.routes.find((r) => r.chain === route.chain);
        if (again && !again.flagged && again.address) return;
      }
      setReplaceError('SoDEX has not issued the new address yet - try again in a minute.');
    } catch (e) {
      setReplaceError(`Could not get a new deposit address: ${(e as Error).message}`);
    } finally {
      setReplacing(false);
    }
  }

  async function copy() {
    if (!shownAddress || !readable) return;
    try {
      await navigator.clipboard.writeText(shownAddress);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the address is selectable */
    }
  }

  return (
    <>
      {firstDeposit && <p className="fx-note fx-note--warn">Your first deposit opens your SoDEX account (USDC, 1 USDC activation fee).</p>}
      <div className="fx-cols">
        <div>
          <Label>Tokens</Label>
          <FxSelect
            searchable
            loading={loading}
            label="Token"
            value={sym}
            onChange={setSymbol}
            searchPlaceholder="Search token"
            options={tokens.length ? tokens.map((t) => ({ value: t.symbol, label: t.symbol, icon: t.symbol })) : [{ value: sym, label: sym, icon: sym }]}
          />
        </div>
        <div>
          <Label aside={min ? <>Min {min} <Info title={`Deposits below ${min} ${sym} may not be credited.`} /></> : undefined}>Chains</Label>
          <FxSelect
            searchable
            loading={loading}
            label="Chain"
            value={route?.chain ?? ''}
            onChange={setChainKey}
            searchPlaceholder="Search chain"
            options={
              token
                ? token.routes.map((r) => ({
                    value: r.chain,
                    label: r.label || chainLabel(r.chain),
                    icon: r.chain,
                    iconKind: 'chain' as const,
                    hint: isOff(r.chain) ? 'Maintenance' : r.flagged ? 'Address changed' : minutes(r.depositMinutes ? r.depositMinutes * 60 : null),
                    disabled: isOff(r.chain),
                  }))
                : [{ value: '', label: 'Chain' }]
            }
          />
        </div>
      </div>

      {down && (
        <p className={`fx-note ${paused ? 'fx-note--err' : 'fx-note--warn'}`}>
          {paused ? `${sym} deposits on ${chainName} are paused by SoDEX - do not send any now. ` : 'SoDEX reports this network is congested - crediting may take longer. '}
          {down.message}
          {down.duration ? ` (${down.duration})` : ''}
        </p>
      )}
      {maint && !maint.known && !loading && <p className="fx-note">SoDEX's maintenance status could not be read - check sodex.com's notices before sending a large amount.</p>}

      {/* The QR code and the address are there from the start - blurred past reading until the warning is read. */}
      <div className={`fx-addrzone${readable ? ' is-readable' : ''}`}>
        <div className="fx-addrzone__content" aria-hidden={!readable}>
          <div className="fx-qr">
            {qr ? <img src={qr} alt={readable ? `Deposit address for ${sym} on ${chainName}` : ''} /> : <span className="fx-qr__wait"><Spinner /></span>}
            {route && <Avatar seed={route.chain} kind="chain" size={26} />}
          </div>

          <div className={`fx-sendrecv${watch ? ' has-strip' : ''}`}>
            <div className={`fx-pill${watch ? (watch.stage === 'done' ? ' is-done' : watch.stage === 'failed' ? ' is-failed' : watch.stage === 'review' ? '' : ' is-live') : ''}`}>
              <span className="fx-pill__s"><Avatar seed={sym} /> <span><small>You send</small><b>{sym}</b></span></span>
              <Arrow />
              <span className="fx-pill__s"><Avatar seed={cfg?.asset ?? sym} /> <span><small>You receive</small><b>{cfg?.asset ?? sym}</b></span></span>
            </div>
            <Collapse open={!!watch}>
              {watch && <DepositProgress w={watch} />}
            </Collapse>
          </div>

          <div>
            <Label aside={<a className="fx-link" href="https://sodex.com/documentation/for-developers/developers/mirror-protocol/lifecycle/custody-deposits" target="_blank" rel="noreferrer" tabIndex={readable ? undefined : -1}>Terms apply</a>}>
              Your deposit address <Info title="Your own SoDEX deposit address on this chain, checked against the ValueChain registry." />
            </Label>
            <div className="fx-addr">
              <code>{shownAddress ?? '0x0000000000000000000000000000000000000000'}</code>
              <button type="button" className="fx-copy" onClick={() => void copy()} disabled={!readable} tabIndex={readable ? undefined : -1}>
                <CopyIcon /> {copied ? 'Copied' : 'Copy address'}
              </button>
            </div>
          </div>
        </div>

        <div className="fx-addrzone__cover" aria-hidden={readable}>
          {loading ? (
            <p className="fx-wait fx-addrzone__wait">
              <Spinner />
              {mirror ? 'Your deposit addresses are being issued - this takes a moment for a new wallet…' : 'Preparing your deposit address…'}
            </p>
          ) : flagged && !paused ? (
            <div className="fx-warnbox" role="alert">
              <p className="fx-warnbox__t">The deposit address has changed</p>
              <p>SoDEX has assigned a new deposit address on {chainName}. Confirm to get it - do not send anything to an address you copied before.</p>
              {replaceError && <p className="fx-note fx-note--err">{replaceError}</p>}
              <button type="button" className="fx-cta" disabled={replacing} onClick={() => void replace()}>
                {replacing ? 'Generating new address…' : 'Confirm & Update Address'}
              </button>
            </div>
          ) : paused ? (
            <div className="fx-warnbox" role="alert">
              <p className="fx-warnbox__t">Deposits paused</p>
              <p>SoDEX has {sym} deposits on {chainName} under maintenance. The address is hidden until they reopen - pick another chain.</p>
            </div>
          ) : (
            <div className="fx-warnbox" role="alert">
              <p className="fx-warnbox__t">I understand:</p>
              <ul>
                <li>Only send <em>{sym}</em> on <em>{chainName}</em> Network.</li>
                {min && <li><em>Each deposit</em> must be at least <em>{min} {sym}</em>.</li>}
                {route?.contractWarning && <li>Send from a normal wallet - <em>not from a smart contract</em>.</li>}
                {route?.needsMemo && <li>No memo / tag is needed. If the sending exchange insists on one, enter any 9-digit number (e.g. 123456789).</li>}
                {route && /^(XRP|XLM)$/.test(route.chain) && <li>Your <em>first {sym}</em> deposit pays a one-time 1 {sym} address activation fee.</li>}
              </ul>
              <p>Otherwise, it will result in permanent <em>loss</em>.</p>
              <button type="button" className="fx-cta" onClick={() => setAcked((prev) => new Set(prev).add(key))}>
                OK, show me the address
              </button>
            </div>
          )}
        </div>
      </div>

      <div className={`fx-info${infoOpen ? ' is-open' : ''}`}>
        <button type="button" className="fx-info__sum" aria-expanded={infoOpen} onClick={() => setInfoOpen((v) => !v)}>
          Arrives in {minutes(eta) || 'a few minutes'} <Info title="SoDEX's own estimate for this chain." /> <Chevron />
        </button>
        <Collapse open={infoOpen}>
          <div className="fx-info__body">
            Send only <b>{sym}</b>, only on <b>{chainName || 'the chosen chain'}</b>{min ? `, at least ${min} ${sym}` : ''}. It is credited to your SoDEX Spot
            balance. {route?.contractWarning ? 'Send from a normal wallet, not a smart contract. ' : ''}Custody on this route is Cobo, SoDEX's custodian.
          </div>
        </Collapse>
      </div>
    </>
  );
}

// --- after a first deposit --------------------------------------------------------------------

function AccountReady({ owner, accountId, enabled, provider, onEnable, onClose }: {
  owner: string;
  accountId: number | null;
  enabled: boolean;
  provider: Eip1193Provider | null;
  onEnable: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [enabling, setEnabling] = useState(false);
  const busyLabel = useStepLabel();
  const [spot, setSpot] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [moved, setMoved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || moved) return;
    let stop = false;
    void spotUsdc(owner).then((v) => !stop && setSpot(v));
    return () => {
      stop = true;
    };
  }, [enabled, owner, moved]);

  async function move() {
    if (!spot || !(Number(spot) > 0)) return;
    setMoving(true);
    setError(null);
    try {
      await api.transferCross('spot-to-perps', 0, spot);
      setMoved(spot);
    } catch (e) {
      setError(`Moving to Futures failed: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setMoving(false);
    }
  }

  return (
    <>
      <p className="fx-note fx-note--ok">
        SoDEX account <b>#{accountId}</b> is open for {short(owner)}.
      </p>
      {!enabled && (
        <>
          <p className="fx-note">One signature enables trading in this browser - no network switch.</p>
          <button
            type="button"
            className="fx-cta"
            disabled={enabling || !provider}
            onClick={async () => {
              setEnabling(true);
              try {
                await onEnable();
              } finally {
                setEnabling(false);
              }
            }}
          >
            {enabling ? <ApproveLabel /> : 'Enable trading'}
          </button>
        </>
      )}
      {enabled && !moved && spot !== null && Number(spot) > 0 && (
        <>
          <p className="fx-note">Your deposit is in your Spot balance ({spot} USDC). Futures trade from the futures balance.</p>
          <button type="button" className="fx-cta" onClick={() => void move()} disabled={moving}>
            {moving ? busyLabel(null) : `Move ${spot} USDC to Futures`}
          </button>
        </>
      )}
      {moved && <p className="fx-note fx-note--ok">Moved {moved} USDC to Futures.</p>}
      {enabled && (
        <button type="button" className={moved || !spot || Number(spot) <= 0 ? 'fx-cta' : 'fx-cta fx-cta--ghost'} onClick={onClose}>
          Start trading
        </button>
      )}
      {error && <p className="fx-note fx-note--err">{error}</p>}
    </>
  );
}

/** The strip under You send -> You receive once a deposit shows up: three steps, the current one lit. */
function DepositProgress({ w }: { w: DepositWatch }) {
  const raw = w.row.rawStatus || w.row.status;
  const processing = raw === 'Reporting' ? 'Reporting to SoDEX' : 'Deposit processing';
  const steps: Array<[DepositStage, string]> = [['detected', 'Deposit detected'], ['processing', processing], ['done', 'Deposited successfully']];
  const at = steps.findIndex(([k]) => k === w.stage);
  const off = w.stage === 'failed' || w.stage === 'review' || w.stage === 'refunding';
  return (
    <div className={`fx-dprog${w.stage === 'failed' ? ' is-failed' : w.stage === 'review' ? ' is-review' : ''}`} role="status" aria-live="polite">
      <div className="fx-dprog__what">
        {w.row.amount ? `${w.row.amount} ${w.row.coin}` : w.row.coin}
        {w.row.chain ? <small> via {chainLabel(w.row.chain)}</small> : null}
      </div>
      {off ? (
        <p className={w.stage === 'failed' ? 'fx-dprog__fail' : 'fx-dprog__note'}>
          {w.stage === 'review'
            ? `SoDEX is holding this deposit for review (${raw}).`
            : w.stage === 'refunding'
              ? `SoDEX is refunding this deposit (${raw}).`
              : `SoDEX could not credit this deposit (${raw}). See Account History for details.`}
        </p>
      ) : (
        <ol className="fx-dprog__steps">
          {steps.map(([k, label], i) => (
            <li key={k} className={i < at ? 'is-past' : i === at ? 'is-now' : ''}>
              <span className="fx-dprog__dot" aria-hidden="true" />
              {label}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
