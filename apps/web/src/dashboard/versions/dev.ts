/**
 * The versions' components, loaded on demand and only by a DEV server. In a build `import.meta.env.DEV` is false:
 * each of these is null and its import is dead code, so devVersions.tsx is never emitted.
 */
import { lazy, useEffect, useState, type ComponentType } from 'react';

const DEV = import.meta.env.DEV;

type Mod = typeof import('./devVersions');
let mod: Mod | null = null;
let loading: Promise<Mod> | null = null;
/** The module, loading it the first time. */
export function loadDev(): Promise<Mod> {
  if (mod) return Promise.resolve(mod);
  // A conditional on the literal the build writes for DEV: the bundler drops the import with its branch.
  loading ??= (DEV ? import('./devVersions') : Promise.reject(new Error('versions are DEV only'))).then((m) => { mod = m; return m; });
  return loading;
}
if (DEV) void loadDev();

/** True once the versions' styles and parts are in: a version is drawn only then, never a frame unstyled. */
export function useDevReady(want: boolean): boolean {
  const [ready, setReady] = useState(() => !DEV || !want || mod !== null);
  useEffect(() => {
    if (ready || !DEV || !want) return;
    let live = true;
    void loadDev().then(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, [ready, want]);
  return ready || !want;
}

function part<K extends keyof Mod>(k: K): ComponentType<any> | null {
  if (!DEV) return null;
  return lazy(() => loadDev().then((m) => ({ default: m[k] as unknown as ComponentType<any> })));
}

export const DevVersionSwitch = part('VersionSwitch');
export const DevPhoneDeck = part('PhoneDeck');
export const DevPhonePulse = part('PhonePulse');
export const DevRangeBar = part('RangeBar');
export const DevEditDock = part('EditDock');
