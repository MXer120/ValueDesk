/**
 * The legal gates of the app (texts in acceptance.ts, notices.ts; rules in
 * jurisdictions.mjs):
 *
 *   <SiteGate>          main.tsx, around App. In a sanctioned place (geo.ts) App is
 *                       not mounted at all - no market streams, no wallet, no
 *                       runners - only the legal pages and a notice of why. The
 *                       edge already answers 451 there (deploy/vercel); this is the
 *                       second check, for a legal page the edge let through.
 *   <TermsGate>         App.tsx: the first-visit clickwrap, until this browser has
 *                       accepted the current SITE_TERMS_VERSION. Never over a legal
 *                       page, so what it links to can be read first.
 *   useSiteTermsSheet() AccountController: the wallet signs the terms with its
 *                       country of residence before trading is enabled, and when a
 *                       new version asks for it (legalGate.ts SIGN_TERMS_EVENT).
 *   <LegalNote>         a one-line notice where it matters (notices.ts).
 *   <EmbedSwitches>     the Cookies page: withdraw consent for a video platform.
 *   openLegalPage()     any component: show a legal page in place (App listens).
 */
import { lazy, Suspense, useCallback, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { Modal } from '../components/Modal';
import { countries } from '../copy/countries';
import { LEGAL_LABELS, LEGAL_PAGES, legalForPath, pathForLegal, type LegalPage } from '../router';
import type { Eip1193Provider } from '../wallet';
import { WalletError } from '../wallet';
import {
  BROWSE_STATEMENTS,
  SITE_TERMS_VERSION,
  TRADE_STATEMENTS,
  acceptBrowse,
  acceptedBefore,
  browseAccepted,
  countryProblem,
  signSiteTerms,
  useAcceptanceRevision,
  type BrowseStatementId,
  type TradeStatementId,
} from './acceptance';
import { EMBED_PLATFORMS, EMBED_PROVIDERS, revokeEmbed, useEmbedConsent } from './embeds';
import { useViewerAccess } from './geo';
import { NOTICES, type NoticeId } from './notices';
import './gate.css';

/* ------------------------------------------------------------ open a page ----- */

export const OPEN_LEGAL_EVENT = 'vd:open-legal';

/** Show a legal page in place (App.tsx listens; without it, the link loads the page). */
export function openLegalPage(page: LegalPage): void {
  window.dispatchEvent(new CustomEvent<LegalPage>(OPEN_LEGAL_EVENT, { detail: page }));
}

const isPlainClick = (e: MouseEvent) => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);

/** A link to a legal page: a real link (middle-click, copy), a plain click opens it in place. */
export function LegalLink({ page, children, onOpen }: { page: LegalPage; children: ReactNode; onOpen?: (p: LegalPage) => void }) {
  return (
    <a
      href={pathForLegal(page)}
      className="lg-link"
      onClick={(e) => {
        if (!isPlainClick(e)) return;
        e.preventDefault();
        (onOpen ?? openLegalPage)(page);
      }}
    >
      {children}
    </a>
  );
}

/** Text with [label](/page) links to legal pages (the statements of acceptance.ts). */
export function LegalText({ text, onOpen }: { text: string; onOpen?: (p: LegalPage) => void }) {
  const parts = text.split(/(\[[^\]]+\]\(\/[a-z-]+\))/g);
  return (
    <>
      {parts.map((part, i) => {
        const m = /^\[([^\]]+)\]\((\/[a-z-]+)\)$/.exec(part);
        const page = m ? legalForPath(m[2]!) : null;
        return page ? <LegalLink key={i} page={page} onOpen={onOpen}>{m![1]}</LegalLink> : part;
      })}
    </>
  );
}

/** One notice line (notices.ts) with its link. */
export function LegalNote({ id, className }: { id: NoticeId; className?: string }) {
  const n = NOTICES[id];
  return (
    <p className={`lg-note${className ? ` ${className}` : ''}`}>
      {n.text} <LegalLink page={n.page}>{n.label}</LegalLink>
    </p>
  );
}

/* ---------------------------------------------------------- the site gate ----- */

