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
 *   ValueDesk executor connect, sign in, terms, copy fee, copy key (up to 180 days, held in Tokyo)
 *   Self-hosted        connect, your copier (address + pairing code), terms, copy fee, copy key
 *
 * Every action is one of the follower's own signatures; nothing is signed on
 * their behalf, nothing is pre-ticked.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BOT_FEE, COPY_FEE_LADDER, COPY_FEE_MAX, EEA_MAX_LEVERAGE, feePercent, regionPolicy } from '@copy-engine';
import { Modal } from '../components/Modal';
import { openConnectDialog } from '../components/account/connect';
import { notify } from '../toast';
import { tradingConfig } from '../trading/config';
import { WalletError } from '../wallet';
import { BOT_HOSTED_KEY_NOTICE, BOT_RISK_SUMMARY, BOT_STATEMENT_LABEL, COPY_RISK_SUMMARY, COPY_STATEMENTS, HOSTED_KEY_NOTICE } from '../legal/copyTerms';
import { countryName } from './countries';
import { LOCATION_UNKNOWN, useViewerGeo } from '../legal/geo';
import { DEFAULT_SELF_URL } from './executor';
import {
  acceptTerms,
  approveFee,
  getLiveCopy,
  approveKey,
  importKey,
  connectSelf,
  readiness,
  revokeKey,
  signIn,
  type CopyModeId,
  type LiveCopy,
} from './live';
import { MAX_BROWSER_KEY_DAYS } from './sodexSetup';
import { ModeCards } from './ModeCards';
import '../components/funds/funds.css';
import './copy.css';
import { fmtPlain, localize } from '../numStyle';

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

/** A step already done is left out (the copy dialog: only what is missing shows, owner 2026-11-03). */
const HideDone = createContext(false);

