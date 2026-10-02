/**
 * What this page knows about a wallet's account since it started listening.
 *
 * A history table kept from an earlier look (exchange/historyTables.ts) is only
 * as good as the moment SoDEX was asked for it: an order or a fill that came
 * after is not in it. SoDEX allows two history reads a minute, so a table is
 * not read again just because it is shown again - but then it has to be
 * CERTAIN that nothing changed. This is where that is known: per wallet,
 * engine and account channel, since when this page has heard the stream
 * without a break, and when it last heard anything.
 *
 * `quietSince(t)` is true only when the page listened the whole time since `t`
 * and heard nothing. Anything less - not listening, a dropped connection, a
 * push - and the table catches up with one read (it is shown meanwhile).
 *
 * Fed by ws.ts from the subscriptions the page already holds (fill
 * notifications, the account band's live data): nothing subscribes for this.
 *
 * A reload: what was known when the page went away is kept (localStorage) and
 * taken over when the next page listens again within TAKEOVER_MS. Nothing can
 * be heard in between - that gap is the one thing this cannot see, which is
 * why TAKEOVER_MS is short.
 */
import { network } from './hosts';
import type { KeyValueStore } from './ledger';

export type AccountEngine = 'spot' | 'perps';

/** A page that listens again this soon after another went away takes over what that one knew. */
export const TAKEOVER_MS = 8_000;
/** Listening counts from this long after it was asked for: the subscription has to reach SoDEX first. */
export const SETTLE_MS = 2_000;
/** A push heard up to this long before a read was sent may not be in its answer yet. */
export const LAG_MS = 1_000;

const KEPT_KEY = 'vs:account-activity';
const KEPT_MAX = 48;
const KEPT_FOR_MS = 60_000;

interface Entry {
  /** Listening without a break since (ms). */
  since: number;
  /** The last push, or interruption (ms; 0 = none). */
  heard: number;
}

interface Kept extends Entry {
  /** When the page that knew this went away. */
  alive: number;
  scope: string;
}

function browserStore(): KeyValueStore | null {
  try {
    return (globalThis as { localStorage?: KeyValueStore }).localStorage ?? null;
  } catch {
    return null;
  }
}

const keyOf = (engine: AccountEngine, user: string, channel: string): string => `${engine}:${user.toLowerCase()}:${channel}`;

export class AccountActivity {
  private readonly live = new Map<string, Entry>();
  /** What this page has listened to before: only its FIRST listen can take over from the page before it. */
  private readonly begun = new Set<string>();
  /** When a push last arrived on each (a push, not an interruption): whether the stream is speaking. */
  private readonly pushedAt = new Map<string, number>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly store: KeyValueStore | null = browserStore(),
    /** What a kept record must match to be taken over (the network: a testnet page knows nothing about mainnet). */
    private readonly scope: () => string = () => '',
  ) {}

  private kept(): Record<string, Kept> {
    try {
      const raw = this.store?.getItem(KEPT_KEY);
      const v = raw ? (JSON.parse(raw) as unknown) : null;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Kept>) : {};
    } catch {
      return {};
    }
  }

  /** The page asked for this wallet's `channel` on an open link (again, after any break). */
  listening(engine: AccountEngine, user: string, channel: string): void {
    const k = keyOf(engine, user, channel);
    if (this.live.has(k)) return;
    const now = this.now();
    // After a break in THIS page (unsubscribed, link down) nothing is taken over: the break is unknown.
    const was = this.begun.has(k) ? undefined : this.kept()[k];
    this.begun.add(k);
    const takeover =
      !!was && was.scope === this.scope() && Number.isFinite(was.alive) && was.alive <= now && now - was.alive <= TAKEOVER_MS &&
      Number.isFinite(was.since) && Number.isFinite(was.heard);
    this.live.set(k, takeover ? { since: was.since, heard: was.heard } : { since: now, heard: 0 });
  }

  /** It stopped listening (unsubscribed, or the stream cannot be had): from here nothing is known. `user` null: every wallet. */
  stopped(engine: AccountEngine, user: string | null, channel: string): void {
    const gone = user ? [keyOf(engine, user, channel)] : [...this.live.keys()].filter((k) => k.startsWith(`${engine}:`) && k.endsWith(`:${channel}`));
    for (const k of gone) {
      this.live.delete(k);
      this.pushedAt.delete(k);
    }
  }

  /** The link to the socket host is down: nothing is heard at all. */
  stoppedAll(): void {
    this.live.clear();
    this.pushedAt.clear();
  }

  /** A push arrived on the wallet's `channel`. */
  heard(engine: AccountEngine, user: string, channel: string): void {
    const k = keyOf(engine, user, channel);
    const e = this.live.get(k);
    if (!e) return;
    e.heard = this.now();
    this.pushedAt.set(k, e.heard);
  }

  /** The page is listening to at least one account channel of this wallet: its stream can speak. */
  isListening(engine: AccountEngine, user: string): boolean {
    const prefix = `${engine}:${user.toLowerCase()}:`;
    for (const k of this.live.keys()) if (k.startsWith(prefix)) return true;
    return false;
  }

  /** The wallet's stream has spoken: a push arrived on one of its account channels at or after `t` (ms). */
  pushedSince(engine: AccountEngine, user: string, t: number): boolean {
    const prefix = `${engine}:${user.toLowerCase()}:`;
    for (const [k, at] of this.pushedAt) if (at >= t && k.startsWith(prefix)) return true;
    return false;
  }

  /** The stream was interrupted (a dropped connection, or back after one): pushes may be missing. No `user`: every wallet of the engine. */
  interrupted(engine: AccountEngine, user?: string): void {
    const prefix = user ? `${engine}:${user.toLowerCase()}:` : `${engine}:`;
    const now = this.now();
    for (const [k, e] of this.live) if (k.startsWith(prefix)) e.heard = now;
  }

  /**
   * Nothing can have changed since a read sent at `t` (ms): the page has been
   * listening to every one of `channels` since before it, and heard nothing.
   */
  quietSince(engine: AccountEngine, user: string, channels: readonly string[], t: number): boolean {
    if (!(t > 0)) return false;
    for (const channel of channels) {
      const e = this.live.get(keyOf(engine, user, channel));
      if (!e || e.since + SETTLE_MS > t || e.heard + LAG_MS >= t) return false;
    }
    return true;
  }

  /** The page is going away: keep what it knows for the page that follows (a reload). */
  keep(): void {
    if (!this.store || this.live.size === 0) return;
    const now = this.now();
    const scope = this.scope();
    const all = this.kept();
    for (const [k, v] of Object.entries(all)) if (!(now - v.alive <= KEPT_FOR_MS)) delete all[k];
    for (const [k, e] of this.live) all[k] = { since: e.since, heard: e.heard, alive: now, scope };
    const keys = Object.keys(all).sort((a, b) => all[a]!.alive - all[b]!.alive);
    for (const k of keys.slice(0, Math.max(0, keys.length - KEPT_MAX))) delete all[k];
    try {
      this.store.setItem(KEPT_KEY, JSON.stringify(all));
    } catch {
      /* the next page simply reads once more */
    }
  }
}

/** This page's. */
export const accountActivity = new AccountActivity(undefined, undefined, () => network());