const LegalViewLazy = lazy(() => import('./LegalView').then((m) => ({ default: m.LegalView })));

/** In a sanctioned place: the legal pages and the notice, nothing of the app. */
export function SiteGate({ children }: { children: ReactNode }) {
  const access = useViewerAccess();
  if (access.level !== 'blocked') return <>{children}</>;
  return <BlockedShell reason={access.reason ?? ''} />;
}

function BlockedShell({ reason }: { reason: string }) {
  const [page, setPage] = useState<LegalPage | null>(() => legalForPath(window.location.pathname));
  useEffect(() => {
    const onPop = () => setPage(legalForPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const open = useCallback((p: LegalPage) => {
    window.history.pushState(null, '', pathForLegal(p));
    setPage(p);
  }, []);
  return (
    <div className="lg-blocked">
      {page ? (
        <div className="lg-blocked__page">
          <Suspense fallback={null}><LegalViewLazy page={page} onOpen={open} /></Suspense>
        </div>
      ) : (
        <main className="lg-blocked__card" role="alert">
          <h1>ValueDesk is not available here</h1>
          <p>{reason}</p>
          <p>Please do not try to get around this restriction, for example with a VPN or a proxy. Funds in your own SoDEX account are not affected: ValueDesk never holds them.</p>
        </main>
      )}
      <nav className="lg-blocked__nav" aria-label="Legal">
        {LEGAL_PAGES.map((p) => (
          <LegalLink key={p} page={p} onOpen={open}>{LEGAL_LABELS[p]}</LegalLink>
        ))}
      </nav>
    </div>
  );
}

/* ------------------------------------------------- the first-visit clickwrap ----- */

/** The clickwrap, until this browser has accepted the current terms. `hidden` while a legal page is on screen. */
export function TermsGate({ hidden, onOpen }: { hidden: boolean; onOpen: (p: LegalPage) => void }) {
  useAcceptanceRevision();
  const access = useViewerAccess();
  const [ticks, setTicks] = useState<Partial<Record<BrowseStatementId, boolean>>>({});
  const accepted = !!browseAccepted();
  if (accepted || access.level === 'blocked') return null;
  const all = BROWSE_STATEMENTS.every((s) => ticks[s.id]);
  const changed = acceptedBefore();
  return (
    <Modal
      open={!hidden}
      size="md"
      title={changed ? 'Our terms have changed' : 'Before you use ValueDesk'}
      className="fx lg-gate"
      onClose={() => { /* accepting is the only way on; the legal pages stay open to read */ }}
      dismissOnBackdrop={false}
    >
      <p className="fx-note">
        {changed
          ? `Please read and accept the current version (${SITE_TERMS_VERSION}) to go on using ValueDesk.`
          : 'ValueDesk is a non-custodial interface to the SoDEX exchange, with market data, copy trading and algo orders. Please read and accept the terms first.'}
      </p>
      {access.level === 'close-only' && <p className="fx-note fx-note--warn">{access.reason}</p>}
      <div className="lg-checks">
        {BROWSE_STATEMENTS.map((s) => (
          <label key={s.id} className="lg-check">
            <input type="checkbox" checked={!!ticks[s.id]} onChange={(e) => setTicks({ ...ticks, [s.id]: e.target.checked })} />
            <span><LegalText text={s.label} onOpen={onOpen} /></span>
          </label>
        ))}
      </div>
      <div className="lg-actions">
        <button type="button" className="fx-cta" disabled={!all} onClick={() => acceptBrowse(BROWSE_STATEMENTS.filter((s) => ticks[s.id]).map((s) => s.id))}>
          Agree and continue
        </button>
      </div>
      <p className="lg-fine">
        Version {SITE_TERMS_VERSION}. Your acceptance is kept in this browser only. ValueDesk sets no cookies and uses no tracking: <LegalLink page="cookies" onOpen={onOpen}>Cookies and storage</LegalLink>.
      </p>
    </Modal>
  );
}

/* --------------------------------------------- the wallet signs the terms ----- */

interface SheetRequest {
  owner: string;
  provider: Eip1193Provider;
  resolve: (signed: boolean) => void;
}

const isRejection = (e: unknown): boolean => e instanceof WalletError && /reject|denied|cancel/i.test(e.message);

/**
 * `ask({owner, provider})` opens the sheet and resolves true once the wallet has
 * signed the current terms (false when closed); render `dialog` once.
 */
export function useSiteTermsSheet(): { ask: (o: { owner: string; provider: Eip1193Provider }) => Promise<boolean>; dialog: ReactNode } {
  const [req, setReq] = useState<SheetRequest | null>(null);
  const [country, setCountry] = useState('');
  const [ticks, setTicks] = useState<Partial<Record<TradeStatementId, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = useCallback(
    (o: { owner: string; provider: Eip1193Provider }) =>
      new Promise<boolean>((resolve) => {
        setError(null);
        setBusy(false);
        setReq((cur) => {
          cur?.resolve(false);
          return { ...o, resolve };
        });
      }),
    [],
  );
  const close = useCallback((signed: boolean) => {
    setReq((cur) => {
      cur?.resolve(signed);
      return null;
    });
  }, []);

  const problem = country ? countryProblem(country) : null;
  const all = TRADE_STATEMENTS.every((s) => ticks[s.id]);
  const sign = async () => {
    if (!req) return;
    setBusy(true);
    setError(null);
    try {
      await signSiteTerms({ provider: req.provider, owner: req.owner, country });
      close(true);
    } catch (e) {
      setError(isRejection(e) ? 'Nothing was signed. Sign in your wallet to accept the terms.' : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const dialog = req ? (
    <Modal open size="md" title="Accept the terms to trade" className="fx lg-sign" onClose={() => close(false)} dismissOnBackdrop={false}>
      <p className="fx-note">
        Before you trade through ValueDesk, your wallet signs the <LegalLink page="terms">Terms of use</LegalLink> and the <LegalLink page="risk">Risk disclosure</LegalLink> (version {SITE_TERMS_VERSION}) with your country of residence - our record of what you agreed to. The signature costs nothing and moves no funds.
      </p>
      <label className="fx-lbl" htmlFor="lg-country">Country of residence</label>
      <select id="lg-country" className="fx-sel lg-select" value={country} onChange={(e) => setCountry(e.target.value)}>
        <option value="">Choose…</option>
        {countries().map((c) => (
          <option key={c.code} value={c.code} disabled={!!countryProblem(c.code)}>
            {c.name}
            {countryProblem(c.code) ? ' - not available' : ''}
          </option>
        ))}
      </select>
      {problem && <p className="fx-note fx-note--err">{problem}</p>}
      <div className="lg-checks">
        {TRADE_STATEMENTS.map((s) => (
          <label key={s.id} className="lg-check">
            <input type="checkbox" checked={!!ticks[s.id]} onChange={(e) => setTicks({ ...ticks, [s.id]: e.target.checked })} />
            <span>{s.label}</span>
          </label>
        ))}
      </div>
      {error && <p className="fx-note fx-note--err" role="alert">{error}</p>}
      <div className="lg-actions">
        <button type="button" className="fx-cta" disabled={!country || !!problem || !all || busy} aria-busy={busy || undefined} onClick={() => void sign()}>
          {busy ? 'Waiting for wallet…' : 'Sign and accept'}
        </button>
        <button type="button" className="fx-link" onClick={() => close(false)}>Not now</button>
      </div>
    </Modal>
  ) : null;

  return { ask, dialog };
}

/* ----------------------------------------------- the video players' consent ----- */

/** The Cookies page's switches: which platforms' players may load, and withdrawing that. */
export function EmbedSwitches() {
  const consent = useEmbedConsent();
  return (
    <ul className="lg-embeds">
      {EMBED_PLATFORMS.map((p) => {
        const at = consent.allowed[p];
        return (
          <li key={p}>
            <span>
              <b>{EMBED_PROVIDERS[p].name}</b>{' '}
              {at !== undefined ? `allowed on ${new Date(at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}` : 'not allowed - its player does not load'}
            </span>
            {at !== undefined && <button type="button" className="fx-link" onClick={() => revokeEmbed(p)}>Withdraw consent</button>}
          </li>
        );
      })}
    </ul>
  );
}
