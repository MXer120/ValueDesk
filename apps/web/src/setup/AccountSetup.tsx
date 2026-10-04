/**
 * First connection on this browser. Indexing keeps running after the wizard
 * closes; closing sets `vs.setup.done` so the dialog does not trap anyone.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { fmt, fmtUsd } from '../format';
import { Modal } from '../components/Modal';
import { CrossFade } from '../components/motion';
import { Seg } from '../components/palette/ui';
import { TRADE_DASHBOARD } from '../dashboard/layout';
import { loadDashboard, saveDashboard } from '../dashboard/storage';
import { potatoChosenByUser, probeDevice, readPotatoOn, suggestPotato, writePotato, type DeviceProbe } from './device';
import { IDLE_PROGRESS, indexEnabled, resetIndex, setIndexEnabled, setIndexSpeed, startIndexer, stopIndexer, subscribeIndex, type IndexProgress } from './indexer';
import { SPEED_ORDER, SPEEDS, indexKey, parseIndex, readSpeed, recommendProfile, type ProfileId, type SpeedId } from './stats';
import '../components/funds/funds.css';
import './setup.css';

/** Opt-in trade panels (registry defaultHidden). Hidden for a beginner who has never saved a layout. */
const BEGINNER_HIDDEN = ['leaderboard', 'feetier', 'venue'];

type Step = 0 | 1 | 2 | 3;

/** The four sheets, in order. History runs underneath the later ones. */
const STEP_LABELS = ['History', 'Layout', 'Device', 'Ready'] as const;

const PROFILE_LABEL: Record<ProfileId, string> = {
  beginner: 'Beginner',
  default: 'Default',
  advanced: 'Advanced',
};

const Tick = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function readDone(): boolean {
  try { return localStorage.getItem('vs.setup.done') != null; }
  catch { return true; }
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
  return `${p.cores} cores · ${mem}`;
}

/** The user turned indexing off. A missing key is the first run, which still starts. */
function indexPaused(): boolean {
  try { return localStorage.getItem('vs.setup.indexOn') === '0'; }
  catch { return false; }
}

