/**
 * Transfers this browser has started, newest first, so the sheet's bottom
 * drawer can show the latest few and follow the one in flight. Local only.
 */
import { useSyncExternalStore } from 'react';
import { pushNotice } from '../../notices';
import { announceMoney } from './moneyNotice';

export type TransferEnd = 'spot' | 'perps' | 'evm';
export type TransferStatus = 'pending' | 'success' | 'failed';

export interface TransferPrompt {
  wallet: 'approve' | 'confirm';
  n: number;
  of: number;
}

export interface TransferLogEntry {
  id: string;
  time: number;
  coin: string;
  /** Already cut for display (the sheet's 6-decimal amount), not raw base units. */
  amount: string;
  from: TransferEnd;
  to: TransferEnd;
  status: TransferStatus;
  /** Last wallet prompt. Null for an engine move, or before one is known. */
  walletStep: TransferPrompt | null;
  /** Signatures are done (or there are none): SoDEX or the chain is working. */
  settling: boolean;
  error?: string;
}

const KEY = 'vs.transfers.v1';
const CAP = 20;
const ENDS = new Set<TransferEnd>(['spot', 'perps', 'evm']);
const STATUSES = new Set<TransferStatus>(['pending', 'success', 'failed']);

const listeners = new Set<() => void>();
let memory: TransferLogEntry[] | null = null;
const EMPTY: TransferLogEntry[] = [];

const isPrompt = (p: unknown): p is TransferPrompt => {
  const x = p as TransferPrompt;
  return !!x && (x.wallet === 'approve' || x.wallet === 'confirm') && typeof x.n === 'number' && typeof x.of === 'number';
};

const isEntry = (e: unknown): e is TransferLogEntry => {
  const x = e as TransferLogEntry;
  return !!x && typeof x.id === 'string' && typeof x.time === 'number' && typeof x.coin === 'string'
    && typeof x.amount === 'string' && ENDS.has(x.from) && ENDS.has(x.to) && STATUSES.has(x.status)
    && typeof x.settling === 'boolean' && (x.walletStep === null || isPrompt(x.walletStep));
};

function read(): TransferLogEntry[] {
  if (memory) return memory;
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    memory = Array.isArray(list) ? list.filter(isEntry).slice(0, CAP) : EMPTY;
  } catch {
    memory = EMPTY;
  }
  return memory;
}

function write(list: TransferLogEntry[]): void {
  memory = list.slice(0, CAP);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(memory));
  } catch {
    /* private mode: kept for this page only */
  }
  for (const l of listeners) l();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    memory = null;
    for (const l of listeners) l();
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useTransferLog(): TransferLogEntry[] {
  return useSyncExternalStore(subscribe, read, read);
}

/** Newest first. The drawer and the tests both read this list. */
export function transferEntries(): TransferLogEntry[] {
  return read();
}

export function beginTransfer(row: Omit<TransferLogEntry, 'id' | 'time' | 'status'>): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  write([{ ...row, id, time: Date.now(), status: 'pending' }, ...read()]);
  return id;
}

export function noteTransferStep(id: string, step: TransferPrompt | { wallet: null }): void {
  const cur = read();
  write(cur.map((e) => {
    if (e.id !== id) return e;
    return step.wallet ? { ...e, walletStep: step, settling: false } : { ...e, settling: true };
  }));
}

export function finishTransfer(id: string, status: 'success' | 'failed', error?: string): void {
  // A failure keeps `settling`, so the drawer marks Pending rather than the last signature.
  write(read().map((e) => (e.id === id ? { ...e, status, settling: status === 'failed' ? e.settling : false, error } : e)));
  const row = read().find((e) => e.id === id);
  if (row) {
    pushNotice(noticeFor(row));
    // On the wallet button too (moneyNotice.ts): money in and out is announced there.
    const kind = row.from === 'evm' ? 'deposit' : row.to === 'evm' ? 'withdraw' : 'transfer';
    const what = kind === 'deposit' ? 'Deposit' : kind === 'withdraw' ? 'Withdrawal' : 'Transfer';
    const where = kind === 'transfer' ? ` to ${END_NAME[row.to] ?? row.to}` : '';
    announceMoney({ kind, status: status === 'success' ? 'done' : 'failed', text: `${what} of ${row.amount} ${row.coin}${where} ${status === 'success' ? 'completed' : 'failed'}` });
  }
}

const END_NAME: Record<string, string> = { spot: 'Spot', perps: 'Futures', evm: 'EVM' };

function noticeFor(e: TransferLogEntry): Parameters<typeof pushNotice>[0] {
  const route = `${e.amount} ${e.coin}`;
  if (e.status === 'failed') {
    return { kind: 'error', title: 'Transfer failed', body: e.error || route, important: true };
  }
  if (e.from === 'evm') return { kind: 'deposit', title: 'Deposit', body: route, important: true };
  if (e.to === 'evm') return { kind: 'withdraw', title: 'Withdrawal', body: route, important: true };
  return { kind: 'info', title: 'Transfer', body: route, important: false };
}

export function dropTransfer(id: string): void {
  write(read().filter((e) => e.id !== id));
}

/** For tests. */
export function _resetTransferLog(): void {
  memory = null;
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* no store */
  }
}
