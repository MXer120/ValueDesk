/** Types for legal/jurisdictions.mjs (the one list of restricted places - see there). */
export interface Country {
  readonly code: string;
  readonly name: string;
}
export interface Region {
  readonly country: string;
  readonly region: string;
  readonly name: string;
}
export type AccessLevel = 'open' | 'close-only' | 'blocked';
export interface SiteAccess {
  level: AccessLevel;
  /** The country the answer was decided on. */
  country: string | null;
  /** The country's or region's name, where restricted. */
  place: string | null;
  /** Why, in plain words, where restricted. */
  reason: string | null;
  /** Which observation restricted it. */
  source: 'observed' | 'declared' | null;
}
export const SANCTIONED_COUNTRIES: readonly Country[];
export const SANCTIONED_REGIONS: readonly Region[];
export const CLOSE_ONLY_COUNTRIES: readonly Country[];
export const LEGAL_PATHS: readonly string[];
export const SANCTIONED_CODES: readonly string[];
export const CLOSE_ONLY_CODES: readonly string[];
export function normaliseCountry(c: unknown): string | null;
export function normaliseRegion(r: unknown): string | null;
export function siteAccess(o?: { country?: string | null; region?: string | null; declared?: string | null }): SiteAccess;
export function closeOnlyPlaceName(country: string | null | undefined): string | null;
export function edgeBlockList(): { countries: string[]; regions: Array<{ country: string; region: string }> };
