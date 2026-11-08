/**
 * VIP move (owner 2026-11-08): a wallet with $1M of its own 14-day volume moves its bots
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
 * the VIP side confirms (its import failed, or it gave the job up) resumes the bots here - never under the brake. A
 * send that was not answered cleanly (a timeout) is asked about (POST /internal/vip/import/status, which also gives
 * up a job not begun), never guessed: with no answer the bots stay paused (outcome 'unknown') and the operator is told.
 * The move runs inside the wallet's queue; its starts and resumes are refused while it runs; jobs are kept in the db.
 * The key is sealed only to the pinned EXECUTOR_VIP_PUBKEY, and EXECUTOR_VIP_URL must be https (or loopback).
 *
 * BACK (owner 2026-11-08): the same move the other way. The VIP executor asks the API server about each wallet whose
 * bots run there every VIP_SWEEP_MS; one that is no longer VIP (under $1M in 14 days, no program) moves back to the
 * standard executor (EXECUTOR_STD_URL, key sealed to the pinned EXECUTOR_STD_PUBKEY, same token) - at most ONE
 * downgrade per wallet per UTC day, so a wallet near the line is never moved to and fro. Upgrades are never limited.
 */
import { randomBytes } from 'node:crypto';

export type VipStepId = 'check' | 'pause' | 'seal' | 'send' | 'start' | 'finish';
export interface VipStep { id: VipStepId; label: string; state: 'wait' | 'run' | 'done' | 'fail'; ms: number | null; note?: string }
export interface VipJob {
  id: string;
  owner: string;
  /** up: standard -> VIP (the wallet asked); down: VIP -> standard (VIP ended). Absent: up (jobs from before). */
  direction?: 'up' | 'down';
  /** Why a move back happened (the API server's words), for the wallet. */
  reason?: string;
  state: 'running' | 'done' | 'failed';
  startedAt: number;
  endedAt: number | null;
  steps: VipStep[];
  bots: number;
  error: string | null;
  /** The VIP executor's read token for this wallet (only to its owner): the page goes on there without signing again. */
  session: { token: string; expiresAt: number } | null;
  /**
   * How it ended for the bots: moved (the VIP side took them), not-moved (it did not; they resumed here unless the
   * brake is on), unknown (the VIP side did not confirm either way: they stay paused here, the operator is told).
   */
  outcome?: 'moved' | 'not-moved' | 'unknown';
}

export const VIP_STEPS: Array<{ id: VipStepId; label: string }> = [
  { id: 'check', label: 'Checking your VIP status' },
  { id: 'pause', label: 'Pausing your bots' },
  { id: 'seal', label: 'Sealing your key to the VIP servers' },
  { id: 'send', label: 'Handing over bots and books' },
  { id: 'start', label: 'Starting on the VIP servers' },
  { id: 'finish', label: 'Releasing the standard servers' },
];

export const VIP_STEPS_DOWN: Array<{ id: VipStepId; label: string }> = [
  { id: 'check', label: 'VIP ended: moving back' },
  { id: 'pause', label: 'Pausing your bots' },
  { id: 'seal', label: 'Sealing your key to the standard servers' },
  { id: 'send', label: 'Handing over bots and books' },
  { id: 'start', label: 'Starting on the standard servers' },
  { id: 'finish', label: 'Releasing the VIP servers' },
];

/** How often the VIP executor asks whether its wallets are still VIP. */
export const VIP_SWEEP_MS = 10 * 60_000;

/** The UTC day of a time (days since 1970-01-01). */
export const utcDay = (ms: number): number => Math.floor(ms / 86_400_000);

/** Whether the wallet was already moved back (a down move began) on the UTC day of `now`: one downgrade a day at most. */
export function downgradedToday(jobs: readonly VipJob[], now: number): boolean {
  return jobs.some((j) => j.direction === 'down' && utcDay(j.startedAt) === utcDay(now));
}

export function newVipJob(owner: string, direction: 'up' | 'down' = 'up', reason?: string): VipJob {
  return {
    id: randomBytes(8).toString('hex'),
    owner,
    direction,
    ...(reason ? { reason } : {}),
    state: 'running',
    startedAt: Date.now(),
    endedAt: null,
    steps: (direction === 'down' ? VIP_STEPS_DOWN : VIP_STEPS).map((s) => ({ ...s, state: 'wait', ms: null })),
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
