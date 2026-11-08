/**
 * The accounts active in a window (store.activeAccounts) read on the index reader's 'scan' thread, not the indexer's.
 *
 * A window's sum over every account is a GROUP BY over its activity rows: for trade.xyz's all-time board and the
 * 30-day cohort members that was 33-74 s on the indexer's only thread (profiles 2026-11-08 19:02-19:04), every stream
 * cut and no board built meanwhile. A read that fails (the thread restarted, READ_MS passed) answers with the last
 * good list of the same venue and kind; with none yet, it is read here as before.
 */
import { liqRead } from './liqReadThread.js';
import type { IndexStore } from './store.js';
import type { Venue } from '../valuedesk/types.js';

type Active = Array<{ acct: string; trades: number; volume: number }>;
const kept = new Map<string, Active>();

export async function activeAccountsAsync(
  store: IndexStore,
  venue: Venue,
  from: { hour: number } | { day: number },
  minTrades: number,
  limit: number,
): Promise<Active> {
  const key = `${venue}|${'hour' in from ? 'h' : 'd'}|${minTrades}|${limit}`;
  try {
    const r = await liqRead({ op: 'activeAccounts', venue, from, minTrades, limit }, () => store);
    if (r) {
      kept.set(key, r);
      return r;
    }
  } catch {
    const k = kept.get(key);
    if (k) return k;
  }
  return store.activeAccounts(venue, from, minTrades, limit);
}
