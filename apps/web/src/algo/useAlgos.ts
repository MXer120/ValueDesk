import { useEffect, useSyncExternalStore } from 'react';
import { browserAlgos } from './browserAlgos';

/** This browser's algos for `address` (the runner follows the wallet; this only reads). */
export function useAlgos(address: string | null) {
  useEffect(() => {
    void browserAlgos.follow(address);
  }, [address]);
  return useSyncExternalStore(browserAlgos.subscribe, browserAlgos.getSnapshot, browserAlgos.getSnapshot);
}
