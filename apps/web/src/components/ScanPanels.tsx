/**
 * The panels that make the portfolio page into a scanner.
 *
 * Everything else on /scan is PORTFOLIO_PANELS unchanged - same components, same
 * data sources, so the two pages cannot drift.
 *
 * THERE IS NO SCAN BAR ANY MORE. "Which address" is not a separate question
 * needing its own panel - it is the identity of the account being looked at, and
 * the account card is where an identity belongs. A search panel floating beside
 * an Account card that ALSO showed an address was two places claiming the same
 * fact. So the scan variant of the account panel carries the input, and this
 * file exports that account card:
 *
 *   account   - the portfolio's account card, with the address made editable
 *
 * On-chain holdings are no longer a scan-only panel either: they are part of
 * "what is this wallet worth" on both pages, so they live in the account card's
 * equity breakdown, with the per-token detail in an opt-in portfolio panel.
 */
import { useEffect, useState } from 'react';
import { AccountChip, Card, OverviewGroup } from './Portfolio';
import type { ScanContext } from '../dashboard/ScanDashboard';
import { aliasFor, saveAlias } from '../dashboard/scanAliases';
import type { PanelDefinition } from '../dashboard/types';
export const SCAN_PANELS: Array<PanelDefinition<ScanContext>> = [];

/**
 * The account card, with the address turned into an input.
 *
 * Same id as the portfolio's own `account` panel, and ScanDashboard SWAPS it in
 * rather than adding it - so the saved layout, the minimum size and the position
 * in the grid are all inherited, and the scan page cannot drift into a different
 * shape from the portfolio it is a view of.
 */
export const SCAN_ACCOUNT_PANEL: PanelDefinition<ScanContext> = {
  id: 'account',
  title: 'Account',
  pad: false,
  minW: 8,
  minH: 6,
  render: (c) => <ScanAccountPanel c={c} />,
};

function ScanAccountPanel({ c }: { c: ScanContext }) {
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
        {/*
          "Me" IS THE CONNECTED WALLET. It used to be a hardcoded address that
          belonged to whoever this dashboard was originally built for, which
          meant the button showed you a stranger's account while the header
          displayed yours.
        */}
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
          <AccountChip
            address={c.scanned}
            unlocked={false}
            exists={c.model.account?.exists ?? null}
          />
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
          <OverviewGroup m={c.model} all={c.all} chain={c.chain} venue={c.venue} prices={c.prices} address={c.address} />
        </>
      )}
    </Card>
  );
}


