/**
 * LOCALHOST ONLY (owner 2026-11-26: "localhost only with multiple versions and the switch ... Do not delete the original
 * keep it in the switch"). The version switch of the SoPoints and Blind Box pages, the Referrals page's own pill
 * (referrals.css `.rf-switch`), with a second group for sample data. A build never imports this file: the pages load it
 * behind `import.meta.env.DEV` (SoPointsPage.tsx, BlindBoxPage.tsx), so production shows Original.
 */
import { useState } from 'react';

/** A choice kept in this browser, read once; any stored value outside `keys` falls back. */
export function useDevChoice<K extends string>(storageKey: string, keys: readonly K[], fallback: K): [K, (k: K) => void] {
  const [v, setV] = useState<K>(() => {
    try {
      const s = localStorage.getItem(storageKey);
      return keys.includes(s as K) ? (s as K) : fallback;
    } catch {
      return fallback;
    }
  });
  const set = (k: K) => {
    setV(k);
    try { localStorage.setItem(storageKey, k); } catch { /* this tab only */ }
  };
  return [v, set];
}

export interface DevSwitchProps<K extends string> {
  label: string;
  versions: ReadonlyArray<readonly [K, string]>;
  value: K;
  onChange: (k: K) => void;
  /** Made-up data for the parts only a sign-in or a wallet fills (sample.ts); off for Original, which stays as it is. */
  sample?: { on: boolean; set: (on: boolean) => void; disabled?: boolean };
}

export function DevSwitch<K extends string>({ label, versions, value, onChange, sample }: DevSwitchProps<K>) {
  return (
    <nav className="rf-switch sx-switch" aria-label={label} data-no-i18n="">
      {versions.map(([k, t]) => (
        <button key={k} type="button" aria-pressed={value === k} className={value === k ? 'is-on' : ''} onClick={() => { onChange(k); (document.querySelector('.appcontent') ?? window).scrollTo({ top: 0 }); }}>{t}</button>
      ))}
      {sample && (
        <>
          <i className="sx-switch__sep" aria-hidden="true" />
          <button type="button" aria-pressed={sample.on} disabled={sample.disabled} title={sample.disabled ? 'Original stays as it is: no sample there' : 'Made-up data for what a sign-in or a wallet fills'} className={`is-sample${sample.on && !sample.disabled ? ' is-on' : ''}`} onClick={() => sample.set(!sample.on)}>Sample</button>
        </>
      )}
    </nav>
  );
}
