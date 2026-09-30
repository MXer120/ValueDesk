/**
 * First connection on this browser. Indexing keeps running after the wizard
 * closes; closing sets `vs.setup.done` so the dialog does not trap anyone.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { fmt, fmtUsd } from '../format';
import { Modal } from '../components/Modal';
import { TRADE_DASHBOARD } from '../dashboard/layout';
import { loadDashboard, saveDashboard } from '../dashboard/storage';
import { probeDevice, suggestPotato, type DeviceProbe } from './device';
import { IDLE_PROGRESS, indexEnabled, setIndexEnabled, startIndexer, stopIndexer, subscribeIndex, type IndexProgress } from './indexer';
import { indexKey, parseIndex, profileBlurb, recommendProfile, type ProfileId } from './stats';
import './setup.css';

/** Opt-in trade panels (registry defaultHidden). Hidden for a beginner who has never saved a layout. */
const BEGINNER_HIDDEN = ['leaderboard', 'feetier', 'venue'];

type Step = 0 | 1 | 2 | 3;

function readDone(): boolean {
  try { return localStorage.getItem('vs.setup.done') != null; }
  catch { return true; }
}

function readPotato(): boolean | null {
  try {
    const v = localStorage.getItem('vs.potato');
    if (v === 'true') return true;
    if (v === 'false') return false;
    return null;
  } catch { return false; }
}

function persistPotato(on: boolean): void {
  try { localStorage.setItem('vs.potato', on ? 'true' : 'false'); }
  catch { /* private mode */ }
}

function applyProfile(profile: ProfileId): void {
  try { localStorage.setItem('vs.setup.profile', profile); }
  catch { /* private mode */ }
  if (profile !== 'beginner') return;
  // A saved layout is the user's. Never overwrite it; only record the profile.
  if (loadDashboard(TRADE_DASHBOARD)) return;
  saveDashboard(TRADE_DASHBOARD, {
    v: TRADE_DASHBOARD.version,
    layouts: {},
    locked: false,
    hidden: BEGINNER_HIDDEN,
  });
}

function when(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}

function deviceLine(p: DeviceProbe): string {
  const mem = p.memoryGb === null ? 'memory not reported' : `${p.memoryGb} GB`;
  const fps = p.fps === null ? 'frames not measured' : `${Math.round(p.fps)} fps`;
  return `${p.cores} cores · ${mem} · ${fps}`;
}

