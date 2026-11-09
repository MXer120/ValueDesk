/**
 * "Bot setup": what a bot needs before it starts, in the copy setup's sheet and steps (CopySetupSteps), worded
 * for bots. Always the ValueDesk executor - bots run nowhere else - so there is no mode to pick, and the
 * sign-in is part of the terms step rather than a step of its own:
 *
 *   practice   connect, terms
 *   real       connect, terms, fee (the wallet's own bot fee, /me bots.feeTenths), trading key
 */
import { useState } from 'react';
import { revokeDayKeysOn } from '../../algo/executorAlgos';
import { readiness, type LiveCopy } from '../../copy/live';
import { CopySetupSteps, SetupProgress, copyReady } from '../../copy/CopySetupSheet';
import { botFeeWords } from '../../bots/presets';
import { Modal } from '../Modal';
import '../funds/funds.css';
import '../../copy/copy.css';

/** The wallet's bot fee in tenths of a bp: the executor's /me (fee ladder, VIP), else /info's, else the default. */
export function botFeeTenthsOf(live: LiveCopy): number | undefined {
  const me = live.hosted.me as unknown as { bots?: { feeTenths?: unknown } } | null;
  const t = me?.bots?.feeTenths;
  if (typeof t === 'number' && Number.isFinite(t) && t >= 0) return t;
  const info = live.hosted.info as unknown as { bots?: { fee?: unknown } } | null;
  const f = info?.bots?.fee;
  return typeof f === 'number' && Number.isFinite(f) && f >= 0 ? f : undefined;
}

/** Ready to start a bot (practice: no fee and no key), or the step still missing in words. */
export function botReady(live: LiveCopy, paper: boolean): { ready: boolean; why: string | null } {
  if (!live.owner) return { ready: false, why: 'Connect your wallet.' };
  if (!live.hosted.info) return { ready: false, why: 'The ValueDesk executor is not reachable right now.' };
  const r = readiness(live, 'hosted');
  if (!r.connected) return { ready: false, why: 'Sign in to the ValueDesk executor (one free signature).' };
  if (!r.terms) return { ready: false, why: 'Accept the terms in the bot setup.' };
  if (!copyReady(live, 'hosted', true)) return { ready: false, why: 'Bots are not available where you are.' };
  if (copyReady(live, 'hosted', paper)) return { ready: true, why: null };
  if (!r.fee) return { ready: false, why: `Approve the ${botFeeWords(botFeeTenthsOf(live))} fee in the bot setup for real orders.` };
  return { ready: false, why: 'Approve the trading key in the bot setup for real orders.' };
}

export function BotSetupSheet({ open, onClose, live, paper }: { open: boolean; onClose: () => void; live: LiveCopy; paper: boolean }) {
  const ready = botReady(live, paper).ready;
  const [revoke, setRevoke] = useState<'idle' | 'busy' | 'done' | string>('idle');
  const doRevoke = async () => {
    setRevoke('busy');
    try {
      await revokeDayKeysOn('hosted');
      setRevoke('done');
    } catch (e) {
      setRevoke(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Modal open={open} title="Bot setup" onClose={onClose} size="md" className="fx cs-sheet">
      <p className="cs-sub">
        Bots trade in your own SoDEX account, run around the clock by ValueDesk.{' '}
        {paper ? 'A practice bot needs the terms only; real orders add the fee and a trading key.' : 'Real orders need the fee and a trading key as well.'}
      </p>
      <SetupProgress live={live} mode="hosted" paper={paper} bots />
      <CopySetupSteps mode="hosted" live={live} paper={paper} bots />
      {live.hosted.signedIn && (
        <p className="cs-sub" role="note">
          Your wallet signs at most once a day: it approves a key this browser keeps (it cannot be read out), which then
          signs your bot actions for up to 24 hours. Used a device you no longer trust?{' '}
          <button type="button" className="bots-link" disabled={revoke === 'busy'} onClick={() => void doRevoke()}>Revoke every day key</button>
          {revoke === 'done' ? ' Done: every device asks your wallet again.' : revoke !== 'idle' && revoke !== 'busy' ? ` Not revoked: ${revoke}` : ''}
        </p>
      )}
      <div className="cs-actions">
        <button type="button" className="fx-cta fx-cta--ghost" onClick={onClose}>{ready ? 'Close' : 'Cancel'}</button>
        <button type="button" className="fx-cta" disabled={!ready} onClick={onClose}>{ready ? 'Done' : 'Finish the steps'}</button>
      </div>
    </Modal>
  );
}
