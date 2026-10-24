/**
 * "Save to folder": what the snapshot of this chart will hold, and the two
 * things the user decides - whether their position and their fills (the
 * execution arrows) go in, frozen as they are now. Then the folders' own
 * picker takes over (folders/bridge.ts saveToFolder); where no folders are
 * available yet, the same sheet downloads the snapshot as a .json file.
 *
 * One of the app's sheets, like the indicator and drawing settings.
 */
import { useState } from 'react';
import { Modal } from '../components/Modal';

export interface ExportSheetProps {
  /** "BTC-USD · 1h". */
  market: string;
  drawings: number;
  indicators: number;
  /** "Long 0.014 at 79,428.6", or null when there is no open position. */
  position: string | null;
  /** Fills of this market that would become arrows. */
  fills: number;
  /** Folders are there (else: download). */
  folders: boolean;
  busy: boolean;
  onSave: (include: { position: boolean; executions: boolean }) => void;
  onClose: () => void;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export function ExportSheet({ market, drawings, indicators, position, fills, folders, busy, onSave, onClose }: ExportSheetProps) {
  const [withPosition, setWithPosition] = useState(position !== null);
  const [withFills, setWithFills] = useState(fills > 0);
  return (
    <Modal
      open
      title={folders ? 'Save to folder' : 'Download snapshot'}
      onClose={onClose}
      className="fx kc-set"
      footer={
        <div className="kc-set-foot">
          <div className="kc-set-actions">
            <button type="button" className="fx-cta fx-cta--ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="fx-cta" disabled={busy} onClick={() => onSave({ position: withPosition && position !== null, executions: withFills && fills > 0 })}>
              {busy ? 'Saving…' : folders ? 'Choose folder…' : 'Download .json'}
            </button>
          </div>
        </div>
      }
    >
      <div className="kc-set-body">
        <p className="kc-set-note kc-export-what">
          <strong>{market}</strong> as it is on screen: the range you see, {plural(drawings, 'drawing')} and {plural(indicators, 'indicator')}. Opening it later
          shows exactly this, without touching your own drawings.
        </p>
        <div className={`kc-set-line${withPosition && position ? '' : ' is-off'}`}>
          <input
            type="checkbox"
            role="switch"
            aria-label="Include my position"
            checked={withPosition && position !== null}
            disabled={position === null}
            onChange={(e) => setWithPosition(e.target.checked)}
          />
          <span className="kc-set-line__name">
            My position
            <span className="kc-export-note">{position ?? 'No open position on this market'}</span>
          </span>
        </div>
        <div className={`kc-set-line${withFills && fills > 0 ? '' : ' is-off'}`}>
          <input
            type="checkbox"
            role="switch"
            aria-label="Include my executions"
            checked={withFills && fills > 0}
            disabled={fills === 0}
            onChange={(e) => setWithFills(e.target.checked)}
          />
          <span className="kc-set-line__name">
            My executions
            <span className="kc-export-note">{fills > 0 ? `${plural(fills, 'fill')} as arrows` : 'No fills on this market'}</span>
          </span>
        </div>
        {!folders && <p className="kc-set-note">Research folders are not available here yet, so the snapshot is saved as a file.</p>}
      </div>
    </Modal>
  );
}
