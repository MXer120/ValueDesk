/**
 * Every published version of the copy trading terms, by COPY_TERMS_VERSION (owner 2026-11-09: the terms version
 * must never make a follower reload the page).
 *
 * The executor serves the text of ITS version (GET /terms/copy) and the web shows and signs exactly that, so a web
 * build newer or older than the executor still signs what the executor records. The web also knows the earlier
 * versions here, so it signs an older executor's version without asking it for the text (executors before
 * 'terms-doc' serve none).
 *
 * Changing the terms: add copy-<new version>.ts (copy the newest, then edit), list it below, set COPY_TERMS_VERSION
 * in policy.ts. Never edit a published file: its hash is what followers signed. Keep at least the version before
 * the newest, for an executor one release behind.
 */
import { bytesToHex, keccak256, utf8 } from '../../../sodex-core/src/index.ts';
import { canonicalJSON } from '../api.ts';
import { COPY_TERMS_VERSION } from '../policy.ts';
import { COPY_TERMS_2026_11_02 } from './copy-2026-11-02.ts';
import { COPY_TERMS_2026_11_09 } from './copy-2026-11-09.ts';
import type { TermsDoc } from './doc.ts';

export type { TermsBlock, TermsDoc } from './doc.ts';

export const COPY_TERMS_DOCS: Readonly<Record<string, TermsDoc>> = {
  '2026-11-02': COPY_TERMS_2026_11_02,
  '2026-11-09': COPY_TERMS_2026_11_09,
};

/** The text of a version, or null when this build does not know it. */
export const copyTermsDoc = (version: string): TermsDoc | null => COPY_TERMS_DOCS[version] ?? null;

/** keccak256 of the text as shown (canonical JSON): the termsHash a follower signs. */
export const copyTermsHash = (doc: TermsDoc): string => bytesToHex(keccak256(utf8(canonicalJSON(doc))));

/** The version in force in this build, with its text and hash. */
export interface CopyTermsServed {
  termsVersion: string;
  termsHash: string;
  doc: TermsDoc;
}
export function currentCopyTerms(): CopyTermsServed {
  const doc = COPY_TERMS_DOCS[COPY_TERMS_VERSION];
  if (!doc) throw new Error(`terms/index.ts lists no text for COPY_TERMS_VERSION ${COPY_TERMS_VERSION}`);
  return { termsVersion: COPY_TERMS_VERSION, termsHash: copyTermsHash(doc), doc };
}
