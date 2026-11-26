/**
 * LOCALHOST ONLY. Page.tsx loads this file only when import.meta.env.DEV is true, so a build has neither the switch nor
 * the previous page.
 *
 *   1 Portfolio  the page (the wallet, wallet/Wallet.tsx), as a build shows it
 *   2 Previous   the page before it (PortfolioPage.tsx PortfolioOriginal), kept on localhost until the owner says
 *
 * History: Overview and Desk, then Stack and Banner, were removed on the owner's word (2026-11-26); he kept Wallet and
 * made it the page the same day ("promote portfolio page so its the new original").
 *
 * The pill at the foot picks one (kept in localStorage). "View a wallet" shows any other wallet's portfolio read-only
 * (devWatch.ts), so the page can be judged with real figures.
 */
import { useState, useTransition, type ComponentType } from 'react';
import type { PortfolioContext } from '../../Portfolio';
import { PortfolioOriginal, type PortfolioPageLinks } from '../PortfolioPage';
import { PortfolioWallet } from './Wallet';
import { isAddress, setDevWatch, useDevWatch } from '../devWatch';
import { shortAddr } from './blocks';

export type VersionProps = { c: PortfolioContext } & PortfolioPageLinks;

const VERSIONS: ReadonlyArray<{ key: string; name: string; C: ComponentType<VersionProps> }> = [
  { key: 'portfolio', name: 'Portfolio', C: PortfolioWallet },
  { key: 'previous', name: 'Previous', C: PortfolioOriginal },
];
const KEY = 'vs.dev.pf.version';
/** The owner's own test wallet (e2e/live/units.test.ts), offered as a one-press example. */
const TEST_WALLET = '0x04fb8f9d0d8cd5495aa47e81ca9804cdf32a277d';

function stored(): number {
  try {
    const k = localStorage.getItem(KEY);
    const i = VERSIONS.findIndex((v) => v.key === k);
    return i < 0 ? 0 : i;
  } catch {
    return 0;
  }
}

export default function DevVersions(props: VersionProps) {
  const [pick, setPick] = useState(stored);
  // The page on screen stays until the next version has loaded.
  const [, startTransition] = useTransition();
  const watch = useDevWatch();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const choose = (i: number) => {
    startTransition(() => setPick(i));
    try { localStorage.setItem(KEY, VERSIONS[i]!.key); } catch { /* this tab only */ }
    document.querySelector('.appcontent')?.scrollTo({ top: 0 });
  };
  const V = VERSIONS[pick]!.C;
  const ok = isAddress(draft);
  return (
    <>
      <V key={pick} {...props} />
      <div className="pfv-switch" data-no-i18n="">
        {editing && (
          <form
            className="pfv-switch__watch"
            onSubmit={(e) => { e.preventDefault(); if (ok) { setDevWatch(draft); setEditing(false); } }}
          >
            <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="0x… any SoDEX wallet, read-only" aria-label="Wallet to view" spellCheck={false} />
            <button type="submit" disabled={!ok}>View</button>
            <button type="button" onClick={() => { setDevWatch(TEST_WALLET); setEditing(false); }}>Test wallet</button>
            <button type="button" onClick={() => setEditing(false)} aria-label="Close">×</button>
          </form>
        )}
        <nav className="pfv-switch__bar" aria-label="Portfolio page, this one or the previous">
          {VERSIONS.map((x, i) => (
            <button key={x.key} type="button" aria-pressed={pick === i} className={pick === i ? 'is-on' : ''} onClick={() => choose(i)}>
              <b>{i + 1}</b><span>{x.name}</span>
            </button>
          ))}
          <i className="pfv-switch__sep" aria-hidden="true" />
          {watch
            ? <button type="button" className="is-watch is-on" onClick={() => setDevWatch(null)} title="Back to my wallet">{shortAddr(watch)} <span aria-hidden="true">×</span></button>
            : <button type="button" className="is-watch" aria-expanded={editing} onClick={() => { setDraft(''); setEditing((v) => !v); }}>View a wallet</button>}
        </nav>
      </div>
    </>
  );
}