export function AccountSetup({ address }: { address: string | null }) {
  const connected = !!address && address.trim().length > 0;
  const [open, setOpen] = useState(() => connected && !readDone());
  const [step, setStep] = useState<Step>(0);
  const [progress, setProgress] = useState<IndexProgress>(IDLE_PROGRESS);
  const [potatoOn, setPotatoOn] = useState(() => (potatoChosenByUser() ? readPotatoOn() : false));
  const [speed, setSpeed] = useState<SpeedId>(() => {
    try { return readSpeed((k) => localStorage.getItem(k)); }
    catch { return 'default'; }
  });
  const [indexOn, setIndexOn] = useState(() => indexEnabled());
  const [probe, setProbe] = useState<DeviceProbe | null>(null);
  const [pos, setPos] = useState({ n: 0, markets: 0 });
  const [picked, setPicked] = useState<ProfileId | null>(null);
  const potatoTouched = useRef(false);

  useLayoutEffect(() => {
    document.documentElement.classList.toggle('is-potato', potatoOn);
  }, [potatoOn]);

  useEffect(() => {
    if (!connected || !address) {
      stopIndexer();
      return;
    }
    const unsub = subscribeIndex(setProgress);
    // Pause stays paused while this sheet is open. A missing flag still
    // starts, so the first run shows progress before the flag is written.
    if (indexEnabled() || (open && !indexPaused())) startIndexer(address);
    else stopIndexer();
    return unsub;
  }, [connected, address, open]);

  useEffect(() => {
    const onToggle = () => {
      setIndexOn(indexEnabled());
      if (!address || !indexEnabled()) {
        stopIndexer();
        return;
      }
      startIndexer(address);
    };
    window.addEventListener('vs-index', onToggle);
    return () => window.removeEventListener('vs-index', onToggle);
  }, [address]);

  // The dev panel reopens the wizard after it has already been finished.
  useEffect(() => {
    const onOpen = (e: Event) => {
      if (!connected) return;
      const raw = (e as CustomEvent<{ step?: number }>).detail?.step;
      const nextStep: Step = raw === 1 || raw === 2 || raw === 3 ? raw : 0;
      setStep(nextStep);
      setPicked(null);
      if (potatoChosenByUser()) setPotatoOn(readPotatoOn());
      setOpen(true);
    };
    window.addEventListener('vs-dev-setup', onOpen);
    return () => window.removeEventListener('vs-dev-setup', onOpen);
  }, [connected]);

  useEffect(() => {
    if (connected && !readDone()) setOpen(true);
  }, [connected]);

  useEffect(() => {
    if (!open || !address || indexPaused()) return;
    setIndexEnabled(true, address);
  }, [open, address]);

  // Probe on load, not only while the sheet is open, so a stored "on" from
  // the old frame-rate check is cleared on a machine that is not small.
  useEffect(() => {
    let dead = false;
    probeDevice().then((p) => { if (!dead) setProbe(p); });
    return () => { dead = true; };
  }, []);

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

  // A hand-set choice wins. Otherwise the probe decides, and a stored "on"
  // from an older frame-rate check does not.
  useEffect(() => {
    if (!probe || potatoTouched.current || potatoChosenByUser()) return;
    const on = suggestPotato(probe);
    setPotatoOn(on);
    writePotato(on, false);
  }, [probe]);

  const snap = useMemo(() => {
    if (!address) return null;
    try { return parseIndex(localStorage.getItem(indexKey(address)), address); }
    catch { return null; }
  }, [address, progress.pages, progress.done, progress.notice, progress.cursorMs]);

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
    if (step >= 2 || potatoTouched.current) writePotato(potatoOn, potatoTouched.current);
    try { localStorage.setItem('vs.setup.done', '1'); }
    catch { /* still close — the dialog must not trap them */ }
    setOpen(false);
  };

  const leave = () => {
    if (step === 1) applyProfile(profile);
    if (step === 2) writePotato(potatoOn, potatoTouched.current);
  };

  const go = (to: Step) => {
    if (to === step) return;
    leave();
    setStep(to);
  };

  const next = () => {
    if (step >= 3) { finish(); return; }
    leave();
    setStep((s) => (s + 1) as Step);
  };

  const progressText = progress.pages === 0 && progress.running
    ? 'Starting…'
    : [
      `${progress.pages} ${progress.pages === 1 ? 'page' : 'pages'}`,
      progress.stream,
      progress.cursorMs ? `${progress.done ? 'through' : 'back to'} ${when(progress.cursorMs)}` : '',
    ].filter(Boolean).join(' · ');

  const hasStats = !!snap && (snap.t.fil > 0 || snap.t.ord > 0 || snap.t.vol > 0);

  return (
    <Modal
      open={open && connected}
      title="Setting up your account"
      onClose={finish}
      onBack={step > 0 ? () => go((step - 1) as Step) : undefined}
      size="md"
      className="fx vs-setup"
    >
      <Seg
        label="Setup progress"
        value={String(step) as '0' | '1' | '2' | '3'}
        onChange={(id) => go(Number(id) as Step)}
        options={STEP_LABELS.map((label, i) => ({ id: String(i) as '0' | '1' | '2' | '3', label }))}
      />

      {progress.notice && <p className="fx-note fx-note--warn">{progress.notice}</p>}

      <CrossFade viewKey={String(step)}>
        <div className="fx-stack">
          {step === 0 && (
            <>
              <div className="fx-box vs-setup__box">
                <div className="fx-kv">
                  <div><span>Status</span><b>{!indexOn ? 'Paused' : progress.done ? 'Caught up' : 'Indexing'}</b></div>
                  <div><span>Progress</span><b>{progressText}</b></div>
                </div>
              </div>
              <div className="vs-setup__index">
                <button
                  type="button"
                  className="fx-cta fx-cta--ghost"
                  onClick={() => {
                    if (!address) return;
                    setIndexEnabled(!indexOn, address);
                    setIndexOn(!indexOn);
                  }}
                >
                  {indexOn ? 'Pause' : 'Resume'}
                </button>
                <Seg
                  label="Index speed"
                  value={speed}
                  onChange={(id) => { setIndexSpeed(id); setSpeed(id); }}
                  options={SPEED_ORDER.map((id) => ({ id, label: id === 'giga' ? 'Giga' : SPEEDS[id].label }))}
                />
                <button
                  type="button"
                  className="fx-link"
                  onClick={() => { if (address) resetIndex(address); }}
                >
                  Clear index
                </button>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="vs-setup__choices" role="group" aria-label="Layout profile">
                {([
                  ['beginner', 'Beginner', 'Less on screen. The denser optional panels stay off.'],
                  ['default', 'Default', 'The usual layout.'],
                  ['advanced', 'Advanced', 'For several markets or a lot of volume.'],
                ] as const).map(([id, title, detail]) => (
                  <button
                    key={id}
                    type="button"
                    className={`fx-opt${profile === id ? ' is-on' : ''}`}
                    aria-pressed={profile === id}
                    onClick={() => setPicked(id)}
                  >
                    <span className="fx-opt__icon"><span className="fx-srct__tick"><Tick /></span></span>
                    <span>
                      <span className="fx-opt__t">
                        {title}
                        {id === suggested && <span className="fx-badge">Recommended</span>}
                      </span>
                      <span className="fx-opt__d">{detail}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="vs-setup__fig">{probe ? deviceLine(probe) : 'Checking…'}</p>
              <button
                type="button"
                className={`fx-opt${potatoOn ? ' is-on' : ''}`}
                aria-pressed={potatoOn}
                onClick={() => {
                  potatoTouched.current = true;
                  const nextOn = !potatoOn;
                  setPotatoOn(nextOn);
                  writePotato(nextOn, true);
                }}
              >
                <span className="fx-opt__icon"><span className="fx-srct__tick"><Tick /></span></span>
                <span>
                  <span className="fx-opt__t">Potato mode</span>
                  <span className="fx-opt__d">Less motion, for a device that is working hard.</span>
                </span>
              </button>
            </>
          )}

          {step === 3 && (
            <>
              <div className="fx-box vs-setup__box">
                <div className="fx-kv">
                  <div><span>Layout</span><b>{PROFILE_LABEL[profile]}</b></div>
                  <div><span>Potato mode</span><b>{potatoOn ? 'On' : 'Off'}</b></div>
                  <div><span>History</span><b>{!indexOn ? 'Paused' : progress.done ? 'Caught up' : 'Indexing'}</b></div>
                  {hasStats && snap && (
                    <>
                      <div><span>Fills</span><b>{fmt(snap.t.fil, 0)}</b></div>
                      <div><span>Orders</span><b>{fmt(snap.t.ord, 0)}</b></div>
                      <div><span>Volume</span><b>{fmtUsd(snap.t.vol)}</b></div>
                      {snap.t.fee ? <div><span>Fees</span><b>{fmtUsd(snap.t.fee)}</b></div> : null}
                      {snap.t.f ? <div><span>Funding</span><b>{fmtUsd(snap.t.f)}</b></div> : null}
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </CrossFade>

      <div className="vs-setup__actions">
        <button type="button" className="fx-cta" onClick={next}>
          {step >= 3 ? 'Done' : 'Continue'}
        </button>
        {step < 3 && (
          <button type="button" className="fx-link" onClick={finish}>Explore while we set up</button>
        )}
      </div>
    </Modal>
  );
}
