/**
 * Use a code (owner 2026-11-25), for a wallet SoDEX says has no referrer. The field starts with ValueDesk's own code - or the
 * code of the link the wallet came with, which is never overridden - and takes any other.
 *
 * Redesigned 2026-11-26 (owner: "redesign the pop up", the fee text out, no Close button, one Apply button without the
 * numbered row, the perks shown after applying as what the wallet got, ValueDesk's own perks among them):
 *   - the field, then ONE button that does the next step: a person's code first joins on ValueDesk (one free signature),
 *     then every code is applied on SoDEX's own page (referral.ts: SoDEX's sign-in only works on sodex.com);
 *   - once SoDEX has the code: "You got", on SoDEX and on ValueDesk, each SoDEX perk with its source.
 *
 * The check is quick (owner 2026-11-26: "in checking for a long time"): SoDEX names a code's owner for a wallet with no
 * referrer, asked from this browser (~0.3 s), and that answer alone says the code is good. What ValueDesk adds to a person's
 * code (welcome, VIP days, a full week) is asked of our server beside it and fills in when it comes. Until then the verdict
 * waited for SoDEX and then our server (which asks SoDEX again), one after the other, up to 10 s each.
 */
import { useEffect, useState } from 'react';
import { CODE_RE, OURS_CODE, REFERRED_START_USD, normCode, type InviteMe } from '@sign/invites/claim';
import { track } from '../../analytics/usage';
import { InviteError, checkCode, dropInvite, fullText, joinInvite, loadMe, pendingInvite, useSodexCode, type CodeCheck } from '../../invites/invites';
import { loadReferral, referralUrl, useReferral, useReferralKnown } from '../../onboarding/referral';
import { YOU_GET, markOffered } from '../../onboarding/referralRules';
import { notify } from '../../toast';
import type { Eip1193Provider } from '../../wallet';
import { Modal } from '../Modal';
import { welcomeText } from './parts';
import '../../onboarding/onboarding.css';

/**
 * The button: only for a connected wallet that SoDEX itself says has no referrer. With sample data (localhost) always, and
 * the dialog runs on a made-up SoDEX (owner 2026-11-26: "In sample ensure i see all features").
 */
export function UseCodeButton({ address, provider, me, sample = false }: { address: string | null; provider: Eip1193Provider | null; me: InviteMe | null; sample?: boolean }) {
  const sc = useSodexCode(sample ? null : address);
  const state = useReferral(sample ? null : address, sc.code);
  const [open, setOpen] = useState(false);
  if (sample) {
    return (
      <>
        <button type="button" className="rf-howbtn is-code" onClick={() => setOpen(true)}>Use a code</button>
        {open && <UseCodeDialog sim address="" provider={null} me={SIM_ME} initial={OURS_CODE} locked={null} onClose={() => setOpen(false)} />}
      </>
    );
  }
  // While the dialog is open it stays, whatever the state becomes: it says so itself.
  if (!address || !provider || (!open && (state !== 'none' || !sc.ready))) return null;
  return (
    <>
      <button type="button" className="rf-howbtn is-code" onClick={() => setOpen(true)}>Use a code</button>
      {open && <UseCodeDialog address={address} provider={provider} me={me} initial={sc.code} locked={me?.joined?.code ?? null} onClose={() => setOpen(false)} />}
    </>
  );
}

/* Sample data: a made-up SoDEX and ValueDesk. */
const SIM_ME = { canJoin: true } as InviteMe;
const SIM_CODES: Record<string, Verdict['state']> = { [OURS_CODE]: 'ok', FRIEND01: 'ok', ALPHA7: 'ok', FULLWEEK: 'ok', SAMPLE: 'own' };
function simCheck(code: string, now = Date.now()): CodeCheck {
  const d = new Date(now);
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 7);
  return { welcome: true, vipDays: code === 'FRIEND01' ? 7 : 0, ...(code === 'FULLWEEK' ? { fullUntil: monday } : {}) };
}

type Verdict = { code: string; state: 'asking' | 'ok' | 'bad' | 'silent' | 'own' };
/** After the typing stops, before anyone is asked. */
const SETTLE_MS = 200;
/** While the SoDEX tab is open: asked again this often, so the dialog turns by itself. */
const WAIT_POLL_MS = 4_000;

