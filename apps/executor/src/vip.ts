/**
 * VIP move (owner 2026-11-08): a wallet with over $1M of 14-day volume, or over 1% of ValueDesk's, moves its bots
 * from the standard executor to the VIP one (AWS Tokyo) with ONE signature, server to server, in seconds:
 *
 *   check   the API server says the wallet is VIP (EXECUTOR_VIP_CHECK_URL); no copy or algo order of its runs here
 *           (they would lose their key), and it has a key
 *   pause   its running bots pull their quotes and hold (what they hold stays in the account)
 *   seal    its SoDEX API key, re-sealed to the VIP executor's import key (Secrets.sealTo: ECDH + AES-GCM, the
 *           format a browser import uses) - never in the clear on the wire
 *   send    the key, its signed record (terms, consents) and its bots' records (books, children) to the VIP
 *           executor's internal import (X-Internal-Token = EXECUTOR_VIP_TOKEN); it adopts them under the same ids and resumes them
 *   finish  here the bots end as handed over (nothing closed), the key is dropped, the wallet is marked moved
 *
 * Both executors keep the same executor id, so every signature the wallet made reads the same on both. A failure
 * before the VIP side took the bots resumes them here.
 */
import { randomBytes } from 'node:crypto';

export type VipStepId = 'check' | 'pause' | 'seal' | 'send' | 'start' | 'finish';
export interface VipStep { id: VipStepId; label: string; state: 'wait' | 'run' | 'done' | 'fail'; ms: number | null; note?: string }
export interface VipJob {
  id: string;
  owner: string;
  state: 'running' | 'done' | 'failed';
  startedAt: number;
  endedAt: number | null;
  steps: VipStep[];
  bots: number;
  error: string | null;
  /** The VIP executor's read token for this wallet (only to its owner): the page goes on there without signing again. */
  session: { token: string; expiresAt: number } | null;
}

export const VIP_STEPS: Array<{ id: VipStepId; label: string }> = [
  { id: 'check', label: 'Checking your VIP status' },
  { id: 'pause', label: 'Pausing your bots' },
  { id: 'seal', label: 'Sealing your key to the VIP servers' },
  { id: 'send', label: 'Handing over bots and books' },
  { id: 'start', label: 'Starting on AWS Tokyo' },
  { id: 'finish', label: 'Releasing the standard servers' },
];

export function newVipJob(owner: string): VipJob {
  return {
    id: randomBytes(8).toString('hex'),
    owner,
    state: 'running',
    startedAt: Date.now(),
    endedAt: null,
    steps: VIP_STEPS.map((s) => ({ ...s, state: 'wait', ms: null })),
    bots: 0,
    error: null,
    session: null,
  };
}

/** Run one step of a job: timed, marked, its error kept as the job's. */
export async function vipStep<T>(job: VipJob, id: VipStepId, fn: () => Promise<T>): Promise<T> {
  const s = job.steps.find((x) => x.id === id)!;
  s.state = 'run';
  const t0 = Date.now();
  try {
    const out = await fn();
    s.state = 'done';
    s.ms = Date.now() - t0;
    return out;
  } catch (e) {
    s.state = 'fail';
    s.ms = Date.now() - t0;
    job.error = e instanceof Error ? e.message : String(e);
    throw e;
  }
}

/** A job as its owner reads it (the token only while it is fresh). */
export const vipJobView = (j: VipJob): VipJob => ({ ...j, steps: j.steps.map((s) => ({ ...s })) });
