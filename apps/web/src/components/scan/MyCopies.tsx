/**
 * My copies: the traders this wallet copies, once copying exists.
 *
 * It does not exist yet. Copying runs through an on-chain contract that has not
 * been deployed, so there is no source for any figure on this card - and the
 * portfolio's rule for a figure with no source is an em-dash with the reason in
 * its tooltip, never a zero. The rows are drawn anyway because they are the
 * shape of what the card will say, which is more useful than a blank box; the
 * one live thing on it is the way to the Copy page.
 */
import { Card, Group, Row } from '../portfolio/parts';
import { DASH } from '../../format';

const WHY = 'Copy trading launches with the on-chain copy contract. Until it is live, nothing is copied from this wallet.';

export function MyCopiesCard() {
  return (
    <Card title="My copies">
      <Group title="Active copies">
        <Row label="Traders copied" value={DASH} cls="pf-dim" hint={WHY} />
        <Row label="Allocated" value={DASH} cls="pf-dim" hint={WHY} />
        <Row label="Copy PnL" privacy="pnl" value={DASH} cls="pf-dim" hint={WHY} />
      </Group>
      <p className="pf-note">{WHY}</p>
      <div className="pf-actions">
        <button type="button" className="pf-btn" onClick={() => { window.location.href = '/copy'; }}>
          Find traders to copy
        </button>
      </div>
    </Card>
  );
}
