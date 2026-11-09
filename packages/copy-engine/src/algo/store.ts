/**
 * Where an algo runner keeps its algos and their logs: SQLite in the
 * executors, IndexedDB in the browser, memory in tests and paper runs.
 */
import { structuredCopy } from '../store.ts';
import type { AlgoEvent, AlgoRecord } from './types.ts';

export interface AlgoStore {
  algos(): Promise<AlgoRecord[]>;
  saveAlgo(a: AlgoRecord): Promise<void>;
  addAlgoEvent(e: AlgoEvent): Promise<void>;
  /** Newest first. */
  /** `after`: only lines newer than this (ms), for a live tail that reads nothing when nothing happened. */
  algoEvents(q: { algoId?: string; owner?: string; limit?: number; before?: number; after?: number }): Promise<AlgoEvent[]>;
}

export class MemoryAlgoStore implements AlgoStore {
  private rows = new Map<string, AlgoRecord>();
  private log: AlgoEvent[] = [];
  constructor(private readonly maxEvents = 20_000) {}

  async algos(): Promise<AlgoRecord[]> {
    return [...this.rows.values()].map((a) => structuredCopy(a));
  }

  async saveAlgo(a: AlgoRecord): Promise<void> {
    this.rows.set(a.id, structuredCopy(a));
  }

  async addAlgoEvent(e: AlgoEvent): Promise<void> {
    this.log.push(e);
    if (this.log.length > this.maxEvents) this.log.splice(0, this.log.length - this.maxEvents);
  }

  async algoEvents(q: { algoId?: string; owner?: string; limit?: number; before?: number; after?: number }): Promise<AlgoEvent[]> {
    const out: AlgoEvent[] = [];
    for (let i = this.log.length - 1; i >= 0 && out.length < (q.limit ?? 200); i--) {
      const e = this.log[i]!;
      if (q.algoId && e.algoId !== q.algoId) continue;
      if (q.owner && e.owner !== q.owner) continue;
      if (q.before !== undefined && e.at >= q.before) continue;
      if (q.after !== undefined && e.at <= q.after) continue;
      out.push(e);
    }
    return out;
  }
}
