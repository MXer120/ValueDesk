/**
 * A glass dock for opening the one-shot screens. It stays on every build,
 * including production, and stays above sheets so it can be used while one
 * is open. Drag the title to move it. Ctrl+Shift+D folds it to a chip.
 */
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Engine } from '../../api';
import { notify } from '../../toast';
import { builderTerms, type BuilderTerms } from '../../trading/builder';
import { tradingConfig } from '../../trading/config';
import {
  requestAdvanced,
  requestDeposit,
  requestDisableTrading,
  requestDisconnect,
  requestEnableTrading,
  requestSignOut,
  requestTransfer,
  requestWithdraw,
} from '../account/actions';
import { useBuilderConsent } from '../account/BuilderConsent';
import { openConnectDialog } from '../account/connect';
import { FeeSchedule } from '../FeeSchedule';
import { openPalette } from '../palette/lazyPalette';
import { readPotatoOn, writePotato } from '../../setup/device';
import { indexEnabled, resetIndex, setIndexEnabled, setIndexSpeed } from '../../setup/indexer';
import { SPEED_ORDER, SPEEDS, readSpeed, type SpeedId } from '../../setup/stats';
import './DevPanel.css';

/**
 * Ctrl+Shift+D is also Chrome's "bookmark all tabs". A bubble listener that
 * skips focused inputs never cancels that, so the shortcut does nothing on the
 * live site while the order ticket has a field focused. Capture on document,
 * installed as the module loads, runs first and cancels the browser action.
 * Keyup covers a keydown the browser swallowed.
 */
function installDevChord(): void {
  if (typeof document === 'undefined') return;
  const w = window as Window & { __vsDevChord?: boolean };
  if (w.__vsDevChord) return;
  w.__vsDevChord = true;
  let down = false;
  const chord = (e: KeyboardEvent): boolean =>
    !e.altKey && !e.metaKey && e.ctrlKey && e.shiftKey
    && (e.code === 'KeyD' || e.key === 'd' || e.key === 'D');
  const onKey = (e: KeyboardEvent) => {
    if (e.type === 'keydown') {
      if (e.repeat || !chord(e)) return;
      down = true;
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(new Event('vs-dev-toggle'));
      return;
    }
    if (!chord(e)) return;
    if (down) { down = false; return; }
    e.preventDefault();
    e.stopPropagation();
    window.dispatchEvent(new Event('vs-dev-toggle'));
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKey, true);
}
installDevChord();

const POS_KEY = 'vs.dev.pos';

function readPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      return { x: p.x, y: p.y };
    }
  } catch { /* private mode */ }
  return null;
}

function savePos(p: { x: number; y: number }): void {
  try { localStorage.setItem(POS_KEY, JSON.stringify(p)); }
  catch { /* private mode */ }
}

function previewTerms(): BuilderTerms {
  const b = tradingConfig().builder;
  if (b) return builderTerms(b, { spot: null, perps: null }, 'enable');
  return {
    builderId: 0,
    perps: 15,
    spot: 15,
    maxFeeRate: 25,
    required: true,
    alreadyApproved: [],
    purpose: 'enable',
  };
}

