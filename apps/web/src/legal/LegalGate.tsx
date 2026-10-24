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
import { FxSelect } from '../components/funds/ui';
import { countries, countryName } from '../copy/countries';
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
} from './acceptance';
import { EMBED_PLATFORMS, EMBED_PROVIDERS, revokeEmbed, useEmbedConsent } from './embeds';
import { useViewerAccess, useViewerGeo } from './geo';
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

const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

interface TermsFormProps {
  /** The connected wallet that signs - null: no wallet, the statements are only confirmed. */
  signer: { owner: string; provider: Eip1193Provider } | null;
  onOpen?: (p: LegalPage) => void;
  /** Accepted: 'signed' by the wallet, or only 'confirmed' in this browser. */
  onDone: (how: 'signed' | 'confirmed') => void;
  /** The quiet second button: accept without the signature, or put the signature off. */
  secondary?: { label: string; onClick: () => void } | null;
}

/**
 * The four statements under ONE "I confirm" and, with a wallet, ONE free
 * signature (acceptance.ts) - the body of the first-visit gate and of the sheet
 * before trading. The country of residence is the one the edge saw (geo.ts),
 * shown with the wallet; it is asked only where the edge could not tell, and
 * can be changed (a traveller).
 */
function TermsForm({ signer, onOpen, onDone, secondary }: TermsFormProps) {
  const geo = useViewerGeo();
  const [confirmed, setConfirmed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detected = geo.country && !countryProblem(geo.country) ? geo.country : null;
  const country = picked ?? detected ?? '';
  const problem = country ? countryProblem(country) : null;
  const choosing = !!signer && (changing || !detected);

  const primary = async () => {
    setError(null);
    if (!signer) {
      acceptBrowse(STATEMENTS.map((s) => s.id));
      onDone('confirmed');
      return;
    }
    setBusy(true);
    try {
      await signSiteTerms({ provider: signer.provider, owner: signer.owner, country });
      onDone('signed');
    } catch (e) {
      setError(isRejection(e) ? 'Nothing was signed. Approve the message in your wallet to continue.' : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <label className={`lg-card lg-card--confirm${confirmed ? ' is-on' : ''}`}>
        <span className="lg-card__head">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>I confirm that</span>
        </span>
        <ul className="lg-points">
          {STATEMENTS.map((s) => <li key={s.id}><LegalText text={s.label} onOpen={onOpen} /></li>)}
        </ul>
      </label>

      {signer && (
        <div className="lg-card lg-card--wallet">
          <div className="lg-kv">
            <span>Wallet</span>
            <b>{shortAddress(signer.owner)}</b>
          </div>
          <div className="lg-kv">
            <span>Resident of</span>
            {choosing ? (
              <FxSelect
                label="Country of residence"
                value={country}
                onChange={(v) => setPicked(v || null)}
                options={[
                  ...(country ? [] : [{ value: '', label: 'Choose…' }]),
                  ...countries().map((c) => ({ value: c.code, label: c.name, disabled: !!countryProblem(c.code), hint: countryProblem(c.code) ? 'not available' : undefined })),
                ]}
                searchable
                searchPlaceholder="Search countries"
                triggerClassName="fx-sel lg-pick"
                listMinWidth={240}
                listAlign="end"
              />
            ) : (
              <b>
                {countryName(country)}{' '}
                <button type="button" className="lg-inline" onClick={() => setChanging(true)}>Change</button>
              </b>
            )}
          </div>
          {problem && <p className="lg-err">{problem}</p>}
        </div>
      )}

      {error && <p className="lg-err" role="alert">{error}</p>}
      <button
        type="button"
        className="lg-cta"
        disabled={!confirmed || busy || (!!signer && (!country || !!problem))}
        aria-busy={busy || undefined}
        onClick={() => void primary()}
      >
        {busy ? 'Waiting for your wallet…' : signer ? 'Sign and continue' : 'Agree and continue'}
      </button>
      {signer && <p className="lg-hint">A free signature in your wallet: not a transaction, no gas, no funds move.</p>}
      {secondary && (
        <button type="button" className="lg-quiet" disabled={busy || !confirmed} onClick={secondary.onClick}>
          {secondary.label}
        </button>
      )}
    </>
  );
}

/** The links and the version, at the foot of both sheets. */
function TermsFoot({ onOpen }: { onOpen?: (p: LegalPage) => void }) {
  return (
    <p className="lg-foot">
      <LegalLink page="terms" onOpen={onOpen}>Terms</LegalLink>
      <LegalLink page="risk" onOpen={onOpen}>Risk</LegalLink>
      <LegalLink page="privacy" onOpen={onOpen}>Privacy</LegalLink>
      <LegalLink page="cookies" onOpen={onOpen}>Cookies</LegalLink>
      <span>Version {SITE_TERMS_VERSION}</span>
    </p>
  );
}

/**
 * The first-visit gate (App.tsx), until this browser has accepted the current
 * terms - signed by the connected wallet where there is one that may trade, in
 * the same step. A wallet that connects after the terms were accepted is asked
 * once to sign them (it may put that off: trading asks again). Never over a
 * legal page (`hidden`), so what it links to can be read first.
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
      size="sm"
      title={accepted ? 'Sign the terms' : changed ? 'Our terms have changed' : 'Welcome to ValueDesk'}
      className={`lg-sheet${accepted ? '' : ' lg-gate'}`}
      // Accepting is the only way on; once the terms are accepted, the signature can wait.
      onClose={() => { if (accepted) skip(); }}
      dismissOnBackdrop={false}
    >
      <p className="lg-lead">
        {accepted
          ? 'Sign the terms you accepted with this wallet, once, so it can trade.'
          : changed
            ? 'Please confirm the current version to go on.'
            : 'Non-custodial trading on SoDEX. Perpetual futures are high-risk: you can lose everything you put in.'}
      </p>
      {access.level === 'close-only' && <p className="lg-warn">{access.reason}</p>}
      <TermsForm
        key={signer ? `sign:${signer.owner}` : 'confirm'}
        signer={signer}
        onOpen={onOpen}
        onDone={() => setTick((n) => n + 1)}
        secondary={
          !signer ? null
          : accepted ? { label: 'Not now', onClick: skip }
          : { label: 'Continue without signing - sign before I trade', onClick: () => { acceptBrowse(STATEMENTS.map((s) => s.id)); skip(); } }
        }
      />
      <TermsFoot onOpen={onOpen} />
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
    <Modal open size="sm" title="Sign the terms to trade" className="lg-sheet" onClose={() => close(false)} dismissOnBackdrop={false}>
      <p className="lg-lead">Your wallet signs the terms once before it trades through ValueDesk: our record of what you agreed to.</p>
      <TermsForm
        key={req.owner}
        signer={{ owner: req.owner, provider: req.provider }}
        onDone={() => close(true)}
        secondary={{ label: 'Not now', onClick: () => close(false) }}
      />
      <TermsFoot />
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
