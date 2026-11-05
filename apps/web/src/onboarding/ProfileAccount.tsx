/**
 * What Settings > Profile holds of the wallet: its username and ValueDesk's SoDEX referral code, in
 * the Settings window's own parts. A first name is saved at once; changing one asks the wallet to sign.
 */
import { useEffect, useId, useState } from 'react';
import { Identicon } from '../components/Identicon';
import { openConnectDialog } from '../components/account/connect';
import { useWalletSnapshot } from '../components/account/useWallet';
import { shortAddr } from '../format';
import { WalletError } from '../wallet';
import { USERNAME_MAX, usernameProblem, usernameProblemText } from '@sign/profiles/claim';
import { ProfileError, changeUsername, checkName, setFirstUsername, useUsername } from './profile';
import { REFERRAL_CODE, REFERRAL_URL, useReferral } from './referral';

export type NameCheckState = { at: 'idle' | 'checking' | 'free' | 'same' } | { at: 'no'; why: string };

/** The rules at once, the server's "taken" a moment after the last key. */
export function useNameCheck(name: string, address: string | null, current: string | null | undefined): NameCheckState {
  const [check, setCheck] = useState<NameCheckState>({ at: 'idle' });
  useEffect(() => {
    if (!name) { setCheck({ at: 'idle' }); return; }
    if (current && name === current) { setCheck({ at: 'same' }); return; }
    const problem = usernameProblem(name);
    if (problem) { setCheck({ at: 'no', why: usernameProblemText(problem) }); return; }
    setCheck({ at: 'checking' });
    const stop = new AbortController();
    const t = setTimeout(() => {
      checkName(name, address, stop.signal).then(
        (r) => setCheck(r.available ? { at: 'free' } : { at: 'no', why: r.reason ?? 'This username is taken.' }),
        (e) => { if (!stop.signal.aborted) setCheck({ at: 'no', why: e instanceof Error ? e.message : 'The check did not answer. Try again.' }); },
      );
    }, 260);
    return () => { clearTimeout(t); stop.abort(); };
  }, [name, address, current]);
  return check;
}

export function NameHint({ id, check, error, idle }: { id: string; check: NameCheckState; error: string | null; idle: string }) {
  return (
    <p id={id} className={`onb-hint is-${error ? 'no' : check.at}`} role="status">
      <i aria-hidden="true" />
      {error ?? (
        check.at === 'no' ? check.why
          : check.at === 'free' ? 'Available'
          : check.at === 'checking' ? 'Checking…'
          : check.at === 'same' ? 'This is your username'
          : idle
      )}
    </p>
  );
}

function UsernameCard({ address }: { address: string }) {
  const wallet = useWalletSnapshot();
  const current = useUsername(address);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const hint = useId();
  const check = useNameCheck(name, address, current);
  const provider = wallet.status === 'connected' ? wallet.provider : null;
  const changing = !!current;
  const ready = check.at === 'free' && !busy && (!changing || !!provider);

  useEffect(() => { setError(null); setSaved(false); }, [name]);

  const save = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      if (changing) await changeUsername(provider!, address, name);
      else await setFirstUsername(address, name);
      setName('');
      setSaved(true);
    } catch (e) {
      setError(e instanceof ProfileError || e instanceof WalletError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stg__card stg-name" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="stg-name__who">
        <Identicon seed={address} size={32} />
        <span className="stg__rowtext">
          <b>{current ?? 'No username yet'}</b>
          <small>{shortAddr(address)}</small>
        </span>
      </div>
      <div className="stg-name__field">
        <input
          className={`fx-input onb-input${check.at === 'no' ? ' is-bad' : ''}`}
          value={name}
          onChange={(e) => setName(e.target.value.trim())}
          placeholder={changing ? 'New username…' : 'Your username…'}
          aria-label={changing ? 'New username' : 'Your username'}
          aria-describedby={hint}
          aria-invalid={check.at === 'no'}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={USERNAME_MAX + 1}
        />
        <button type="submit" className="stg__btn is-go" disabled={!ready}>
          {busy ? (changing ? 'Confirm in your wallet…' : 'Saving…') : changing ? 'Change' : 'Save'}
        </button>
      </div>
      {saved && !name
        ? <p className="onb-hint is-free" role="status"><i aria-hidden="true" />Saved</p>
        : <NameHint id={hint} check={check} error={error} idle={`3 to ${USERNAME_MAX} letters, numbers or _`} />}
      {changing && <p className="stg__note">Changing it takes one free signature from your wallet, never a transaction.{!provider && ' Connect your wallet to sign.'}</p>}
    </form>
  );
}

function ReferralCard({ address }: { address: string }) {
  const state = useReferral(address);
  if (state === 'other' || state === 'self' || state === 'unknown') return null;
  return (
    <>
      <div className="stg__label"><span>SoDEX referral</span></div>
      <div className="stg__card">
        <div className="stg__row">
          <span className="stg__rowtext">
            <b>
              {state === 'bound' ? `Joined with ${REFERRAL_CODE}` : state === 'pending' ? `One step left on ${REFERRAL_CODE}` : `Use code ${REFERRAL_CODE}`}
            </b>
            <small>
              {state === 'bound'
                ? 'Your wallet is on ValueDesk\'s SoDEX referral code.'
                : state === 'pending'
                  ? 'Open SoDEX once: it finishes the code with your wallet.'
                  : 'ValueDesk\'s referral code on SoDEX, for wallets without one. You confirm with your wallet on SoDEX, and SoDEX rewards ValueDesk for wallets that use it. No funds move.'}
            </small>
          </span>
          {state !== 'bound' && (
            <a className="stg__btn stg-name__link" href={REFERRAL_URL} target="_blank" rel="noopener noreferrer">{state === 'pending' ? 'Open SoDEX' : 'Apply on SoDEX'}</a>
          )}
        </div>
      </div>
    </>
  );
}

export function ProfileAccount({ address }: { address: string | null }) {
  if (!address) {
    return (
      <div className="stg__card">
        <div className="stg__row">
          <span className="stg__rowtext"><b>No wallet connected</b><small>Connect a wallet to set your username.</small></span>
          <button type="button" className="stg__btn is-go" onClick={() => openConnectDialog()}>Connect wallet</button>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="stg__label"><span>Username</span></div>
      <UsernameCard address={address} />
      <ReferralCard address={address} />
    </>
  );
}
