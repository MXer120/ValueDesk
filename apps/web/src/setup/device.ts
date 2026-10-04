/**
 * A capability check, not a guess at the device's age.
 *
 * Potato only when the hardware itself is small: 4 cores or fewer AND 4 GB
 * or less. A frame sample is not used. Opening this sheet, a busy tab, or a
 * hidden tab reports a low number on a fast machine, and that was turning
 * potato mode on for devices that do not need it. Missing deviceMemory is
 * not treated as small — only Chromium reports it.
 */
export interface DeviceProbe {
  cores: number;
  /** navigator.deviceMemory, in GB. null when the browser does not report it. */
  memoryGb: number | null;
  /** Kept for callers. Always null: frame rate is not a device fact. */
  fps: number | null;
}

export function suggestPotato(p: DeviceProbe): boolean {
  return p.cores > 0 && p.cores <= 4 && p.memoryGb !== null && p.memoryGb <= 4;
}

const POTATO_KEY = 'vs.potato';
const POTATO_USER = 'vs.potato.user';

/** True when this browser's potato setting was flipped by hand. */
export function potatoChosenByUser(): boolean {
  try { return localStorage.getItem(POTATO_USER) === '1'; }
  catch { return false; }
}

export function readPotatoOn(): boolean {
  try { return localStorage.getItem(POTATO_KEY) === 'true'; }
  catch { return false; }
}

/** Apply the class and remember it. `byUser` keeps a later probe from overwriting the choice. */
export function writePotato(on: boolean, byUser: boolean): void {
  document.documentElement.classList.toggle('is-potato', on);
  try {
    localStorage.setItem(POTATO_KEY, on ? 'true' : 'false');
    if (byUser) localStorage.setItem(POTATO_USER, '1');
  } catch { /* private mode */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('vs-potato'));
}

export async function probeDevice(): Promise<DeviceProbe> {
  const rawCores = Number(navigator.hardwareConcurrency);
  // Unknown is not "small". A missing count must not trip the 4-core test.
  const cores = Number.isFinite(rawCores) && rawCores > 0 ? rawCores : 8;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const memoryGb = typeof mem === 'number' && Number.isFinite(mem) && mem > 0 ? mem : null;
  return { cores, memoryGb, fps: null };
}
