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
 * `timer.unref()` on Node, nothing in a browser (where timers are numbers).
 * Lets a background timer never hold a Node process open, without a
 * Node-only type in code the browser also runs.
 */
export function unrefTimer(t: unknown): void {
  (t as { unref?: () => void } | null | undefined)?.unref?.();
}