export function UseCodeDialog({ address, provider, me, initial, locked, onClose, sim = false }: {
  address: string; provider: Eip1193Provider | null; me: InviteMe | null; initial: string;
  /** Sample data: nothing is asked of a wallet, SoDEX or our server. */
  sim?: boolean;
  /** The code this wallet joined ValueDesk with: SoDEX gets the same. */
  locked: string | null;
  onClose: () => void;
}) {
  const [text, setText] = useState(locked ?? initial);
  const code = normCode(text);
  const ours = code === OURS_CODE;
  const shaped = CODE_RE.test(code);
  const [verdict, setVerdict] = useState<Verdict>({ code: '', state: 'asking' });
  /** Our server's word on a person's code: what ValueDesk adds. */
  const [extra, setExtra] = useState<{ code: string; check: CodeCheck } | null>(null);
  /** What joining on ValueDesk gave (this dialog's join, or the one the wallet had). */
  const [got, setGot] = useState<{ welcome: boolean; vipUntil: number | null } | null>(
    locked ? { welcome: !!me?.welcome?.active, vipUntil: me?.vipUntil ?? null } : null,
  );
  const joined = !!got;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  useEffect(() => { if (!sim) markOffered(address); }, [address, sim]);
  const [simApplied, setSimApplied] = useState(false);

  useEffect(() => {
    if (!shaped) return;
    let off = false;
    setVerdict({ code, state: 'asking' });
    const t = window.setTimeout(() => {
      if (sim) {
        const state = SIM_CODES[code] ?? 'bad';
        if (state === 'ok' && !ours) setExtra({ code, check: simCheck(code) });
        setVerdict({ code, state });
        return;
      }
      const server = ours ? null : checkCode(code);
      void server?.then((c) => { if (!off && c.state === 'ok') setExtra({ code, check: c }); });
      void (async (): Promise<Verdict['state']> => {
        const s = await loadReferral(address, code);
        if (s === 'self') return 'own';
        if (s !== 'unknown') return 'ok'; // SoDEX named the code's owner
        // SoDEX named nobody (no such code) or did not answer here: our server asks it too.
        if (!server) return 'silent';
        return (await server).state;
      })().then((state) => { if (!off) setVerdict({ code, state }); });
    }, SETTLE_MS);
    return () => { off = true; window.clearTimeout(t); };
  }, [address, code, shaped, ours, sim]);

  const cur = shaped && verdict.code === code ? verdict.state : null;
  const ok = cur === 'ok';
  const check = ok && extra?.code === code ? extra.check : null;
  const real = useReferralKnown(sim ? null : address, ok ? code : OURS_CODE);
  const sodex = sim ? (simApplied ? 'bound' : 'none') : real;
  const applied = ok && (sodex === 'bound' || sodex === 'pending');
  /** A person's code is joined on ValueDesk too, while this wallet still may. */
  const full = !!check?.fullUntil && check.fullUntil > Date.now() && !joined;
  const canJoin = ok && !ours && !full && (joined || me?.canJoin === true);
  const needJoin = canJoin && !joined;
  const done = applied && !needJoin;
  const waiting = ok && opened && !applied && sodex !== 'other';

  // Back from the SoDEX tab, and every few seconds while it is open: asked again, so the dialog turns by itself.
  useEffect(() => {
    if (!ok || applied) return;
    // Sample data: the wallet "confirms on SoDEX" a moment after the tab opened.
    if (sim) {
      if (!opened) return;
      const t = window.setTimeout(() => setSimApplied(true), 2_500);
      return () => window.clearTimeout(t);
    }
    const ask = () => { if (document.visibilityState === 'visible') void loadReferral(address, code); };
    document.addEventListener('visibilitychange', ask);
    window.addEventListener('focus', ask);
    const t = opened ? window.setInterval(ask, WAIT_POLL_MS) : undefined;
    return () => {
      document.removeEventListener('visibilitychange', ask);
      window.removeEventListener('focus', ask);
      window.clearInterval(t);
    };
  }, [ok, applied, opened, address, code, sim]);

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      if (sim || !provider) {
        await new Promise((r) => setTimeout(r, 900));
        setGot({ welcome: check?.welcome !== false, vipUntil: check?.vipDays ? Date.now() + check.vipDays * 86_400_000 : null });
        return;
      }
      const r = await joinInvite(provider, address, code);
      track('invite.bind', {});
      setGot({ welcome: r.welcome, vipUntil: r.vipUntil });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (!/reject|denied|cancel/i.test(m)) setError(e instanceof InviteError ? m : `Could not join: ${m}`);
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    if (sim) { onClose(); return; }
    if (applied && pendingInvite()?.code === code) dropInvite();
    if (joined) void loadMe(address);
    onClose();
  };

  const status = !text ? null
    : !shaped ? <i className="is-bad">4 to 20 letters and numbers</i>
    : !cur || cur === 'asking' ? <i><span className="rf-usecode__spin" aria-hidden="true" />Checking</i>
    : applied ? <i className="is-ok"><Check />Applied</i>
    : cur === 'ok' ? <i className={full ? undefined : 'is-ok'}>{ours ? "ValueDesk's code" : full ? 'Full this week' : 'Valid'}</i>
    : cur === 'own' ? <i className="is-bad">Your own code</i>
    : cur === 'silent' ? <i className="is-bad">SoDEX did not answer</i>
    : <i className="is-bad">SoDEX has no such code</i>;

  const hint = !ok ? null
    : done ? (sodex === 'pending' ? 'SoDEX finishes it after your first deposit.' : null)
    : sodex === 'other' ? 'This wallet has another referrer on SoDEX now.'
    : full ? <>{fullText(check!.fullUntil!)} <span>It still counts on SoDEX.</span></>
    : !ours && !canJoin && me?.blocked === 'has-volume' ? 'This wallet has traded on ValueDesk already, so the code counts on SoDEX only.'
    : !ours && !canJoin && me?.blocked === 'has-referrals' ? 'Others joined with your code already, so this one counts on SoDEX only.'
    : waiting ? null
    : needJoin ? 'One free signature here, then you confirm on sodex.com. No funds move.'
    : 'You confirm with your wallet on sodex.com. No funds move.';

  const squad = YOU_GET.find((b) => b.id === 'squad')!;
  const points = YOU_GET.find((b) => b.id === 'points')!;
  const vipDays = got?.vipUntil ? Math.max(1, Math.round((got.vipUntil - Date.now()) / 86_400_000)) : 0;

  return (
    <Modal open size="sm" title={done ? 'Code applied' : 'Use a code'} className="dlg inv-dlg rf-usecode" onClose={close}>
      <label className={`rf-usecode__field${applied ? ' is-on' : ''}`}>
        <span className="inv-code__k">Referral code</span>
        <input
          value={text} onChange={(e) => { setText(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20)); setError(null); setOpened(false); }}
          disabled={!!locked || joined || applied} spellCheck={false} autoCapitalize="characters" autoComplete="off" aria-label="Referral code" aria-invalid={cur === 'bad' || cur === 'own'}
        />
        <span className="rf-usecode__st" aria-live="polite">{status}</span>
      </label>

      {done && (
        <section className="rf-usecode__got" aria-label="What you got">
          <div className="dlg-label"><span>You got</span></div>
          <ul className="inv-perks">
            <li title={points.line}><b>+5%</b><span>SoPoints on SoDEX <Src s={points.source} /></span></li>
            <li title={squad.line}><b>up to +25%</b><span>{ours ? "Squad boost in ValueDesk's Squad" : "Squad boost in your inviter's Squad"} <Src s={squad.source} /></span></li>
            {got?.welcome && <li><b>$0</b><span>{`ValueDesk fee on your first ${welcomeText()}`}</span></li>}
            {joined && <li><b>${REFERRED_START_USD / 1000}K</b><span>ValueDesk fee tier from your first trade</span></li>}
            {vipDays > 0 && <li><b className="vip-text">VIP</b><span>{vipDays === 1 ? 'ValueDesk fee for 1 day' : `ValueDesk fee for ${vipDays} days`}</span></li>}
          </ul>
        </section>
      )}

      {done ? (
        <button type="button" className="dlg-btn is-go rf-usecode__go" onClick={close}>Done</button>
      ) : needJoin ? (
        <button type="button" className="dlg-btn is-go rf-usecode__go" disabled={busy} onClick={() => void join()}>{busy ? 'Confirm in your wallet…' : applied ? 'Join on ValueDesk' : 'Apply'}</button>
      ) : ok && sodex !== 'other' ? (
        <a
          className={`dlg-btn rf-usecode__go${waiting ? '' : ' is-go'}`} href={referralUrl(code)} target="_blank" rel="noopener noreferrer"
          onClick={(e) => { if (sim) e.preventDefault(); setOpened(true); setError(null); }}
        >
          {waiting ? 'Open SoDEX again' : joined ? 'Apply on SoDEX' : 'Apply'}
        </a>
      ) : (
        <button type="button" className="dlg-btn is-go rf-usecode__go" disabled>Apply</button>
      )}

      {waiting && <p className="rf-usecode__hint"><span className="rf-usecode__spin" aria-hidden="true" />Waiting for SoDEX. Confirm with your wallet in the SoDEX tab.</p>}
      {hint && <p className="rf-usecode__hint">{hint}</p>}
      {error && <p className="rf-usecode__hint is-bad" role="alert">{error}</p>}
      {sim && !done && <p className="rf-usecode__hint" data-no-i18n="">Sample data: try FRIEND01 (a VIP code), ALPHA7, FULLWEEK, or SAMPLE (your own).</p>}
    </Modal>
  );
}

function Src({ s }: { s: { label: string; url: string } }) {
  return <a href={s.url} target="_blank" rel="noopener noreferrer" title={s.label}>source</a>;
}

const Check = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
);
