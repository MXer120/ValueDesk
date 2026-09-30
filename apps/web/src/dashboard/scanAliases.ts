/**
 * Scan's address aliases (a name you gave an address, kept in localStorage).
 *
 * Their own module, not ScanDashboard.tsx, because the always-loaded shell
 * needs them too: the Cmd+K palette resolves an alias typed into the search
 * box. Importing them from ScanDashboard pulled the whole Scan and Portfolio
 * pages (and every panel under them) into the first-load bundle just for
 * these four functions. ScanDashboard re-exports them, so existing importers
 * keep working.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Aliases are the one thing worth keeping from the old page. */
const ALIAS_KEY = 'scan-aliases';

export function aliasMap(): Record<string, string> {
  try {
    return (JSON.parse(localStorage.getItem(ALIAS_KEY) || '{}') || {}) as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveAlias(addr: string, name: string): void {
  const m = aliasMap();
  const k = addr.toLowerCase();
  if (name.trim()) m[k] = name.trim();
  else delete m[k];
  try {
    localStorage.setItem(ALIAS_KEY, JSON.stringify(m));
  } catch {
    /* storage disabled */
  }
}

export const aliasFor = (addr: string): string => aliasMap()[addr.toLowerCase()] ?? '';

/** An alias, or a raw address, resolved to an address. */
export function resolveTarget(input: string): string | null {
  const t = input.trim();
  if (ADDRESS_RE.test(t)) return t;
  const m = aliasMap();
  const hit = Object.keys(m).find((a) => m[a]!.toLowerCase() === t.toLowerCase());
  return hit ?? null;
}
