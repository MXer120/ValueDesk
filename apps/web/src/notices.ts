/**
 * Notifications kept on this browser. The navbar bell reads them.
 * The unread mark is only for deposit, withdrawal, error, and system items
 * such as an unfinished account setup - and for the ValueDesk team's reply to
 * the visitor's feedback (feedback/FeedbackHost.tsx). Ordinary transfers stay in
 * the list without lighting the mark.
 */
export type NoticeKind = 'deposit' | 'withdraw' | 'error' | 'system' | 'info' | 'reply' | 'algo' | 'copy';
/** How much a notice matters (the bell's View filters on it): info, warn, error. */
export type NoticeGrade = 'info' | 'warn' | 'error';
/** Where an algo or copy notice came from: this browser's runner, the hosted executor, or the wallet's inbox on the server. */
export type NoticeOrigin = 'browser' | 'executor' | 'inbox';

export interface Notice {
  id: string;
  time: number;
  kind: NoticeKind;
  title: string;
  body: string;
  important: boolean;
  read: boolean;
  /** For a `reply`: the feedback thread it belongs to (feedback/threads.ts) - the row opens that chat. */
  ref?: string;
  /** An algo or copy notice (copy-engine notices.ts): its grade, wallet and origin. Others take theirs from the kind (gradeOf). */
  grade?: NoticeGrade;
  owner?: string;
  origin?: NoticeOrigin;
}

const KIND_GRADE: Record<NoticeKind, NoticeGrade> = { deposit: 'info', withdraw: 'info', error: 'error', system: 'warn', info: 'info', reply: 'info', algo: 'warn', copy: 'warn' };
/** A notice's grade: its own, else its kind's. */
export const gradeOf = (n: Pick<Notice, 'kind' | 'grade'>): NoticeGrade => n.grade ?? KIND_GRADE[n.kind] ?? 'info';

const KEY = 'vs.notices.v1';
// The last 200 on this browser; the wallet's inbox on the server keeps every algo and copy notice (inbox.ts).
const CAP = 200;
const SETUP_ID = 'system:setup';
const INDEX_ID = 'system:index';

const listeners = new Set<() => void>();
let memory: Notice[] | null = null;

const isNotice = (v: unknown): v is Notice => {
  const n = v as Notice;
  return !!n && typeof n.id === 'string' && typeof n.time === 'number'
    && typeof n.title === 'string' && typeof n.body === 'string'
    && typeof n.important === 'boolean' && typeof n.read === 'boolean';
};

function read(): Notice[] {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    memory = Array.isArray(list) ? list.filter(isNotice).slice(0, CAP) : [];
  } catch {
    memory = [];
  }
  return memory;
}

function write(list: Notice[]): void {
  memory = list.slice(0, CAP);
  try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* private mode */ }
  for (const l of listeners) l();
}

export function notices(): Notice[] {
  return read();
}

export function unreadImportant(): number {
  return read().filter((n) => n.important && !n.read).length;
}

export function subscribeNotices(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function pushNotice(row: Omit<Notice, 'id' | 'time' | 'read'> & { id?: string; time?: number }): void {
  const id = row.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const next = read().filter((n) => n.id !== id);
  write([{ ...row, id, time: row.time ?? Date.now(), read: false }, ...next].sort((a, b) => b.time - a.time));
}

/** Notices that may already be here (the inbox, the executor): new ids only, read as they were, newest first. */
export function mergeNotices(rows: ReadonlyArray<Omit<Notice, 'read'> & { read?: boolean }>): number {
  const cur = read();
  const have = new Set(cur.map((n) => n.id));
  const add = rows.filter((r) => !have.has(r.id)).map((r) => ({ ...r, read: r.read ?? false }));
  if (add.length) write([...add, ...cur].sort((a, b) => b.time - a.time));
  return add.length;
}

export function markNoticesRead(): void {
  const cur = read();
  if (cur.every((n) => n.read)) return;
  write(cur.map((n) => (n.read ? n : { ...n, read: true })));
}

/** Keep the two standing system rows in step with setup and indexing. */
export function syncSystemNotices(input: { connected: boolean; setupDone: boolean; indexing: boolean }): void {
  const cur = read();
  const rest = cur.filter((n) => n.id !== SETUP_ID && n.id !== INDEX_ID);
  const rows: Notice[] = [];
  if (input.connected && !input.setupDone) {
    const prev = cur.find((n) => n.id === SETUP_ID);
    rows.push({
      id: SETUP_ID,
      time: prev?.time ?? Date.now(),
      kind: 'system',
      title: 'Finish setting up',
      body: 'Account setup is still open. Indexing waits with it.',
      important: true,
      read: prev?.read ?? false,
    });
  }
  if (input.indexing) {
    const prev = cur.find((n) => n.id === INDEX_ID);
    rows.push({
      id: INDEX_ID,
      time: prev?.time ?? Date.now(),
      kind: 'system',
      title: 'Indexing your account',
      body: 'History is being rolled into statistics on this browser.',
      important: true,
      read: prev?.read ?? false,
    });
  }
  const next = [...rows, ...rest].slice(0, CAP);
  if (JSON.stringify(next) === JSON.stringify(cur)) return;
  write(next);
}
