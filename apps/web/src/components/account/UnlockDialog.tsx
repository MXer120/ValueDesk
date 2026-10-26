/**
 * The one unlock dialog for the trading key's user lock (trading/keyLock.ts),
 * mounted once in App.tsx. It shows whatever keyLock asks for - "Unlock
 * trading", "Confirm withdrawal of 100 USDC", "Confirm your current lock to
 * change it" - and answers it with the password or the passkey.
 *
 * Nothing is checked here: keyLock derives the key and verifies it (AES-GCM
 * refusing to decrypt = wrong password) and holds every wrong answer back for
 * a second, so the dialog cannot be the thing that makes guessing fast. The
 * passkey prompt is started by a button press, never on open: Safari only lets
 * WebAuthn run from a user gesture, and a prompt that appears by itself is the
 * kind a user learns to approve without reading.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Modal } from '../Modal';
import { DlgFoot } from '../dialogParts';
import { useUnlockRequest, type UnlockRequest } from '../../trading/keyLock';
import '../funds/funds.css';
import './UnlockDialog.css';

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export function UnlockDialog() {
  const req = useUnlockRequest();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /* The sheet keeps its last request while it plays its exit. */
  const last = useRef<UnlockRequest | null>(null);
  if (req) last.current = req;
  const shown = req ?? last.current;

  useEffect(() => {
    setPassword('');
    setError(null);
    setBusy(false);
  }, [req?.id]);

  if (!shown) return null;

  const run = async (answer: () => Promise<string | null>) => {
    if (busy || !req) return;
    setBusy(true);
    setError(null);
    try {
      const err = await answer();
      if (err) setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!req || !password) return;
    const pw = password;
    void run(async () => {
      const err = await req.submitPassword(pw);
      if (err) setPassword('');
      return err;
    });
  };

  const isPasskey = shown.kind === 'passkey';
  const title = shown.purpose === 'confirm' ? 'Confirm it is you' : 'Unlock trading';

  return (
    <Modal
      open={!!req}
      title={title}
      onClose={() => req?.cancel()}
      className="fx vs-confirm vd-unlock"
      dismissOnBackdrop={false}
    >
      <form className="vd-unlock__body dlg" onSubmit={submit}>
        <p className="vd-unlock__reason">{shown.reason}</p>
        <p className="vd-unlock__who">
          {isPasskey ? 'Use the passkey' : 'Enter the password'} you set for the trading key of wallet <strong>{short(shown.owner)}</strong>.
        </p>
        {!isPasskey && (
          <span className={`dlg-field is-wide${error ? ' is-bad' : ''}`}>
            <input
              className="vd-unlock__input"
              type="password"
              autoComplete="current-password"
              placeholder="Password"
              aria-label="Password"
              aria-invalid={!!error || undefined}
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
          </span>
        )}
        {error && (
          <p className="dlg-err vd-unlock__err" role="alert">
            {error}
          </p>
        )}
        <DlgFoot>
          <button type="button" className="dlg-btn" onClick={() => req?.cancel()}>
            Cancel
          </button>
          {isPasskey ? (
            <button type="button" className="dlg-btn is-go" disabled={busy || !req} onClick={() => req && void run(() => req.usePasskey())}>
              {busy ? 'Waiting for passkey…' : 'Use passkey'}
            </button>
          ) : (
            <button type="submit" className="dlg-btn is-go" disabled={busy || !password || !req}>
              {busy ? 'Checking…' : shown.purpose === 'confirm' ? 'Confirm' : 'Unlock'}
            </button>
          )}
        </DlgFoot>
      </form>
    </Modal>
  );
}