function Step({ done, current, title, desc, action, children, n }: {
  done: boolean;
  current: boolean;
  title: string;
  desc: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  n: number;
}) {
  if (useContext(HideDone) && done) return null;
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

function ActBtn({ label, onClick, primary, disabled, busy, submit = false }: { label: string; onClick: () => void; primary: boolean; disabled?: boolean; busy?: boolean; submit?: boolean }) {
  return (
    <button type={submit ? 'submit' : 'button'} className={`cs-btn${primary ? ' cs-btn--primary' : ''}`} onClick={onClick} disabled={disabled || busy}>
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
 * The steps a copy in `mode` needs, in order, and which are done (a paper copy needs no fee and no key). For
 * bots (the Bots page, always the hosted executor) the sign-in is no step of its own: the terms step signs in
 * as well, so it is done once both are.
 */
export function setupSteps(live: LiveCopy, mode: CopyModeId, paper?: boolean, bots?: boolean): Array<{ id: string; done: boolean }> {
  const r = readiness(live, mode);
  const out = [{ id: 'wallet', done: !!live.owner && live.canSign }];
  if (mode === 'self') out.push({ id: 'copier', done: r.connected });
  if (mode === 'hosted' && !bots) out.push({ id: 'signin', done: r.connected });
  out.push({ id: 'terms', done: bots ? r.terms && r.connected : r.terms });
  if (!paper) out.push({ id: 'fee', done: r.fee }, { id: 'key', done: r.key });
  return out;
}

/**
 * The steps of one mode, each with its own action: connect, sign in or pair,
 * terms, copy fee, copy key. Used by the setup sheet, by the copy modal's
 * second step and, worded for bots (`bots`), by the Bots page's setup.
 */
export function CopySetupSteps({ mode, live, paper, bots, hideDone = false }: { mode: CopyModeId; live: LiveCopy; paper?: boolean; bots?: boolean; hideDone?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [termsOpen, setTermsOpen] = useState(false);
  // The country the edge saw (or the executor, which reads the same header) - never picked by the follower (owner, 2026-10-28).
  const geo = useViewerGeo();
  const country = geo.country ?? live.viewerCountry ?? '';
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [selfUrl, setSelfUrl] = useState(live.self.url || DEFAULT_SELF_URL);
  const [pairing, setPairing] = useState('');
  const [days, setDays] = useState<number>(mode === 'browser' ? MAX_BROWSER_KEY_DAYS : 30);
  // A key the follower made on SoDEX themselves (hosted and self-hosted): its name and private key.
  const [own, setOwn] = useState<{ open: boolean; name: string; key: string }>({ open: false, name: '', key: '' });

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const steps = useMemo(() => setupSteps(live, mode, paper, bots), [owner, live.canSign, mode, r.connected, r.terms, r.fee, r.key, paper, bots]);
  const current = steps.find((s) => !s.done)?.id ?? null;
  // Numbered among the steps shown: with the done ones left out, what is missing reads 1, 2, ...
  const shown = hideDone ? steps.filter((s) => !s.done) : steps;
  const n = (id: string) => shown.findIndex((s) => s.id === id) + 1;

  const ladder = COPY_FEE_LADDER.map((s) => `${localize(feePercent(s.fee))}${s.fromUsd ? ` from $${(s.fromUsd / 1e6 >= 1 ? `${fmtPlain(s.fromUsd / 1e6)}M` : `${fmtPlain(s.fromUsd / 1e3)}k`)}` : ''}`).join(', ');
  const keyDays = mode === 'browser' ? [1, 3, 7] : [7, 30, 90, 180];
  const keyHolder = mode === 'browser' ? 'only this browser' : mode === 'hosted' ? 'the ValueDesk executor in Tokyo' : 'your copier';
  const what = bots ? 'bots' : 'copies';
  // Bots: the terms step signs in to the executor as well (no step of its own).
  const termsDone = bots ? r.terms && r.connected : r.terms;

  return (
    <HideDone.Provider value={hideDone}>
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
              ? `${owner.slice(0, 6)}…${owner.slice(-4)} - its SoDEX account is the one your ${what} trade in.`
              : `The wallet whose SoDEX account your ${what} trade in.`
        }
        action={(!owner || !live.canSign) && <ActBtn label={owner ? 'Reconnect' : 'Connect'} primary onClick={() => void openConnectDialog()} />}
      />

      {mode === 'hosted' && !bots && (
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
                    <input className="fx-input" value={pairing} onChange={(e) => setPairing(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="Pairing code" spellCheck={false} aria-label="Pairing code" maxLength={10} autoComplete="off" />
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
        done={termsDone}
        current={current === 'terms'}
        title={bots ? 'Accept the terms' : 'Accept the copy trading terms'}
        desc={
          live.terms
            ? `Accepted ${new Date(live.terms.acceptedAt).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })} · from ${countryName(live.terms.country)}.${bots && !r.connected ? ' One more signature opens your bots.' : ''}`
            : bots
              ? r.connected
                ? 'No acceptance on record for this wallet yet: the risks, the fee, and what you confirm. One signature.'
                : 'One signature opens your bots. If this wallet accepted the terms before, in any browser, that is all.'
              : 'The risks, the fee, and what you confirm. One signature.'
        }
        action={
          !r.terms
            ? bots && !r.connected
              // Sign in first: the executor's record of an earlier acceptance then counts, and nobody signs the terms twice.
              ? <ActBtn label="Continue" primary={current === 'terms'} disabled={!owner || !live.hosted.info} busy={working === 'signin'} onClick={() => void run('signin', async () => {
                  await signIn('hosted');
                  if (!getLiveCopy().terms) setTermsOpen(true);
                })} />
              : !termsOpen && <ActBtn label="Review" primary={current === 'terms'} disabled={!owner} onClick={() => setTermsOpen(true)} />
            : bots && !r.connected && (
              <ActBtn label="Continue" primary={current === 'terms'} disabled={!owner || !live.hosted.info} busy={working === 'signin'} onClick={() => void run('signin', () => signIn('hosted'))} />
            )
        }
      >
        {!r.terms && termsOpen && (!bots || r.connected) && (
          <div className="cs-form">
            <ul className="cs-risks">
              {(bots ? BOT_RISK_SUMMARY : COPY_RISK_SUMMARY).map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
            <p className="fx-note">
              Read the full <a className="fx-link" href="/copy-terms" target="_blank" rel="noopener">{bots ? 'terms and risk disclosure' : 'copy trading terms and risk disclosure'}</a>{bots ? ' (bots: section 3).' : '.'}
            </p>
            <p className="fx-note">
              Your location: <b>{country ? `${countryName(country)}, from your connection` : 'unknown'}</b>
            </p>
            {!country && <p className="fx-note fx-note--err">{LOCATION_UNKNOWN}</p>}
            {!bots && country && regionPolicy(country, live.viewerCountry).maxLeverage === EEA_MAX_LEVERAGE && (
              <p className="fx-note fx-note--warn">In the EU and EEA, copies are limited to {EEA_MAX_LEVERAGE}x leverage.</p>
            )}
            {country && !regionPolicy(country, live.viewerCountry).allowed && (
              <p className="fx-note fx-note--err">{regionPolicy(country, live.viewerCountry).reason}</p>
            )}
            <div className="cs-checks">
              {COPY_STATEMENTS.map((s) => (
                <label key={s.id} className="oe-check cs-check">
                  <input type="checkbox" checked={!!ticks[s.id]} onChange={(e) => setTicks({ ...ticks, [s.id]: e.target.checked })} />
                  <span>{bots ? BOT_STATEMENT_LABEL[s.id] ?? s.label : s.label}</span>
                </label>
              ))}
            </div>
            <ActBtn
              label="Sign and accept"
              primary
              disabled={!country || !allTicked || !regionPolicy(country, live.viewerCountry).allowed}
              busy={working === 'terms'}
              onClick={() => void run('terms', async () => {
                await acceptTerms(country);
                if (bots && !getLiveCopy().hosted.signedIn) await signIn('hosted');
              }, bots ? 'Terms accepted.' : 'Copy trading terms accepted.')}
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
          title={bots ? 'Approve the fee' : 'Approve the copy fee'}
          desc={
            !tradingConfig().builder
              ? `This build of ValueDesk charges no ${bots ? '' : 'copy '}fee: nothing to approve.`
              : r.fee
              ? `Approved on SoDEX up to ${localize(feePercent(Math.max(live.fee.perps ?? COPY_FEE_MAX, COPY_FEE_MAX)))}.`
              : bots
                ? `Bot orders pay ${localize(feePercent(BOT_FEE))} (${BOT_FEE / 10} bp) of their value, instead of any other ValueDesk fee. SoDEX charges it; you approve up to ${localize(feePercent(COPY_FEE_MAX))} and can revoke it.`
                : `Copied orders pay ${ladder} of their value (by your 14-day volume). SoDEX charges it; you approve up to ${localize(feePercent(COPY_FEE_MAX))} and can revoke it.`
          }
          action={!r.fee && <ActBtn label="Approve" primary={current === 'fee'} disabled={!owner} busy={working === 'fee'} onClick={() => void run('fee', approveFee, bots ? 'Fee approved on SoDEX.' : 'Copy fee approved on SoDEX.')} />}
        />
      )}

      {!paper && (
        <Step
          n={n('key')}
          done={r.key}
          current={current === 'key'}
          title={bots ? 'Approve the trading key' : 'Approve the copy key'}
          desc={
            r.key
              ? mode === 'browser'
                ? `Registered until ${new Date(live.browser.key!.expiresAt).toLocaleString('en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.`
                : `Registered${side?.me?.key?.expiresAt ? ` until ${new Date(side.me.key.expiresAt).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}.`
              : `A SoDEX key for perps only, held by ${keyHolder}. It trades your ${what}; per SoDEX it can also move funds between your own SoDEX accounts and your wallet, never to anyone else.`
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
                onClick={() => void run('key', () => approveKey(mode, days), bots ? 'Trading key registered on your SoDEX account.' : 'Copy key registered on your SoDEX account.')}
              />
            )
          }
        >
          {!r.key && (
            <div className="cs-form">
              {mode === 'hosted' && current === 'key' && <p className="fx-note fx-note--warn">{bots ? BOT_HOSTED_KEY_NOTICE : HOSTED_KEY_NOTICE}</p>}
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
              {mode !== 'browser' && (
                <div className="cs-own">
                  <button type="button" className="fx-link" aria-expanded={own.open} onClick={() => setOwn((o) => ({ ...o, open: !o.open }))}>
                    {own.open ? 'Let the executor make the key instead' : 'I made an API key on SoDEX myself'}
                  </button>
                  {own.open && (
                    <form
                      className="cs-own__form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run('key', async () => {
                          await importKey(mode, own.name, own.key);
                          setOwn({ open: false, name: '', key: '' });
                        }, 'Your SoDEX key is set up for copying.');
                      }}
                    >
                      <p className="fx-note">
                        Make a perps API key on sodex.com with this wallet, valid for at most {side?.info?.keyTtlDaysMax ?? 180} days, then enter its name and its private key here.
                        The key is encrypted in this browser so that only {mode === 'hosted' ? 'the ValueDesk executor' : 'your copier'} can read it.
                      </p>
                      <input className="fx-input" value={own.name} onChange={(e) => setOwn((o) => ({ ...o, name: e.target.value }))} placeholder="Key name, as SoDEX shows it" aria-label="Key name" spellCheck={false} autoComplete="off" maxLength={64} />
                      <input className="fx-input" type="password" value={own.key} onChange={(e) => setOwn((o) => ({ ...o, key: e.target.value }))} placeholder="Private key (0x...)" aria-label="Private key" spellCheck={false} autoComplete="off" />
                      <ActBtn label="Use this key" primary disabled={!owner || !r.connected || !r.terms || !own.name.trim() || !own.key.trim()} busy={working === 'key'} onClick={() => {}} submit />
                    </form>
                  )}
                </div>
              )}
            </div>
          )}
        </Step>
      )}
    </ol>
    {error && <p className="fx-note fx-note--err" role="alert">{error}</p>}
    {live.busy === 'wallet' && <p className="fx-wait"><span className="fx-spin" aria-hidden="true" />Waiting for your wallet…</p>}
    </HideDone.Provider>
  );
}

/** What each step is called once it is done, for the copy dialog's "already done" pills. */
export const STEP_DONE_LABEL: Record<string, string> = {
  wallet: 'Wallet connected',
  signin: 'Signed in',
  copier: 'Copier paired',
  terms: 'Terms accepted',
  fee: 'Copy fee approved',
  key: 'Copy key active',
};

/** "2 of 4 done", over a bar: how far this mode's steps are. */
export function SetupProgress({ live, mode, paper, bots }: { live: LiveCopy; mode: CopyModeId; paper?: boolean; bots?: boolean }) {
  const steps = setupSteps(live, mode, paper, bots);
  const done = steps.filter((x) => x.done).length;
  return (
    <div className="cs-progress" aria-label={`${done} of ${steps.length} steps done`}>
      <span className="cs-progress__t">{done === steps.length ? (bots ? 'Ready to run bots' : 'Ready to copy') : `${done} of ${steps.length} steps done`}</span>
      <span className="cs-progress__bar"><i style={{ width: `${(done / steps.length) * 100}%` }} /></span>
    </div>
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
    <Modal open={open} title="Copy setup" onClose={onClose} size="md" className="fx cs-sheet">
      <p className="cs-sub">Copies trade in your own SoDEX account, under your rules. Pick where the copier runs.</p>

      <ModeCards value={mode} onChange={onMode} />

      <SetupProgress live={live} mode={mode} paper={paper} />
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
