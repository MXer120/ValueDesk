/**
 * The localhost switch between the layout editor's drag and resize versions (store.ts), modelled on the Referrals
 * page's sample switch (`rf-switch`): a pill at the foot of the window, the chosen one in white. Folds to one small
 * button so a screenshot can show the page alone. Only ever mounted in DEV (devVersions.tsx).
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { DRAG_VERSIONS, setDragVersion, useDragVersion } from './store';

const FOLD_KEY = 'vs.dev.trade.switchFolded';

/** Folded until opened in this tab on a phone, where the open pill would sit on the page's own controls. */
function folded(): boolean {
  try {
    const v = sessionStorage.getItem(FOLD_KEY);
    if (v !== null) return v === '1';
  } catch { /* no storage: the default below */ }
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches;
}

export function VersionSwitch() {
  const drag = useDragVersion();
  const [fold, setFold] = useState(folded);
  const setFolded = (v: boolean) => {
    setFold(v);
    try { sessionStorage.setItem(FOLD_KEY, v ? '1' : '0'); } catch { /* this tab only */ }
  };
  const at = DRAG_VERSIONS.findIndex((v) => v.id === drag);

  if (fold) {
    return createPortal(
      <button type="button" className="tvswitch tvswitch--folded" data-no-i18n="" onClick={() => setFolded(false)} title="Drag and resize versions (localhost only)">
        <span className="tvswitch__k">Drag</span><b>{at + 1}</b>
      </button>,
      document.body,
    );
  }
  return createPortal(
    <div className="tvswitch" role="group" aria-label="Drag and resize versions (localhost only)" data-no-i18n="">
      <nav className="tvswitch__set" aria-label="Drag and resize version">
        <span className="tvswitch__k">Drag</span>
        {DRAG_VERSIONS.map((v, i) => (
          <button key={v.id} type="button" aria-pressed={drag === v.id} className={drag === v.id ? 'is-on' : ''} title={v.line} onClick={() => setDragVersion(v.id)}>
            <b>{i + 1}</b><span>{v.name}</span>
          </button>
        ))}
      </nav>
      <button type="button" className="tvswitch__fold" aria-label="Fold the version switch" title="Fold" onClick={() => setFolded(true)}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
    </div>,
    document.body,
  );
}
