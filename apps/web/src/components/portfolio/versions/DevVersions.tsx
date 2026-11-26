/**
 * LOCALHOST ONLY. PortfolioPage.tsx loads this file only when import.meta.env.DEV is true, so a build has neither the
 * switch nor the versions. Owner 2026-11-26: "localhost only with multiple versions and the switch ... Do not delete
 * the original keep it in the switch."
 *
 *   1 Original   today's page, untouched
 *   2 Wallet     the balance card and its four keys, accounts you open in place; the chart, earn and trading beside them
 *   3 Stack      the same wallet in one column, as a wallet app on a phone, on every screen
 *   4 Banner     the card and the chart side by side across the top, the accounts as four tiles under them
 *
 * Overview and Desk were removed on the owner's word (2026-11-26: "give me 2 other versions of 4wallet, remove 2 & 3");
 * Stack and Banner are the two other wallets (Wallet.tsx).
 *
 * The pill at the foot picks one (kept in localStorage, like the referral page's). "View a wallet" shows any other
 * wallet's portfolio read-only (devWatch.ts), so a version can be judged with real figures.
 */
import { lazy, Suspense, useState, useTransition, type ComponentType } from 'react';
import type { PortfolioContext } from '../../Portfolio';
import type { PortfolioPageLinks } from '../PortfolioPage';
import { isAddress, setDevWatch, useDevWatch } from '../devWatch';
import { shortAddr } from './blocks';
import '../../bots/kit/kit.css';
import '../../bots/botsPages.css';
import '../../vip.css';
import './versions.css';

export type VersionProps = { c: PortfolioContext } & PortfolioPageLinks;

const VERSIONS: ReadonlyArray<{ key: string; name: string; C: ComponentType<VersionProps> | null }> = [
  { key: 'original', name: 'Original', C: null },
  { key: 'wallet', name: 'Wallet', C: lazy(() => import('./Wallet').then((m) => ({ default: m.WalletTwoColumns }))) },
  { key: 'stack', name: 'Stack', C: lazy(() => import('./Wallet').then((m) => ({ default: m.WalletStack }))) },
  { key: 'banner', name: 'Banner', C: lazy(() => import('./Wallet').then((m) => ({ default: m.WalletBanner }))) },
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

export default function DevVersions({ Original, ...props }: VersionProps & { Original: ComponentType<VersionProps> }) {
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
      {V ? <Suspense fallback={null}><V key={pick} {...props} /></Suspense> : <Original {...props} />}
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
        <nav className="pfv-switch__bar" aria-label="Portfolio page versions">
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
