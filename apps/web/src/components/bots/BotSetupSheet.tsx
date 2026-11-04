/**
 * "Bot setup": what a bot needs before it starts, in the copy setup's sheet and steps (CopySetupSteps), worded
 * for bots. Always the ValueDesk executor - bots run nowhere else - so there is no mode to pick, and the
 * sign-in is part of the terms step rather than a step of its own:
 *
 *   practice   connect, terms
 *   real       connect, terms, fee (0.1 bp), trading key
 */
import { readiness, type LiveCopy } from '../../copy/live';
import { CopySetupSteps, SetupProgress, copyReady } from '../../copy/CopySetupSheet';
import { botFeeWords } from '../../bots/presets';
import { Modal } from '../Modal';
import '../funds/funds.css';
import '../../copy/copy.css';

/** Ready to start a bot (practice: no fee and no key), or the step still missing in words. */
export function botReady(live: LiveCopy, paper: boolean): { ready: boolean; why: string | null } {
  if (!live.owner) return { ready: false, why: 'Connect your wallet.' };
  if (!live.hosted.info) return { ready: false, why: 'The ValueDesk executor is not reachable right now.' };
  const r = readiness(live, 'hosted');
  if (!r.terms || !r.connected) return { ready: false, why: 'Accept the terms in the bot setup.' };
  if (!copyReady(live, 'hosted', true)) return { ready: false, why: 'Bots are not available where you are.' };
  if (copyReady(live, 'hosted', paper)) return { ready: true, why: null };
  if (!r.fee) return { ready: false, why: `Approve the ${botFeeWords()} fee in the bot setup for real orders.` };
  return { ready: false, why: 'Approve the trading key in the bot setup for real orders.' };
}

export function BotSetupSheet({ open, onClose, live, paper }: { open: boolean; onClose: () => void; live: LiveCopy; paper: boolean }) {
  const ready = botReady(live, paper).ready;
  return (
    <Modal open={open} title="Bot setup" onClose={onClose} size="md" className="fx cs-sheet">
      <p className="cs-sub">
        Bots trade in your own SoDEX account, run around the clock by ValueDesk.{' '}
        {paper ? 'A practice bot needs the terms only; real orders add the fee and a trading key.' : 'Real orders need the fee and a trading key as well.'}
      </p>
      <SetupProgress live={live} mode="hosted" paper={paper} bots />
      <CopySetupSteps mode="hosted" live={live} paper={paper} bots />
      <div className="cs-actions">
        <button type="button" className="fx-cta fx-cta--ghost" onClick={onClose}>{ready ? 'Close' : 'Cancel'}</button>
        <button type="button" className="fx-cta" disabled={!ready} onClick={onClose}>{ready ? 'Done' : 'Finish the steps'}</button>
      </div>
    </Modal>
  );
}
