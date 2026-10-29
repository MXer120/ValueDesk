/**
 * Browser algos go on through page switches and reloads; only closing the tab stops them for
 * good (the owner, 2026-10-29). A page that goes away cannot tell a reload from a close, so the
 * next start tells them apart: the tab that runs a wallet's algos notes the time while it runs
 * and as it goes (pagehide, hidden); a page that loaded within RELOAD_MS of that note is a
 * reload - or another open tab taking over - and the algos go on; a page that loaded later
 * found the last tab closed, and its runner stops them (browserAlgos.ts startRuntime).
 *
 * What counts is the note as it stood when THIS page loaded (captureBoot, from main.tsx): a
 * runner that starts only once the wallet reconnects, a minute in, still knows it was a reload.
 */
const KEY = 'vd-algo-alive';
/** A reload, or a tab taking over: back within this of the running tab's last note. */
export const RELOAD_MS = 20_000;
const BEAT_MS = 5_000;

type Alive = Record<string, number>;

function readAlive(): Alive {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' ? (v as Alive) : {};
  } catch {
    return {};
  }
}

let boot: { at: number; alive: Alive } | null = null;

/** The running tabs' notes as this page found them. Call once, first thing. */
export function captureBoot(now = Date.now()): void {
  boot ??= { at: now, alive: readAlive() };
}

/** Closed, not reloaded: the running tab's last note for `owner` was more than RELOAD_MS before the page loaded at `bootAt`. Never noted: no. */
export function wasClosed(alive: Readonly<Record<string, number>>, bootAt: number, owner: string): boolean {
  const last = alive[owner];
  return typeof last === 'number' && bootAt - last > RELOAD_MS;
}

/** Whether `owner`'s algos lost their tab before this page loaded (closed, not reloaded). */
export function closedBeforeBoot(owner: string): boolean {
  const b = boot ?? { at: Date.now(), alive: readAlive() };
  return wasClosed(b.alive, b.at, owner);
}

/** This tab runs `owner`'s algos: note it now, every few seconds, and as the page goes. Returns the stop. */
export function keepAlive(owner: string, now: () => number = Date.now): () => void {
  const note = () => {
    try {
      const m = readAlive();
      m[owner] = now();
      localStorage.setItem(KEY, JSON.stringify(m));
    } catch {
      /* private mode: a reload then counts as a close */
    }
  };
  note();
  // What this page now knows is current: a later start of its own runner is no reload question.
  if (boot) boot.alive[owner] = now();
  const t = setInterval(note, BEAT_MS);
  // Never what keeps a process alive (tests run the runner under Node).
  (t as unknown as { unref?: () => void }).unref?.();
  const onHide = () => note();
  const onVis = () => { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') note(); };
  const win = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null;
  const doc = typeof document !== 'undefined' && typeof document.addEventListener === 'function' ? document : null;
  win?.addEventListener('pagehide', onHide);
  doc?.addEventListener('visibilitychange', onVis);
  return () => {
    clearInterval(t);
    win?.removeEventListener('pagehide', onHide);
    doc?.removeEventListener('visibilitychange', onVis);
  };
}
