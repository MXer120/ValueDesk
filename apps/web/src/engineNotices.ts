/**
 * The follower's algo and copy notices (copy-engine notices.ts: a copy halted, an algo failed,
 * stopped or held, a copied position closed outside the copier...) in the bell, from three places:
 *
 *   - this browser's runners as it happens (takeEngineNotice: browserAlgos.ts, browserCopier.ts) -
 *     an error also as a toast;
 *   - the wallet's inbox on the server (ops/inbox.ts), once the wallet is signed in (the feedback
 *     chat's wallet session): every notice raised here goes there too - queued on this browser
 *     until the wallet signs in - so it can be read on any device for as long as it is kept;
 *   - the hosted executor, once signed in there: its copies' and algos' notices (it keeps them).
 *
 * syncNotices brings the two stored ones into the bell; the bell calls it while it is shown.
 */
import type { EngineNotice } from '@copy-engine';
import { mergeNotices, pushNotice, type Notice, type NoticeOrigin } from './notices';
import { heldSession } from './feedback/session';
import { hostedExecutor } from './copy/executor';

const PENDING_KEY = 'vs.inbox.pending.v1';
const PENDING_CAP = 500;
const BATCH = 50;

/** A notice as the bell's row ("(paper)" when nothing was sent). */
export function noticeRow(n: EngineNotice, origin: NoticeOrigin): Omit<Notice, 'read'> {
  return {
    id: n.id, time: n.at, kind: n.source, grade: n.grade, owner: n.owner, origin,
    title: n.paper ? `${n.title} (paper)` : n.title, body: n.body, important: n.grade !== 'info',
    ...(n.kind === 'key-expiry' ? { action: 'renew-key' as const } : {}),
  };
}

function pending(): EngineNotice[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]');
    return Array.isArray(v) ? (v as EngineNotice[]).filter((n) => n && typeof n.id === 'string' && typeof n.owner === 'string') : [];
  } catch {
    return [];
  }
}
function savePending(list: EngineNotice[]): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-PENDING_CAP)));
  } catch {
    /* private mode: the bell still has it */
  }
}

/** A notice from this browser's runner: into the bell now, and on its way to the wallet's inbox. */
export function takeEngineNotice(n: EngineNotice): void {
  pushNotice(noticeRow(n, 'browser'));
  // The toast is loaded when one is due: the runners stay free of the UI (and of its styles in their tests).
  if (n.grade === 'error') void import('./toast').then((t) => t.notify('error', `${n.title}${n.body ? `: ${n.body}` : ''}`)).catch(() => {});
  // Paper algos run under no wallet ('paper'): there is no inbox to keep them in.
  if (!/^0x[0-9a-f]{40}$/.test(n.owner)) return;
  const rest = pending().filter((x) => x.id !== n.id);
  savePending([...rest, n]);
  void flushInbox(n.owner);
}

let flushing = false;
/** Send this browser's queued notices of `owner` to its inbox, if the wallet is signed in. */
export async function flushInbox(owner: string, f: typeof fetch = fetch): Promise<void> {
  const s = heldSession(owner);
  if (!s || flushing) return;
  flushing = true;
  try {
    for (;;) {
      const mine = pending().filter((x) => x.owner === owner).slice(0, BATCH);
      if (!mine.length) return;
      const r = await f('/api/vs/inbox/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
        body: JSON.stringify({ notices: mine }),
      }).catch(() => null);
      if (!r || !r.ok) return;
      const sent = new Set(mine.map((x) => x.id));
      savePending(pending().filter((x) => !sent.has(x.id)));
    }
  } finally {
    flushing = false;
  }
}

/** The stored notices of `owner` into the bell: its inbox (signed in with the wallet) and the hosted executor's (signed in there). */
export async function syncNotices(owner: string, f: typeof fetch = fetch): Promise<number> {
  let added = 0;
  await flushInbox(owner, f);
  const s = heldSession(owner);
  if (s) {
    const r = await f('/api/vs/inbox/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
      body: JSON.stringify({ limit: 200 }),
    }).catch(() => null);
    const b = r && r.ok ? ((await r.json().catch(() => null)) as { notices?: Array<Omit<EngineNotice, 'owner'>> } | null) : null;
    if (b?.notices) added += mergeNotices(b.notices.map((n) => noticeRow({ ...n, owner }, 'inbox')));
  }
  const t = hostedExecutor.token(owner);
  if (t) {
    const r = await hostedExecutor.notices(t).catch(() => null);
    if (r?.notices) added += mergeNotices(r.notices.map((n) => noticeRow(n, 'executor')));
  }
  return added;
}
