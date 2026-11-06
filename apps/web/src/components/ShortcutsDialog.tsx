/**
 * The keyboard shortcuts window: the `?` key and More > Keyboard shortcuts open it from anywhere.
 * Mounted once by App.tsx.
 */
import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import './ShortcutsDialog.css';

const OPEN_EVENT = 'vs:open-shortcuts';

export function openShortcuts(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

/* The handler takes either modifier, so a wrong guess here costs one wrong glyph, not a shortcut. */
const MOD = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';

const SHORTCUTS: Array<[string[], string]> = [
  [['1', '…', '6'], 'switch page'],
  [[MOD, 'K'], 'search markets'],
  [['/'], 'search markets'],
  [['c'], 'cancel all open orders'],
  [['?'], 'this help'],
];

export function ShortcutsDialog() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);
  const close = () => setOpen(false);
  return (
    <Modal
      open={open}
      title="Keyboard shortcuts"
      onClose={close}
      footer={<button className="btn-primary" onClick={close}>Close</button>}
    >
      <dl className="keyhelp">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={what + keys.join()} className="keyhelp__row">
            <dt>
              {keys.map((k, i) => (k === '…' ? <span key={i} className="muted">…</span> : <kbd key={i}>{k}</kbd>))}
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      <p className="muted small keyhelp__note">
        Shortcuts are inert while a text field has focus, so typing a quantity never fires a trading
        action. Any other printable key starts a market search with it.
      </p>
    </Modal>
  );
}
