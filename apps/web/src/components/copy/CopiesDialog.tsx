/**
 * "Manage copies" on the Portfolio page's My copies card: every copy this wallet
 * runs, in every mode, with Pause, Resume, Stop, Close and Stop all, and each
 * copy's activity (panels.tsx).
 *
 * The Copy page is the trader grid alone (owner, 2026-10-26) and its old My
 * copies tab went with it, so this table was mounted nowhere: a copy, once
 * started, could not be paused or stopped from the site - the card's "Manage
 * copies" only led back to the trader grid. Loaded on demand, from the card.
 */
import { useSyncExternalStore } from 'react';
import { getLiveCopy, subscribeLiveCopy } from '../../copy/live';
import type { Venue } from '../../vsApi';
import { openPath } from '../../nav';
import { Modal } from '../Modal';
import { CopiesManager } from './panels';
import './Copy.css';

/* In place (nav.ts openPath): the dialog closes with the page it sits on, no reload. */
const openTrader = (address: string, venue?: Venue) => {
  openPath(venue ? `/scan?address=${encodeURIComponent(address)}&venue=${venue}` : `/scan?find=${encodeURIComponent(address)}`);
};

export default function CopiesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const live = useSyncExternalStore(subscribeLiveCopy, getLiveCopy, getLiveCopy);
  return (
    <Modal open={open} title="My copies" onClose={onClose} size="lg">
      <div className="pf cpy-manage">
        <CopiesManager src={{ live, wallet: live.owner, onScan: openTrader }} />
      </div>
    </Modal>
  );
}
