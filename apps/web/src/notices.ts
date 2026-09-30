/**
 * Notifications kept on this browser. The navbar bell reads them.
 * The unread mark is only for deposit, withdrawal, error, and system items
 * such as an unfinished account setup. Ordinary transfers stay in the list
 * without lighting the mark.
 */
export type NoticeKind = 'deposit' | 'withdraw' | 'error' | 'system' | 'info';

export interface Notice {
  id: string;
  time: number;
  kind: NoticeKind;
  title: string;
  body: string;
  important: boolean;
  read: boolean;
}

const KEY = 'vs.notices.v1';
const CAP = 40;
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

export function pushNotice(row: Omit<Notice, 'id' | 'time' | 'read'> & { id?: string }): void {
  const id = row.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const next = read().filter((n) => n.id !== id);
  write([{ ...row, id, time: Date.now(), read: false }, ...next]);
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
