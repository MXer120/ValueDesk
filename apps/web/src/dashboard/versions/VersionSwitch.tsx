/**
 * The localhost switch between the trade page's versions and the layout editor's (store.ts), modelled on the
 * Referrals page's sample switch (`rf-switch`): a pill at the foot of the window, the chosen one in white. Folds to
 * one small button so a screenshot can show the page alone. Only ever mounted in DEV (devVersions.tsx).
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  EDITOR_VERSIONS, PAGE_VERSIONS, setEditorVersion, setPageVersion, useEditorVersion, usePageVersion,
} from './store';

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
  const page = usePageVersion();
  const editor = useEditorVersion();
  const [fold, setFold] = useState(folded);
  const setFolded = (v: boolean) => {
    setFold(v);
    try { sessionStorage.setItem(FOLD_KEY, v ? '1' : '0'); } catch { /* this tab only */ }
  };
  const pageAt = PAGE_VERSIONS.findIndex((v) => v.id === page);
  const editorAt = EDITOR_VERSIONS.findIndex((v) => v.id === editor);

  if (fold) {
    return createPortal(
      <button type="button" className="tvswitch tvswitch--folded" data-no-i18n="" onClick={() => setFolded(false)} title="Trade page versions (localhost only)">
        <span className="tvswitch__k">Page</span><b>{pageAt + 1}</b>
        <span className="tvswitch__k">Editor</span><b>{editorAt + 1}</b>
      </button>,
      document.body,
    );
  }
  return createPortal(
    <div className="tvswitch" role="group" aria-label="Trade page versions (localhost only)" data-no-i18n="">
      <nav className="tvswitch__set" aria-label="Trade page version">
        <span className="tvswitch__k">Page</span>
        {PAGE_VERSIONS.map((v, i) => (
          <button key={v.id} type="button" aria-pressed={page === v.id} className={page === v.id ? 'is-on' : ''} title={v.line} onClick={() => setPageVersion(v.id)}>
            <b>{i + 1}</b><span>{v.name}</span>
          </button>
        ))}
      </nav>
      <i className="tvswitch__rule" aria-hidden="true" />
      <nav className="tvswitch__set" aria-label="Layout editor version">
        <span className="tvswitch__k">Editor</span>
        {EDITOR_VERSIONS.map((v, i) => (
          <button key={v.id} type="button" aria-pressed={editor === v.id} className={editor === v.id ? 'is-on' : ''} title={v.line} onClick={() => setEditorVersion(v.id)}>
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
