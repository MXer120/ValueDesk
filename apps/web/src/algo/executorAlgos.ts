/**
 * Algo orders on an executor: ValueDesk's (hosted, Tokyo, 24/7) or the
 * trader's own (self-hosted). They run while every browser is closed.
 *
 * The executor and everything it needs are the COPY setup's: the terms, the
 * builder-fee approval, the key the trader registered for that executor, and a
 * signed-in session (copy/live.ts keeps all of it). An algo adds nothing to
 * set up; it adds two signed instructions, 'algo-start' (the spec, as the
 * wallet shows it) and 'algo-action' (pause / resume / cancel / cancel all).
 */
import { requirePaperAlgo } from './liveAlgos';
import type { AlgoEvent, AlgoView } from '@copy-engine';
import { ExecutorClient, ExecutorError, hostedExecutor, selfBase, signCopy } from '../copy/executor';
import { requireTermsOrThrow } from '../legal/acceptance';
import { getLiveCopy, readiness, type CopyModeId } from '../copy/live';
import { algoProvider } from './algoBus';

export type ExecutorMode = Exclude<CopyModeId, 'browser'>;

const selfClients = new Map<string, ExecutorClient>();

function clientFor(mode: ExecutorMode): ExecutorClient | null {
  if (mode === 'hosted') return hostedExecutor;
  const url = getLiveCopy().self.url;
  if (!url) return null;
  const base = selfBase(url);
  let c = selfClients.get(base);
  if (!c) selfClients.set(base, (c = new ExecutorClient(base, 'self')));
  return c;
}

/** Where the executor stands for algos: ready, or the step that is missing (in words). */
export function executorReady(mode: ExecutorMode, paper: boolean): { ready: boolean; why: string | null } {
  const s = getLiveCopy();
  const side = s[mode];
  const name = mode === 'hosted' ? 'the ValueDesk executor' : 'your copier';
  if (!s.owner) return { ready: false, why: 'Connect your wallet.' };
  if (!side.info) return { ready: false, why: mode === 'hosted' ? 'The ValueDesk executor is not reachable right now.' : 'Connect your self-hosted copier in Copy → Set up.' };
  if (!side.info.algos) return { ready: false, why: `${mode === 'hosted' ? 'The ValueDesk executor' : 'Your copier'} does not run algo orders yet (update it).` };
  const r = readiness(s, mode);
  if (!r.terms) return { ready: false, why: `Accept the terms of ${name} in Copy → Set up.` };
  if (!r.connected) return { ready: false, why: `Sign in to ${name} in Copy → Set up.` };
  if (paper) return { ready: true, why: null };
  if (!r.fee) return { ready: false, why: 'Approve the ValueDesk fee in Copy → Set up.' };
  if (!r.key) return { ready: false, why: `Register the key of ${name} in Copy → Set up ("Approve agent").` };
  return { ready: true, why: null };
}

function needWallet(): { owner: string; provider: NonNullable<ReturnType<typeof algoProvider>> } {
  const owner = getLiveCopy().owner;
  const provider = algoProvider();
  if (!owner || !provider) throw new Error('Connect your wallet first.');
  return { owner, provider };
}

async function call<T>(client: ExecutorClient, method: 'GET' | 'POST', path: string, o: { token?: string | null; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  let res: Response;
  try {
    res = await fetch(client.base + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), credentials: 'omit', cache: 'no-store', mode: 'cors' });
  } catch {
    throw new ExecutorError(client.kind === 'self' ? 'Your copier does not answer. Is it running?' : 'The ValueDesk executor could not be reached. Try again in a moment.', 0, 'network');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; code?: string };
    throw new ExecutorError(d.error || `The executor answered HTTP ${res.status}.`, res.status, d.code || 'http');
  }
  return data as T;
}

/** Start an algo on an executor: one wallet signature over the spec. */
export async function startOn(mode: ExecutorMode, spec: unknown, seed: number): Promise<AlgoView> {
  requirePaperAlgo(spec);
  const { owner, provider } = needWallet();
  const client = clientFor(mode);
  const info = getLiveCopy()[mode].info;
  if (!client || !info) throw new Error('That executor is not connected.');
  await requireTermsOrThrow({ owner, reason: 'start this algo order' });
  const request = await signCopy(provider, owner, info.executorId, 'algo-start', { spec, seed });
  return call<AlgoView>(client, 'POST', '/algos', { body: { request } });
}

/** Pause, resume or cancel one algo on an executor (or cancel all there): one wallet signature. */
export async function actOn(mode: ExecutorMode, op: 'pause' | 'resume' | 'cancel' | 'cancel-all', id?: string): Promise<AlgoView[]> {
  const { owner, provider } = needWallet();
  const client = clientFor(mode);
  const info = getLiveCopy()[mode].info;
  if (!client || !info) throw new Error('That executor is not connected.');
  const request = await signCopy(provider, owner, info.executorId, 'algo-action', id ? { op, id } : { op });
  return (await call<{ algos: AlgoView[] }>(client, 'POST', '/algos/action', { body: { request } })).algos;
}

/** This wallet's algos on an executor it is signed in to (no session: none, quietly). */
export async function listOn(mode: ExecutorMode): Promise<AlgoView[]> {
  const owner = getLiveCopy().owner;
  const client = clientFor(mode);
  const token = owner && client ? client.token(owner) : null;
  if (!client || !token || !getLiveCopy()[mode].info?.algos) return [];
  return (await call<{ algos: AlgoView[] }>(client, 'GET', '/algos', { token })).algos;
}

export async function eventsOn(mode: ExecutorMode, id: string, limit = 200): Promise<AlgoEvent[]> {
  const owner = getLiveCopy().owner;
  const client = clientFor(mode);
  const token = owner && client ? client.token(owner) : null;
  if (!client || !token) return [];
  return (await call<{ events: AlgoEvent[] }>(client, 'GET', `/algos/${encodeURIComponent(id)}/events?limit=${limit}`, { token })).events;
}
