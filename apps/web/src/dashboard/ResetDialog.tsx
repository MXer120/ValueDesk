/**
 * "Reset layout" asks first, and what to reset: the sizes and places only (the
 * widgets stay), or the whole terminal back to how it shipped - widgets too.
 * Either way the terminal returns to its own original (storage.ts resetSlot):
 * News to the News layout, Trade to the designed one.
 */
import { Modal } from '../components/Modal';
import type { ResetMode } from './storage';

export function ResetDialog({ open, name, onReset, onClose }: {
  open: boolean;
  /** The terminal on screen ("News"). */
  name: string | null;
  onReset: (mode: ResetMode) => void;
  onClose: () => void;
}) {
  const what = name ? `the ${name} terminal` : 'this layout';
  return (
    <Modal open={open} title={`Reset ${what}?`} onClose={onClose} size="sm" className="fx dash-reset">
      <p className="dash-reset__lead">Back to how {what} first looked. Choose how much:</p>
      <div className="dash-reset__opts">
        <button type="button" className="dash-reset__opt" onClick={() => onReset('sizes')}>
          <b>Sizes and places</b>
          <span>Every panel back to its original size and place. The widgets you added or removed stay as they are.</span>
        </button>
        <button type="button" className="dash-reset__opt" onClick={() => onReset('all')}>
          <b>The whole terminal</b>
          <span>Sizes, places and widgets: the panels it started with, nothing else.</span>
        </button>
      </div>
      <div className="dash-reset__foot">
        <button type="button" className="fx-cta fx-cta--ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
