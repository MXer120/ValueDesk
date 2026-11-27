/**
 * Scan: the portfolio page, pointed at somebody else's wallet.
 *
 * WHY THIS REPLACES 4,142 LINES OF VANILLA JS. The old scan page was a
 * standalone static document copied from an unrelated "MISSIONCONTROL"
 * dashboard, sharing zero code, zero CSS tokens and zero components with this
 * app, on a bespoke 13-route backend built to match the copy. It rendered the
 * same facts as the portfolio page in a different vocabulary, so the two drifted
 * apart by construction and every fix had to be made twice.
 *
 * Everything the portfolio shows is already address-parameterised: `Portfolio`
 * takes an `address` prop and every `/api/acct/*` route takes a free `?address=`.
 * So scanning is not a different page - it is the same page with a different
 * address and no signing key. That is the whole design.
 *
 * READ-ONLY BY CONSTRUCTION. `unlocked` is hard-wired false: a scanned wallet is
 * never yours, and the order and transfer controls key off exactly that flag.
 * There is no path from this page to a signed request.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePortfolioContext, type PortfolioContext, type PortfolioProps } from '../components/Portfolio';
import { SCAN_VENUES, type Venue } from '../vsApi';
import { useHlState } from '../components/scan/HlCards';
import { analyticsSuspectNote, chartValueIsPnl } from '../components/scan/hlModel';
import { useVsTrader, type Presence } from '../components/scan/useVs';
import {
  accountStanding, readVenue, sortOverview, switchStanding,
  VENUE_FAIL, type VenueCard,
} from '../components/scan/addressVenues';
import { ScanVenueCard } from '../components/scan/ScanVenueCard';
import { VenueLogo } from '../components/VenueLogo';
import '../components/scan/scan.css';
import { resolveTarget } from './scanAliases';
import { PortfolioWallet } from '../components/portfolio/wallet/Wallet';
import { VenueWallet } from '../components/scan/VenueWallet';
import { ScanStart, ScanWho } from '../components/scan/ScanTop';
import { ScanSearch } from '../components/scan/versions/parts';
import { bestVenue } from '../components/scan/versions/model';
import { absent, cardFromProfile, unknownCard } from '../components/scan/addressVenues';
import { pushRecent } from '../components/scan/tracked';
import { scanShare } from '../components/share/shareData';
import type { VsRead } from '../components/scan/useVs';
import type { TraderProfile } from '../vsApi';
import { Button } from '../components/bots/kit/kit';
import { VENUE_LABEL } from '../vsApi';
import { openPath } from '../nav';
import { pathForTab, type Tab } from '../router';
import type { Eip1193Provider } from '../wallet';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/*
 * WHICH VENUE. `?venue=` carries it, the same parameter every Scan link from
 * Explore, Leaderboard and Copy already sets. SoDEX is the default and is kept
 * OUT of the URL, so every SoDEX scan link that existed before the venue switch
 * is still the canonical one.
 */
const venueFromUrl = (): Venue => {
  const v = new URLSearchParams(window.location.search).get('venue')?.toLowerCase();
  return (SCAN_VENUES as readonly string[]).includes(v ?? '') ? (v as Venue) : 'sodex';
};

const scanUrl = (address: string | null, venue: Venue): string => {
  const q = new URLSearchParams();
  if (address) q.set('address', address);
  if (venue !== 'sodex') q.set('venue', venue);
  const s = q.toString();
  return s ? `/scan?${s}` : '/scan';
};

/* Aliases live in ./scanAliases so the always-loaded shell (the Cmd+K palette)
   can resolve one without importing this whole page. Re-exported for the
   existing importers. */
export { aliasMap, saveAlias, aliasFor, resolveTarget } from './scanAliases';

export interface ScanContext extends PortfolioContext {
  /** The address being scanned, which is NOT the connected wallet. */
  scanned: string | null;
  /** The wallet actually connected, for the "Me" affordance. */
  connected: string | null;
  onScan: (addressOrAlias: string) => void;
  scanError: string | null;
}

/*
 * VERSIONS, LOCALHOST ONLY (owner 2026-11-26: "localhost only with multiple versions and the switch ... completely
 * redesign the scan page ... Do not delete the original keep it in the switch"). A pill at the foot of the page picks
 * the version (kept in this browser); the new ones are components/scan/versions/, loaded only on localhost. A build
 * has neither the pill nor their code (`DEV` is false there, so the import below is dropped) and shows the original.
 */
