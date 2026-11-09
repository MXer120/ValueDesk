/**
 * Accepting the copy trading terms: ONE wallet signature, before any copy.
 *
 * The follower ticks the four statements, names their country of residence,
 * and signs an 'accept-terms' CopyRequest that carries the terms version and
 * the keccak256 of the exact terms text shown (legal/copyTerms.ts). The same
 * signed request is
 *   - kept in this browser (the browser copier needs a declared country), and
 *   - recorded by ValueDesk's executor (its record of who accepted which terms,
 *     in every mode), and
 *   - handed to a self-hosted executor when one is used.
 * A new terms version needs a new signature. A wallet that accepted the current terms in another browser is not
 * asked again: once it signs in to ValueDesk's executor, that record counts here too (adoptRecordedTerms).
 */
import {
  COPY_TERMS_EXECUTOR,
  COPY_TERMS_VERSION,
  canonicalJSON,
  normaliseCountry,
  regionPolicy,
  type AcceptTermsPayload,
  type RegionPolicy,
  type SignedCopyRequest,
  type TermsRecord,
} from '@copy-engine';
import { bytesToHex, keccak256, utf8 } from '@sodex-core';
import { COPY_TERMS } from '../legal/copyTerms';
import type { Eip1193Provider } from '../wallet';
import { logger } from '../log';
import { ExecutorError, hostedExecutor, signCopy, type ExecutorClient } from './executor';

const log = logger('copy');

/** keccak256 of the terms as shown: any change to the text is a new hash. */
export const COPY_TERMS_HASH = bytesToHex(keccak256(utf8(canonicalJSON(COPY_TERMS))));

export interface LocalTerms {
  termsVersion: string;
  termsHash: string;
  country: string;
  acceptedAt: number;
  /** ValueDesk's executor has the record. */
  recorded: boolean;
  /** The signed acceptance; null when it was signed in another browser and only the executor's record is here. */
  request: SignedCopyRequest | null;
}

const key = (owner: string) => `vd.copy.terms:${owner.toLowerCase()}`;

/** This wallet's acceptance of the CURRENT terms in this browser, or null. */
export function localTerms(owner: string | null | undefined): LocalTerms | null {
  if (!owner) return null;
  try {
    const raw = localStorage.getItem(key(owner));
    if (!raw) return null;
    const t = JSON.parse(raw) as LocalTerms;
    return t.termsVersion === COPY_TERMS_VERSION && t.termsHash === COPY_TERMS_HASH ? t : null;
  } catch {
    return null;
  }
}

function save(owner: string, t: LocalTerms): void {
  try {
    localStorage.setItem(key(owner), JSON.stringify(t));
  } catch {
    /* private mode: accepted for this page only */
  }
}

/** The region rule for this wallet (declared country here, IP country as the executor saw it). */
export const termsPolicy = (t: LocalTerms | null, viewerCountry: string | null): RegionPolicy => regionPolicy(t?.country ?? null, viewerCountry);

export async function acceptCopyTerms(o: { provider: Eip1193Provider; owner: string; country: string }): Promise<LocalTerms> {
  const owner = o.owner.toLowerCase();
  const country = normaliseCountry(o.country);
  if (!country) throw new Error('Choose your country of residence.');
  const payload: AcceptTermsPayload = {
    termsVersion: COPY_TERMS_VERSION,
    termsHash: COPY_TERMS_HASH,
    country,
    adult: true,
    notUsPerson: true,
    ownDecision: true,
    risksUnderstood: true,
  };
  const request = await signCopy(o.provider, owner, COPY_TERMS_EXECUTOR, 'accept-terms', payload);
  const t: LocalTerms = { termsVersion: COPY_TERMS_VERSION, termsHash: COPY_TERMS_HASH, country, acceptedAt: Date.now(), recorded: false, request };
  try {
    await hostedExecutor.acceptTerms(request);
    t.recorded = true;
  } catch (e) {
    // A refusal for the region is final: say it. Unreachable is not: the record is sent again later.
    if (e instanceof ExecutorError && (e.status === 451 || e.status === 400)) throw e;
    log.warn('copy terms: ValueDesk could not record the acceptance now; it is sent again later', { error: String(e) });
  }
  save(owner, t);
  return t;
}

/**
 * ValueDesk's executor already records this wallet's acceptance of the CURRENT terms (signed in another browser,
 * or on another of our addresses): keep it here, so the setup does not ask for the same signature twice.
 */
export function adoptRecordedTerms(owner: string, r: TermsRecord | null): LocalTerms | null {
  if (!r || r.termsVersion !== COPY_TERMS_VERSION || r.termsHash !== COPY_TERMS_HASH) return null;
  const t: LocalTerms = { termsVersion: r.termsVersion, termsHash: r.termsHash, country: r.country, acceptedAt: r.acceptedAt, recorded: true, request: null };
  save(owner.toLowerCase(), t);
  return t;
}

/** Send a not-yet-recorded acceptance to ValueDesk again (on load). */
export async function recordPendingTerms(owner: string): Promise<void> {
  const t = localTerms(owner);
  if (!t || t.recorded || !t.request) return;
  try {
    await hostedExecutor.acceptTerms(t.request);
    save(owner, { ...t, recorded: true });
  } catch (e) {
    // Already recorded (the same signature): done.
    if (e instanceof ExecutorError && e.code === 'replay') save(owner, { ...t, recorded: true });
  }
}

/** Hand the same signed acceptance to a self-hosted executor. */
export async function sendTermsTo(client: ExecutorClient, owner: string): Promise<void> {
  const t = localTerms(owner);
  if (!t) throw new Error('Accept the copy trading terms first.');
  if (!t.request) throw new Error('Your copier needs the signed terms: accept them once in this browser.');
  try {
    await client.acceptTerms(t.request);
  } catch (e) {
    if (e instanceof ExecutorError && e.code === 'replay') return;
    throw e;
  }
}
