import { useEffect, useSyncExternalStore } from 'react';
import { algoOwner } from './algoBus';
import { browserAlgos } from './browserAlgos';

/** This browser's algos for `address` - or its paper book with no wallet (the runner follows the wallet; this only reads). */
export function useAlgos(address: string | null) {
  useEffect(() => {
    void browserAlgos.follow(algoOwner(address));
  }, [address]);
  return useSyncExternalStore(browserAlgos.subscribe, browserAlgos.getSnapshot, browserAlgos.getSnapshot);
}