const DEV = import.meta.env.DEV;
const VERSION_KEY = 'vs.dev.scan.version';
const ScanVersions = DEV ? lazy(() => import('../components/scan/versions/ScanVersions')) : null;
// The pill's own look, also while the original is on screen (the versions' stylesheet comes with their chunk).
if (DEV) void import('../components/scan/versions/switch.css');
// 'Scan' is the page in the Portfolio's layout (owner 2026-11-27); the others are the earlier localhost drafts.
const VERSION_NAMES = ['Scan', 'Profile', 'Venues', 'Desk'] as const;

function storedVersion(): number {
  if (!DEV) return 0;
  try {
    const n = Number(localStorage.getItem(VERSION_KEY));
    return Number.isInteger(n) && n >= 0 && n < VERSION_NAMES.length ? n : 0;
  } catch {
    return 0;
  }
}

/** Where Scan's links go (App passes the app's own; the Copy page's window falls back to plain navigation). */
export interface ScanLinks {
  provider?: Eip1193Provider | null;
  onOpenMarket?: (symbol: string, engine: 'spot' | 'perps') => void;
  onOpenTab?: (tab: Tab) => void;
}

export function ScanDashboard(props: Omit<PortfolioProps, 'address'> & { address: string | null } & ScanLinks) {
  const [version, setVersion] = useState(storedVersion);
  if (!DEV || !ScanVersions) return <ScanOriginal {...props} />;
  const choose = (n: number) => {
    setVersion(n);
    try { localStorage.setItem(VERSION_KEY, String(n)); } catch { /* this tab only */ }
  };
  return (
    <>
      {version === 0 ? <ScanOriginal {...props} /> : (
        <Suspense fallback={null}><ScanVersions version={version} props={props} /></Suspense>
      )}
      <nav className="rf-switch sx-switch" aria-label="Scan page versions" data-no-i18n="">
        {VERSION_NAMES.map((name, i) => (
          <button key={name} type="button" aria-pressed={version === i} className={version === i ? 'is-on' : ''} onClick={() => choose(i)}>
            <b>{i === 0 ? 'S' : i}</b><span>{name}</span>
          </button>
        ))}
      </nav>
    </>
  );
}

/** Scan inside another page (the Copy page's trader popup, owner 2026-11-27): this wallet and venue to start with, and
 * the browser's address bar left alone (no pushState, no popstate, no `?find=`). */
export interface ScanEmbedTarget { address: string; venue: Venue }

/** The Scan page for one wallet, inside another page (copy/TraderPeek.tsx). */
export function ScanEmbed(props: Omit<PortfolioProps, 'address'> & { address: string | null; embed: ScanEmbedTarget } & ScanLinks) {
  return <ScanOriginal {...props} key={`${props.embed.venue}:${props.embed.address}`} />;
}

