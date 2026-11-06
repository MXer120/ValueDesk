/**
 * The workspace bar.
 *
 * What used to sit here was a developer readout ("REST weight used 586/1200,
 * 2 hub client(s)") plus a printed shortcut list - two things that are useful
 * to whoever is BUILDING the terminal and to nobody who is trading on it. In a
 * professional terminal the bottom bar answers two questions instead: am I
 * connected, and which account am I acting as. Those are the two facts that
 * change the meaning of every number above them, so they get the one strip
 * that is always on screen.
 *
 * Layout follows that: connection then identity on the left (read first) and
 * the three things you might reach for on the right, each side divided from
 * the empty middle by a full-height rule.
 *
 * THE DEVELOPER READOUT IS A TOOLTIP NOW. "REST weight 449/1200, 6 hub
 * client(s)" was a third text block sitting in the middle of the bar. It was
 * already fenced behind `import.meta.env.DEV` so it never shipped, but a dev
 * build is what every screenshot and every side-by-side comparison is taken
 * against, so it was still the most visible thing in the bar for anyone
 * looking at the bar. It now rides on the connection element's `title`, where
 * it costs no pixels and is still one hover away from the person who needs it
 * - which is the same person who is hovering the connection status to begin
 * with when panels go stale.
 *
 * MULTI-ACCOUNT. The backend does serve a plural view - `GET /api/session`
 * carries `accounts[] / activeAddress / unlockedCount`, and there is a
 * dedicated `GET /api/session/accounts` - so the switcher is real: picking an
 * unlocked account POSTs `/api/session/active`, which is the address the next
 * signed order actually goes out under. But `SessionInfo` in api.ts has not
 * grown those fields yet and api.ts is outside this file's remit, so the rows
 * are read structurally (see `readAccounts`) and the component degrades to a
 * single non-switching chip if the field is absent. It never renders a list it
 * cannot actually switch between - a switcher that silently does nothing is
 * worse than no switcher, because it makes you believe you changed accounts.
 *
 * A locked account is listed but cannot be made active (the server refuses
 * with 409, correctly - "active" has to keep meaning "the key a write signs
 * with"), so its row routes to the wallet page to unlock instead.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePresence } from './motion';
import { useHoverMenu } from './useHoverMenu';
import type { SessionInfo } from '../api';
import { Modal } from './Modal';
import { useAddressMask } from '../privacy';
import { LEGAL_LABELS, LEGAL_PAGES, STATUS_PATH, pathForLegal, type LegalPage } from '../router';
import { FeedbackButton } from '../feedback/FeedbackButton';
import './StatusFooter.css';

/**
 * One stored account, as `accountRows()` in server/src/routes/wallet.ts emits
 * it. Only the fields this bar actually renders are declared; everything else
 * on the row (permissions, expiry, keyAddress) belongs to the wallet page.
 */
interface AccountRow {
  address: string;
  apiKeyName?: string;
  network?: string;
  protection?: 'memory';
  unlocked: boolean;
  active: boolean;
}

/**
 * Structural read of the plural view, with a runtime shape check.
 *
 * Returns null - not [] - when the backend predates multi-account, because the
 * two mean different things to the caller: null is "there is no plural view,
 * fall back to the single session", [] is "the plural view exists and is
 * empty, i.e. no keys are stored yet". Collapsing them would make a fresh
 * install look like an old server.
 */
function readAccounts(session: SessionInfo | null): AccountRow[] | null {
  const raw = (session as unknown as { accounts?: unknown } | null)?.accounts;
  if (!Array.isArray(raw)) return null;
  return raw.filter(
    (r): r is AccountRow =>
      typeof r === 'object' && r !== null && typeof (r as AccountRow).address === 'string',
  );
}

export interface StatusFooterProps {
  /** Human-readable connection state, already derived in App.tsx. */
  connLabel: string;
  /** True only when both the local hub AND the venue socket are up. */
  connOk: boolean;
  session: SessionInfo | null;
  /** The browser wallet address, which may exist with no stored key at all. */
  address: string | null;
  /** `/api/health`; untyped upstream, so read defensively. */
  health: { weightSpent?: number; weightLimit?: number; hub?: { clients?: number } } | null;
  onGoToWallet: () => void;
  /** The statistics page is gone; the footer button shows only when a destination is given. */
  onGoToStats?: () => void;
  /** Re-read the session after a switch, so the rest of the app follows. */
  onSessionChanged: () => void;
  /** Lifted so the `?` keyboard shortcut can open the same dialog. */
  helpOpen: boolean;
  onHelpOpen: (open: boolean) => void;
  /** The legal page on screen, if one is (its link reads as current). */
  legal?: LegalPage | null;
  /** Show a legal page in place. Without it the links load the page like any link. */
  onOpenLegal?: (page: LegalPage) => void;
  /** The status page is on screen (its link reads as current). */
  status?: boolean;
  /** Show the status page in place. Without it the link loads the page like any link. */
  onOpenStatus?: () => void;
}

