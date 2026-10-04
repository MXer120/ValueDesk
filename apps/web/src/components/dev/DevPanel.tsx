/**
 * A glass dock for reopening one-shot screens (account setup, connect, the
 * fee schedule). The live site is a production build, so this is not gated on
 * `import.meta.env.DEV` alone: it also shows when `vs.dev` is `1` or the page
 * was opened with `?dev=1` (`?dev=0` clears it). Ctrl+Shift+D toggles it. In
 * dev the shortcut only folds the sheet — the dock is back on the next load.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Engine } from '../../api';
import { openConnectDialog } from '../account/connect';
import { openPalette } from '../palette/lazyPalette';
import { FeeSchedule } from '../FeeSchedule';
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

function storedPotato(): boolean {
  try { return localStorage.getItem('vs.potato') === 'true'; }
  catch { return false; }
}

function readAllowed(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    const flag = new URLSearchParams(window.location.search).get('dev');
    if (flag === '1') {
      localStorage.setItem('vs.dev', '1');
      return true;
    }
    if (flag === '0') {
      localStorage.removeItem('vs.dev');
      return false;
    }
    return localStorage.getItem('vs.dev') === '1';
  } catch {
    return false;
  }
}

function persistDev(on: boolean): void {
  try {
    if (on) localStorage.setItem('vs.dev', '1');
    else localStorage.removeItem('vs.dev');
  } catch { /* private mode */ }
}

export function DevPanel({ address, engine }: { address: string | null; engine: Engine }) {
  const [allowed, setAllowed] = useState(readAllowed);
  const [open, setOpen] = useState(readAllowed);
  const [sched, setSched] = useState(false);
  const [potato, setPotato] = useState(storedPotato);

  useEffect(() => {
    const onToggle = () => {
      if (import.meta.env.DEV) {
        setAllowed(true);
        setOpen((v) => !v);
        return;
      }
      setAllowed((was) => {
        const next = !was;
        persistDev(next);
        setOpen(next);
        return next;
      });
    };
    window.addEventListener('vs-dev-toggle', onToggle);
    return () => window.removeEventListener('vs-dev-toggle', onToggle);
  }, []);

  const hide = () => {
    setSched(false);
    setOpen(false);
    if (!import.meta.env.DEV) {
      persistDev(false);
      setAllowed(false);
    }
  };

  const openSetup = () => {
    if (!address) {
      openConnectDialog();
      return;
    }
    window.dispatchEvent(new Event('vs-dev-setup'));
  };

  const forget = () => {
    try { localStorage.removeItem('vs.setup.done'); }
    catch { /* private mode */ }
    openSetup();
  };

  const togglePotato = () => {
    const next = !storedPotato();
    document.documentElement.classList.toggle('is-potato', next);
    try { localStorage.setItem('vs.potato', next ? 'true' : 'false'); }
    catch { /* private mode */ }
    setPotato(next);
  };

  const dock = allowed ? (
    <aside className={open ? 'devp' : 'devp is-shut'} aria-label="Developer">
      {open ? (
        <div className="devp__sheet">
          <div className="devp__head">
            <span className="devp__title">Dev</span>
            <span className="devp__hint">Ctrl+Shift+D</span>
            <button type="button" className="devp__hide" onClick={hide}>Hide</button>
          </div>
          <button type="button" className="devp__btn" onClick={openSetup}>Account setup</button>
          <button type="button" className="devp__btn" onClick={() => openConnectDialog()}>Connect</button>
          <button type="button" className="devp__btn" onClick={() => openPalette()}>Search</button>
          <button type="button" className="devp__btn" onClick={() => setSched(true)}>Fee schedule</button>
          <button type="button" className="devp__btn" onClick={togglePotato}>
            Potato mode
            <span className="devp__meta">{potato ? 'On' : 'Off'}</span>
          </button>
          <button type="button" className="devp__btn" onClick={forget}>Forget setup</button>
        </div>
      ) : (
        <button
          type="button"
          className="devp__chip"
          onClick={() => { setPotato(storedPotato()); setOpen(true); }}
        >
          Dev
        </button>
      )}
    </aside>
  ) : null;

  return (
    <>
      {dock && createPortal(dock, document.body)}
      <FeeSchedule open={sched} onClose={() => setSched(false)} engine={engine} address={address} />
    </>
  );
}
