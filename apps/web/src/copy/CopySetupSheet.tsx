/**
 * "Set up copy trading": where a copier runs, and the steps it needs.
 *
 * The owner's reference is Hyperdash's "Add existing wallet" sheet - a mode
 * switch on top, then one row per step with its own action on the right
 * (Connect, Approve Agent, Approve Builder), the next one lit, the done ones
 * ticked. Drawn in this app's sheet language (funds.css `fx`), with the steps
 * this app needs:
 *
 *   This browser       connect, terms, copy fee, copy key (7 days, in this browser)
 *   ValueDesk executor connect, sign in, terms, copy fee, copy key (up to 90 days, held in Tokyo)
 *   Self-hosted        connect, your copier (address + pairing code), terms, copy fee, copy key
 *
 * Every action is one of the follower's own signatures; nothing is signed on
 * their behalf, nothing is pre-ticked.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { COPY_FEE_LADDER, COPY_FEE_MAX, EEA_MAX_LEVERAGE, feePercent, regionPolicy } from '@copy-engine';
import { Modal } from '../components/Modal';
import { Seg } from '../components/palette/ui';
import { openConnectDialog } from '../components/account/connect';
import { notify } from '../toast';
import { tradingConfig } from '../trading/config';
import { WalletError } from '../wallet';
import { COPY_RISK_SUMMARY, COPY_STATEMENTS, HOSTED_KEY_NOTICE } from '../legal/copyTerms';
import { countries, countryName } from './countries';
import { DEFAULT_SELF_URL } from './executor';
import {
  acceptTerms,
  approveFee,
  approveKey,
  connectSelf,
  readiness,
  revokeKey,
  signIn,
  type CopyModeId,
  type LiveCopy,
} from './live';
import { MAX_BROWSER_KEY_DAYS } from './sodexSetup';
import '../components/funds/funds.css';
import './copy.css';

export const MODE_LABEL: Record<CopyModeId, string> = {
  browser: 'This browser',
  hosted: 'ValueDesk executor',
  self: 'Self-hosted',
};

export const MODE_HINT: Record<CopyModeId, string> = {
  browser: 'Copies while this tab is open. The key stays in this browser.',
  hosted: 'Copies around the clock from ValueDesk’s server in Tokyo, with a key it holds for you.',
  self: 'Copies from a copier you run on your own computer or server. The key stays with you.',
};

const isRejection = (e: unknown): boolean => e instanceof WalletError && /reject|denied|cancel/i.test(e.message);

const Tick = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function Step({ done, current, title, desc, action, children, n }: {
  done: boolean;
  current: boolean;
  title: string;
  desc: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  n: number;
}) {
  return (
    <li className={`cs-step${done ? ' is-done' : ''}${current ? ' is-current' : ''}`}>
      <span className="cs-step__dot" aria-hidden="true">{done ? <Tick /> : n}</span>
      <div className="cs-step__body">
        <div className="cs-step__head">
          <div>
            <div className="cs-step__t">{title}</div>
            <div className="cs-step__d">{desc}</div>
          </div>
          {action && <div className="cs-step__act">{action}</div>}
        </div>
        {children}
      </div>
    </li>
  );
}

function ActBtn({ label, onClick, primary, disabled, busy }: { label: string; onClick: () => void; primary: boolean; disabled?: boolean; busy?: boolean }) {
  return (
    <button type="button" className={`cs-btn${primary ? ' cs-btn--primary' : ''}`} onClick={onClick} disabled={disabled || busy}>
      {busy ? <span className="fx-spin" aria-hidden="true" /> : null}
      {label}
    </button>
  );
}

export interface CopySetupSheetProps {
  open: boolean;
  onClose: () => void;
  mode: CopyModeId;
  onMode: (m: CopyModeId) => void;
  live: LiveCopy;
  /** When given, the sheet's main button starts the copy once the mode is ready. */
  onStart?: () => Promise<void>;
  startLabel?: string;
  /** A paper copy needs no fee approval and no key. */
  paper?: boolean;
}

/** Everything a copy in `mode` needs is done (a paper copy needs no fee and no key), and the region allows it. */
export function copyReady(live: LiveCopy, mode: CopyModeId, paper?: boolean): boolean {
  const r = readiness(live, mode);
  const policy = regionPolicy(live.terms?.country ?? null, live.viewerCountry);
  if (live.terms && !policy.allowed) return false;
  if (!live.owner || !live.canSign || !r.terms) return false;
  if (mode !== 'browser' && !r.connected) return false;
  return paper ? true : r.fee && r.key;
}

