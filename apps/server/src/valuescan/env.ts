/**
 * `process.env[name]` where there is a process, `undefined` in a browser.
 *
 * The venue providers read their endpoint overrides from the environment at
 * import time. The same files also run in the browser (the web imports them
 * through `@sign/*` to read each user's own venue data from the user's own
 * IP), where `process` does not exist; there every override is simply unset
 * and the public defaults apply.
 */
export function envOf(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

/**
 * Whether this process only SERVES the API: next to an indexer running as its
 * own process (VALUESCAN_INDEXER=0), or to the public (VALUESCAN_HOSTED=1).
 *
 * Such a process must not spend the address's exchange budgets on its
 * visitors. The indexer reads from the same address under budgets planned for
 * it, and a visitor count is not something a budget can be planned for. So
 * there, what a public route shows comes from the index, or from a feed every
 * visitor shares - and a provider that could only answer by crawling the venue
 * says "not available" instead (sodex/positioning.ts, hyperliquid/positioning.ts,
 * and the Hyperliquid client's share in hyperliquid/info.ts).
 *
 * False in the single-process dev server, and in a browser (each user's own
 * address; there is no process to ask).
 */
export function apiOnly(get: (name: string) => string | undefined = envOf): boolean {
  return get('VALUESCAN_HOSTED')?.trim() === '1' || get('VALUESCAN_INDEXER') === '0';
}

/**
 * `timer.unref()` on Node, nothing in a browser (where timers are numbers).
 * Lets a background timer never hold a Node process open, without a
 * Node-only type in code the browser also runs.
 */
export function unrefTimer(t: unknown): void {
  (t as { unref?: () => void } | null | undefined)?.unref?.();
}
