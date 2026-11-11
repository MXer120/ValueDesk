/**
 * What a SoDEX refusal means for an algo or a bot (owner 2026-11-08: bots must "understand" refusals and never stop
 * for one they can handle). SoDEX documents almost no refusal texts (research 2026-11-09: failures carry a negative
 * `code` and an `error` string; a REJECTED order update carries a reason `r`), so the texts are read loosely, from the
 * live ones seen ("position not found: N", "API key error: API key not found", "nonce already used",
 * "error code: 1015"), our own local refusals ("Not sent: ...") and the documented rejection causes.
 *
 *   post-only   the touch moved under a post-only quote: re-price from a fresh book; never counted
 *   position    reduce-only with nothing (or less) to reduce: the bot's close logic reads the position (botRefused)
 *   margin      not enough margin or balance: the side that ADDS waits; the side that reduces goes on; never counted
 *   limit       open-interest or position cap: as margin (limits.ts limitRefusal names it)
 *   rate        IP 429 / Cloudflare 1015 / address quota / account order rate: wait; never counted
 *   local       refused here before sending ("Not sent: ..."): wait; never counted
 *   maintenance SoDEX is in maintenance (its words, an HTTP 503 or "service unavailable" in a refusal): held until it
 *               is back (the executor's maintenance watch); never counted, never a reason for a bot to stop
 *   nonce       a nonce out of order: nothing was executed, the next send is fine; never counted
 *   key         the trading key is missing, expired or not approved: the host's problem check holds the bot
 *   halt        the market halted or delisted: the market check holds (delisting ends through the close)
 *   price       tick, lot, band or minimum: re-read the market and re-price; counted (it should not repeat)
 *   unknown     anything else: counted
 */
export type RefusalKind = 'post-only' | 'position' | 'margin' | 'limit' | 'rate' | 'local' | 'maintenance' | 'nonce' | 'key' | 'halt' | 'price' | 'unknown';

/**
 * SoDEX's maintenance in a refusal's words. Read before 'margin' ("service unavailable" holds "available") and 'halt'
 * ("trading suspended for maintenance" is maintenance). Not a bare 503: a size like 0.503 would match it.
 */
export const MAINTENANCE_TEXT = /maint[ae]n[ae]nce|HTTP 503|service (is )?(temporarily )?unavailable|upgrade in progress|system (is )?(being )?upgrad/i;

const RULES: ReadonlyArray<[RefusalKind, RegExp]> = [
  ['local', /^not sent\b/i],
  ['maintenance', MAINTENANCE_TEXT],
  ['post-only', /post[- _]?only|would (immediately )?(take|cross|match|trade)|immediately (match|execute)|maker only|gtx/i],
  ['position', /reduce[- ]?only|no position|position (is )?(not|does not|doesn't)|position not found|exceeds? (the )?position|position size|position.*(zero|empty|closed)/i],
  ['rate', /\b429\b|1015|rate[- ]?limit|too many|quota|weight|order rate|throttl/i],
  ['nonce', /nonce/i],
  ['key', /api key|signature|agent|unauthori[sz]ed|not approved|expired|forbidden|\b401\b|\b403\b/i],
  ['margin', /margin|insufficient|not enough|balance|equity|available/i],
  ['limit', /open interest|\boi\b|position limit|max(imum)? position|notional cap|risk limit/i],
  ['halt', /halt|not trading|suspend|delist|closed market|market (is )?closed/i],
  ['price', /tick|lot|step size|price band|price limit|limit (up|down)|min(imum)? (qty|quantity|notional|size|order)|precision|invalid price|invalid quantity/i],
];

export function refusalKind(text: string | null | undefined): RefusalKind {
  const t = String(text ?? '');
  for (const [kind, re] of RULES) if (re.test(t)) return kind;
  return 'unknown';
}

/** Whether a refusal of this kind counts toward the "something is wrong" count (only what nothing else handles). */
export const countsAsFailure = (k: RefusalKind): boolean => k === 'unknown' || k === 'price';

/**
 * The words a user sees in a bot's activity for a refusal (owner 2026-11-08: no server details there; the full text
 * stays in the executor's own log and the operator's alerts).
 */
export function refusalWords(k: RefusalKind): string {
  switch (k) {
    case 'post-only': return 'the price moved as it was placed (post-only); placed again at the new price';
    case 'position': return 'nothing left to reduce on SoDEX';
    case 'margin': return 'not enough free margin on SoDEX; new orders wait, closing goes on';
    case 'limit': return 'a SoDEX position or open-interest limit; new orders wait, closing goes on';
    case 'rate': return 'SoDEX asked to slow down; it waits and goes on';
    case 'local': return 'held back here to keep within SoDEX\'s limits; it goes on';
    case 'maintenance': return 'SoDEX is in maintenance; it waits and goes on when SoDEX is back';
    case 'nonce': return 'a request arrived out of order; sent again';
    case 'key': return 'the trading key was not accepted; renew it in setup';
    case 'halt': return 'the market is not trading now';
    case 'price': return 'SoDEX refused the price or size; re-checking the market';
    default: return 'SoDEX refused it; the details are in our server log';
  }
}
