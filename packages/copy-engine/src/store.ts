/**
 * Where a copier keeps its subscriptions, their runtime state and their
 * activity. The hosted and self-hosted executors use SQLite
 * (apps/executor/src/store.ts), the browser copier IndexedDB; tests and paper
 * runs use the memory store here.
 */
import type { ActivityEntry, SubState, Subscription } from './types.ts';

export interface CopyStore {
  subscriptions(): Promise<Subscription[]>;
  subscription(id: string): Promise<Subscription | null>;
  saveSubscription(s: Subscription): Promise<void>;
  state(subId: string): Promise<SubState | null>;
  saveState(s: SubState): Promise<void>;
  addActivity(e: ActivityEntry): Promise<void>;
  /** Newest first. */
  activity(q: { subId?: string; owner?: string; limit?: number; before?: number }): Promise<ActivityEntry[]>;
}

export class MemoryStore implements CopyStore {
  private subs = new Map<string, Subscription>();
  private states = new Map<string, SubState>();
  private log: ActivityEntry[] = [];
  constructor(private readonly maxActivity = 20_000) {}

  async subscriptions(): Promise<Subscription[]> {
    return [...this.subs.values()].map((s) => structuredCopy(s));
  }

  async subscription(id: string): Promise<Subscription | null> {
    const s = this.subs.get(id);
    return s ? structuredCopy(s) : null;
  }

  async saveSubscription(s: Subscription): Promise<void> {
    this.subs.set(s.id, structuredCopy(s));
  }

  async state(subId: string): Promise<SubState | null> {
    const s = this.states.get(subId);
    return s ? structuredCopy(s) : null;
  }

  async saveState(s: SubState): Promise<void> {
    this.states.set(s.subId, structuredCopy(s));
  }

  async addActivity(e: ActivityEntry): Promise<void> {
    this.log.push(e);
    if (this.log.length > this.maxActivity) this.log.splice(0, this.log.length - this.maxActivity);
  }

  async activity(q: { subId?: string; owner?: string; limit?: number; before?: number }): Promise<ActivityEntry[]> {
    const out: ActivityEntry[] = [];
    for (let i = this.log.length - 1; i >= 0 && out.length < (q.limit ?? 200); i--) {
      const e = this.log[i]!;
      if (q.subId && e.subId !== q.subId) continue;
      if (q.owner && e.owner !== q.owner) continue;
      if (q.before !== undefined && e.at >= q.before) continue;
      out.push(e);
    }
    return out;
  }
}

/** JSON round trip: the stores hand out copies, never their own objects. */
export const structuredCopy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
