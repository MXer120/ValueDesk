/**
 * The referral link with the wallet's own code, changed right where it is shown (owner 2026-11-26: "customizing just by
 * clicking in the ref input field and typing, needs to follow all sodex side rules, but changable only once like sodex").
 *
 * The code is the wallet's SoDEX code, so the change is made on SoDEX, as SoDEX's own referral page makes it
 * (invites/sodexRewards.ts: 4 to 18 of A-Z and 0-9, SoDEX's own text signed, biz/referral/updateMyCode, once). A wallet not
 * signed in to SoDEX signs in first (the same sign-in as the weekly claim). Before that SoDEX has not said whether the code
 * may still change: the field opens, and SoDEX's answer is said if it may not.
 *
 * Sample data (localhost): the same field, the same rules and the one change, made up: no wallet, no SoDEX.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { setOwnCode } from '../../invites/invites';
import { OWN_CODE_MAX, fetchStats, ownCodeErrorText, ownCodeInput, ownCodeProblem, ownCodeProblemText, postOwnCode, signOwnCode } from '../../invites/sodexRewards';
import type { SodexRewards } from '../../invites/useSodexRewards';
import { NeedsPointsToken, SodexError, getPointsToken, setPointsToken } from '../../points';
import { signInToPoints } from '../../pointsAuth';
import { notify } from '../../toast';
import { WalletError, type Eip1193Provider } from '../../wallet';
import { Icon } from '../bots/kit/kit';
import { LinkButton, LinkIcons, LinkText, type LinkState, type RefView } from './parts';

type Busy = 'signin' | 'sign' | 'save';
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Sample data: codes "taken" on the made-up SoDEX, so that answer can be seen too. */
const SAMPLE_TAKEN = new Set(['VALUEDESK', 'SODEX', 'TAKEN']);
const ONCE = 'SoDEX lets you change your code once, and it was changed already.';

export function OwnLinkBar({ l, v, s, provider }: { l: LinkState; v: RefView; s: SodexRewards; provider: Eip1193Provider | null }) {
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [sampleCode, setSampleCode] = useState<string | null>(null);
  const [used, setUsed] = useState(false);
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const code = v.sample ? sampleCode ?? l.code : l.code;
  // Before a SoDEX sign-in SoDEX has not said: the field opens, and its answer comes on Save.
  const can = !used && (s.stats ? s.stats.canModify : true);
  const problem = ownCodeProblem(text);
  const same = text === code;

  useEffect(() => { setEdit(false); setError(null); setNote(null); setUsed(false); setSampleCode(null); }, [v.address, v.sample]);
  useEffect(() => { if (edit) input.current?.select(); }, [edit]);
  // SoDEX's signed-in stats name the code SoDEX's own page shows (a code changed on another device too): ours shows it.
  const statsCode = v.sample ? null : s.stats?.code ?? null;
  useEffect(() => { if (v.address && statsCode && statsCode !== l.code && l.state === 'ok') setOwnCode(v.address, statsCode); }, [v.address, statsCode, l.code, l.state]);

  const start = () => {
    if (!code || busy) return;
    if (!can) { setNote(ONCE); return; }
    setText(code);
    setError(null);
    setNote(null);
    setEdit(true);
  };
  const cancel = () => { if (!busy) { setEdit(false); setError(null); } };

  const save = async () => {
    if (busy || !code) return;
    if (problem) { setError(ownCodeProblemText(problem)); return; }
    if (same) { setEdit(false); return; }
    const next = text;
    setError(null);
    if (v.sample) {
      if (SAMPLE_TAKEN.has(next)) { setError('This code is taken. Try another.'); return; }
      setBusy('sign'); await pause(700);
      setBusy('save'); await pause(500);
      setBusy(null); setSampleCode(next); setUsed(true); setEdit(false);
      notify('ok', `Sample: your code is now ${next}. SoDEX allows one change, so it stays.`);
      return;
    }
    if (!provider || !v.address) return;
    const a = v.address.toLowerCase();
    try {
      if (!getPointsToken(a)) {
        setBusy('signin');
        setPointsToken(a, await signInToPoints(provider, a));
      }
      // SoDEX's word first: a change made already (on another device, or on sodex.com) needs no second signature.
      setBusy('save');
      const st = await fetchStats(a).catch(() => null);
      if (st?.code && st.code !== code) setOwnCode(a, st.code);
      if (st && !st.canModify) { setUsed(true); setEdit(false); setNote(ONCE); s.refresh(); return; }
      setBusy('sign');
      const signed = await signOwnCode(provider, a, next);
      setBusy('save');
      await postOwnCode(a, signed, next);
      setOwnCode(a, next);
      setUsed(true);
      setEdit(false);
      s.refresh();
      notify('ok', `Your code is now ${next}. SoDEX allows one change, so it stays.`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (e instanceof WalletError && /reject|denied|cancel/i.test(m)) { /* changed their mind */ }
      else if (e instanceof NeedsPointsToken) setError('Sign in to SoDEX again, then save.');
      else if (e instanceof SodexError) {
        setError(ownCodeErrorText(e));
        if (e.code === -3001004) { setUsed(true); setEdit(false); setNote(ONCE); }
      } else setError(`SoDEX did not change the code: ${m}`);
    } finally {
      setBusy(null);
    }
  };

  const hint = busy === 'signin' ? 'Sign in to SoDEX in your wallet: one signature, no transaction.'
    : busy === 'sign' ? "Confirm the new code in your wallet: SoDEX's own text, no transaction."
    : busy === 'save' ? 'Saving on SoDEX…'
    : error ?? (edit ? `${text.length}/${OWN_CODE_MAX} · A to Z and 0 to 9, at least 4 · SoDEX lets you change it once` : note);

  return (
    <>
      <div className={`rf-bar is-big${edit ? ' is-edit' : ''}`}>
        <div className="rf-bar__in">
          {edit ? (
            <label className="rf-linkedit">
              <span aria-hidden="true">valuedesk.so/?ref=</span>
              <input
                ref={input} value={text} disabled={!!busy} maxLength={OWN_CODE_MAX} spellCheck={false} autoCapitalize="characters" autoComplete="off"
                aria-label="Your referral code" aria-describedby={hintId} aria-invalid={!!error}
                onChange={(e) => { setText(ownCodeInput(e.target.value)); setError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } else if (e.key === 'Escape') { e.preventDefault(); cancel(); } }}
              />
            </label>
          ) : code ? (
            <button type="button" className={`rf-linktext is-code${can ? ' is-open' : ''}`} onClick={start} title={can ? 'Change your code' : ONCE} aria-label={can ? `Your link, valuedesk.so/?ref=${code}. Change your code` : `Your link, valuedesk.so/?ref=${code}`}>
              <span>valuedesk.so/?ref=</span><b>{code}</b>{can && <Icon name="pen" size={14} className="rf-linkpen" />}
            </button>
          ) : (
            <LinkText l={l} />
          )}
          {edit ? (
            <>
              <button type="button" className="rf-linkcancel" onClick={cancel} disabled={!!busy}>Cancel</button>
              <button type="button" className="rf-cta" onClick={() => void save()} disabled={!!busy || !!problem || same}>{busy ? 'Check wallet…' : 'Save'}</button>
            </>
          ) : (
            <LinkButton l={l} label="Copy" />
          )}
        </div>
        {!edit && <LinkIcons l={l} />}
      </div>
      {hint && <p id={hintId} className={`rf-codehint${error ? ' is-bad' : ''}`} role={error ? 'alert' : undefined} aria-live="polite">{hint}</p>}
    </>
  );
}
