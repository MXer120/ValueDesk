/**
 * Accepting ValueDesk's terms: a clickwrap with a versioned record.
 *
 * WHAT IS ACCEPTED. The Terms of use and the Risk disclosure (terms.ts,
 * risk.ts) as one version, SITE_TERMS_VERSION, fingerprinted by SITE_TERMS_HASH
 * (keccak256 of the two texts, canonical JSON). The privacy policy and the
 * cookie notice inform; they are not agreed to, so they are not part of it.
 *
 * TWO STEPS
 *   1. Everyone who opens the site: the first-visit sheet (LegalGate.tsx) - three
 *      statements, each ticked, then "Agree and continue". Kept in this browser
 *      only: the version, the fingerprint, the time and the statements. No
 *      personal data, nothing sent anywhere.
 *   2. A wallet, before it trades: when trading is enabled (AccountController),
 *      the wallet signs the same version and fingerprint, its country of
 *      residence and four statements - a CopyRequest 'accept-site-terms'
 *      (EIP-712, packages/copy-engine/src/api.ts). Kept in this browser, and sent
 *      to ValueDesk's executor, which appends it to its log of signed requests
 *      with the country the edge saw (apps/executor, POST /api/copy/v1/site-terms).
 *      Until the executor has it, it is sent again on the next visit.
 *
 * A NEW VERSION asks both again: the sheet comes back ("the terms have
 * changed"), and new positions wait for the new signature - closing, cancelling
 * and withdrawing never wait (trading/legalGate.ts). acceptance.test.ts
 * recomputes the fingerprint from the texts: change terms.ts or risk.ts (or a
 * list in jurisdictions.mjs, which the terms name) without raising the version
 * and pinning the new hash here, and the test fails.
 *
 * The texts themselves stay out of the first load (they are the legal chunk):
 * this module only holds the version and the fingerprint.
 */
import { useSyncExternalStore } from 'react';
import { SITE_TERMS_EXECUTOR, type AcceptSiteTermsPayload, type SignedCopyRequest } from '@copy-engine';
import { ExecutorError, hostedExecutor, signCopy } from '../copy/executor';
import type { Eip1193Provider } from '../wallet';
import { logger } from '../log';
import { normaliseCountry, siteAccess } from './jurisdictions.mjs';

const log = logger('legal');

/** The terms' version: a date, with a counter when they change twice on one day (2026-10-24.2). */
export const SITE_TERMS_VERSION = '2026-10-24';
/** keccak256(canonicalJSON({ terms: TERMS, risk: RISK })) of SITE_TERMS_VERSION; acceptance.test.ts recomputes it. */
export const SITE_TERMS_HASH = '0xe2043d05d08184e57b9df4eeab33c36dcf3ed640095202ce22bee5116bf179e0';

/* ------------------------------------------------------------- statements ----- */

export type BrowseStatementId = 'agree' | 'eligible' | 'risk';

/** The first-visit sheet's statements, in the order shown. Links in [label](/page) form (LegalGate renders them). */
export const BROWSE_STATEMENTS: ReadonlyArray<{ id: BrowseStatementId; label: string }> = [
  { id: 'agree', label: 'I have read and agree to the [Terms of use](/terms) and the [Risk disclosure](/risk), and I have read the [Privacy policy](/privacy).' },
  { id: 'eligible', label: 'I am at least 18 years old. I am not in, and do not live in, a country or region where ValueDesk is not available, I am not subject to sanctions, and I do not hide where I am (for example with a VPN).' },
  { id: 'risk', label: 'I understand that trading perpetual futures and crypto-assets can lose me all the money I put in, that nothing on ValueDesk is advice, and that ValueDesk never holds my funds.' },
];

export type TradeStatementId = 'adult' | 'notRestricted' | 'risksUnderstood' | 'ownDecisions';

/** The statements a wallet signs before it trades (AcceptSiteTermsPayload), in the order shown. */
export const TRADE_STATEMENTS: ReadonlyArray<{ id: TradeStatementId; label: string }> = [
  { id: 'adult', label: 'I am at least 18 years old and able to enter into binding contracts, and I trade for myself, not for anyone else.' },
  { id: 'notRestricted', label: 'I do not live in, and do not trade from, the United States or its territories, a sanctioned country or region named in the Terms of use, or any place where this trading is not lawful for me; I am not subject to sanctions, and I do not hide where I am.' },
  { id: 'risksUnderstood', label: 'I have read the Terms of use and the Risk disclosure. I understand that leveraged trading can lose me my whole margin within minutes, and that orders can fill late, partly, at worse prices or not at all.' },
  { id: 'ownDecisions', label: 'Every trade, copy and algo order is my own decision. ValueDesk gives no advice, owes me no duty to act in my interest, and does not check whether trading is suitable for me.' },
];

/* --------------------------------------------------------------- storage ----- */

export interface BrowseRecord {
  termsVersion: string;
  termsHash: string;
  acceptedAt: number;
  statements: BrowseStatementId[];
}

export interface SignedSiteTerms {
  termsVersion: string;
  termsHash: string;
  country: string;
  acceptedAt: number;
  /** ValueDesk's executor has the record. */
  recorded: boolean;
  request: SignedCopyRequest;
}

const BROWSE_KEY = 'vd.site.terms.v1';
const signedKey = (owner: string) => `vd.site.terms:${owner.toLowerCase()}`;

