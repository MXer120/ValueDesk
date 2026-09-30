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
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Dashboard } from './Dashboard';
import { PORTFOLIO_DASHBOARD } from './layout';
import {
  PORTFOLIO_PANELS, usePortfolioContext, type PortfolioContext, type PortfolioProps,
} from '../components/Portfolio';
import { SCAN_ACCOUNT_PANEL, SCAN_PANELS } from '../components/ScanPanels';
import { SCAN_VENUES, type Venue } from '../vsApi';
import { ScanHeader } from '../components/scan/ScanHeader';
import { HL_SCAN_PANELS, type HlScanContext } from '../components/scan/HlPanels';
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

/** Aliases are the one thing worth keeping from the old page. */
const ALIAS_KEY = 'scan-aliases';

export function aliasMap(): Record<string, string> {
  try {
    return (JSON.parse(localStorage.getItem(ALIAS_KEY) || '{}') || {}) as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveAlias(addr: string, name: string): void {
  const m = aliasMap();
  const k = addr.toLowerCase();
  if (name.trim()) m[k] = name.trim();
  else delete m[k];
  try {
    localStorage.setItem(ALIAS_KEY, JSON.stringify(m));
  } catch {
    /* storage disabled */
  }
}

export const aliasFor = (addr: string): string => aliasMap()[addr.toLowerCase()] ?? '';

/** An alias, or a raw address, resolved to an address. */
export function resolveTarget(input: string): string | null {
  const t = input.trim();
  if (ADDRESS_RE.test(t)) return t;
  const m = aliasMap();
  const hit = Object.keys(m).find((a) => m[a]!.toLowerCase() === t.toLowerCase());
  return hit ?? null;
}

export interface ScanContext extends PortfolioContext {
  /** The address being scanned, which is NOT the connected wallet. */
  scanned: string | null;
  /** The wallet actually connected, for the "Me" affordance. */
  connected: string | null;
  onScan: (addressOrAlias: string) => void;
  scanError: string | null;
}

export function ScanDashboard(props: Omit<PortfolioProps, 'address'> & { address: string | null }) {
  const connected = props.address;

  /*
   * The scanned address lives in the URL, so a scan is a link you can send.
   * `?address=` is the same parameter the old page used, which keeps every link
   * anyone already saved working.
   */
  const [scanned, setScanned] = useState<string | null>(() => {
    const q = new URLSearchParams(window.location.search).get('address');
    return q && ADDRESS_RE.test(q) ? q : null;
  });
  const [scanError, setScanError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  /* Set when the address is on more than one venue (or a venue couldn't be
     checked). Nothing is pushed until a row is picked. */
  const [choice, setChoice] = useState<{ address: string; cards: VenueCard[] } | null>(null);
  const [venue, setVenue] = useState<Venue>(venueFromUrl);
  /* Read by the callbacks below without re-creating them on every switch. */
  const venueRef = useRef(venue);
  venueRef.current = venue;
  const scannedRef = useRef(scanned);
  scannedRef.current = scanned;
  const scanSeq = useRef(0);

  useEffect(() => {
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
  }, []);

  const commitScan = useCallback((addr: string, v: Venue) => {
    setChoice(null);
    setChecking(false);
    setScanError(null);
    setScanned(addr);
    setVenue(v);
    window.history.pushState(null, '', scanUrl(addr, v));
  }, []);

  const onScan = useCallback((input: string) => {
    const t = input.trim();
    const seq = ++scanSeq.current;
    if (ADDRESS_RE.test(t) || resolveTarget(t)) {
      // The overview is a link too (`?find=`): the leaderboard opens it, reload keeps it.
      window.history.replaceState(null, '', `/scan?find=${encodeURIComponent(resolveTarget(t) ?? t)}`);
    }
    if (!t) {
      setScanned(null);
      setScanError(null);
      setChoice(null);
      setChecking(false);
      window.history.replaceState(null, '', scanUrl(null, venueRef.current));
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
    const land = (card: VenueCard) => {
      if (scanSeq.current !== seq) return;
      setChoice((cur) => {
        if (!cur || cur.address !== addr) return cur;
        const cards = cur.cards.filter((c) => c.venue !== card.venue).concat(card);
        return { address: addr, cards };
      });
    };
    void Promise.all(SCAN_VENUES.map((v) => readVenue(v, addr).then(land))).then(() => {
      if (scanSeq.current === seq) setChecking(false);
    }).catch(() => {
      if (scanSeq.current !== seq) return;
      setChecking(false);
      setScanError(VENUE_FAIL);
    });
  }, []);

  /* `/scan?find=<address>` - the overview for that address (the leaderboard's
     links). On load, and when back/forward lands on one. */
  useEffect(() => {
    const run = () => {
      const f = new URLSearchParams(window.location.search).get('find');
      if (f && !new URLSearchParams(window.location.search).get('address')) onScan(f);
    };
    run();
    window.addEventListener('popstate', run);
    return () => window.removeEventListener('popstate', run);
  }, [onScan]);

  /* The venue switch is a history stop, like a new address: back returns to
     the venue you were reading. */
  const onVenue = useCallback((v: Venue) => {
    if (v === venueRef.current) return;
    setVenue(v);
    window.history.pushState(null, '', scanUrl(scannedRef.current, v));
  }, []);

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
  const sodexFallback: Presence | null = venue === 'sodex' && base.model.account
    ? accountStanding(base.model.account, base.model.positions.length)
    : null;
  const sodexPresence = switchStanding(sodexProfile);
  // SoDEX's own history for this account is unusable (server flag): the charts give way to one sentence.
  // Until the profile answers (slow for a big account), the same first check on
  // the chart this page already holds - never headline the false value meanwhile.
  const early = sodexProfile.data ? null : chartValueIsPnl(base.venue.points);
  const historyNote = analyticsSuspectNote(sodexProfile.data?.analyticsSuspect ?? early);
  if (historyNote) {
    context.historyNote = historyNote;
    context.liveEquity = sodexProfile.data?.summary.accountValue ?? base.model.account?.accountValue ?? null;
  }
  const presence: Partial<Record<Venue, Presence>> = {
    sodex: sodexPresence === 'unknown' && sodexFallback ? sodexFallback : sodexPresence,
    hyperliquid: switchStanding(hlProfile),
    tradexyz: switchStanding(xyzProfile),
    lighter: switchStanding(lighterProfile),
    arcus: switchStanding(arcusProfile),
  };

  /* The Hyperliquid view's data, read only while it is the venue on screen. */
  // Every venue but SoDEX is drawn by the Hyperliquid cards over its own profile + fills.
  const hl = useHlState(venue !== 'sodex' ? scanned : null, venue === 'sodex' ? 'hyperliquid' : venue);
  const hlContext: HlScanContext = { scanned, connected, onScan, scanError, hl };

  /*
   * The portfolio's panels, with the ACCOUNT card swapped for the scan variant
   * that carries the address input. Swapped rather than appended: two panels
   * with the same id would both render, and the layout only has one slot for it.
   */
  const panels = [
    ...PORTFOLIO_PANELS.map((p) => (p.id === 'account' ? SCAN_ACCOUNT_PANEL : p)),
    ...SCAN_PANELS,
  ];

  /*
   * WITH NOTHING SCANNED, EVERY OTHER PANEL IS A GRID OF EM-DASHES.
   *
   * They used to render at full contrast, which made an idle page look like a
   * page reporting that this wallet holds nothing. Dimming and softening them
   * says "waiting for an address" without removing them - you can still see the
   * shape of what you are about to get - and the account card stays sharp
   * because it is the one you are meant to be looking at.
   *
   * `pointer-events: none` goes with it: a period toggle you can click but whose
   * result you cannot read is a control that appears broken.
   */
  /*
   * THE HEADER IS ADDED ABOVE THE GRID, NOT INTO IT. The SoDEX dashboard below
   * is the element it always was - same config, same panels, same context - so
   * the venue switch cannot change a pixel of what SoDEX shows. The Hyperliquid
   * view is a second Dashboard over the SAME config and panel ids (see
   * HlPanels.tsx), keyed apart so switching remounts it cleanly.
   */
  const backToSearch = () => {
    setChoice(null);
    setChecking(false);
    setScanError(null);
    setScanned(null);
    window.history.pushState(null, '', scanUrl(null, venueRef.current));
  };

  if (!scanned) {
    const cards = sortOverview(SCAN_VENUES.map((v) => choice?.cards.find((c) => c.venue === v)).filter((c): c is VenueCard => !!c));
    return (
      <ScanFind
        seed={choice?.address ?? ''}
        busy={checking && cards.length === 0}
        error={scanError}
        connected={connected}
        onScan={onScan}
      >
        {cards.map((card) => (
          <ScanVenueCard key={card.venue} card={card} onPick={(v) => commitScan(choice!.address, v)} />
        ))}
      </ScanFind>
    );
  }

  return (
    <div className="scanv">
      <ScanHeader venue={venue} onVenue={onVenue} presence={presence} scanned={scanned} onNewSearch={backToSearch} />
      {venue === 'sodex' ? (
        <Dashboard
          key="sodex"
          config={PORTFOLIO_DASHBOARD}
          panels={panels as never[]}
          context={context as never}
          className={`pf scan ${scanned ? '' : 'scan--idle'}`}
        />
      ) : (
        <Dashboard
          key={venue}
          config={PORTFOLIO_DASHBOARD}
          panels={HL_SCAN_PANELS}
          context={hlContext}
          className={`pf scan scan--hl ${scanned ? '' : 'scan--idle'}`}
        />
      )}
    </div>
  );
}

function ScanFind({
  seed, busy, error, connected, onScan, children,
}: {
  /** The address the overview below is for, shown in the field. */
  seed: string;
  busy: boolean;
  error: string | null;
  connected: string | null;
  onScan: (input: string) => void;
  children?: ReactNode;
}) {
  const [draft, setDraft] = useState(seed);
  useEffect(() => { if (seed) setDraft(seed); }, [seed]);
  /* An emptied field (or just "0x") folds the venues away without dropping
     them: typing the address back brings them back, a new search replaces them. */
  const folded = /^(0x)?$/i.test(draft.trim());
  return (
    <form
      className="scan-find"
      onSubmit={(e) => {
        e.preventDefault();
        onScan(draft);
      }}
    >
      <div className="scan-find__hero">
        <span className="scan-find__marks" aria-hidden="true">
          {SCAN_VENUES.map((v) => (
            <span key={v} className="scan-find__mark"><VenueLogo venue={v} size={44} /></span>
          ))}
        </span>
        <h1>Search any wallet</h1>
      </div>
      <div className="scan-find__row">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="0x… address or saved alias"
          aria-label="Wallet address"
          spellCheck={false}
          autoComplete="off"
          autoFocus
        />
        {connected && (
          <button
            type="button"
            className="scan-find__me"
            title="Scan the connected wallet"
            onClick={() => { setDraft(connected); onScan(connected); }}
          >
            Me
          </button>
        )}
        <button type="submit" className="scan-find__go" disabled={busy || !draft.trim()}>{busy ? 'Looking up…' : 'Search'}</button>
      </div>
      {error && <p className="scan-find__err">{error}</p>}
      {children && (
        <div className={`scan-find__fold${folded ? ' is-folded' : ''}`} aria-hidden={folded || undefined}>
          <div className="scan-find__cards">{children}</div>
        </div>
      )}
    </form>
  );
}
