/**
 * The operator's emergency brake, said in one line at the top of the app
 * (apps/server/src/ops/brake.ts, read through /api/health every 30 s). Shown
 * only while it is on: what is paused, and the operator's reason.
 */
import { brakeOf } from '../trading/config';

export function BrakeBanner({ health }: { health: { brake?: unknown } | null | undefined }) {
  const b = brakeOf(health?.brake);
  if (!b) return null;
  const what = b.trading ? 'Trading is paused' : b.copies && b.algos ? 'Copy trading and algo orders are paused' : b.copies ? 'Copy trading is paused' : 'Algo orders are paused';
  return (
    <div className="banner warn" role="alert">
      <div className="banner-inner">
        <span className="banner-text">
          {what} on ValueDesk: {b.reason} <span className="muted">Your open positions and the stops resting on SoDEX are not touched{b.trading ? ', and you can still close positions, cancel orders and withdraw' : ''}.</span>
        </span>
      </div>
    </div>
  );
}
