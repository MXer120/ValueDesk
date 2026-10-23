/**
 * My copies: what this wallet copies, in every mode (copy/live.ts), as the
 * portfolio summarises it. Equity and PnL are each copy's own books - its
 * allocation, the fills the copier saw and the marks it read - added up.
 */
import { useSyncExternalStore } from 'react';
import { Card, Group, Row } from '../portfolio/parts';
import { DASH, fmt, fmtUsd, signClass } from '../../format';
import { copyRows, getLiveCopy, subscribeLiveCopy } from '../../copy/live';

export function MyCopiesCard() {
  const live = useSyncExternalStore(subscribeLiveCopy, getLiveCopy, getLiveCopy);
  const running = copyRows(live).filter((r) => r.view.subscription.status !== 'stopped');
  const real = running.filter((r) => !r.view.subscription.settings.paper);
  const allocated = real.reduce((a, r) => a + r.view.subscription.settings.allocationUsd, 0);
  const pnl = real.reduce((a, r) => a + r.view.pnl, 0);
  const none = real.length === 0;
  const why = 'No live copy is running for this wallet. Paper copies are not counted here.';
  return (
    <Card title="My copies">
      <Group title="Active copies">
        <Row label="Traders copied" value={none ? DASH : fmt(real.length, 0)} cls={none ? 'pf-dim' : undefined} hint={none ? why : undefined} />
        <Row label="Allocated" value={none ? DASH : fmtUsd(allocated, 0)} cls={none ? 'pf-dim' : undefined} hint={none ? why : undefined} />
        <Row label="Copy PnL" privacy="pnl" value={none ? DASH : `${pnl > 0 ? '+' : ''}${fmtUsd(pnl, 2)}`} cls={none ? 'pf-dim' : signClass(pnl)} hint={none ? why : undefined} />
      </Group>
      {running.length > real.length && <p className="pf-note">{running.length - real.length} paper {running.length - real.length === 1 ? 'copy' : 'copies'} running as well.</p>}
      <div className="pf-actions">
        <button type="button" className="pf-btn" onClick={() => { window.location.href = '/copy'; }}>
          {none ? 'Find traders to copy' : 'Manage copies'}
        </button>
      </div>
    </Card>
  );
}
