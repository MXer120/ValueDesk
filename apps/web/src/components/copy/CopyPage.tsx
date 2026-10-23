/**
 * Copy trading, as a dashboard.
 *
 * The same seam as the portfolio, points and scan pages: a panel registry
 * (panels.tsx), a layout (layout.ts), and one context hook (useCopy.ts) that
 * owns every fetch and every piece of state. `className="pf copy"` puts the
 * panels in the portfolio's design-system scope, which is what the Card, Row
 * and Group they are built from are styled against.
 *
 * Live copying is copy/live.ts: the setup sheet (copy/CopySetupSheet.tsx)
 * takes the follower through their own signatures, "Start copying" starts a
 * copy in the mode they chose, and "My copies" shows every copy of the wallet
 * in every mode.
 *
 * Reads `?address=&venue=` on mount (Explore, Leaderboard and Scan link here
 * with them) and keeps the URL in step with the selected trader.
 */
import { Dashboard } from '../../dashboard/Dashboard';
import { CopySetupSheet } from '../../copy/CopySetupSheet';
import { startCopy } from '../../copy/live';
import { notify } from '../../toast';
import { COPY_DASHBOARD } from './layout';
import { COPY_PANELS } from './panels';
import { useCopyContext, type CopyPageProps } from './useCopy';
import './Copy.css';

export type { CopyPageProps } from './useCopy';

export function CopyPage(props: CopyPageProps) {
  const context = useCopyContext(props);
  const settings = context.copySettings;
  return (
    <>
      <Dashboard config={COPY_DASHBOARD} panels={COPY_PANELS} context={context} className="pf copy" />
      <CopySetupSheet
        open={context.setupOpen}
        onClose={context.closeSetup}
        mode={context.runOn}
        onMode={context.setRunOn}
        live={context.live}
        paper={context.setup.paper}
        onStart={
          context.setupStarts && settings
            ? async () => {
                await startCopy(context.runOn, settings);
                notify('ok', settings.paper ? 'Paper copy started.' : 'Copying started.');
              }
            : undefined
        }
        startLabel={context.setup.paper ? 'Start paper copy' : 'Start copying'}
      />
    </>
  );
}
