/**
 * Real algo orders are switched off for now: only practice runs start, in this browser or on an
 * executor. The ticket says so, and the browser runner and the executor client refuse one anyway.
 *
 * THE LIVE TEST'S WALLETS, ON A DEV SERVER ONLY. `VITE_LIVE_ALGOS_WALLETS` (comma-separated
 * addresses, in apps/web/.env.local) lets those wallets start real algos, so the live test
 * suite's browser target (apps/executor/tools/live-test, `--target browser`) can run them in a
 * tab with its follower wallet. A build Vite makes for a deployment (`import.meta.env.DEV` false)
 * reads none of it, whatever the variable says, and deploy/release/build-web.sh exports it empty:
 * no wallet of a deployed site starts a real algo until LIVE_ALGOS is on for everyone.
 */
export const LIVE_ALGOS = false;

export const LIVE_ALGOS_OFF = 'Real algo orders are off for now. Turn on Practice run to try one against the live market.';

/** The wallets a dev server lets run real algos: the variable's addresses, lower-case; anything else in it is ignored. None outside dev. */
export function liveAlgoWalletsFrom(raw: unknown, dev: boolean): ReadonlySet<string> {
  if (!dev || typeof raw !== 'string') return new Set();
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => /^0x[0-9a-f]{40}$/.test(s)));
}

const env = (import.meta as { env?: { DEV?: boolean; VITE_LIVE_ALGOS_WALLETS?: string } }).env;

/** This build's test wallets (empty but on a dev server with the variable set). */
export const LIVE_ALGOS_WALLETS: ReadonlySet<string> = liveAlgoWalletsFrom(env?.VITE_LIVE_ALGOS_WALLETS, env?.DEV === true);

/** Whether `owner` may start real algos here: everyone once LIVE_ALGOS is on; until then a dev server's test wallets only. */
export function liveAlgosFor(owner: string | null | undefined, wallets: ReadonlySet<string> = LIVE_ALGOS_WALLETS): boolean {
  if (LIVE_ALGOS) return true;
  return !!owner && wallets.has(owner.toLowerCase());
}

/** Throws unless the spec is a practice run, or real algos are on for `owner` (the wallet that starts it). */
export function requirePaperAlgo(spec: unknown, owner?: string | null, wallets: ReadonlySet<string> = LIVE_ALGOS_WALLETS): void {
  if (liveAlgosFor(owner, wallets)) return;
  if (!(typeof spec === 'object' && spec !== null && (spec as { paper?: unknown }).paper === true)) throw new Error(LIVE_ALGOS_OFF);
}
