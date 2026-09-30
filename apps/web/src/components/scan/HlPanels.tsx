/**
 * The Hyperliquid view of Scan, and the Hyperliquid section of Portfolio.
 *
 * SCAN. `HL_SCAN_PANELS` fills the SAME eight slots as PORTFOLIO_PANELS -
 * account, fees, performance, value, pnl, capital, exposure, band - under the
 * same ids, so ScanDashboard hands it PORTFOLIO_DASHBOARD unchanged and the page
 * keeps its shape, and the user's arrangement of it, when the venue switches.
 * Only the source behind each card changes.
 *
 * PORTFOLIO. `PORTFOLIO_HL_PANELS` are new ids (`hl-*`, `copies`) placed BELOW
 * the existing layout, so the SoDEX part of the page does not move by a pixel;
 * see PortfolioDashboard.tsx for how their default placement is computed.
 */
import { useEffect, useState } from 'react';
import type { PanelDefinition, PanelPlacement, BreakpointName } from '../../dashboard/types';
import { AccountChip, Card } from '../Portfolio';
import { aliasFor, saveAlias } from '../../dashboard/ScanDashboard';
import {
  HlActivityCard, HlCapitalCard, HlChips, HlExposureCard, HlOverviewGroup,
  HlPerformanceCard, HlPnlCard, HlValueCard, HlVolumeGroup, type HlState,
} from './HlCards';
import { MyCopiesCard } from './MyCopies';
import { VenueBand } from './VenueBand';

/* ---------------------------------------------------------------------------
 * SCAN
 * ------------------------------------------------------------------------ */

export interface HlScanContext {
  scanned: string | null;
  connected: string | null;
  onScan: (addressOrAlias: string) => void;
  scanError: string | null;
  hl: HlState;
}

/**
 * The account card with the address input, as ScanPanels' SoDEX variant draws
 * it - same input row, same Me button, same alias row - over the venue's own
 * overview instead of the SoDEX equity breakdown.
 */
function HlScanAccountPanel({ c }: { c: HlScanContext }) {
  const [draft, setDraft] = useState('');
  const [alias, setAlias] = useState('');
  const [savedAlias, setSavedAlias] = useState(false);

  useEffect(() => {
    setDraft(c.scanned ?? '');
    setAlias(c.scanned ? aliasFor(c.scanned) : '');
  }, [c.scanned]);

  return (
    <Card title="Account" className="pf-card--identity">
      <div className="scan-addr">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') c.onScan(draft); }}
          placeholder="0x… address or saved alias"
          aria-label="Address or alias to scan"
          spellCheck={false}
        />
        <button
          type="button"
          className="pf-btn"
          disabled={!c.connected}
          title={c.connected ? 'Scan the connected wallet' : 'No wallet connected'}
          onClick={() => c.connected && c.onScan(c.connected)}
        >
          Me
        </button>
      </div>
      {c.scanError && <p className="pf-note pf-note--warn">{c.scanError}</p>}

      {!c.scanned ? (
        <p className="pf-note">Paste an address, or press Me.</p>
      ) : (
        <>
          <AccountChip address={c.scanned} unlocked={false} exists={null} />
          <div className="scan-addr">
            <input
              value={alias}
              onChange={(e) => { setAlias(e.target.value); setSavedAlias(false); }}
              placeholder="Save an alias for this address"
              aria-label="Alias"
              spellCheck={false}
            />
            <button
              type="button"
              className="pf-btn"
              onClick={() => { saveAlias(c.scanned!, alias); setSavedAlias(true); }}
            >
              {savedAlias ? 'Saved' : 'Save'}
            </button>
          </div>
          <HlChips p={c.hl.trader.data} />
          <HlOverviewGroup hl={c.hl} />
        </>
      )}
    </Card>
  );
}

/** Same ids, titles and minimum sizes as PORTFOLIO_PANELS, so the layout is shared. */
export const HL_SCAN_PANELS: Array<PanelDefinition<HlScanContext>> = [
  { id: 'account', title: 'Account', pad: false, minW: 8, minH: 6, render: (c) => <HlScanAccountPanel c={c} /> },
  { id: 'fees', title: 'Fees and traded volume', pad: false, minW: 8, minH: 5, render: (c) => <HlActivityCard hl={c.hl} /> },
  { id: 'performance', title: 'Performance', pad: false, minW: 8, minH: 6, render: (c) => <HlPerformanceCard hl={c.hl} /> },
  { id: 'value', title: 'Account value', pad: false, minW: 12, minH: 10, render: (c) => <HlValueCard hl={c.hl} /> },
  { id: 'pnl', title: 'Performance chart', pad: false, minW: 12, minH: 10, render: (c) => <HlPnlCard hl={c.hl} /> },
  { id: 'capital', title: 'Capital efficiency', pad: false, minW: 10, minH: 6, render: (c) => <HlCapitalCard hl={c.hl} /> },
  { id: 'exposure', title: 'Net positions exposure', pad: false, minW: 10, minH: 6, render: (c) => <HlExposureCard hl={c.hl} /> },
  { id: 'band', title: 'Positions, orders and history', pad: false, minW: 16, minH: 8, render: (c) => <VenueBand hl={c.hl} /> },
];