export function DevPanel({ address, engine }: { address: string | null; engine: Engine }) {
  const [open, setOpen] = useState(true);
  const [sched, setSched] = useState<null | 'sodex' | 'valuedesk'>(null);
  const [potato, setPotato] = useState(readPotatoOn);
  const [indexOn, setIndexOn] = useState(() => indexEnabled());
  const [speed, setSpeed] = useState<SpeedId>(() => {
    try { return readSpeed((k) => localStorage.getItem(k)); }
    catch { return 'default'; }
  });
  const [pos, setPos] = useState(readPos);
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ dx: number; dy: number; x0: number; y0: number; moved: boolean } | null>(null);
  const builderConsent = useBuilderConsent();

  useEffect(() => {
    const onToggle = () => setOpen((v) => !v);
    window.addEventListener('vs-dev-toggle', onToggle);
    return () => window.removeEventListener('vs-dev-toggle', onToggle);
  }, []);

  useEffect(() => {
    const sync = () => setIndexOn(indexEnabled());
    window.addEventListener('vs-index', sync);
    return () => window.removeEventListener('vs-index', sync);
  }, []);

  useEffect(() => {
    const sync = () => setPotato(readPotatoOn());
    window.addEventListener('vs-potato', sync);
    return () => window.removeEventListener('vs-potato', sync);
  }, []);

  const clamp = (x: number, y: number) => {
    const w = ref.current?.offsetWidth ?? 280;
    const h = ref.current?.offsetHeight ?? 40;
    return {
      x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - w - 8)),
      y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - Math.min(h, 80) - 8)),
    };
  };

  // Later portals (sheets) append after this one. Keep the dock last in the
  // body so it stays on top and last in the tab order while a sheet is open.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el?.parentElement) el.parentElement.appendChild(el);
  });

  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clamp(p.x, p.y) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = (e: ReactPointerEvent, fromChip: boolean) => {
    if (!fromChip && (e.target as HTMLElement).closest('button')) return;
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
    d.moved = true;
    setPos(clamp(e.clientX - d.dx, e.clientY - d.dy));
  };

  const onPointerUp = (fromChip: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (fromChip && !d.moved) setOpen(true);
    if (d.moved) {
      setPos((p) => {
        if (p) savePos(p);
        return p;
      });
    }
  };

  const openSetup = (step?: 0 | 1 | 2 | 3) => {
    if (!address) {
      openConnectDialog();
      return;
    }
    window.dispatchEvent(new CustomEvent('vs-dev-setup', { detail: { step: step ?? 0 } }));
  };

  const forget = () => {
    try { localStorage.removeItem('vs.setup.done'); }
    catch { /* private mode */ }
    openSetup(0);
  };

  const togglePotato = () => {
    const next = !readPotatoOn();
    writePotato(next, true);
    setPotato(next);
  };

  const place = pos ? { left: pos.x, top: pos.y, bottom: 'auto' as const, right: 'auto' as const } : undefined;

  const dock = (
    <aside
      ref={ref}
      className={open ? 'devp' : 'devp is-shut'}
      style={place}
      aria-label="Developer"
      tabIndex={-1}
    >
      {open ? (
        <div className="devp__sheet">
          <div
            className="devp__head"
            onPointerDown={(e) => onPointerDown(e, false)}
            onPointerMove={onPointerMove}
            onPointerUp={() => onPointerUp(false)}
          >
            <span className="devp__grip" aria-hidden="true" />
            <span className="devp__title">Dev</span>
            <span className="devp__hint">Drag</span>
            <button type="button" className="devp__hide" onClick={() => setOpen(false)}>Hide</button>
          </div>
          <div className="devp__body">
            <p className="devp__sec">Sheets</p>
            <button type="button" className="devp__btn" onClick={() => openSetup(0)}>Account setup</button>
            <div className="devp__row">
              {(['History', 'Layout', 'Device', 'Ready'] as const).map((label, i) => (
                <button key={label} type="button" className="devp__mini" onClick={() => openSetup(i as 0 | 1 | 2 | 3)}>{label}</button>
              ))}
            </div>
            <button type="button" className="devp__btn" onClick={() => openConnectDialog()}>Connect</button>
            <button type="button" className="devp__btn" onClick={() => requestDeposit()}>Deposit</button>
            <button type="button" className="devp__btn" onClick={() => requestWithdraw()}>Withdraw</button>
            <button type="button" className="devp__btn" onClick={() => requestTransfer()}>Transfer</button>
            <button type="button" className="devp__btn" onClick={() => { void builderConsent.ask(previewTerms()); }}>Builder fee</button>
            <button type="button" className="devp__btn" onClick={() => setSched('sodex')}>Fee schedule · SoDEX</button>
            <button type="button" className="devp__btn" onClick={() => setSched('valuedesk')}>Fee schedule · ValueDesk</button>
            <button type="button" className="devp__btn" onClick={() => openPalette()}>Search</button>
            <button type="button" className="devp__btn" onClick={() => requestEnableTrading()}>Enable trading</button>
            <button type="button" className="devp__btn" onClick={() => requestDisableTrading()}>Turn off trading</button>
            <button type="button" className="devp__btn" onClick={() => requestAdvanced()}>Advanced keys</button>
            <button type="button" className="devp__btn" onClick={() => requestDisconnect()}>Disconnect</button>
            <button type="button" className="devp__btn" onClick={() => requestSignOut()}>Sign out</button>

            <p className="devp__sec">State</p>
            <button type="button" className="devp__btn" onClick={togglePotato}>
              Potato mode
              <span className="devp__meta">{potato ? 'On' : 'Off'}</span>
            </button>
            <button type="button" className="devp__btn" title="Clears the finished flag and shows account setup again. The wallet, trading key, and trade index stay." onClick={forget}>Forget setup</button>
            <div className="devp__row">
              <button type="button" className="devp__mini" onClick={() => notify('ok', 'Saved.')}>Ok</button>
              <button type="button" className="devp__mini" onClick={() => notify('info', 'Heads up.')}>Info</button>
              <button type="button" className="devp__mini" onClick={() => notify('error', 'Something failed.')}>Error</button>
            </div>

            <p className="devp__sec">Index</p>
            <button
              type="button"
              className="devp__btn"
              disabled={!address}
              onClick={() => {
                if (!address) return;
                const next = !indexEnabled();
                setIndexEnabled(next, address);
                setIndexOn(next);
              }}
            >
              {indexOn ? 'Pause indexing' : 'Resume indexing'}
              <span className="devp__meta">{address ? '' : 'No wallet'}</span>
            </button>
            <div className="devp__row">
              {SPEED_ORDER.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={speed === id ? 'devp__mini is-on' : 'devp__mini'}
                  onClick={() => { setIndexSpeed(id); setSpeed(id); }}
                >
                  {id === 'giga' ? 'Giga' : SPEEDS[id].label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="devp__btn"
              disabled={!address}
              onClick={() => { if (address) resetIndex(address); }}
            >
              Clear index
            </button>
          </div>
        </div>
      ) : (
        <div
          className="devp__chip"
          onPointerDown={(e) => onPointerDown(e, true)}
          onPointerMove={onPointerMove}
          onPointerUp={() => onPointerUp(true)}
        >
          Dev
        </div>
      )}
    </aside>
  );

  return (
    <>
      {createPortal(dock, document.body)}
      {builderConsent.dialog}
      <FeeSchedule
        open={sched !== null}
        onClose={() => setSched(null)}
        engine={engine}
        address={address}
        table={sched ?? 'sodex'}
      />
    </>
  );
}
