/**
 * Wealth (/wealth): the Portfolio's own Wealth tab (components/portfolio/WealthTab.tsx) under SoDEX's mark,
 * so the two share one look, one set of reads and one total (summary.ts summarize). All of SoDEX's funds,
 * names and shelves come from trading/wealth.ts; only the page header and the maintenance notice are here.
 *
 * On localhost a switch at the foot of the page shows the page's versions for the owner to choose from (owner
 * 2026-11-26: "multiple versions and the switch ... Do not delete the original keep it in the switch"): Original
 * (this page as it was), Shelves, Desk and Mine (./wealth/, loaded on localhost only). All read exactly what the
 * Original reads, and every way in or out is the Original's. "Test wallet" reads the owner's test wallet with no
 * signer, so nothing can be sent for it. A build shows the Original only and carries none of the versions.
 */
import { Suspense, lazy, useState } from 'react';
import { usePortfolioContext, type PortfolioProps } from '../Portfolio';
import { useSummary } from '../portfolio/PortfolioPage';
import { WealthTab } from '../portfolio/WealthTab';
import { useWealth } from '../portfolio/useWealth';
import { usePolled } from '../explore/cohorts/parts';
import { SODEX_SITE } from '../../sodexProgrammes';
import type { Eip1193Provider } from '../../wallet';
import { Pill, ProgrammeHero, ProgrammePage } from './parts';
import { fetchMaintenance, type WealthMaintenance } from './wealthMaintenance';

export interface SodexPageProps extends PortfolioProps {
  provider: Eip1193Provider | null;
  onOpenMarket: (symbol: string, engine: 'spot' | 'perps') => void;
}

const DEV = import.meta.env.DEV;
const KEY = 'vs.dev.wealth.version';
const WATCH_KEY = 'vs.dev.wealth.watch';
/** The owner's test wallet (the live-test suite's), read-only here. Localhost only. */
const TEST_WALLET = DEV ? '0x04fb8f9d0d8cd5495aa47e81ca9804cdf32a277d' : null;
const WealthVersion = DEV ? lazy(() => import('./wealth/Versions')) : null;
// Loaded at once on localhost, so the switch has its styles on the Original too.
if (DEV) void import('./wealth/Versions');
type Version = 'original' | 'shelves' | 'desk' | 'mine';
const VERSIONS: ReadonlyArray<[Version, string]> = [['original', 'Original'], ['shelves', 'Shelves'], ['desk', 'Desk'], ['mine', 'Mine']];

function stored(): Version {
  if (!DEV) return 'original';
  try {
    const s = localStorage.getItem(KEY);
    return VERSIONS.some(([k]) => k === s) ? (s as Version) : 'original';
  } catch {
    return 'original';
  }
}
function storedWatch(): boolean {
  if (!DEV) return false;
  try { return localStorage.getItem(WATCH_KEY) === '1'; } catch { return false; }
}
const keep = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* this tab only */ } };

export function WealthPage({ provider, onOpenMarket, ...props }: SodexPageProps) {
  const [ver, setVer] = useState(stored);
  const [watch, setWatch] = useState(storedWatch);
  // Watching the test wallet: its reads, and no signer, so nothing can be sent from this tab for it.
  const watched = DEV && watch && TEST_WALLET ? TEST_WALLET : null;
  const signer = watched ? null : provider;
  const c = usePortfolioContext(watched ? { ...props, address: watched } : props);
  const w = useWealth(c.address, c.refreshToken);
  const { summary } = useSummary(c, w);
  const maint = usePolled<WealthMaintenance>('wealth-maintenance', (signal) => fetchMaintenance(signal), 30_000);

  const version: Version = DEV ? ver : 'original';
  const switcher = DEV && (
    <nav className="wv-switch" aria-label="Page version" data-no-i18n="">
      {VERSIONS.map(([k, t]) => <button key={k} type="button" aria-pressed={version === k} className={version === k ? 'is-on' : ''} onClick={() => { setVer(k); keep(KEY, k); }}>{t}</button>)}
      <span aria-hidden="true" />
      <button type="button" aria-pressed={watch} className={watch ? 'is-on is-watch' : ''} title="Read the owner's test wallet; nothing can be signed while it is on" onClick={() => { setWatch(!watch); keep(WATCH_KEY, watch ? '0' : '1'); }}>Test wallet</button>
    </nav>
  );

  if (version !== 'original' && WealthVersion) {
    return (
      <Suspense fallback={null}>
        <WealthVersion
          version={version}
          provider={signer}
          onDone={c.onChanged}
          vp={{ w, value: summary.wealth, slp: summary.slp, maint: maint.data, ctx: { address: c.address, refreshToken: c.refreshToken, onOpenMarket } }}
        >
          {switcher}
        </WealthVersion>
      </Suspense>
    );
  }

  return (
    <ProgrammePage label="Wealth">
      <ProgrammeHero
        title="Wealth"
        line="Tokenised funds, vaults and on-chain yield."
        aside={<a className="pf-btn" href={SODEX_SITE.wealth} target="_blank" rel="noopener noreferrer">Open on SoDEX</a>}
      />
      {maint.data?.state === 'maintenance' && (
        <div className="sdx-banner" role="status">
          <Pill tone="warn" dot>Maintenance</Pill>
          <span>{maint.data.message || 'SoDEX has Wealth in maintenance. Figures may be behind.'}</span>
        </div>
      )}
      {/* The Portfolio's scope, for the tab's own rules. */}
      <div className="pf bots pfx sdx-wealthtab">
        <WealthTab
          w={w}
          value={summary.wealth}
          slp={summary.slp}
          address={c.address}
          provider={signer}
          refreshToken={c.refreshToken}
          onOpenMarket={onOpenMarket}
          onDone={c.onChanged}
        />
      </div>
      {switcher}
    </ProgrammePage>
  );
}