export function AccountSetup({ address }: { address: string | null }) {
  const connected = !!address && address.trim().length > 0;
  const [open, setOpen] = useState(() => connected && !readDone());
  const [step, setStep] = useState<Step>(0);
  const [progress, setProgress] = useState<IndexProgress>(IDLE_PROGRESS);
  const [potatoOn, setPotatoOn] = useState(() => readPotato() === true);
  const [probe, setProbe] = useState<DeviceProbe | null>(null);
  const [pos, setPos] = useState({ n: 0, markets: 0 });
  const [picked, setPicked] = useState<ProfileId | null>(null);
  const potatoTouched = useRef(false);

  useLayoutEffect(() => {
    document.documentElement.classList.toggle('is-potato', potatoOn);
  }, [potatoOn]);

  useEffect(() => {
    if (!connected || !address || (!open && !indexEnabled())) {
      stopIndexer();
      return;
    }
    startIndexer(address);
    return subscribeIndex(setProgress);
  }, [connected, address, open]);

  useEffect(() => {
    const onToggle = () => {
      if (!address || !indexEnabled()) {
        if (!open) stopIndexer();
        return;
      }
      startIndexer(address);
    };
    window.addEventListener('vs-index', onToggle);
    return () => window.removeEventListener('vs-index', onToggle);
  }, [address, open]);

  useEffect(() => {
    if (connected && !readDone()) setOpen(true);
  }, [connected]);

  useEffect(() => {
    if (open && address) setIndexEnabled(true, address);
  }, [open, address]);

  useEffect(() => {
    if (!open) return;
    let dead = false;
    probeDevice().then((p) => { if (!dead) setProbe(p); });
    return () => { dead = true; };
  }, [open]);

  useEffect(() => {
    if (!open || !address) return;
    let dead = false;
    api.positions(address).then((r) => {
      if (dead) return;
      const rows = (r.positions ?? []).filter((p: { size?: unknown; q?: unknown; symbol?: unknown }) => {
        const sz = Number(p.size ?? p.q ?? 0);
        return Number.isFinite(sz) && sz !== 0;
      });
      const markets = new Set(rows.map((p: { symbol?: unknown }) => String(p.symbol ?? '')).filter(Boolean));
      setPos({ n: rows.length, markets: markets.size });
    }).catch(() => { if (!dead) setPos({ n: 0, markets: 0 }); });
    return () => { dead = true; };
  }, [open, address]);

  // Offer the suggestion once the device step is up. A stored choice wins.
  useEffect(() => {
    if (step < 2 || !probe || potatoTouched.current) return;
    if (readPotato() !== null) return;
    setPotatoOn(suggestPotato(probe));
  }, [step, probe]);

  const snap = useMemo(() => {
    if (!address) return null;
    try { return parseIndex(localStorage.getItem(indexKey(address)), address); }
    catch { return null; }
  }, [address, progress.pages]);

  const suggested = recommendProfile({
    openPositions: pos.n,
    fills: snap?.t.fil ?? 0,
    orders: snap?.t.ord ?? 0,
    volume: snap?.t.vol ?? 0,
    markets: pos.markets,
  });
  const profile = picked ?? suggested;

  const finish = () => {
    if (step >= 1) applyProfile(profile);
    if (step >= 2 || potatoTouched.current) persistPotato(potatoOn);
    try { localStorage.setItem('vs.setup.done', '1'); }
    catch { /* still close — the dialog must not trap them */ }
    setOpen(false);
  };

  const next = () => {
    if (step >= 3) { finish(); return; }
    if (step === 1) applyProfile(profile);
    if (step === 2) persistPotato(potatoOn);
    setStep((s) => (s + 1) as Step);
  };

  const progressText = progress.pages === 0 && progress.running
    ? 'Starting…'
    : [
      `${progress.pages} ${progress.pages === 1 ? 'page' : 'pages'}`,
      progress.stream,
      progress.cursorMs ? `${progress.done ? 'through' : 'back to'} ${when(progress.cursorMs)}` : '',
    ].filter(Boolean).join(' · ');

  const indexState = progress.done && !progress.running ? 'done' : progress.running || step === 0 ? 'now' : 'wait';

  return (
    <Modal
      open={open && connected}
      title="Setting up your account"
      onClose={finish}
      onBack={step > 0 ? () => setStep((s) => (s - 1) as Step) : undefined}
      size="lg"
      className="vs-setup"
      footer={(
        <div className="vs-setup__foot">
          {step < 3 && <button type="button" className="vs-setup__skip" onClick={finish}>Explore while we set up</button>}
          <button type="button" className="btn-primary vs-setup__go" onClick={next}>{step >= 3 ? 'Explore while we set up' : 'Continue'}</button>
        </div>
      )}
    >
      <div className="vs-setup__split">
        <div className="vs-setup__main">
      <p className="vs-setup__kicker">{step >= 3 ? 'Ready when you are.' : 'This may take a moment.'}</p>
      <ol className="vs-setup__list">
        <li className={step > 0 ? 'is-done' : 'is-now'}>
          <i aria-hidden="true" />
          <span>Enabling this browser</span>
        </li>
        <li className={indexState === 'done' ? 'is-done' : indexState === 'now' ? 'is-now' : ''}>
          <i aria-hidden="true" />
          <span>Indexing history <small>{progressText}</small></span>
        </li>
        <li className={step > 1 ? 'is-done' : step === 1 ? 'is-now' : ''}>
          <i aria-hidden="true" />
          <span>Layout · {profile}</span>
        </li>
        <li className={step > 2 ? 'is-done' : step === 2 ? 'is-now' : ''}>
          <i aria-hidden="true" />
          <span>This device{potatoOn ? ' · potato mode' : ''}</span>
        </li>
      </ol>

      {step === 0 && (
        <>
          <p className="vs-setup__note">
            History is rolled into statistics on this browser: fees, funding, volume, deposits,
            withdrawals, orders, and fills. Individual trades are not stored.
          </p>
          <p className="vs-setup__progress">{progressText}</p>
          {progress.notice && <p className="vs-setup__note">{progress.notice}</p>}
          <p className="vs-setup__note">
            {progress.done && !progress.running
              ? 'Caught up. New activity is picked up from here.'
              : 'You can keep browsing. Indexing stays at a steady pace so trading is not rate limited.'}
          </p>
        </>
      )}

      {step === 1 && (
        <>
          <p className="vs-setup__note">
            From what SoDEX already shows — open positions, volume, or nothing yet — this account looks {suggested}. {profileBlurb(suggested)}
          </p>
          <div className="vs-setup__choices" role="group" aria-label="Layout profile">
            {([
              ['beginner', 'Beginner', 'Less on screen. The denser optional panels stay off.'],
              ['default', 'Default', 'The usual layout.'],
              ['advanced', 'Advanced', 'For several markets or a lot of volume.'],
            ] as const).map(([id, title, detail]) => (
              <button
                key={id}
                type="button"
                className={`vs-setup__choice${profile === id ? ' active' : ''}`}
                aria-pressed={profile === id}
                onClick={() => setPicked(id)}
              >
                <span>{title}</span>
                <small>{id === suggested ? `Recommended. ${detail}` : detail}</small>
              </button>
            ))}
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <p className="vs-setup__note">
            A short check: core count, memory if the browser reports it, and a few frames.
            A device’s age can’t be known from here.
          </p>
          <p className="vs-setup__progress">{probe ? deviceLine(probe) : 'Checking…'}</p>
          <p className="vs-setup__note">
            {probe && suggestPotato(probe)
              ? 'This device looks tight, so potato mode starts on. You can turn it off.'
              : 'This device looks fine. Potato mode stays off unless you turn it on.'}
          </p>
          <label className="vs-setup__row">
            <span>Potato mode</span>
            <input
              type="checkbox"
              checked={potatoOn}
              onChange={(e) => {
                potatoTouched.current = true;
                setPotatoOn(e.target.checked);
                persistPotato(e.target.checked);
              }}
            />
          </label>
        </>
      )}

      {step === 3 && (
        <>
          <p className="vs-setup__note">
            Layout {profile}. Potato mode {potatoOn ? 'on' : 'off'}.
            {progress.done ? ' History is caught up.' : ' Indexing continues in the background.'}
          </p>
          {snap && (snap.t.fil > 0 || snap.t.ord > 0 || snap.t.vol > 0) && (
            <p className="vs-setup__progress">
              {fmt(snap.t.fil, 0)} fills · {fmt(snap.t.ord, 0)} orders · {fmtUsd(snap.t.vol)} volume
              {snap.t.fee ? ` · ${fmtUsd(snap.t.fee)} fees` : ''}
              {snap.t.f ? ` · ${fmtUsd(snap.t.f)} funding` : ''}
            </p>
          )}
        </>
      )}
        </div>
        <aside className="vs-setup__art" aria-hidden="true">
          <div className="vs-setup__glow" />
          <div className="vs-setup__grid" />
          <svg className="vs-setup__chart" viewBox="0 0 280 200" preserveAspectRatio="none">
            <path className="vs-setup__fill" d="M8 156 C 36 154, 52 118, 78 112 S 120 64, 156 72 210 36 272 28 V 188 H 8 Z" />
            <path className="vs-setup__line" d="M8 156 C 36 154, 52 118, 78 112 S 120 64, 156 72 210 36 272 28" />
          </svg>
          <div className="vs-setup__float">
            <span className="vs-setup__chip"><i /> Equity</span>
            <span className="vs-setup__chip vs-setup__chip--dim"><i /> 30d</span>
          </div>
        </aside>
      </div>
    </Modal>
  );
}