function ScanOriginal(props: Omit<PortfolioProps, 'address'> & { address: string | null; embed?: ScanEmbedTarget } & ScanLinks) {
  const connected = props.address;
  const embed = props.embed ?? null;
  // Embedded, the page keeps its state to itself: the host page owns the URL.
  const push = (url: string) => { if (!embed) window.history.pushState(null, '', url); };
  const replace = (url: string) => { if (!embed) window.history.replaceState(null, '', url); };

  /*
   * The scanned address lives in the URL, so a scan is a link you can send.
   * `?address=` is the same parameter the old page used, which keeps every link
   * anyone already saved working.
   */
  const [scanned, setScanned] = useState<string | null>(() => {
    if (embed) return ADDRESS_RE.test(embed.address) ? embed.address : null;
    const q = new URLSearchParams(window.location.search).get('address');
    return q && ADDRESS_RE.test(q) ? q : null;
  });
  const [scanError, setScanError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  /* Set when the address is on more than one venue (or a venue couldn't be
     checked). Nothing is pushed until a row is picked. */
  const [choice, setChoice] = useState<{ address: string; cards: VenueCard[] } | null>(null);
  const [venue, setVenue] = useState<Venue>(() => (embed ? embed.venue : venueFromUrl()));
  /* Read by the callbacks below without re-creating them on every switch. */
  const venueRef = useRef(venue);
  venueRef.current = venue;
  const scannedRef = useRef(scanned);
  scannedRef.current = scanned;
  const scanSeq = useRef(0);

  useEffect(() => {
    if (embed) return;
    const onPop = () => {
      const q = new URLSearchParams(window.location.search).get('address');
      setScanned(q && ADDRESS_RE.test(q) ? q : null);
      setVenue(venueFromUrl());
      setChoice(null);
      setChecking(false);
      scanSeq.current += 1;
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [embed]);

  const commitScan = useCallback((addr: string, v: Venue) => {
    setChoice(null);
    setChecking(false);
    setScanError(null);
    setScanned(addr);
    setVenue(v);
    push(scanUrl(addr, v));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onScan = useCallback((input: string) => {
    const t = input.trim();
    const seq = ++scanSeq.current;
    if (ADDRESS_RE.test(t) || resolveTarget(t)) {
      // The overview is a link too (`?find=`): the leaderboard opens it, reload keeps it.
      replace(`/scan?find=${encodeURIComponent(resolveTarget(t) ?? t)}`);
    }
    if (!t) {
      setScanned(null);
      setScanError(null);
      setChoice(null);
      setChecking(false);
      replace(scanUrl(null, venueRef.current));
      return;
    }
    const addr = resolveTarget(t);
    if (!addr) {
      setChoice(null);
      setChecking(false);
      setScanError(
        ADDRESS_RE.test(t) ? null : 'Not an address or a saved alias. Paste a 0x… address.',
      );
      return;
    }
    setScanError(null);
    setChoice({
      address: addr,
      cards: SCAN_VENUES.map((venue) => ({
        venue, exists: false, unknown: false, inactive: false, equity: null, lastActive: null, curve: null, pending: true,
      })),
    });
    setChecking(true);
    const got: VenueCard[] = [];
    const land = (card: VenueCard) => {
      if (scanSeq.current !== seq) return;
      got.push(card);
      setChoice((cur) => {
        if (!cur || cur.address !== addr) return cur;
        const cards = cur.cards.filter((c) => c.venue !== card.venue).concat(card);
        return { address: addr, cards };
      });
    };
    void Promise.all(SCAN_VENUES.map((v) => readVenue(v, addr).then(land))).then(() => {
      if (scanSeq.current !== seq) return;
      setChecking(false);
      // As the Profile version: a search opens the largest active account at once; the platform switch has the rest.
      // A wallet with no account anywhere stays here, its venues listed.
      const best = bestVenue(got);
      if (best) commitScan(addr, best);
    }).catch(() => {
      if (scanSeq.current !== seq) return;
      setChecking(false);
      setScanError(VENUE_FAIL);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* `/scan?find=<address>` - the overview for that address (the leaderboard's
     links). On load, and when back/forward lands on one. */
  useEffect(() => {
    if (embed) return;
    const run = () => {
      const f = new URLSearchParams(window.location.search).get('find');
      if (f && !new URLSearchParams(window.location.search).get('address')) onScan(f);
    };
    run();
    window.addEventListener('popstate', run);
    return () => window.removeEventListener('popstate', run);
  }, [onScan, embed]);

  /* The venue switch is a history stop, like a new address: back returns to
     the venue you were reading. */
  const onVenue = useCallback((v: Venue) => {
    if (v === venueRef.current) return;
    setVenue(v);
    push(scanUrl(scannedRef.current, v));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /*
   * The portfolio's own context, built for the SCANNED address. `unlocked:false`
   * is the load-bearing part - see the header.
   *
   * Only while SoDEX is the venue on screen. Reading a Hyperliquid address
   * through six SoDEX account routes would spend the SoDEX rate budget (shared
   * with the trade page) on panels nobody is looking at.
   */
  const base = usePortfolioContext({ ...props, address: venue === 'sodex' ? scanned : null, unlocked: false });
  // readOnly: a stranger's account shows no close / modify / cancel / transfer controls at all.
  const context: ScanContext = { ...base, readOnly: true, scanned, connected, onScan, scanError };

  /*
   * Has this address traded on each venue? One profile read per venue, shared
   * with the Hyperliquid view below through useVs's request cache. A venue with
   * no equity and nothing in the last 30 days is inactive. While SoDEX's
   * multi-venue provider cannot answer, the portfolio account read stands in.
   */
  const sodexProfile = useVsTrader('sodex', scanned);
  const hlProfile = useVsTrader('hyperliquid', scanned);
  const xyzProfile = useVsTrader('tradexyz', scanned);
  const lighterProfile = useVsTrader('lighter', scanned);
  const arcusProfile = useVsTrader('arcus', scanned);
  // SoDEX's own history for this account is unusable (server flag): the charts give way to one sentence.
  // Until the profile answers (slow for a big account), the same first check on
  // the chart this page already holds - never headline the false value meanwhile.
  const early = sodexProfile.data ? null : chartValueIsPnl(base.venue.points);
  const historyNote = analyticsSuspectNote(sodexProfile.data?.analyticsSuspect ?? early);
  if (historyNote) {
    context.historyNote = historyNote;
    context.liveEquity = sodexProfile.data?.summary.accountValue ?? base.model.account?.accountValue ?? null;
  }

  /* The Hyperliquid view's data, read only while it is the venue on screen. */
  // Every venue but SoDEX is drawn by the Hyperliquid cards over its own profile + fills.
  const hl = useHlState(venue !== 'sodex' ? scanned : null, venue === 'sodex' ? 'hyperliquid' : venue);

  // Every wallet opened on the Scan page (a search, a link, a venue switch) is a recent search; the window is not.
  useEffect(() => { if (!embed && scanned) pushRecent(scanned, venue); }, [embed, scanned, venue]);

  const backToSearch = () => {
    setChoice(null);
    setChecking(false);
    setScanError(null);
    setScanned(null);
    push(scanUrl(null, venueRef.current));
  };

  if (!scanned) {
    const cards = sortOverview(SCAN_VENUES.map((v) => choice?.cards.find((c) => c.venue === v)).filter((c): c is VenueCard => !!c));
    const done = !checking && cards.length > 0 && cards.every((c) => !c.pending);
    return (
      <ScanStart seed={choice?.address ?? ''} busy={checking} error={scanError} connected={connected} onSearch={onScan}>
        {done ? cards.map((card) => <ScanVenueCard key={card.venue} card={card} onPick={(v) => commitScan(choice!.address, v)} />) : null}
      </ScanStart>
    );
  }

  /*
   * THE PORTFOLIO'S LAYOUT (owner 2026-11-27: "Scan page, i want the same layout as portfolio page, just without the
   * earn & angepasste componenents for scan. Use for copy trading pop up AND actual scan page."). SoDEX: the Portfolio
   * page itself in its scan mode, over the same context the grid had (read-only). The other venues: the same layout
   * over the venue's profile and fills (VenueWallet.tsx). The header keeps the venue switch and the note on what a copy
   * could not follow; Copy and Counter-trade are the page's keys now.
   */
  const openTab = props.onOpenTab ?? ((t: Tab) => openPath(pathForTab(t)));
  const openMarket = props.onOpenMarket ?? (() => openPath(pathForTab('trade')));
  // The platform switch (the Profile version's): each venue's card from the same five profile reads as the presence.
  const reads: Record<Venue, VsRead<TraderProfile | null>> = { sodex: sodexProfile, hyperliquid: hlProfile, tradexyz: xyzProfile, lighter: lighterProfile, arcus: arcusProfile };
  const venueCards = SCAN_VENUES.map((v): VenueCard => {
    const r = reads[v];
    if (!r.settled) return { ...absent(v), pending: true };
    return r.error ? unknownCard(v) : cardFromProfile(v, r.data);
  });
  const shareAs = scanShare(scanned, venue, VENUE_LABEL[venue]);
  return (
    <div className="scanv scanv--pf">
      {!embed && (
        <div className="sxh-bar">
          <Button variant="quiet" icon="arrowLeft" onClick={backToSearch}>New search</Button>
          <ScanSearch seed={scanned} connected={connected} onSearch={onScan} error={scanError} className="sxh-bar__find" />
        </div>
      )}
      <ScanWho address={scanned} venue={venue} profile={reads[venue].data} cards={venueCards} onVenue={onVenue} settled={venueCards.every((c) => !c.pending)} />
      {venue === 'sodex'
        ? <PortfolioWallet key={`sodex:${scanned}`} c={context} provider={props.provider ?? null} onOpenMarket={openMarket} onOpenTab={openTab} scan={{ shareAs }} />
        : <VenueWallet key={`${venue}:${scanned}`} hl={hl} venue={venue} address={scanned} shareAs={shareAs} />}
    </div>
  );
}
