/**
 * How many algos are live in this browser, for labels that must not pull in
 * the runner (the account tabs are in the first chunk; the runner signs
 * orders and loads after the page). browserAlgos.ts writes it.
 */
import { useSyncExternalStore } from 'react';
import type { Eip1193Provider } from '../wallet';

/** The connected wallet's provider (App hands it to AlgoRunner): what signs an instruction to an executor. */
let provider: Eip1193Provider | null = null;
export const setAlgoProvider = (p: Eip1193Provider | null): void => {
  provider = p;
};
export const algoProvider = (): Eip1193Provider | null => provider;

let live = 0;
let runnerLoaded = false;
const listeners = new Set<() => void>();

/** browserAlgos.ts is loaded (by the runner, the ticket or the Algos tab): from now on it follows every wallet change. */
export const noteRunnerLoaded = (): void => {
  runnerLoaded = true;
};
export const isRunnerLoaded = (): boolean => runnerLoaded;

export function setLiveAlgos(n: number): void {
  if (n === live) return;
  live = n;
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const useLiveAlgos = (): number => useSyncExternalStore(subscribe, () => live, () => 0);