export function StatusFooter({
  connLabel, connOk, session, address, health,
  onGoToWallet, onGoToStats, onSessionChanged, helpOpen, onHelpOpen, legal = null, onOpenLegal,
  status = false, onOpenStatus,
}: StatusFooterProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const accounts = readAccounts(session);
  // The signing account outranks the browser-connected one: it is what a write
  // is actually attributed to. `address` is only a fallback for the read-only
  // case where a wallet is connected but no key has been enabled yet.
  const activeRow = accounts?.find((a) => a.active) ?? null;
  const activeAddr = activeRow?.address ?? session?.session?.address ?? address ?? null;
  const canSwitch = (accounts?.length ?? 0) > 1;

  // Close on outside click. Bound on mousedown rather than click so a press
  // that starts outside the popup dismisses it before the underlying control
  // fires, which is what makes the menu feel non-modal.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [menuOpen]);

  const pick = useCallback(
    async (row: AccountRow) => {
      if (row.active) {
        setMenuOpen(false);
        return;
      }
      // A locked key cannot be made active - it has nothing to sign with - so
      // send the user where unlocking happens instead of firing a request the
      // server will (rightly) reject with 409.
      if (!row.unlocked) {
        setMenuOpen(false);
        onGoToWallet();
        return;
      }
      setBusy(row.address);
      setError(null);
      try {
        const res = await fetch('/api/session/active', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: row.address }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        setMenuOpen(false);
        onSessionChanged();
      } catch (e) {
        // Surfaced in the menu, not swallowed: the user believes they changed
        // the account a subsequent order signs under.
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [onGoToWallet, onSessionChanged],
  );

  // Sentence case, not the raw prop. App.tsx derives the label lower-case
  // ("live", "connecting", "hub ok · sodex closed") because it is a state name
  // rather than a sentence; the bar renders it as one. Done here rather than
  // with `text-transform: capitalize`, which would also capitalise "Sodex
  // Closed" mid-string, and never with `uppercase`, which nothing in this
  // terminal uses.
  const connWord = connLabel.charAt(0).toUpperCase() + connLabel.slice(1);

  // The REST budget and hub-client count, folded into the tooltip that already
  // names the connection state. Compiled out of a production build entirely by
  // the `import.meta.env.DEV` fence, exactly as the old inline readout was.
  const connTitle = import.meta.env.DEV
    ? `Connection: ${connWord} · REST weight ${health?.weightSpent ?? '—'}/${health?.weightLimit ?? '—'} per min · ${health?.hub?.clients ?? '—'} hub client(s)`
    : `Connection: ${connWord}`;

  /* The footer chip is on screen on every page, so it is the address most
     likely to end up in a screenshot. */
  const maskAddr = useAddressMask();
  const chipLabel = activeAddr ? maskAddr(activeAddr) : 'Connect account';
  // The sub-label is the account's STATE, never a placeholder. With a key
  // stored but locked, "locked" is the true answer; with a wallet connected
  // and no key, "read-only" is.
  const chipState = !activeAddr
    ? null
    : activeRow
      ? (activeRow.unlocked ? (activeRow.apiKeyName ?? 'unlocked') : 'locked')
      : session?.unlocked
        ? (session.session?.apiKeyName ?? 'unlocked')
        : 'read-only';

  return (
    <footer className="sfoot">
      <div className="sfoot-group">
        <span className="sfoot-conn" title={connTitle}>
          <span className={`sfoot-dot ${connOk ? 'ok' : 'warn'}`} />
          <span className="sfoot-connword">{connWord}</span>
        </span>

        <span className="sfoot-rule" aria-hidden="true" />

        <div className="sfoot-acct" ref={wrapRef}>
          <button
            type="button"
            className={`sfoot-chip ${activeAddr ? '' : 'none'} ${menuOpen ? 'open' : ''}`}
            aria-haspopup={canSwitch ? 'menu' : undefined}
            aria-expanded={canSwitch ? menuOpen : undefined}
            title={activeAddr ?? 'No account connected'}
            onClick={() => (canSwitch ? setMenuOpen((v) => !v) : onGoToWallet())}
          >
            <span className="sfoot-chipaddr">{chipLabel}</span>
            {chipState && <span className="sfoot-chipstate">{chipState}</span>}
            {/* The slot is unconditional, the caret inside it is not: the chip
                has to measure the same whether or not there is a second
                account to switch to, or the bar's identity read jumps sideways
                the moment a key is added. See `.sfoot-chipslot`. */}
            <span className="sfoot-chipslot" aria-hidden="true">{canSwitch && <Caret />}</span>
          </button>

          {menuOpen && accounts && (
            <div className="sfoot-pop" role="menu" aria-label="Switch account">
              <div className="sfoot-poplabel">
                Signing account
                {typeof session?.network === 'string' && session.network ? ` · ${session.network}` : ''}
              </div>
              {accounts.map((a) => (
                <button
                  key={a.address}
                  type="button"
                  role="menuitemradio"
                  aria-checked={a.active}
                  /* `current`, not `active`: styles.css owns a global
                     `button.active` (fill + a 2px accent rule along the BOTTOM
                     edge) which out-specifies this file's row rule and loads
                     after it, so the selected row picked up an underline it
                     was never meant to have. */
                  className={`sfoot-poprow ${a.active ? 'current' : ''}`}
                  disabled={busy !== null}
                  onClick={() => void pick(a)}
                >
                  <span className={`sfoot-dot ${a.unlocked ? 'ok' : ''}`} />
                  <span className="sfoot-popaddr">{maskAddr(a.address)}</span>
                  <span className="sfoot-popstate">
                    {busy === a.address ? 'switching…' : a.unlocked ? (a.apiKeyName ?? 'unlocked') : 'locked'}
                  </span>
                </button>
              ))}
              {error && <div className="sfoot-poperr">{error}</div>}
            </div>
          )}
        </div>

      </div>

      {/* The right cluster is divided from the empty middle by the same rule
          that divides the left one. The reference has both; we only ever drew
          the first, which left the icons floating off the window's edge with
          nothing to belong to.

          Three controls, and each one goes somewhere real. The wallet button
          absorbed the "add another account" plus that used to sit beside the
          chip: the reference keeps its left cluster to status and identity
          only, and the destination was the wallet page in both cases, so this
          is one button fewer for the same reach. */}
      <div className="sfoot-group sfoot-right">
        {/* Send feedback: on every page, never behind a menu (feedback/FeedbackButton.tsx). The
            shell test fails without it - the site does not go live without it (docs/GO-LIVE.md). */}
        <FeedbackButton />
        {/* The status page (status/StatusPage.tsx): whether the site, the data and the copy
            executor are up, and their last 90 days. A page of its own, like the legal ones. */}
        <a
          href={STATUS_PATH}
          className="sfoot-link sfoot-link--status"
          aria-current={status ? 'page' : undefined}
          onClick={(e) => {
            if (!onOpenStatus || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            setMenuOpen(false);
            onOpenStatus();
          }}
        >
          Status
        </a>
        {/* The Impressum, privacy policy and terms: required to be reachable from every page, and this
            bar is the one strip every page has. One entry that names the Impressum, a menu of all the
            documents (owner 2026-11-06: the row of seven words was too much). */}
        <LegalMenu legal={legal} onOpenLegal={onOpenLegal ? (p) => { setMenuOpen(false); onOpenLegal(p); } : undefined} />
        <span className="sfoot-rule" aria-hidden="true" />
        <button
          type="button"
          className="sfoot-icon"
          title="Wallet and accounts"
          aria-label="Wallet and accounts"
          onClick={() => {
            setMenuOpen(false);
            onGoToWallet();
          }}
        >
          <WalletIcon />
        </button>
        <button
          type="button"
          className="sfoot-icon"
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          onClick={() => onHelpOpen(true)}
        >
          <HelpIcon />
        </button>
        {onGoToStats && (
          <button
            type="button"
            className="sfoot-icon"
            title="Statistics"
            aria-label="Statistics"
            onClick={onGoToStats}
          >
            <StatsIcon />
          </button>
        )}
      </div>

      <ShortcutsDialog open={helpOpen} onClose={() => onHelpOpen(false)} />
    </footer>
  );
}

/**
 * The shortcut list, previously a native `alert()` - which cannot be styled,
 * cannot render a <kbd>, blocks the whole tab, and (the real problem on a
 * trading screen) cannot be dismissed by clicking away from it.
 */
/* The modifier is platform-dependent and the old alert() hedged with
   "⌘/Ctrl+K", which makes the reader do the work. Detected once at module
   load; `navigator.platform` is deprecated but is the only signal that is
   universally present, and a wrong guess here costs one wrong glyph, not a
   broken shortcut - the handler accepts either modifier regardless. */
const MOD = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';

const SHORTCUTS: Array<[string[], string]> = [
  [['1', '…', '6'], 'switch page'],
  [[MOD, 'K'], 'search markets'],
  [['/'], 'search markets'],
  [['c'], 'cancel all open orders'],
  [['?'], 'this help'],
];

function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      title="Keyboard shortcuts"
      onClose={onClose}
      footer={<button className="btn-primary" onClick={onClose}>Close</button>}
    >
      <dl className="sfoot-keys">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={what + keys.join()} className="sfoot-keyrow">
            <dt>
              {keys.map((k, i) => (k === '…' ? <span key={i} className="muted">…</span> : <kbd key={i}>{k}</kbd>))}
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      <p className="muted small sfoot-keynote">
        Shortcuts are inert while a text field has focus, so typing a quantity never fires a trading
        action. Any other printable key starts a market search with it.
      </p>
    </Modal>
  );
}

/* Icons are inline and stroked in `currentColor` so they inherit the muted ->
   --text colour change the buttons carry on hover, rather than needing a
   second fill rule per state.
 *
 * 16px viewBoxes in a 20px button, with every path drawn to REACH the viewBox
 * edges. The reference's trailing glyphs measure 14-16px of ink and the last of
 * them ends 18px from the window's right edge; ours ended at 21px, which is not
 * a padding error - the bar's 16px inset is already exact at both ends - but a
 * drawing that sat ~2px inside its own box on every side. The rectangle, the
 * circle radius and the outer bar positions below are therefore chosen so the
 * STROKE's outer edge lands on the viewBox, not the path's centre line.
 *
 * Drawn here rather than imported - they are four paths, and a glyph set is
 * exactly the kind of thing that must not be lifted from the terminal we
 * measured. */
const Caret = () => (
  <svg className="sfoot-glyph" viewBox="0 0 16 16" width="9" height="9" aria-hidden="true">
    <path d="M3 10l5-5 5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const WalletIcon = () => (
  <svg className="sfoot-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <rect x="1.15" y="2.65" width="13.7" height="10.7" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <path d="M1.15 6h13.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="11.5" cy="10.4" r="0.95" fill="currentColor" />
  </svg>
);

const HelpIcon = () => (
  <svg className="sfoot-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <circle cx="8" cy="8" r="6.85" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <path
      d="M6.2 6a1.9 1.9 0 1 1 2.5 2c-.45.22-.7.55-.7 1v.35"
      fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"
    />
    <circle cx="8" cy="11.7" r="0.9" fill="currentColor" />
  </svg>
);

const StatsIcon = () => (
  <svg className="sfoot-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path
      d="M1.25 14.2V8.6M8 14.2V2.4M14.75 14.2V6.2"
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
    />
  </svg>
);

/** The legal documents behind one entry: opens upward, on hover or a press, like the bar's other pop-ups (useHoverMenu.ts). */
function LegalMenu({ legal, onOpenLegal }: { legal: LegalPage | null; onOpenLegal?: (page: LegalPage) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const { open, close, press, hoverProps } = useHoverMenu(root);
  const pres = usePresence(open);
  return (
    <div className="sfoot-legal" ref={root} {...hoverProps}>
      <button type="button" className={`sfoot-link sfoot-legal__btn${legal ? ' is-here' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={press}>
        <span lang="de">Impressum</span><span className="sfoot-legal__more"> &amp; legal</span>
      </button>
      {pres.mounted && (
        <nav
          className={`menu-popup sfoot-legal__menu navpop${pres.closing ? ' is-closing' : ''}`}
          aria-label="Legal"
          onAnimationEnd={(e) => { if (pres.closing && e.animationName === 'mo-pop-out') pres.done(); }}
        >
          {LEGAL_PAGES.map((p) => (
            <a
              key={p}
              href={pathForLegal(p)}
              lang={p === 'impressum' ? 'de' : undefined}
              className={`menu-row${legal === p ? ' is-current' : ''}`}
              aria-current={legal === p ? 'page' : undefined}
              onClick={(e) => {
                if (!onOpenLegal || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                close();
                onOpenLegal(p);
              }}
            >
              <span className="menu-row__label">{LEGAL_LABELS[p]}</span>
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}
