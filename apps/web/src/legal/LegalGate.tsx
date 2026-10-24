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
 *                       accepted the current SITE_TERMS_VERSION - with a connected
 *                       wallet, ticked AND signed in one step (one free signature);
 *                       a wallet that connects later is asked once to sign what was
 *                       ticked. Never over a legal page, so what it links to can be
 *                       read first.
 *   useSiteTermsSheet() AccountController: the same form, when trading is enabled
 *                       by a wallet that has not signed, or a new version asks for it
 *                       (legalGate.ts SIGN_TERMS_EVENT).
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
  SITE_TERMS_VERSION,
  STATEMENTS,
  acceptBrowse,
  acceptedBefore,
  browseAccepted,
  countryProblem,
  signSiteTerms,
  signedTerms,
  useAcceptanceRevision,
  type StatementId,
} from './acceptance';
import { EMBED_PLATFORMS, EMBED_PROVIDERS, revokeEmbed, useEmbedConsent } from './embeds';
import { useViewerAccess } from './geo';
import { screeningOf, useScreening } from './screening';
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

/* ------------------------------------------------- accepting, and signing ----- */

const isRejection = (e: unknown): boolean => e instanceof WalletError && /reject|denied|cancel/i.test(e.message);

/** Wallets that chose "Not now" for the signature in this page load: the gate does not ask them again. */
const skipped = new Set<string>();

interface TermsFormProps {
  /** The statements must be ticked here (false: they were ticked before and are shown for the signature). */
  needTicks: boolean;
  /** The connected wallet that signs - null: no wallet, the statements are only ticked. */
  signer: { owner: string; provider: Eip1193Provider } | null;
  onOpen?: (p: LegalPage) => void;
  /** Accepted: 'signed' by the wallet, or only 'ticked'. */
  onDone: (how: 'signed' | 'ticked') => void;
  /** The second button: accept without the signature, or put the signature off. */
  secondary?: { label: string; onClick: () => void; needsTicks?: boolean } | null;
}

/**
 * The statements and, with a wallet, the country of residence and ONE free
 * signature (acceptance.ts) - the body of the first-visit gate and of the
 * sheet before trading.
 */
