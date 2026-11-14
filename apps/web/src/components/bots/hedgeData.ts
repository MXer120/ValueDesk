/**
 * What the hedge pages read from SoDEX directly (public reads, no sign-in): the coin a wallet holds in its futures
 * balance (the spot hedge's other leg) and whether a wallet has a SoDEX account yet (a new second wallet).
 */
import { useEffect, useState } from 'react';
import { readGateway } from '../../trading/gateway';
import { sodexAccountId } from '../../trading/session';

const COIN_MS = 15_000;

/** The coin `base` in `wallet`'s futures balance (perps state B[].wb), null while unknown; read every 15 s. */
export function useFuturesCoin(wallet: string | null, base: string): number | null {
  const [v, setV] = useState<number | null>(null);
  useEffect(() => {
    setV(null);
    if (!wallet) return;
    let dead = false;
    const read = async () => {
      try {
        const st = await readGateway<{ B?: Array<{ a: string; wb: string }> } | null>(`/api/v1/perps/accounts/${wallet.toLowerCase()}/state`);
        const row = (st?.B ?? []).find((b) => String(b.a).toUpperCase() === base.toUpperCase());
        if (!dead) setV(Number(row?.wb) || 0);
      } catch {
        /* asked again on the next round */
      }
    };
    void read();
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void read(); }, COIN_MS);
    return () => { dead = true; window.clearInterval(t); };
  }, [wallet, base]);
  return v;
}

/** Whether `wallet` has a SoDEX account (true / false), null while unknown or unreadable. */
export function useHasSodexAccount(wallet: string | null): boolean | null {
  const [v, setV] = useState<boolean | null>(null);
  useEffect(() => {
    setV(null);
    if (!wallet) return;
    let dead = false;
    sodexAccountId(wallet.toLowerCase()).then((id) => { if (!dead) setV(id > 0); }, () => { if (!dead) setV(null); });
    return () => { dead = true; };
  }, [wallet]);
  return v;
}
