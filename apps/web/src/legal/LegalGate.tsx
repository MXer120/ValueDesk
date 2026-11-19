/**
 * The legal gates of the app (texts in acceptance.ts, notices.ts; rules in
 * jurisdictions.mjs):
 *
 *   <SiteGate>          main.tsx, around App. In a sanctioned place (geo.ts) App is
 *                       not mounted at all - no market streams, no wallet, no
 *                       runners - only the legal pages and a notice of why. The
 *                       edge already answers 451 there (deploy/vercel); this is the
 *                       second check, for a legal page the edge let through.
 *   <TermsGate>         App.tsx: the terms popup - on the first visit (closable: a
 *                       visitor may look around first), and as a gate at every action
 *                       that needs the terms (acceptance.ts requireTerms). With a
 *                       connected wallet, confirmed AND signed in one step (one free
 *                       signature); the optional extras (the Live Feed's players,
 *                       Reown's usage reports) offered beside it as a
 *                       choice of their own. Never over a legal page.
 *   <RegionPill>        NavBar: the red pill in a restricted (close-only) place.
 *   <RegionBanner>      App.tsx, above the shell: one slim full-width line on every
 *                       page while ValueDesk is close-only for the visitor (or the
 *                       country is unknown); not dismissible (notices.ts).
 *   <EmbedSwitches>     the Cookies page: withdraw consent for a video platform.
 *   <ReownSwitch>       the Cookies page: allow or withdraw Reown's usage reports.
 *   <AnalyticsSwitch>   the Cookies page: allow or withdraw ValueDesk's own usage analytics.
 *   openLegalPage()     any component: show a legal page in place (App listens).
 */
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { dropBootShell } from '../bootShell';
import { Modal } from '../components/Modal';
import { countryName } from '../copy/countries';
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
  lookAround,
  lookedAround,
  setTermsGate,
  signSiteTerms,
  signedTerms,
  useAcceptanceRevision,
  type TermsRequest,
} from './acceptance';
import { EMBED_PLATFORMS, EMBED_PROVIDERS, allEmbedsAllowed, allowAllEmbeds, revokeEmbed, useEmbedConsent } from './embeds';
import { allowReownReports, reownReportsAllowed, revokeReownReports, useReownReportsAllowedAt } from './reownConsent';
import { allowAnalytics, analyticsAllowed, analyticsDecided, declineAnalytics, revokeAnalytics, useAnalyticsAllowedAt } from './analyticsConsent';
import { LOCATION_UNKNOWN, useGeoSettled, useViewerAccess, useViewerGeo } from './geo';
import { regionBannerText } from './notices';
import { siteAccess } from './jurisdictions.mjs';
import { screeningOf, useScreening } from './screening';
import { lazyChunk } from '../lazyPage';
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

/* ---------------------------------------------------------- the site gate ----- */

const LegalViewLazy = lazyChunk(() => import('./LegalView').then((m) => ({ default: m.LegalView })));

/** In a sanctioned place: the legal pages and the notice, nothing of the app. */
export function SiteGate({ children }: { children: ReactNode }) {
  const access = useViewerAccess();
  if (access.level !== 'blocked') return <>{children}</>;
  return <BlockedShell reason={access.reason ?? ''} />;
}