/**
 * The steps of one mode, each with its own action: connect, sign in or pair,
 * terms, copy fee, copy key. Used by the setup sheet and by the copy modal's
 * second step.
 */
export function CopySetupSteps({ mode, live, paper }: { mode: CopyModeId; live: LiveCopy; paper?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [termsOpen, setTermsOpen] = useState(false);
  const [country, setCountry] = useState(live.terms?.country ?? '');
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [selfUrl, setSelfUrl] = useState(live.self.url || DEFAULT_SELF_URL);
  const [pairing, setPairing] = useState('');
  const [days, setDays] = useState<number>(mode === 'browser' ? MAX_BROWSER_KEY_DAYS : 30);

  useEffect(() => {
    setDays(mode === 'browser' ? MAX_BROWSER_KEY_DAYS : 30);
    setError(null);
  }, [mode]);

  const r = readiness(live, mode);
  const owner = live.owner;
  const policy = regionPolicy(live.terms?.country ?? (country || null), live.viewerCountry);
  const blocked = !!live.terms && !policy.allowed;
  const allTicked = COPY_STATEMENTS.every((s) => ticks[s.id]);
  const side = mode === 'browser' ? null : live[mode];

  const run = async (what: string, fn: () => Promise<void>, ok?: string) => {
    setError(null);
    setWorking(what);
    try {
      await fn();
      if (ok) notify('ok', ok);
    } catch (e) {
      if (!isRejection(e)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
    }
  };

  // The steps of this mode, in order; the first one not done is lit.
  type S = { id: string; done: boolean };
  const steps: S[] = useMemo(() => {
    const out: S[] = [{ id: 'wallet', done: !!owner && live.canSign }];
    if (mode === 'self') out.push({ id: 'copier', done: r.connected });
    if (mode === 'hosted') out.push({ id: 'signin', done: r.connected });
    out.push({ id: 'terms', done: r.terms });
    if (!paper) out.push({ id: 'fee', done: r.fee }, { id: 'key', done: r.key });
    return out;
  }, [owner, live.canSign, mode, r.connected, r.terms, r.fee, r.key, paper]);
  const current = steps.find((s) => !s.done)?.id ?? null;
  const n =(id: string) => steps.findIndex((s) => s.id === id) + 1;

  const ladder = COPY_FEE_LADDER.map((s) => `${feePercent(s.fee)}${s.fromUsd ? ` from $${(s.fromUsd / 1e6 >= 1 ? `${s.fromUsd / 1e6}M` : `${s.fromUsd / 1e3}k`)}` : ''}`).join(', ');
  const keyDays = mode === 'browser' ? [1, 3, 7] : [7, 30, 90];
  const keyHolder = mode === 'browser' ? 'only this browser' : mode === 'hosted' ? 'the ValueDesk executor in Tokyo' : 'your copier';

  return (
    <>
    <ol className="cs-steps">
      <Step
        n={n('wallet')}
        done={!!owner && live.canSign}
        current={current === 'wallet'}
        title="Connect wallet"
        desc={
          owner && !live.canSign
            ? `${owner.slice(0, 6)}…${owner.slice(-4)} is connected read-only. Every step here is a signature: reconnect it with your wallet.`
            : owner
              ? `${owner.slice(0, 6)}…${owner.slice(-4)} - its SoDEX account is the one copies trade in.`
              : 'The wallet whose SoDEX account the copies trade in.'
        }
        action={(!owner || !live.canSign) && <ActBtn label={owner ? 'Reconnect' : 'Connect'} primary onClick={() => void openConnectDialog()} />}
      />

      {mode === 'hosted' && (
        <Step
          n={n('signin')}
          done={r.connected}
          current={current === 'signin'}
          title="Sign in to the ValueDesk executor"
          desc={
            live.hosted.infoError
              ? 'The executor is not reachable right now.'
              : live.hosted.info
                ? `${live.hosted.info.location}. One signature shows it this wallet’s copies.`
                : 'Checking the executor…'
          }
          action={
            !r.connected && (
              <ActBtn label="Sign in" primary={current === 'signin'} disabled={!owner || !live.hosted.info} busy={working === 'signin'} onClick={() => void run('signin', () => signIn('hosted'))} />
            )
          }
        />
      )}

      {mode === 'self' && (
        <Step
          n={n('copier')}
          done={r.connected}
          current={current === 'copier'}
          title="Connect your copier"
          desc={
            r.connected
              ? `${live.self.url} - paired with this wallet.`
              : live.self.info
                ? live.self.info.owner
                  ? 'Found it. Sign in to it with this wallet.'
                  : 'Found it. Enter the pairing code it printed, then sign.'
                : 'Run the copier (Node.js 22+), then enter its address.'
          }
        >
          {!r.connected && (
            <div className="cs-form">
              <div className="cs-row">
                <input className="fx-input" value={selfUrl} onChange={(e) => setSelfUrl(e.target.value)} placeholder={DEFAULT_SELF_URL} spellCheck={false} aria-label="Copier address" />
                <ActBtn label="Find" primary={!live.self.info} busy={working === 'find'} onClick={() => void run('find', async () => void (await connectSelf(selfUrl)))} />
              </div>
              {live.self.info && (
                <div className="cs-row">
                  {!live.self.info.owner && (
                    <input className="fx-input" value={pairing} onChange={(e) => setPairing(e.target.value.toUpperCase())} placeholder="Pairing code" spellCheck={false} aria-label="Pairing code" maxLength={8} />
                  )}
                  <ActBtn
                    label={live.self.info.owner ? 'Sign in' : 'Pair'}
                    primary
                    disabled={!owner || (!live.self.info.owner && pairing.length < 8)}
                    busy={working === 'pair'}
                    onClick={() => void run('pair', () => signIn('self', pairing), live.self.info?.owner ? undefined : 'Your copier is paired with this wallet.')}
                  />
                </div>
              )}
              <p className="fx-note">
                Get it: <a className="fx-link" href="/copier/valuedesk-copier.mjs" download>valuedesk-copier.mjs</a> (<a className="fx-link" href="/copier/valuedesk-copier.mjs.sha256">sha256</a>), then
                run <code>node valuedesk-copier.mjs</code>. Open source (MIT). On a server, reach it through an SSH tunnel to 127.0.0.1:8799.
              </p>
            </div>
          )}
        </Step>
      )}

      <Step
        n={n('terms')}
        done={r.terms}
        current={current === 'terms'}
        title="Accept the copy trading terms"
        desc={
          live.terms
            ? `Accepted ${new Date(live.terms.acceptedAt).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })} · resident in ${countryName(live.terms.country)}.`
            : 'The risks, the fee, and what you confirm. One signature.'
        }
        action={!r.terms && !termsOpen && <ActBtn label="Review" primary={current === 'terms'} disabled={!owner} onClick={() => setTermsOpen(true)} />}
      >
        {!r.terms && termsOpen && (
          <div className="cs-form">
            <ul className="cs-risks">
              {COPY_RISK_SUMMARY.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
            <p className="fx-note">
              Read the full <a className="fx-link" href="/copy-terms" target="_blank" rel="noopener">copy trading terms and risk disclosure</a>.
            </p>
            <label className="fx-lbl" htmlFor="cs-country">Country of residence</label>
            <select id="cs-country" className="fx-sel cs-select" value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="">Choose…</option>
              {countries().map((c) => (
                <option key={c.code} value={c.code} disabled={c.blocked}>
                  {c.name}
                  {c.blocked ? ' - not available' : ''}
                </option>
              ))}
            </select>
            {country && regionPolicy(country, live.viewerCountry).maxLeverage === EEA_MAX_LEVERAGE && (
              <p className="fx-note fx-note--warn">In the EU and EEA, copies are limited to {EEA_MAX_LEVERAGE}x leverage.</p>
            )}
            {country && !regionPolicy(country, live.viewerCountry).allowed && (
              <p className="fx-note fx-note--err">{regionPolicy(country, live.viewerCountry).reason}</p>
            )}
            <div className="cs-checks">
              {COPY_STATEMENTS.map((s) => (
                <label key={s.id} className="oe-check cs-check">
                  <input type="checkbox" checked={!!ticks[s.id]} onChange={(e) => setTicks({ ...ticks, [s.id]: e.target.checked })} />
                  <span>{s.label}</span>
                </label>
              ))}
            </div>
            <ActBtn
              label="Sign and accept"
              primary
              disabled={!country || !allTicked || !regionPolicy(country, live.viewerCountry).allowed}
              busy={working === 'terms'}
              onClick={() => void run('terms', () => acceptTerms(country), 'Copy trading terms accepted.')}
            />
          </div>
        )}
        {blocked && <p className="fx-note fx-note--err">{policy.reason}</p>}
      </Step>

      {!paper && (
        <Step
          n={n('fee')}
          done={r.fee}
          current={current === 'fee'}
          title="Approve the copy fee"
          desc={
            !tradingConfig().builder
              ? 'This build of ValueDesk charges no copy fee: nothing to approve.'
              : r.fee
              ? `Approved on SoDEX up to ${feePercent(Math.max(live.fee.perps ?? COPY_FEE_MAX, COPY_FEE_MAX))}.`
              : `Copied orders pay ${ladder} of their value (by your 14-day volume). SoDEX charges it; you approve up to ${feePercent(COPY_FEE_MAX)} and can revoke it.`
          }
          action={!r.fee && <ActBtn label="Approve" primary={current === 'fee'} disabled={!owner} busy={working === 'fee'} onClick={() => void run('fee', approveFee, 'Copy fee approved on SoDEX.')} />}
        />
      )}

      {!paper && (
        <Step
          n={n('key')}
          done={r.key}
          current={current === 'key'}
          title="Approve the copy key"
          desc={
            r.key
              ? mode === 'browser'
                ? `Registered until ${new Date(live.browser.key!.expiresAt).toLocaleString('en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.`
                : `Registered${side?.me?.key?.expiresAt ? ` until ${new Date(side.me.key.expiresAt).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}.`
              : `A SoDEX key for perps only, held by ${keyHolder}. It trades your copies; per SoDEX it can also move funds between your own SoDEX accounts and your wallet, never to anyone else.`
          }
          action={
            r.key ? (
              <button type="button" className="fx-link fx-link--warn" disabled={!!working} onClick={() => void run('revoke', () => revokeKey(mode, false), 'Copy key revoked on SoDEX.')}>
                Revoke
              </button>
            ) : (
              <ActBtn
                label="Approve"
                primary={current === 'key'}
                disabled={!owner || (mode !== 'browser' && !r.connected) || !r.terms}
                busy={working === 'key'}
                onClick={() => void run('key', () => approveKey(mode, days), 'Copy key registered on your SoDEX account.')}
              />
            )
          }
        >
          {!r.key && (
            <div className="cs-form">
              {mode === 'hosted' && current === 'key' && <p className="fx-note fx-note--warn">{HOSTED_KEY_NOTICE}</p>}
              <div className="cs-days" role="group" aria-label="Key lifetime">
                <span className="fx-note">Valid for</span>
                {keyDays.map((d) => (
                  <button key={d} type="button" className={`pf-ctl${days === d ? ' is-on' : ''}`} onClick={() => setDays(d)}>
                    {d} {d === 1 ? 'day' : 'days'}
                  </button>
                ))}
              </div>
              {mode === 'browser' && (
                <p className="fx-note">At most {MAX_BROWSER_KEY_DAYS} days in a browser. When it runs out, copying stops until you approve a new one.</p>
              )}
            </div>
          )}
        </Step>
      )}
    </ol>
    {error && <p className="fx-note fx-note--err" role="alert">{error}</p>}
    {live.busy === 'wallet' && <p className="fx-wait"><span className="fx-spin" aria-hidden="true" />Waiting for your wallet…</p>}
    </>
  );
}

export function CopySetupSheet({ open, onClose, mode, onMode, live, onStart, startLabel, paper }: CopySetupSheetProps) {
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (open) setError(null);
  }, [open, mode]);
  const ready = copyReady(live, mode, paper);

  return (
    <Modal open={open} title="Set up copy trading" onClose={onClose} size="md" className="fx cs-sheet">
      <p className="cs-sub">Copies run in your own SoDEX account, under your rules. Choose where the copier runs.</p>

      <Seg
        label="Where the copier runs"
        value={mode}
        onChange={(m) => onMode(m)}
        options={(['browser', 'hosted', 'self'] as const).map((id) => ({ id, label: MODE_LABEL[id], title: MODE_HINT[id] }))}
      />
      <p className="fx-note">{MODE_HINT[mode]}</p>

      <CopySetupSteps mode={mode} live={live} paper={paper} />
      {error && <p className="fx-note fx-note--err" role="alert">{error}</p>}

      <div className="cs-actions">
        <button type="button" className="fx-cta fx-cta--ghost" onClick={onClose}>
          {ready ? 'Close' : 'Cancel'}
        </button>
        {onStart ? (
          <button
            type="button"
            className="fx-cta"
            disabled={!ready || starting}
            onClick={() => {
              setError(null);
              setStarting(true);
              onStart()
                .then(onClose, (e: unknown) => { if (!isRejection(e)) setError(e instanceof Error ? e.message : String(e)); })
                .finally(() => setStarting(false));
            }}
          >
            {starting ? 'Starting…' : startLabel ?? 'Start copying'}
          </button>
        ) : (
          <button type="button" className="fx-cta" disabled={!ready} onClick={onClose}>
            {ready ? 'Done' : 'Finish the steps'}
          </button>
        )}
      </div>
    </Modal>
  );
}
