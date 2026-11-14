/**
 * Accepting ValueDesk's terms: a clickwrap with a versioned record, signed by
 * the visitor's own wallet.
 *
 * WHAT IS ACCEPTED. The Terms of use and the Risk disclosure (terms.ts,
 * risk.ts) as one version, SITE_TERMS_VERSION, fingerprinted by SITE_TERMS_HASH
 * (keccak256 of the two texts, canonical JSON), with the four STATEMENTS below.
 * The privacy policy and the cookie notice inform; they are not agreed to, so
 * they are not part of the fingerprint.
 *
 * ONE STEP, WITH THE WALLET (LegalGate.tsx TermsGate):
 *   - a visitor with a connected wallet ticks "I confirm" over the four
 *     statements and signs ONE message with that wallet, for the country the
 *     edge saw (geo.ts; shown read-only - never picked or typed in, owner
 *     2026-10-28; unknown: no signature, nothing opens) - free: an
 *     EIP-712 signature, not a transaction, no gas, no funds move. The signed
 *     request is a CopyRequest 'accept-site-terms' (packages/copy-engine/src/
 *     api.ts) whose payload carries the version, the fingerprint, the country,
 *     the four statements as flags and, word for word, as the text the wallet
 *     shows. Kept in this browser, and sent to ValueDesk's executor, which appends
 *     it to its log of signed requests with the country the edge saw
 *     (apps/executor, POST /api/copy/v1/site-terms); until the executor has it,
 *     it is sent again on the next visit;
 *   - a visitor without a wallet confirms the same statements ("Agree and
 *     continue"): kept in this browser only. A wallet that connects later signs
 *     them at its first action that needs the terms;
 *   - or the visitor looks around first ("Just look around", or the popup's X):
 *     nothing is accepted, the public data stays open, and the popup comes back
 *     as a gate at the first action that needs the terms (requireTerms below);
 *   - a wallet from a close-only place cannot sign (its country restricts
 *     trading): it browses on the ticked statements and can close positions.
 * Copy trading asks for its own signature on top - the copy terms, before the
 * first copy in any mode (copy/terms.ts).
 *
 * A NEW VERSION asks again: the gate comes back ("the terms have changed"), and
 * new positions wait for the new signature - closing, cancelling and
 * withdrawing never wait (trading/legalGate.ts). acceptance.test.ts recomputes
 * the fingerprint from the texts: change terms.ts or risk.ts (or a list in
 * jurisdictions.mjs, which the terms name) without raising the version and
 * pinning the new hash here, and the test fails.
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
export const SITE_TERMS_VERSION = '2026-11-14';
/** keccak256(canonicalJSON({ terms: TERMS, risk: RISK })) of SITE_TERMS_VERSION; acceptance.test.ts recomputes it. */
export const SITE_TERMS_HASH = '0x0f5a0b617b57019850fbb426b40f56351aef2232f5085b35ce524d35d18e2782';

/* ------------------------------------------------------------- statements ----- */

export type StatementId = 'agree' | 'eligible' | 'risks' | 'ownDecisions';

/**
 * What every visitor confirms, in the order shown - ticked without a wallet,
 * ticked and signed with one. Links in [label](/page) form (LegalGate renders
 * them; the signed text drops the link syntax). The ids are the flags of
 * AcceptSiteTermsPayload.
 */
export const STATEMENTS: ReadonlyArray<{ id: StatementId; label: string }> = [
  { id: 'agree', label: 'I agree to the [Terms of use](/terms) and the [Risk disclosure](/risk), and have read the [Privacy policy](/privacy).' },
  { id: 'eligible', label: 'I am 18 or older, not sanctioned, not living or using ValueDesk where it is not allowed, and not hiding where I am (e.g. a VPN).' },
  { id: 'risks', label: 'I understand that trading perpetual futures can lose me all the money I put in.' },
  { id: 'ownDecisions', label: 'My trades are my own decisions: ValueDesk gives no advice and never holds my funds.' },
];

/** A statement as plain text: [label](/page) -> label. */
const plain = (s: string): string => s.replace(/\[([^\]]+)\]\(\/[a-z-]+\)/g, '$1');

/** What the wallet shows and signs, word for word (the payload's `text`). */
export function signedText(country: string): string {
  return [
    `ValueDesk - Terms of use and Risk disclosure, version ${SITE_TERMS_VERSION} (fingerprint ${SITE_TERMS_HASH}).`,
    // The country the edge saw - true when the visitor travels too; where they live is in the `eligible` statement.
    `Country seen from my connection: ${country}.`,
    ...STATEMENTS.map((s) => plain(s.label)),
    'This signature is free: it is not a transaction and moves no funds.',
  ].join(' ');
}

/* --------------------------------------------------------------- storage ----- */

export interface BrowseRecord {
  termsVersion: string;
  termsHash: string;
  acceptedAt: number;
  statements: StatementId[];
  /** The wallet that signed it, when the acceptance was signed. */
  signedBy?: string;
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
  return current(r) && STATEMENTS.every((s) => r!.statements?.includes(s.id)) ? r : null;
}

/** An earlier version was accepted here (the gate then says the terms changed). */
export function acceptedBefore(): boolean {
  const r = read<BrowseRecord>(BROWSE_KEY);
  return !!r && !current(r);
}