function BlockedShell({ reason }: { reason: string }) {
  const [page, setPage] = useState<LegalPage | null>(() => legalForPath(window.location.pathname));
  /* The notice takes the screen: index.html's static shell (a picture of the app, bootShell.ts) goes at once. */
  useLayoutEffect(() => dropBootShell({ fade: false }), []);
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

const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

interface TermsFormProps {
  /** The connected wallet that signs - null: no wallet, the statements are only confirmed. */
  signer: { owner: string; provider: Eip1193Provider } | null;
  /** Offer the optional extras (the Live Feed's players, Reown's usage reports): "Only necessary" and "Accept all", side by side. */
  offerOptional: boolean;
  onOpen?: (p: LegalPage) => void;
  /** Accepted: 'signed' by the wallet, or only 'confirmed' in this browser. */
  onDone: (how: 'signed' | 'confirmed') => void;
}

/**
 * The four statements under ONE "I confirm that" and, with a wallet, ONE free
 * signature (acceptance.ts). The country is the one the edge saw (geo.ts),
 * shown with the wallet, read-only: the visitor cannot pick or type one (owner,
 * 2026-10-28). Where the edge could not tell, the wallet cannot sign - browsing,
 * closing, cancelling and withdrawing still work (geo.ts LOCATION_UNKNOWN).
 *
 * THE OPTIONAL EXTRAS, LAWFULLY. Consent to the Live Feed's YouTube / Twitch /
 * Kick / Vimeo players and to Reown's usage reports when a wallet connects
 * (§ 25(1) TDDDG, Art. 6(1)(a) GDPR; embeds.ts, reownConsent.ts) is offered in the
 * same step but stays a choice of its own: two equally sized buttons side by
 * side, "Only necessary" and "Accept all", both accepting the terms, only the
 * second allowing the extras. "Accept all" is the primary (accent) button at the
 * owner's wish; "Only necessary" stays a full button of the same size, plainly
 * readable - colour may lead, the refusal may not be hidden or made harder
 * (DSK guidance; EDPB cookie banner taskforce report, 2023). One line above the
 * buttons says what "Accept all" adds, with "Details" (the Cookies page): consent
 * must be informed when it is given (Art. 4(11) GDPR, CJEU C-673/17), so the
 * extras are named there, the full explanation being on the Cookies page and in
 * the privacy policy.
 * Nothing is pre-selected (CJEU C-673/17 Planet49), refusing is as easy as
 * accepting (DSK guidance on digital services), and the terms never depend on it
 * (Art. 7(4) GDPR). A visitor who chose "Only necessary" turns a platform on in
 * the Live Feed itself, Reown's reports on the Cookies page, and withdraws there.
 */
function TermsForm({ signer, offerOptional, onOpen, onDone }: TermsFormProps) {
  const geo = useViewerGeo();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<'necessary' | 'all' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const country = geo.country ?? '';
  const problem = country ? countryProblem(country) : signer ? LOCATION_UNKNOWN : null;
  const ready = confirmed && !busy && (!signer || (!!country && !problem));

  const accept = async (all: boolean) => {
    setError(null);
    setBusy(all ? 'all' : 'necessary');
    try {
      if (signer) {
        await signSiteTerms({ provider: signer.provider, owner: signer.owner, country });
      } else {
        acceptBrowse(STATEMENTS.map((s) => s.id));
      }
      if (all) {
        allowAllEmbeds();
        allowReownReports();
        allowAnalytics();
      } else if (offerOptional && !analyticsDecided()) {
        // "Only necessary" is this visitor's answer on analytics too: never asked again (AnalyticsPrompt.tsx).
        declineAnalytics();
      }
      onDone(signer ? 'signed' : 'confirmed');
    } catch (e) {
      setError(isRejection(e) ? 'Nothing was signed. Approve the message in your wallet to continue.' : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const label = (all: boolean): string => {
    if (busy === (all ? 'all' : 'necessary')) return 'Waiting for your wallet…';
    if (!offerOptional) return signer ? 'Sign and continue' : 'Agree and continue';
    return all ? 'Accept all' : 'Only necessary';
  };

  return (
    <>
      {/* What is agreed to stays in the language of the terms it refers to. */}
      <label className={`lg-card lg-card--confirm${confirmed ? ' is-on' : ''}`} data-no-i18n="">
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
            <span>Your location</span>
            <b>{country ? `${countryName(country)}, from your connection` : 'unknown'}</b>
          </div>
          {problem && <p className="lg-err">{problem}</p>}
        </div>
      )}


      {error && <p className="lg-err" role="alert">{error}</p>}
      {/* The answer as one block - what "Accept all" adds, the two buttons, what the wallet signs - so on a phone it
          stays at the sheet's foot (gate.css .lg-act) with its words always beside the buttons they explain. */}
      <div className="lg-act">
        {offerOptional ? (
          <>
            <p className="lg-small lg-extras">
              &ldquo;Accept all&rdquo; also allows ValueDesk&rsquo;s own usage analytics (on its own server, no third party), the Live Feed&rsquo;s video players and usage reports to Reown. <LegalLink page="cookies" onOpen={onOpen}>Details</LegalLink>
            </p>
            <div className="lg-pair">
              <button type="button" className="lg-cta lg-cta--secondary" disabled={!ready} aria-busy={busy === 'necessary' || undefined} onClick={() => void accept(false)}>{label(false)}</button>
              <button type="button" className="lg-cta" disabled={!ready} aria-busy={busy === 'all' || undefined} onClick={() => void accept(true)}>{label(true)}</button>
            </div>
          </>
        ) : (
          <button type="button" className="lg-cta" disabled={!ready} aria-busy={!!busy || undefined} onClick={() => void accept(false)}>{label(false)}</button>
        )}
        {signer && <p className="lg-hint">Your wallet signs once - free: not a transaction, no gas, no funds move.</p>}
      </div>
    </>
  );
}

/** The links and the version, at the foot of the popup. */
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

interface PendingAction extends TermsRequest {
  resolve: (ok: boolean) => void;
}

/**
 * The terms popup (App.tsx), in two moments:
 *   - on the first visit, until the visitor accepts the current version or looks
 *     around first (its X, or "Just look around"): then it does not open by itself
 *     again for this version;
 *   - at an action that needs the terms (acceptance.ts requireTerms - an opening
 *     order, an algo, enabling trading, a deposit, copy trading): it opens as a
 *     gate, says what for, and the action goes on once the terms are accepted -
 *     and signed, where a wallet is connected that may trade - or is dropped when
 *     the visitor closes it.
 * Never over a legal page (`hidden`), so what it links to can be read first.
 */
export function TermsGate({ hidden, onOpen, address, provider }: {
  hidden: boolean;
  onOpen: (p: LegalPage) => void;
  address: string | null;
  provider: Eip1193Provider | null;
}) {
  useAcceptanceRevision();
  useScreening(address);
  useEmbedConsent();
  const access = useViewerAccess();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [, setTick] = useState(0);

  const owner = address ? address.toLowerCase() : null;
  /** The wallet that signs: connected, in a place that may trade, not screened out. */
  const signerFor = (o: string | null | undefined) =>
    o && o.toLowerCase() === owner && provider && access.level === 'open' && screeningOf(o) !== 'sanctioned'
      ? { owner: o.toLowerCase(), provider }
      : null;
  const doneFor = (o: string | null | undefined): boolean => {
    if (!browseAccepted()) return false;
    const s = signerFor(o ?? owner);
    return !s || !!signedTerms(s.owner);
  };

  /* The latest view of the props for the handler, which actions call at any time. */
  const latest = useRef({ doneFor });
  latest.current = { doneFor };
  useEffect(() => {
    setTermsGate((r) => new Promise<boolean>((resolve) => {
      if (latest.current.doneFor(r.owner)) {
        resolve(true);
        return;
      }
      setPending((cur) => {
        cur?.resolve(false);
        return { ...r, resolve };
      });
    }));
    return () => setTermsGate(null);
  }, []);

  const finish = (ok: boolean) => {
    setPending((cur) => {
      cur?.resolve(ok);
      return null;
    });
    setTick((n) => n + 1);
  };

  if (access.level === 'blocked') return null;
  const accepted = !!browseAccepted();
  const intro = !pending && !accepted && !lookedAround();
  if (!pending && !intro) return null;
  const signer = signerFor(pending?.owner ?? owner);
  const changed = acceptedBefore();
  const close = () => {
    if (pending) finish(false);
    else {
      lookAround();
      setTick((n) => n + 1);
    }
  };
  const title = pending
    ? accepted ? 'Sign the terms to continue' : 'Accept the terms to continue'
    : changed ? 'Our terms have changed' : 'Welcome to ValueDesk';
  return (
    /* The first visit's popup opens by itself: the dialog takes the focus, not its X (a ring on it before anything was
       touched). Asked for by an action, the X is where focus goes, as in every other dialog. */
    <Modal open={!hidden} size="sm" title={title} className="lg-sheet" onClose={close} dismissOnBackdrop={false} focusDialog={!pending}>
      <p className="lg-lead">
        {pending
          ? `To ${pending.reason}, ${signer ? 'your wallet signs' : 'please accept'} the terms once.${accepted ? '' : ' Perpetual futures are high-risk: you can lose everything you put in.'}`
          : changed
            ? 'Please confirm the current version - or look around first.'
            : 'Non-custodial trading on SoDEX. Perpetual futures are high-risk: you can lose everything you put in.'}
      </p>
      {access.level === 'close-only' && <p className="lg-warn">{access.reason}</p>}
      <TermsForm
        key={signer ? `sign:${signer.owner}` : 'confirm'}
        signer={signer}
        offerOptional={!allEmbedsAllowed() || !reownReportsAllowed() || !analyticsAllowed()}
        onOpen={onOpen}
        onDone={() => (pending ? finish(true) : setTick((n) => n + 1))}
      />
      <button type="button" className="lg-quiet" onClick={close}>{pending ? 'Not now' : 'Just look around'}</button>
      <TermsFoot onOpen={onOpen} />
    </Modal>
  );
}

/* ------------------------------------------------- the restricted-region pill ----- */

/**
 * The navbar's red pill wherever the edge puts the visitor in a restricted
 * place (jurisdictions.mjs): close-only from the US, the UK and Canada, and what a connected
 * wallet declared. A sanctioned place never gets this far (SiteGate). It opens
 * the Terms of use, where section 3 says what applies.
 */
export function RegionPill({ address }: { address: string | null }) {
  useAcceptanceRevision();
  const seen = useViewerAccess();
  const declared = signedTerms(address)?.country ?? null;
  const access = declared && seen.level === 'open' ? siteAccess({ declared }) : seen;
  if (access.level === 'open') return null;
  return (
    <a
      href={pathForLegal('terms')}
      className="lg-region"
      title={access.reason ?? undefined}
      onClick={(e) => {
        if (!isPlainClick(e)) return;
        e.preventDefault();
        openLegalPage('terms');
      }}
    >
      <span className="lg-region__dot" aria-hidden="true" />
      {access.level === 'close-only' ? 'Restricted region · close-only' : 'Not available in your region'}
    </a>
  );
}


/**
 * The strip at the very top of the app, full width, one slim line, on every
 * page and not dismissible, while ValueDesk is close-only for this visitor -
 * by the country the edge saw or the one the wallet signed for - or while the
 * country is unknown (geo.ts: nothing opens then). It reserves its own height
 * (--region-h, gate.css) so the shell below is never covered.
 */
export function RegionBanner({ address }: { address: string | null }) {
  useAcceptanceRevision();
  const seen = useViewerAccess();
  const geo = useViewerGeo();
  const settled = useGeoSettled();
  const declared = signedTerms(address)?.country ?? null;
  const access = declared && seen.level === 'open' ? siteAccess({ declared }) : seen;
  const text = regionBannerText(access, !!geo.country || !settled);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!el) {
      root.style.removeProperty('--region-h');
      return;
    }
    const measure = () => root.style.setProperty('--region-h', `${el.offsetHeight}px`);
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty('--region-h');
    };
  }, [text]);
  if (!text) return null;
  return (
    <div ref={ref} className="lg-region-banner" role="status">
      <span className="lg-region__dot" aria-hidden="true" />
      <span className="lg-region-banner__text">{text}</span>
      <a
        href={pathForLegal('terms')}
        onClick={(e) => {
          if (!isPlainClick(e)) return;
          e.preventDefault();
          openLegalPage('terms');
        }}
      >
        Why
      </a>
    </div>
  );
}

