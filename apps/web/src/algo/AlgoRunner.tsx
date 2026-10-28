/**
 * Mounted once in App.tsx, on every page: keeps this browser's algo runner
 * following the connected wallet, so algos run whichever page is open.
 *
 * The runner signs orders, so it is only loaded where there is something to
 * run: this wallet has a live algo in this browser's books, or the runner was
 * loaded already (an algo was started, or the Algos tab opened).
 */
import { useEffect } from 'react';
import type { Eip1193Provider } from '../wallet';
import { algoOwner, isRunnerLoaded, needsRunner, setAlgoProvider } from './algoBus';
import { openAlgoStore } from './algoStore';

const runner = async () => (await import('./browserAlgos')).browserAlgos;

export default function AlgoRunner({ address, provider }: { address: string | null; provider: Eip1193Provider | null }) {
  useEffect(() => setAlgoProvider(provider), [provider]);
  useEffect(() => {
    let gone = false;
    void (async () => {
      // No wallet: the paper book (paper algos started without one).
      const owner = algoOwner(address);
      if (!isRunnerLoaded()) {
        const live = (await (await openAlgoStore()).algos()).some((a) => a.owner === owner && needsRunner(a));
        if (gone || !live) return;
      }
      if (!gone) await (await runner()).follow(owner);
    })();
    return () => {
      gone = true;
    };
  }, [address]);
  // Algos on an executor run while no tab does: their limit notices (a hold or a cut at SoDEX's position limit or
  // open-interest cap) reach the bell from the executor's list, read while the page is visible (limitNotices.ts).
  useEffect(() => {
    if (!address) return;
    let gone = false;
    const check = async () => {
      if (gone || document.visibilityState !== 'visible') return;
      const [{ listOn }, { noteLimitNotices }] = await Promise.all([import('./executorAlgos'), import('./limitNotices')]);
      for (const mode of ['hosted', 'self'] as const) {
        const views = await listOn(mode).catch(() => []);
        if (!gone) noteLimitNotices(views, mode === 'hosted' ? 'on the ValueDesk executor' : 'on your copier');
      }
    };
    void check();
    const t = window.setInterval(() => void check(), EXECUTOR_NOTICE_MS);
    return () => {
      gone = true;
      window.clearInterval(t);
    };
  }, [address]);
  return null;
}

/** How often the executors' algo lists are read for limit notices (only an executor the wallet is signed in to answers). */
const EXECUTOR_NOTICE_MS = 30_000;
