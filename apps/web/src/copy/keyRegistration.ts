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