/* ------------------------------------------------- the Cookies page's switches ----- */

/** The Cookies page's switch for Reown's usage reports (reownConsent.ts). */
export function ReownSwitch() {
  const at = useReownReportsAllowedAt();
  return (
    <ul className="lg-embeds">
      <li>
        <span>
          <b>Reown usage reports</b>{' '}
          {at !== null ? `allowed on ${new Date(at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}` : 'not allowed - they are not sent'}
        </span>
        {at !== null
          ? <button type="button" className="fx-link" onClick={revokeReownReports}>Withdraw consent</button>
          : <button type="button" className="fx-link" onClick={() => allowReownReports()}>Allow</button>}
      </li>
    </ul>
  );
}


/** The Cookies page's switch for ValueDesk's own usage analytics (analyticsConsent.ts, analytics/usage.ts). */
export function AnalyticsSwitch() {
  const at = useAnalyticsAllowedAt();
  return (
    <ul className="lg-embeds">
      <li>
        <span>
          <b>ValueDesk usage analytics</b>{' '}
          {at !== null ? `allowed on ${new Date(at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}` : 'not allowed - nothing is measured'}
        </span>
        {at !== null
          ? <button type="button" className="fx-link" onClick={revokeAnalytics}>Withdraw consent</button>
          : <button type="button" className="fx-link" onClick={() => allowAnalytics()}>Allow</button>}
      </li>
    </ul>
  );
}

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
