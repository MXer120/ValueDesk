/**
 * The legal documents - Impressum, privacy policy, cookie and storage notice,
 * terms of use, risk disclosure, copy trading terms - and the check a public
 * build runs on them.
 *
 * `assertLegalPagesComplete()` throws while any `[[OWNER: ...]]` placeholder
 * is left, naming each one. The production build calls it through
 * tools/check-legal.ts (`npx tsx tools/check-legal.ts`, exit code 1 while a
 * placeholder is left), so a public build cannot ship a draft.
 */
import type { LegalPage } from '../router';
import { COOKIES } from './cookies';
import { COPY_TERMS } from './copyTerms';
import { IMPRESSUM } from './impressum';
import { PRIVACY } from './privacy';
import { RISK } from './risk';
import { TERMS } from './terms';
import { placeholderReport, placeholdersOf, type LeftPlaceholder, type LegalDoc } from './model';

export const LEGAL_DOCS: Record<LegalPage, LegalDoc> = {
  impressum: IMPRESSUM,
  privacy: PRIVACY,
  cookies: COOKIES,
  terms: TERMS,
  risk: RISK,
  'copy-terms': COPY_TERMS,
};

/** Every placeholder still in the legal pages. */
export function legalPlaceholders(docs: Record<LegalPage, LegalDoc> = LEGAL_DOCS): LeftPlaceholder[] {
  return placeholdersOf(docs);
}

/** For the production build: throws, listing every placeholder, until the owner has filled them all in. */
export function assertLegalPagesComplete(docs: Record<LegalPage, LegalDoc> = LEGAL_DOCS): void {
  const report = placeholderReport(legalPlaceholders(docs));
  if (report) throw new Error(report);
}