function TermsForm({ needTicks, signer, onOpen, onDone, secondary }: TermsFormProps) {
  const [ticks, setTicks] = useState<Partial<Record<StatementId, boolean>>>({});
  const [country, setCountry] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allTicked = !needTicks || STATEMENTS.every((s) => ticks[s.id]);
  const problem = country ? countryProblem(country) : null;

  const primary = async () => {
    setError(null);
    if (!signer) {
      acceptBrowse(STATEMENTS.map((s) => s.id));
      onDone('ticked');
      return;
    }
    setBusy(true);
    try {
      await signSiteTerms({ provider: signer.provider, owner: signer.owner, country });
      onDone('signed');
    } catch (e) {
      setError(isRejection(e) ? 'Nothing was signed. Sign the message in your wallet to accept the terms.' : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {needTicks ? (
        <div className="lg-checks">
          {STATEMENTS.map((s) => (
            <label key={s.id} className="lg-check">
              <input type="checkbox" checked={!!ticks[s.id]} onChange={(e) => setTicks({ ...ticks, [s.id]: e.target.checked })} />
              <span><LegalText text={s.label} onOpen={onOpen} /></span>
            </label>
          ))}
        </div>
      ) : (
        <ul className="lg-confirm">
          {STATEMENTS.map((s) => <li key={s.id}><LegalText text={s.label} onOpen={onOpen} /></li>)}
        </ul>
      )}
      {signer && (
        <>
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
          <p className="lg-fine">
            Your wallet signs one message with these statements and the terms&rsquo; version. It is free: a signature, not a transaction - no gas, and no funds move.
          </p>
        </>
      )}
      {error && <p className="fx-note fx-note--err" role="alert">{error}</p>}
      <div className="lg-actions">
        <button
          type="button"
          className="fx-cta"
          disabled={!allTicked || busy || (!!signer && (!country || !!problem))}
          aria-busy={busy || undefined}
          onClick={() => void primary()}
        >
          {busy ? 'Waiting for wallet…' : signer ? 'Sign and accept' : 'Agree and continue'}
        </button>
        {secondary && (
          <button type="button" className="fx-link" disabled={busy || (!!secondary.needsTicks && !allTicked)} onClick={secondary.onClick}>
            {secondary.label}
          </button>
        )}
      </div>
    </>
  );
}

/**
 * The first-visit gate (App.tsx), until this browser has accepted the current
 * terms - signed by the connected wallet where there is one that may trade, in
 * the same step. A wallet that connects after the statements were ticked is
 * asked once to sign them (it may put that off: trading asks again). Never over
 * a legal page (`hidden`), so what it links to can be read first.
 */
export function TermsGate({ hidden, onOpen, address, provider }: {
  hidden: boolean;
  onOpen: (p: LegalPage) => void;
  address: string | null;
  provider: Eip1193Provider | null;
}) {
  useAcceptanceRevision();
  useScreening(address);
  const access = useViewerAccess();
  const [, setTick] = useState(0);
  const accepted = !!browseAccepted();
  const owner = address ? address.toLowerCase() : null;
  const mayTrade = !!owner && !!provider && access.level === 'open' && screeningOf(owner) !== 'sanctioned';
  const signer = mayTrade && !signedTerms(owner) && !skipped.has(owner!) ? { owner: owner!, provider: provider! } : null;
  if (access.level === 'blocked' || (accepted && !signer)) return null;
  const changed = acceptedBefore();
  const skip = () => {
    if (owner) skipped.add(owner);
    setTick((n) => n + 1);
  };
  return (
    <Modal
      open={!hidden}
      size="md"
      title={accepted ? 'Sign the terms with your wallet' : changed ? 'Our terms have changed' : 'Before you use ValueDesk'}
      className={`fx${accepted ? '' : ' lg-gate'}`}
      // Accepting is the only way on; once the statements are ticked, the signature can wait.
      onClose={() => { if (accepted) skip(); }}
      dismissOnBackdrop={false}
    >
      <p className="fx-note">
        {accepted
          ? 'You accepted these terms in this browser. Sign them with this wallet, once, so it can trade: ValueDesk keeps the signature as its record of what you agreed to.'
          : changed
            ? `Please read and accept the current version (${SITE_TERMS_VERSION}) to go on using ValueDesk.`
            : 'ValueDesk is a non-custodial interface to the SoDEX exchange, with market data, copy trading and algo orders. Please read and accept the terms first.'}
      </p>
      {access.level === 'close-only' && <p className="fx-note fx-note--warn">{access.reason}</p>}
      <TermsForm
        key={signer ? `sign:${signer.owner}` : 'tick'}
        needTicks={!accepted}
        signer={signer}
        onOpen={onOpen}
        onDone={() => setTick((n) => n + 1)}
        secondary={
          !signer ? null
          : accepted ? { label: 'Not now', onClick: skip }
          : { label: 'Agree, and sign before I trade', needsTicks: true, onClick: () => { acceptBrowse(STATEMENTS.map((s) => s.id)); skip(); } }
        }
      />
      <p className="lg-fine">
        Version {SITE_TERMS_VERSION}. ValueDesk sets no cookies and uses no tracking: <LegalLink page="cookies" onOpen={onOpen}>Cookies and storage</LegalLink>. Copy trading asks for its own terms before the first copy.
      </p>
    </Modal>
  );
}

interface SheetRequest {
  owner: string;
  provider: Eip1193Provider;
  resolve: (signed: boolean) => void;
}

/**
 * `ask({owner, provider})` opens the signing sheet and resolves true once the
 * wallet has signed the current terms (false when closed); render `dialog`
 * once. AccountController asks before it enables trading, and when an opening
 * order was refused for a missing signature (legalGate.ts SIGN_TERMS_EVENT).
 */
export function useSiteTermsSheet(): { ask: (o: { owner: string; provider: Eip1193Provider }) => Promise<boolean>; dialog: ReactNode } {
  const [req, setReq] = useState<SheetRequest | null>(null);
  useAcceptanceRevision();

  const ask = useCallback(
    (o: { owner: string; provider: Eip1193Provider }) =>
      new Promise<boolean>((resolve) => {
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

  const dialog = req ? (
    <Modal open size="md" title="Sign the terms to trade" className="fx lg-sign" onClose={() => close(false)} dismissOnBackdrop={false}>
      <p className="fx-note">
        Before you trade through ValueDesk, your wallet signs the <LegalLink page="terms">Terms of use</LegalLink> and the <LegalLink page="risk">Risk disclosure</LegalLink> (version {SITE_TERMS_VERSION}) with your country of residence - our record of what you agreed to.
      </p>
      <TermsForm
        key={req.owner}
        needTicks={!browseAccepted()}
        signer={{ owner: req.owner, provider: req.provider }}
        onDone={() => close(true)}
        secondary={{ label: 'Not now', onClick: () => close(false) }}
      />
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
