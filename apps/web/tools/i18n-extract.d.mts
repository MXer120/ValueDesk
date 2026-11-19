/** Types for tools/i18n-extract.mjs (its collectStrings, read by tools/i18n-parts.mjs). */
export function readsAsText(s: string): boolean;
export function collectStrings(): { list: string[]; where: Map<string, Set<string>> };
