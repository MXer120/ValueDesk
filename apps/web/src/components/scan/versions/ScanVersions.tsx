/**
 * The new Scan versions, behind the localhost pill (dashboard/ScanDashboard.tsx). Loaded only on localhost.
 *
 *   1 Profile  the trader's page: the curve and the copy decision first (V1Profile.tsx)
 *   2 Venues   the wallet on every venue at once: one ledger, one merged book (V2Venues.tsx)
 *   3 Desk     a workbench: wallets on a rail, the account in tabs, the book by risk (V3Desk.tsx)
 */
import type { ScanPageProps } from './flow';
import { V1Profile } from './V1Profile';
import { V2Venues } from './V2Venues';
import { V3Desk } from './V3Desk';
import '../../bots/kit/kit.css';
import '../../bots/botsPages.css';
import '../../copy/CopyHome.css';
import '../../Account.css';
import '../scan.css';
import './versions.css';

export default function ScanVersions({ version, props }: { version: number; props: ScanPageProps }) {
  const V = version === 2 ? V2Venues : version === 3 ? V3Desk : V1Profile;
  return (
    <div className="tf bots-page sx-page" data-version={version}>
      <V {...props} />
    </div>
  );
}