export function acceptBrowse(statements: readonly StatementId[], now = Date.now(), signedBy?: string): BrowseRecord {
  if (!STATEMENTS.every((s) => statements.includes(s.id))) throw new Error('Tick every statement to continue.');
  const r: BrowseRecord = {
    termsVersion: SITE_TERMS_VERSION,
    termsHash: SITE_TERMS_HASH,
    acceptedAt: now,
    statements: STATEMENTS.map((s) => s.id),
    ...(signedBy ? { signedBy } : {}),
  };
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

/** The payload a wallet signs for `country` (every statement true, and its text). */
export function siteTermsPayload(country: string): AcceptSiteTermsPayload {
  const c = normaliseCountry(country);
  if (!c) throw new Error('ValueDesk could not tell from your connection which country you are in.');
  return {
    termsVersion: SITE_TERMS_VERSION,
    termsHash: SITE_TERMS_HASH,
    country: c,
    agree: true,
    eligible: true,
    risks: true,
    ownDecisions: true,
    text: signedText(c),
  };
}

/** Why `country` cannot sign (a restricted country of residence), or null. */
export function countryProblem(country: string): string | null {
  const a = siteAccess({ declared: country });
  return a.level === 'open' ? null : a.reason;
}

/**
 * The wallet signs the current terms for `country` - one free signature; the
 * signature is kept here, counts as this browser's acceptance too, and is sent
 * to ValueDesk's executor (again later if that fails now).
 */
export async function signSiteTerms(o: { provider: Eip1193Provider; owner: string; country: string }): Promise<SignedSiteTerms> {
  const owner = o.owner.toLowerCase();
  const problem = countryProblem(o.country);
  if (problem) throw new Error(problem);
  const payload = siteTermsPayload(o.country);
  const request = await signCopy(o.provider, owner, SITE_TERMS_EXECUTOR, 'accept-site-terms', payload);
  const t: SignedSiteTerms = { termsVersion: SITE_TERMS_VERSION, termsHash: SITE_TERMS_HASH, country: payload.country, acceptedAt: Date.now(), recorded: false, request };
  write(signedKey(owner), t);
  acceptBrowse(STATEMENTS.map((s) => s.id), t.acceptedAt, owner);
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

/* ------------------------------------------- browsing first, terms at action ----- */

/*
 * A visitor may close the first-visit popup ("Just look around") and browse the
 * public data without accepting anything. The terms are then asked for - as a
 * gate, at the moment of the action - by everything that makes ValueDesk do
 * something for the visitor: an order that opens or increases a position, an
 * algo, enabling trading, a deposit, accepting the copy terms, creating a copy
 * key, starting, changing or resuming a copy (requireTerms below; LegalGate.tsx
 * TermsGate answers). Closing, cancelling, reducing and withdrawing are never
 * held up: nobody is kept in a position until they accept terms.
 */
const LOOK_KEY = 'vd.site.terms.look';

/** The visitor chose to look around first (for the current version): the popup does not open by itself. */
export const lookedAround = (): boolean => read<string>(LOOK_KEY) === SITE_TERMS_VERSION;
export const lookAround = (): void => write(LOOK_KEY, SITE_TERMS_VERSION);

/** What an action needs: this browser's acceptance, and the wallet's signature where it can sign. */
export interface TermsRequest {
  /** The wallet the action is for (its signature is asked where it can sign). */
  owner?: string | null;
  /** What the visitor is about to do, for the popup ("place this order"). */
  reason: string;
}

type GateHandler = (r: TermsRequest) => Promise<boolean>;
let gate: GateHandler | null = null;

/** TermsGate registers itself; null when it unmounts. */
export function setTermsGate(h: GateHandler | null): void {
  gate = h;
}

/**
 * Resolves true once the terms the action needs are accepted - at once when
 * they already are, otherwise after the visitor accepted them in the popup;
 * false when they closed it. In a page without the popup (it failed to mount):
 * true only if they are accepted already. Outside a browser - the unit tests,
 * the Node live runner, which use these modules without the web app - there is
 * no one to ask: true (the signature rules of trading/legalGate.ts still hold).
 */
export function requireTerms(r: TermsRequest): Promise<boolean> {
  if (gate) return gate(r);
  if (typeof window === 'undefined') return Promise.resolve(true);
  return Promise.resolve(!!browseAccepted() && (!r.owner || !!signedTerms(r.owner)));
}

/** The refusal of an action whose terms were not accepted: the user's decision, said quietly. */
export class TermsNotAccepted extends Error {
  override name = 'TermsNotAccepted';
  constructor(reason: string) {
    super(`Cancelled: the terms were not accepted, so ValueDesk did not ${reason}.`);
  }
}

/** requireTerms, throwing TermsNotAccepted when the visitor closed the popup. */
export async function requireTermsOrThrow(r: TermsRequest): Promise<void> {
  if (!(await requireTerms(r))) throw new TermsNotAccepted(r.reason);
}

/** For tests. */
export function _resetAcceptanceForTests(): void {
  memory.clear();
  gate = null;
  changed();
}

/** For tests of the order flow: `owner` has accepted and signed the current terms (no real signature behind it). */
export function _signedTermsForTests(owner: string, country = 'DE'): void {
  const request = { action: 'accept-site-terms', owner: owner.toLowerCase(), executor: SITE_TERMS_EXECUTOR, payload: '{}', nonce: '0', deadline: '0', chainId: 1, signature: '0x' } as SignedCopyRequest;
  write(signedKey(owner), { termsVersion: SITE_TERMS_VERSION, termsHash: SITE_TERMS_HASH, country, acceptedAt: 0, recorded: true, request } satisfies SignedSiteTerms);
  acceptBrowse(STATEMENTS.map((s) => s.id), 0, owner.toLowerCase());
}
