/**
 * The one Hyperliquid /info client of this runtime.
 *
 * On the server that is the process-wide budget every provider, the indexer
 * and the positioning sweep share (re-exported by ./index.ts). In the browser
 * (the web imports the account reads through `@sign/*`), the same module gives
 * each user their own client with the same budget, spent from their own IP.
 * Kept apart from ./index.ts so importing it never pulls in the whale feed's
 * WebSocket or the 39 MB leaderboard store.
 */
import { HL_INFO_URL, HL_WEIGHT_PER_MIN, HlInfoClient } from './info.js';

let transport: typeof fetch = (...a) => fetch(...a);

/**
 * Route this runtime's /info requests through another fetch. The browser uses
 * it to count every tab's requests against one per-IP budget; the server never
 * calls it (plain fetch).
 */
export function setHlTransport(fn: typeof fetch): void {
  transport = fn;
}

export const hlInfo = new HlInfoClient(HL_INFO_URL, HL_WEIGHT_PER_MIN, (...a) => transport(...a));
