/**
 * SoDEX's limits mid-run, in the bell: when a running algo is held, or one of
 * its orders cut, by the position limit or the open-interest cap, the runtime
 * writes a notice on the algo (copy-engine limits.ts `k.limitNotice`, with how
 * much can still be added). Every place an algo runs hands its views here -
 * this browser's runner, and the executors' lists (GET /algos), which reach a
 * browser the same way - and each notice goes in the bell once, by its id,
 * with a toast while it is fresh.
 */
import { limitNoticeOf, type AlgoView } from '@copy-engine';
import { pushNotice } from '../notices';

const SEEN_KEY = 'vs.algo.limitSeen.v1';
const KEEP = 200;
/** An older notice (the page opened long after it) goes in the bell quietly, without a toast. */
const FRESH_MS = 30 * 60_000;

let seen: string[] | null = null;

function seenList(): string[] {
  if (seen) return seen;
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    seen = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-KEEP) : [];
  } catch {
    seen = [];
  }
  return seen;
}

function remember(id: string): void {
  const list = seenList();
  list.push(id);
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(list));
  } catch {
    /* private mode: this tab still remembers */
  }
}

/** Put each new limit notice of these algos in the bell (and a toast while fresh). `where`: where they run, in words. */
export function noteLimitNotices(views: readonly AlgoView[], where?: string, now = Date.now()): number {
  let told = 0;
  for (const v of views) {
    const n = limitNoticeOf(v.algo);
    if (!n || seenList().includes(n.id)) continue;
    remember(n.id);
    const body = where ? `${n.text} (${where})` : n.text;
    pushNotice({ id: `algo-limit:${n.id}`, kind: n.what === 'held' ? 'error' : 'info', title: n.title, body, important: true });
    // The toast module draws (coin icons, styles): loaded only when there is something to say.
    if (now - n.at <= FRESH_MS) void import('../toast').then((t) => t.notify('warn', `${n.title}. ${n.text}`)).catch(() => {});
    told++;
  }
  return told;
}

/** Tests: forget what was told. */
export function resetLimitNotices(): void {
  seen = [];
  try {
    localStorage.removeItem(SEEN_KEY);
  } catch {
    /* none */
  }
}
