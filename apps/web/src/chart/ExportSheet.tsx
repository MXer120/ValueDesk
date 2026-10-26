/**
 * "Save to folder": what the snapshot of this chart will hold, and the two
 * things the user decides - whether their position and their fills (the
 * execution arrows) go in, frozen as they are now. Then the folders' own
 * picker takes over (folders/bridge.ts saveToFolder); where no folders are
 * available yet, the same sheet downloads the snapshot as a .json file.
 *
 * In the Settings language (dialogParts.tsx), like the indicator and drawing settings.
 */
import { useState } from 'react';
import { Modal } from '../components/Modal';
import { DlgFoot, DlgRow, DlgSection, DlgSwitch } from '../components/dialogParts';

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
        <DlgFoot>
          <button type="button" className="dlg-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="dlg-btn is-go"
            disabled={busy}
            onClick={() => onSave({ position: withPosition && position !== null, executions: withFills && fills > 0 })}
          >
            {busy ? 'Saving…' : folders ? 'Choose folder…' : 'Download .json'}
          </button>
        </DlgFoot>
      }
    >
      <div className="dlg">
        <p className="dlg-note kc-export-what">
          <strong>{market}</strong> as it is on screen: the range you see, {plural(drawings, 'drawing')} and {plural(indicators, 'indicator')}. Opening it later
          shows exactly this, without touching your own drawings.
        </p>
        <DlgSection label="Also include">
          <DlgRow title="My position" line={position ?? 'No open position on this market'} off={!(withPosition && position)}>
            <DlgSwitch
              label="Include my position"
              on={withPosition && position !== null}
              disabled={position === null}
              onWord="Included"
              offWord="Left out"
              onChange={setWithPosition}
            />
          </DlgRow>
          <DlgRow title="My executions" line={fills > 0 ? `${plural(fills, 'fill')} as arrows` : 'No fills on this market'} off={!(withFills && fills > 0)}>
            <DlgSwitch
              label="Include my executions"
              on={withFills && fills > 0}
              disabled={fills === 0}
              onWord="Included"
              offWord="Left out"
              onChange={setWithFills}
            />
          </DlgRow>
        </DlgSection>
        {!folders && <p className="dlg-note">Research folders are not available here yet, so the snapshot is saved as a file.</p>}
      </div>
    </Modal>
  );
}
