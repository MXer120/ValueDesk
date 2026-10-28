/**
 * OUR Connect dialog: the first and only thing any Connect button opens
 * (connect.ts:openConnectDialog). Mounted once, by AccountController.
 *
 * It is laid out like the owner's reference - "Connect", a round close button,
 * an email row, an "or" rule, SafePal / Bitget / MetaMask / WalletConnect /
 * Other Wallet - and drawn with Valuetrade's modal treatment (ConnectDialog.css).
 * AppKit appears only AFTER a row is pressed, and only the part of it that row
 * needs; walletconnect.ts:connectVia decides which, per device. This file knows
 * the routes by name and nothing about AppKit itself.
 *
 * TWO LAYERS, EACH WITH ITS OWN LIFE:
 *  - the SCRIM (the tint and the blur over the page) is up from the session's
 *    first frame to its last, AppKit included: while AppKit is in front, it is
 *    the backdrop AppKit sits on (AppKit's own overlay is switched off -
 *    walletconnect.ts:shareBackdrop). No frame of a session is ever unblurred,
 *    and the page is never tinted twice;
 *  - the CARD steps out of AppKit's way and back.
 *
 * THE SESSION, from open to close:
 *  - open: scrim and card animate in, and AppKit is warmed up behind them so the
 *    next step is not a second-long wait.
 *  - a wallet row with its extension present: the row says "Confirm in
 *    MetaMask" while the extension's own prompt is up. No AppKit UI at all.
 *  - any other row: AppKit opens on the right view with its own entrance, and
 *    the card animates out underneath it (session kept, scrim untouched). If
 *    AppKit is closed WITHOUT a wallet, the card animates back in WHILE AppKit
 *    fades out, with the row that was tried focused - a "back", not a dead end;
 *    Esc or the close button then ends it. That is the documented choice for
 *    "the user closed AppKit": return here.
 *  - a wallet connects, by any route: everything leaves in one motion - AppKit
 *    (it closes itself), the card if it is up, and the scrim - and the navbar
 *    shows the address exactly as before; that state arrives through the wallet
 *    snapshot, not through this component.
 *
 * Accessibility: a real `dialog` labelled by its title, focus moved in on open
 * and back to the invoking control on close, Tab trapped inside, Esc and a
 * backdrop press close it. The email row is announced as unavailable
 * (`aria-disabled`, described by its "Coming soon" label) and does nothing.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { notifyError } from '../../toast';
import { discoverWallets, onWallets, type WalletInfo } from '../../wallet';
import {
  ConnectRejectedError,
  FEATURED_WALLETS,
  WALLETCONNECT_IMAGE_ID,
  closeWalletModal,
  connectVia,
  connectorImageUrl,
  findInstalled,
  initWallet,
  isWalletConnected,
  isWalletModalUp,
  onWalletModalClosed,
  routeFor,
  walletImageUrl,
  type ConnectChoice,
  type ConnectRoute,
} from '../../walletconnect';
import { getAccountPending, setAccountPending } from './actions';
import { closeConnectDialog, useConnectDialogOpen } from './connect';
import { useWalletSnapshot } from './useWallet';
import './ConnectDialog.css';

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The exit animations are --dur-fast (140ms); this only covers a lost `animationend`. */
const LEAVE_FALLBACK_MS = 320;

/** How often a card waiting behind AppKit checks that AppKit is really still there. */
const AWAY_WATCH_MS = 400;

/**
 * Where the session is. `scrim` is the backdrop: 'off' (no session), 'on', or
 * 'leaving' (its exit animation; the session ends when it has run). `card` is
 * the dialog itself: 'shown', 'leaving' (its exit animation), or 'away' (not
 * rendered - AppKit is in front of the scrim).
 */
interface Stage {
  scrim: 'off' | 'on' | 'leaving';
  card: 'shown' | 'leaving' | 'away';
}
const NO_SESSION: Stage = { scrim: 'off', card: 'away' };

interface Attempt {
  choice: ConnectChoice;
  route: ConnectRoute;
}