const listeners = new Set<() => void>();
let revision = 0;
const changed = () => {
  revision++;
  for (const l of listeners) l();
};

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** In memory too: a private window that refuses storage still accepts for this page. */
const memory = new Map<string, unknown>();
function write(key: string, v: unknown): void {
  memory.set(key, v);
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode: accepted for this page only */
  }
  changed();
}
const read = <T,>(key: string): T | null => (memory.get(key) as T | undefined) ?? readJson<T>(key);

const current = (r: { termsVersion?: unknown; termsHash?: unknown } | null): boolean =>
  !!r && r.termsVersion === SITE_TERMS_VERSION && r.termsHash === SITE_TERMS_HASH;

/** This browser's acceptance of the CURRENT terms, or null. */
export function browseAccepted(): BrowseRecord | null {
  const r = read<BrowseRecord>(BROWSE_KEY);
  return current(r) && BROWSE_STATEMENTS.every((s) => r!.statements?.includes(s.id)) ? r : null;
}

/** An earlier version was accepted here (the sheet then says the terms changed). */
export function acceptedBefore(): boolean {
  const r = read<BrowseRecord>(BROWSE_KEY);
  return !!r && !current(r);
}

export function acceptBrowse(statements: readonly BrowseStatementId[], now = Date.now()): BrowseRecord {
  if (!BROWSE_STATEMENTS.every((s) => statements.includes(s.id))) throw new Error('Tick every statement to continue.');
  const r: BrowseRecord = { termsVersion: SITE_TERMS_VERSION, termsHash: SITE_TERMS_HASH, acceptedAt: now, statements: BROWSE_STATEMENTS.map((s) => s.id) };
  write(BROWSE_KEY, r);
  return r;
}

/** This wallet's signed acceptance of the CURRENT terms in this browser, or null. */
export function signedTerms(owner: string | null | undefined): SignedSiteTerms | null {
  if (!owner) return null;
  const r = read<SignedSiteTerms>(signedKey(owner));
  return current(r) && !!normaliseCountry(r!.country) ? r : null;
}

export function subscribeAcceptance(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const getRevision = () => revision;

/** Re-render when an acceptance is given (in this tab). */
export function useAcceptanceRevision(): number {
  return useSyncExternalStore(subscribeAcceptance, getRevision, getRevision);
}

/* ---------------------------------------------------------------- signing ----- */

/** The payload a wallet signs for `country` (every statement true). */
export function siteTermsPayload(country: string): AcceptSiteTermsPayload {
  const c = normaliseCountry(country);
  if (!c) throw new Error('Choose your country of residence.');
  return {
    termsVersion: SITE_TERMS_VERSION,
    termsHash: SITE_TERMS_HASH,
    country: c,
    adult: true,
    notRestricted: true,
    risksUnderstood: true,
    ownDecisions: true,
  };
}

/** Why `country` cannot sign (a restricted country of residence), or null. */
export function countryProblem(country: string): string | null {
  const a = siteAccess({ declared: country });
  return a.level === 'open' ? null : a.reason;
}

/**
 * The wallet signs the current terms for `country`; the signature is kept here
 * and sent to ValueDesk's executor (again later if that fails now).
 */
export async function signSiteTerms(o: { provider: Eip1193Provider; owner: string; country: string }): Promise<SignedSiteTerms> {
  const owner = o.owner.toLowerCase();
  const problem = countryProblem(o.country);
  if (problem) throw new Error(problem);
  const payload = siteTermsPayload(o.country);
  const request = await signCopy(o.provider, owner, SITE_TERMS_EXECUTOR, 'accept-site-terms', payload);
  const t: SignedSiteTerms = { termsVersion: SITE_TERMS_VERSION, termsHash: SITE_TERMS_HASH, country: payload.country, acceptedAt: Date.now(), recorded: false, request };
  write(signedKey(owner), t);
  await sendRecord(owner, t);
  return signedTerms(owner) ?? t;
}

async function sendRecord(owner: string, t: SignedSiteTerms): Promise<void> {
  try {
    await hostedExecutor.acceptSiteTerms(t.request);
    write(signedKey(owner), { ...t, recorded: true });
  } catch (e) {
    // The same signature already recorded: done. Anything else (an executor without
    // the route yet, an outage): kept here, sent again on the next visit.
    if (e instanceof ExecutorError && e.code === 'replay') write(signedKey(owner), { ...t, recorded: true });
    else log.warn('site terms: ValueDesk could not record the acceptance now; it is sent again later', { error: String(e) });
  }
}

/** Send a not-yet-recorded acceptance to ValueDesk again (when the wallet connects). */
export async function recordPendingSiteTerms(owner: string | null | undefined): Promise<void> {
  const t = signedTerms(owner);
  if (!owner || !t || t.recorded) return;
  await sendRecord(owner.toLowerCase(), t);
}

/** For tests. */
export function _resetAcceptanceForTests(): void {
  memory.clear();
  changed();
}

/** For tests of the order flow: `owner` has signed the current terms (no real signature behind it). */
export function _signedTermsForTests(owner: string, country = 'DE'): void {
  const request = { action: 'accept-site-terms', owner: owner.toLowerCase(), executor: SITE_TERMS_EXECUTOR, payload: '{}', nonce: '0', deadline: '0', chainId: 1, signature: '0x' } as SignedCopyRequest;
  write(signedKey(owner), { termsVersion: SITE_TERMS_VERSION, termsHash: SITE_TERMS_HASH, country, acceptedAt: 0, recorded: true, request } satisfies SignedSiteTerms);
}
