/**
 * Web Worker entry for the copy simulation (bundled by Vite as an ES module
 * worker, see index.ts). Stateless: one request in, one response out.
 * Imports only the pure engine, so the worker chunk stays small.
 */
import { runCopySimulation } from './engine';
import { packResult, type SimRequest, type SimResponse } from './protocol';

interface WorkerScope {
  onmessage: ((e: { data: SimRequest }) => void) | null;
  postMessage(msg: SimResponse): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (e) => {
  const { id, fills, config, opts } = e.data;
  let msg: SimResponse;
  try {
    msg = { id, ok: true, result: packResult(runCopySimulation(fills, config, opts), fills) };
  } catch (err) {
    msg = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  scope.postMessage(msg);
};