interface Row {
  choice: ConnectChoice;
  label: string;
  /** Icon candidates, best first. Empty = a text-only row. */
  icons: string[];
  installed: boolean;
}

export function ConnectDialog() {
  const active = useConnectDialogOpen();
  const wallet = useWalletSnapshot();
  const [stage, setStage] = useState<Stage>(NO_SESSION);
  const [busy, setBusy] = useState<Attempt | null>(null);
  const [note, setNote] = useState('');
  const [discovered, setDiscovered] = useState<readonly WalletInfo[]>([]);
  const titleId = useId();

  const sheetRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage>(NO_SESSION);
  const activeRef = useRef(active);
  activeRef.current = active;
  const busyRef = useRef<Attempt | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const lastChoice = useRef<ConnectChoice | null>(null);
  /** Bumped whenever an in-flight attempt stops mattering (closed, or superseded). */
  const attemptSeq = useRef(0);
  const offModal = useRef<(() => void) | null>(null);

  const go = useCallback((next: Stage) => {
    stageRef.current = next;
    setStage(next);
  }, []);

  const setAttempt = useCallback((a: Attempt | null) => {
    busyRef.current = a;
    setBusy(a);
  }, []);

  /* Every EIP-6963 announcement, live: drives the "Installed" tags. */
  useEffect(() => onWallets((list) => setDiscovered(list)), []);

  /* The session is over: nothing on screen, nothing waiting behind AppKit. */
  const finish = useCallback(() => {
    attemptSeq.current++;
    offModal.current?.();
    offModal.current = null;
    go(NO_SESSION);
    setAttempt(null);
    if (getAccountPending() === 'connect') setAccountPending(null);
    closeConnectDialog();
    const back = restoreTo.current;
    restoreTo.current = null;
    /* After the render this triggers, not now: the navbar's Connect, the
       ticket's button and the menu's Reconnect are DISABLED while a connect is
       pending, so a close during an extension prompt found them still disabled
       here and focus fell to <body>. */
    if (back) {
      window.setTimeout(() => {
        if (back.isConnected && !back.matches(':disabled')) back.focus({ preventScroll: true });
      }, 0);
    }
  }, [go, setAttempt]);

  /** End the session: the card (if it is up) and the scrim leave in one motion. */
  const close = useCallback(() => {
    const { scrim, card } = stageRef.current;
    if (scrim === 'off') {
      finish();
      return;
    }
    if (scrim === 'leaving') return;
    go({ scrim: 'leaving', card: card === 'away' ? 'away' : 'leaving' });
  }, [finish, go]);

  /** AppKit is in front now: the card animates out under it, the scrim stays. */
  const stepAside = useCallback(() => {
    const { scrim, card } = stageRef.current;
    if (scrim === 'on' && card === 'shown') go({ scrim: 'on', card: 'leaving' });
  }, [go]);

  /** AppKit is leaving without a wallet: the card animates back in during its fade. */
  const comeBack = useCallback(() => {
    const { scrim, card } = stageRef.current;
    if (scrim === 'on' && card !== 'shown') go({ scrim: 'on', card: 'shown' });
  }, [go]);

  const onCardLeft = useCallback(() => {
    const { scrim, card } = stageRef.current;
    if (scrim === 'on' && card === 'leaving') go({ scrim: 'on', card: 'away' });
  }, [go]);

  const onScrimLeft = useCallback(() => {
    if (stageRef.current.scrim === 'leaving') finish();
  }, [finish]);

  /* Session start. */
  useEffect(() => {
    if (!active || stageRef.current.scrim !== 'off') return;
    const focused = document.activeElement;
    restoreTo.current = focused instanceof HTMLElement && focused !== document.body ? focused : null;
    lastChoice.current = null;
    setNote('');
    setAttempt(null);
    go({ scrim: 'on', card: 'shown' });
    discoverWallets();
    /* Warm-up: loading and starting AppKit is most of the wait after a row is
       pressed, and the user asked to connect by opening this. A failure (no
       project id, offline) is reported by the row that needs it, not here. */
    void initWallet().catch(() => {});
  }, [active, go, setAttempt]);

  /* A lost `animationend` must not leave an invisible sheet catching clicks, or
     a scrim that never goes. */
  useEffect(() => {
    const done = stage.scrim === 'leaving' ? onScrimLeft : stage.card === 'leaving' ? onCardLeft : null;
    if (!done) return;
    const t = window.setTimeout(done, LEAVE_FALLBACK_MS);
    return () => window.clearTimeout(t);
  }, [stage.scrim, stage.card, onScrimLeft, onCardLeft]);

  /* Behind AppKit, the card waits to be told AppKit has gone. Should that word
     ever be lost, it must not leave a bare scrim over the page: look now and
     then, and come back if AppKit is no longer there. */
  useEffect(() => {
    if (stage.scrim !== 'on' || stage.card !== 'away') return;
    const t = window.setInterval(() => {
      if (!isWalletModalUp()) comeBack();
    }, AWAY_WATCH_MS);
    return () => window.clearInterval(t);
  }, [stage.scrim, stage.card, comeBack]);

  /* Connected, by whatever route: done. */
  const prevStatus = useRef(wallet.status);
  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = wallet.status;
    if (activeRef.current && was !== 'connected' && wallet.status === 'connected') close();
  }, [wallet.status, close]);

  const cardUp = stage.scrim === 'on' && stage.card === 'shown';

  /* Focus: into the sheet on open, onto the row last tried when coming back. */
  useEffect(() => {
    if (!cardUp) return;
    const node = sheetRef.current;
    if (!node) return;
    const target = lastChoice.current
      ? node.querySelector<HTMLElement>(`[data-choice="${lastChoice.current}"]`)
      : node.querySelector<HTMLElement>('[data-choice]');
    (target ?? node).focus({ preventScroll: true });
  }, [cardUp]);

  /* Esc and the focus trap, bound at document level like Modal.tsx. */
  useEffect(() => {
    if (!cardUp) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      /* No key reaches the page behind. App.tsx binds single-key shortcuts on
         window (digits switch tabs, any other printable key - Space included -
         opens the market search), and Space is how a keyboard presses a row
         here, so it opened the palette over this dialog. Nor does Tab reach
         AppKit's own window listener while its card is still fading out behind
         ours: it would pull focus into that card. Stopping propagation does not
         cancel a key's default action: Enter and Space still press the focused
         button, and Tab still moves focus - within the trap below. */
      e.stopPropagation();
      if (e.key !== 'Tab') return;
      const node = sheetRef.current;
      if (!node) return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const inside = node.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [cardUp, close]);

  useEffect(() => () => {
    offModal.current?.();
  }, []);

  /* AppKit is leaving - told on the first frame of its exit. With a wallet:
     leave together. Without: come back while it fades. */
  const onModalLeft = useCallback((connected: boolean) => {
    offModal.current?.();
    offModal.current = null;
    if (!activeRef.current) return;
    if (connected || isWalletConnected()) close();
    else comeBack();
  }, [close, comeBack]);

  const choose = useCallback(async (choice: ConnectChoice) => {
    const now = stageRef.current;
    if (now.scrim !== 'on' || now.card !== 'shown') return;
    /* One AppKit view at a time. An extension prompt, on the other hand, can sit
       unanswered forever, so it never blocks trying another row. */
    const inFlight = busyRef.current;
    if (inFlight && inFlight.route !== 'extension') return;

    const seq = ++attemptSeq.current;
    /* Still the attempt that counts, in a session that is not ending. */
    const wanted = () => seq === attemptSeq.current && activeRef.current && stageRef.current.scrim === 'on';
    const route = routeFor(choice, discovered);
    lastChoice.current = choice;
    setNote('');
    setAttempt({ choice, route });
    setAccountPending('connect');
    try {
      const taken = await connectVia(choice, route, wanted);
      if (taken === 'extension') return; /* connected - the status effect closes us */
      if (!wanted()) {
        /* Closed while AppKit was still loading: it must not stay up over a
           page the user has already gone back to. (Replaced by another row
           instead: whatever AppKit shows now is that row's.) */
        if (!activeRef.current || stageRef.current.scrim !== 'on') closeWalletModal();
        return;
      }
      offModal.current?.();
      offModal.current = onWalletModalClosed(onModalLeft);
      stepAside();
    } catch (e) {
      if (seq !== attemptSeq.current) return;
      if (e instanceof ConnectRejectedError) setNote(e.message);
      else notifyError('Connect wallet', e);
    } finally {
      if (seq === attemptSeq.current) {
        setAttempt(null);
        if (getAccountPending() === 'connect') setAccountPending(null);
      }
    }
  }, [discovered, onModalLeft, setAttempt, stepAside]);

  if (stage.scrim === 'off') return null;
  const ending = stage.scrim === 'leaving';

  const rows: Row[] = [
    ...FEATURED_WALLETS.map((w): Row => {
      const found = findInstalled(w, discovered);
      const icons = [walletImageUrl(w.imageId), found?.via === 'announced' ? found.icon : null];
      return { choice: w.key, label: w.label, icons: icons.filter((s): s is string => !!s), installed: !!found };
    }),
    {
      choice: 'walletconnect',
      label: 'WalletConnect',
      icons: [connectorImageUrl(WALLETCONNECT_IMAGE_ID)].filter((s): s is string => !!s),
      installed: false,
    },
    { choice: 'other', label: 'Other Wallet', icons: [], installed: false },
  ];

  return createPortal(
    <div
      className="cdlg-scrim"
      data-state={ending ? 'closing' : 'open'}
      data-card={stage.card === 'away' ? 'away' : undefined}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !ending) close();
      }}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) onScrimLeft();
      }}
    >
      {stage.card !== 'away' && (
        <div
          ref={sheetRef}
          className="cdlg"
          data-state={stage.card === 'leaving' ? 'closing' : 'open'}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget) onCardLeft();
          }}
        >
          <div className="cdlg-head">
            <h2 id={titleId} className="cdlg-title">Connect</h2>
            <button type="button" className="cdlg-close" aria-label="Close" onClick={close}>
              <CloseGlyph />
            </button>
          </div>


          <div className="cdlg-or" aria-hidden="true">or</div>

          <div className="cdlg-list">
            {rows.map((row) => {
              const mine = busy?.choice === row.choice ? busy : null;
              return (
                <button
                  key={row.choice}
                  type="button"
                  className="cdlg-row"
                  data-choice={row.choice}
                  aria-busy={mine ? true : undefined}
                  onClick={() => { void choose(row.choice); }}
                >
                  <span className="cdlg-row__body">
                    {row.icons.length > 0 && (
                      <WalletIcon key={row.icons.join('|')} sources={row.icons} label={row.label} />
                    )}
                    <span className="cdlg-row__label">{row.label}</span>
                  </span>
                  <span className="cdlg-row__aside">
                    {mine ? (
                      <>
                        <span className="cdlg-wait">
                          {mine.route === 'extension' ? `Confirm in ${row.label}` : 'Opening…'}
                        </span>
                        <span className="cdlg-spin" aria-hidden="true" />
                      </>
                    ) : row.installed ? (
                      <span className="cdlg-tag">Installed</span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>

          <p className="cdlg-note" role="status" aria-live="polite">{note}</p>
        </div>
      )}
    </div>,
    document.body,
  );
}

/**
 * A wallet icon that never shows as broken: AppKit's own image first, then the
 * icon the extension announced (when it is installed), then a plain wallet
 * glyph on a control tile - never a letter (owner, 2026-10-28).
 */
function WalletIcon({ sources, label }: { sources: string[]; label: string }) {
  const [failed, setFailed] = useState(0);
  const src = sources[failed];
  if (!src) {
    return (
      <span className="cdlg-icon cdlg-icon--mono" title={label} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="70%" height="70%">
          <rect x="3" y="6" width="18" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M3 9.5h18" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="16.5" cy="14" r="1.3" fill="currentColor" />
        </svg>
      </span>
    );
  }
  return (
    <img
      className="cdlg-icon"
      src={src}
      alt=""
      width={24}
      height={24}
      decoding="async"
      draggable={false}
      onError={() => setFailed((n) => n + 1)}
    />
  );
}

const CloseGlyph = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