/* ---------------------------------------------------------------------------
 * PORTFOLIO
 * ------------------------------------------------------------------------ */

/** What the portfolio's Hyperliquid panels need on top of the page's own context. */
export interface PortfolioHlExtras {
  hl: HlState;
}

/** The venue named the way the rail names an engine: `Fee rate <unit>perps</unit>`. */
const onHl = (title: string) => <>{title} <span className="pf-unit">Hyperliquid</span></>;

export const PORTFOLIO_HL_PANELS: Array<PanelDefinition<PortfolioHlExtras>> = [
  {
    id: 'hl-account',
    title: 'Hyperliquid account',
    pad: false,
    minW: 8,
    minH: 6,
    render: (c) => (
      <Card title={onHl('Account')} className="pf-card--identity">
        <HlChips p={c.hl.trader.data} />
        <HlOverviewGroup hl={c.hl} />
        <HlVolumeGroup hl={c.hl} />
        {c.hl.address && (
          <button
            type="button"
            className="pf-btn pf-btn--ghost"
            onClick={() => {
              window.location.href = `/scan?address=${encodeURIComponent(c.hl.address!)}&venue=hyperliquid`;
            }}
          >
            Open in Scan
          </button>
        )}
      </Card>
    ),
  },
  {
    id: 'hl-value',
    title: 'Hyperliquid account value',
    pad: false,
    minW: 12,
    minH: 10,
    render: (c) => <HlValueCard hl={c.hl} title={onHl('Account value')} />,
  },
  {
    id: 'hl-pnl',
    title: 'Hyperliquid performance',
    pad: false,
    minW: 12,
    minH: 10,
    render: (c) => <HlPnlCard hl={c.hl} title={onHl('Performance')} />,
  },
  {
    id: 'copies',
    title: 'My copies',
    pad: false,
    minW: 8,
    minH: 6,
    render: () => <MyCopiesCard />,
  },
  {
    id: 'hl-band',
    title: 'Hyperliquid positions and fills',
    pad: false,
    minW: 16,
    minH: 8,
    render: (c) => <VenueBand hl={c.hl} />,
  },
];

/**
 * Where the new panels go by default: in rows of their own under everything
 * already on the page, per breakpoint, in the portfolio's own column rhythm
 * (a 12-column rail and a 36-column main at lg, two halves at md, one column
 * below that).
 *
 * `base` is the first free row. It is passed in rather than fixed because a
 * user who has dragged the portfolio around may already reach further down than
 * the default layout does, and a default placed on top of their panels would
 * make the grid shove their arrangement out of the way.
 */
export function hlPlacements(bp: BreakpointName, base: number): PanelPlacement[] {
  const y = base;
  /*
   * lg: the grid compacts upward, so each column continues from where its own
   * SoDEX panels end - the rail at row 32, the main column at row 36 in the
   * shipped layout. The heights are chosen so the two columns meet again: the
   * rail's Hyperliquid account card (17 rows, from 32) ends on the same row as
   * the two chart cards (13 rows, from 36), and My copies ends with the band.
   */
  if (bp === 'lg') {
    return [
      { i: 'hl-account', x: 0, y, w: 12, h: 17 },
      { i: 'hl-value', x: 12, y, w: 18, h: 13 },
      { i: 'hl-pnl', x: 30, y, w: 18, h: 13 },
      { i: 'copies', x: 0, y: y + 17, w: 12, h: 14 },
      { i: 'hl-band', x: 12, y: y + 13, w: 36, h: 14 },
    ];
  }
  if (bp === 'md') {
    return [
      { i: 'hl-value', x: 0, y, w: 24, h: 13 },
      { i: 'hl-pnl', x: 24, y, w: 24, h: 13 },
      { i: 'hl-account', x: 0, y: y + 13, w: 24, h: 15 },
      { i: 'copies', x: 24, y: y + 13, w: 24, h: 15 },
      { i: 'hl-band', x: 0, y: y + 28, w: 48, h: 14 },
    ];
  }
  return [
    { i: 'hl-value', x: 0, y, w: 48, h: 13 },
    { i: 'hl-pnl', x: 0, y: y + 13, w: 48, h: 13 },
    { i: 'hl-account', x: 0, y: y + 26, w: 48, h: 15 },
    { i: 'hl-band', x: 0, y: y + 41, w: 48, h: 14 },
    { i: 'copies', x: 0, y: y + 55, w: 48, h: 8 },
  ];
}

export const HL_PANEL_IDS: ReadonlySet<string> = new Set(PORTFOLIO_HL_PANELS.map((p) => p.id));
