/** Types for tools/licenses.mjs (imported by vite.config.ts, the copier's bundler and src/legal/licences.test.ts). */
export interface PackageLicence {
  name: string;
  version: string;
  licence: string | null;
  cleared: boolean;
  source: string;
  files: Array<{ name: string; text: string }>;
}
export const ALLOWED: Set<string>;
export const CLEARED: Array<{ test: RegExp; licence: string; as: string }>;
export function packageDirOf(id: string): { dir: string; name: string } | null;
export function licenceOf(pkg: Record<string, unknown>): string | null;
export function licenceAllowed(expr: string | null): boolean;
export function readPackage(dir: string): PackageLicence;
export function renderLicences(pkgs: PackageLicence[], product?: string): string;
export function thirdPartyLicences(o?: { fileName?: string }): { name: string; apply: 'build'; generateBundle(): void };
