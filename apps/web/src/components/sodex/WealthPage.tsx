/**
 * Wealth (/wealth): the Portfolio's own Wealth tab (components/portfolio/WealthTab.tsx) under SoDEX's mark,
 * so the two share one look, one set of reads and one total (summary.ts summarize). All of SoDEX's funds,
 * names and shelves come from trading/wealth.ts; only the page header and the maintenance notice are here.
 */
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

export function WealthPage({ provider, onOpenMarket, ...props }: SodexPageProps) {
  const c = usePortfolioContext(props);
  const w = useWealth(c.address, c.refreshToken);
  const { summary } = useSummary(c, w);
  const maint = usePolled<WealthMaintenance>('wealth-maintenance', (signal) => fetchMaintenance(signal), 30_000);

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
          provider={provider}
          refreshToken={c.refreshToken}
          onOpenMarket={onOpenMarket}
          onDone={c.onChanged}
        />
      </div>
    </ProgrammePage>
  );
}
