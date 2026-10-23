/**
 * Mounted once in App.tsx, on every page: keeps this browser's algo runner
 * following the connected wallet, so algos run whichever page is open.
 *
 * The runner signs orders, so it is only loaded where there is something to
 * run: this wallet has a live algo in this browser's books, or the runner was
 * loaded already (an algo was started, or the Algos tab opened).
 */
import { useEffect } from 'react';
import { FINAL_STATUSES } from '@copy-engine';
import type { Eip1193Provider } from '../wallet';
import { isRunnerLoaded, setAlgoProvider } from './algoBus';
import { openAlgoStore } from './algoStore';

const runner = async () => (await import('./browserAlgos')).browserAlgos;

export default function AlgoRunner({ address, provider }: { address: string | null; provider: Eip1193Provider | null }) {
  useEffect(() => setAlgoProvider(provider), [provider]);
  useEffect(() => {
    let gone = false;
    void (async () => {
      const owner = address?.toLowerCase() ?? null;
      if (!owner) {
        if (isRunnerLoaded()) await (await runner()).follow(null);
        return;
      }
      if (!isRunnerLoaded()) {
        const live = (await (await openAlgoStore()).algos()).some((a) => a.owner === owner && !FINAL_STATUSES.has(a.status));
        if (gone || !live) return;
      }
      if (!gone) await (await runner()).follow(owner);
    })();
    return () => {
      gone = true;
    };
  }, [address]);
  return null;
}
