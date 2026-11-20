/**
 * Send a signed key registration to every engine it was prepared for (one wallet signature, one request per
 * engine) and decide the outcome. Kept apart from sodexSetup.ts so it can be tested without a wallet or network.
 *
 * Why (2026-11-20): only the first request was sent; once spot joined the engines that was spot alone, so no key
 * reached perps and the executor waited for it forever ("Approve the trading key" hung for every user).
 *
 * Perps carries copies, algos and futures bots, so a perps refusal throws. A spot refusal is returned in `failed`:
 * the key still works on futures and a spot bot asks to renew the key.
 */
export type KeyEngine = 'perps' | 'spot';

export const KEY_NOT_CONFIRMED = 'SoDEX did not confirm the copy key. Check your connection and approve again.';

/** SoDEX's documented limit: API keys per account and engine, besides the wallet's own `default`. */
export const SODEX_KEY_LIMIT = 5;

/** The futures key list is full: `message` says which keys and what to do; `expired` is one the setup may remove itself. */
export class KeyLimitError extends Error {
  constructor(message: string, readonly expired: string | null) {
    super(message);
    this.name = 'KeyLimitError';
  }
}

/**
 * When a futures registration was refused and the account's futures key list is full: what the trader reads (which
 * keys there are, expired ones first, and how to make room) and an expired key the setup can remove for them (an
 * expired key trades for nobody; a live one may be sodex.com's own login or another app, so only the trader removes
 * those). Null when the list has room (another reason). A key under `name` itself does not count: it is replaced.
 */
export function keyLimit(rows: ReadonlyArray<{ name: string; expiresAt?: number | null }>, name: string, reason: string, now = Date.now()): { text: string; expired: string | null } | null {
  const others = rows.filter((r) => r.name !== 'default' && r.name !== name);
  if (others.length < SODEX_KEY_LIMIT) return null;
  const isOld = (r: { expiresAt?: number | null }) => !!r.expiresAt && r.expiresAt <= now;
  const list = [...others].sort((a, b) => Number(isOld(b)) - Number(isOld(a)))
    .map((r) => `${r.name}${isOld(r) ? ' (expired)' : ''}`).join(', ');
  const expired = others.find(isOld)?.name ?? null;
  const how = expired
    ? `Remove the expired key ${expired} with the button below (two wallet signatures), or any key you no longer use on sodex.com > API keys`
    : 'Remove a key you no longer use on sodex.com > API keys';
  return {
    text: `Your SoDEX account already holds ${others.length} API keys on futures, the most SoDEX allows: ${list}. ${how}, then approve the trading key again. (SoDEX said: ${reason})`,
    expired,
  };
}

export async function sendKeyRegistration<R extends { engine: KeyEngine }>(
  requests: readonly R[],
  send: (r: R) => Promise<unknown>,
  /** True for "no answer" (the request may have landed). */
  isUnknown: (e: unknown) => boolean,
  /** Ask SoDEX whether the key is listed on this engine now. */
  landed: (engine: KeyEngine) => Promise<boolean>,
): Promise<{ sent: KeyEngine[]; failed: KeyEngine[] }> {
  if (!requests.some((r) => r.engine === 'perps')) throw new Error('A trading key must be registered on futures (perps).');
  const settled = await Promise.allSettled(requests.map((r) => send(r)));
  const failed: KeyEngine[] = [];
  for (let i = 0; i < requests.length; i++) {
    const engine = requests[i]!.engine;
    const r = settled[i]!;
    if (r.status === 'fulfilled') continue;
    if (!isUnknown(r.reason)) {
      if (engine === 'perps') throw r.reason;
      failed.push(engine);
      continue;
    }
    // No answer is not a no: ask SoDEX whether it landed.
    const ok = await landed(engine).catch(() => false);
    if (ok) continue;
    if (engine === 'perps') throw new Error(KEY_NOT_CONFIRMED);
    failed.push(engine);
  }
  return { sent: requests.map((r) => r.engine).filter((e) => !failed.includes(e)), failed };
}
