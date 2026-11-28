/**
 * The More menu's "new" dots (owner 2026-11-28: "add a green dot onto the more dropdown, if users didnt visit the
 * sopoints, blind box and wealth pages, so a dot to every one of them too. referrals page too"). A page counts as
 * visited once it was on screen in this browser; nothing leaves it.
 */
import { useEffect, useState } from 'react';

export const NEW_PAGES = ['points', 'blind-boxes', 'wealth', 'referrals'] as const;
export type NewPage = (typeof NEW_PAGES)[number];
const KEY = 'vs.nav.seen';
const EVENT = 'vs:nav-seen';

function read(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]); } catch { return new Set(NEW_PAGES); }
}

export function markSeen(p: NewPage): void {
  const s = read();
  if (s.has(p)) return;
  s.add(p);
  try { localStorage.setItem(KEY, JSON.stringify([...s])); } catch { /* storage off: the dot simply stays */ }
  window.dispatchEvent(new Event(EVENT));
}

/** The pages not visited yet. */
export function useUnseen(): ReadonlySet<NewPage> {
  const [seen, setSeen] = useState(read);
  useEffect(() => {
    const on = () => setSeen(read());
    window.addEventListener(EVENT, on);
    window.addEventListener('storage', on);
    return () => { window.removeEventListener(EVENT, on); window.removeEventListener('storage', on); };
  }, []);
  return new Set(NEW_PAGES.filter((p) => !seen.has(p)));
}
