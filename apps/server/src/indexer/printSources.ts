/**
 * The venues' trade sockets as one set the indexer can open before it writes (a handover's standby, handover.ts) and
 * hand to the engine as they are, already subscribed: Lighter needs ~75 s to subscribe its markets, and that is the gap
 * a handover exists to avoid.
 *
 * The engine opens its own sockets as before when it is handed none and no factory is set. The factory is the tests'
 * seam: a fake venue in place of the four real ones, in a real indexer process (handover.test.ts).
 */
import type { Venue } from '../valuedesk/types.js';
import { ARCUS_WS, arcusMarkets } from '../valuedesk/extra/arcus.js';
import { LIGHTER_WS, lighterActiveMarkets } from '../valuedesk/extra/lighter.js';
import { ArcusStream, HlStream, LighterStream, SodexStream, streamLog, type Dedup, type Print } from './streams.js';

/** What the engine needs of a socket set: when each came up, its memory of ids, and stop. */
export interface PrintSource {
  readonly since: number | null;
  readonly dedup: Dedup;
  stop(): void;
}

export interface Sources {
  hyperliquid: HlStream | null;
  sodex: SodexStream | null;
  lighter: LighterStream | null;
  arcus: ArcusStream | null;
}

export type SourceFactory = (emit: (p: Print) => void) => Sources;

let factory: SourceFactory | null = null;

/** Tests: every socket set the indexer opens from now on comes from here. */
export function setSourceFactory(f: SourceFactory | null): void {
  factory = f;
}

export function sourceFactory(): SourceFactory | null {
  return factory;
}

/** The venues of a set that have a socket. */
export function sourceVenues(s: Sources): Venue[] {
  return (Object.keys(s) as Array<keyof Sources>).filter((v) => s[v] !== null);
}

export function sourceOf(s: Sources, v: Venue): PrintSource | null {
  return (s as unknown as Record<string, PrintSource | null>)[v] ?? null;
}

export function stopSources(s: Sources): void {
  for (const v of sourceVenues(s)) try { sourceOf(s, v)?.stop(); } catch { /* stopped */ }
}

/**
 * The four real sockets (or the factory's), started, delivering to `emit`. `gradualHl`: Hyperliquid subscribes only the
 * markets taken (HlStream.take: a standby beside a running indexer, streams.ts HL_SUBSCRIPTION_LIMIT). Lighter is set
 * only once its market list is read and its sockets started; a list that fails is tried again every minute, until
 * `stopped()` says the set is no longer wanted (one that comes through after that is stopped, not adopted).
 */
export function openSources(emit: (p: Print) => void, stopped: () => boolean = () => false, o: { gradualHl?: boolean } = {}): Sources {
  if (factory) return factory(emit);
  const s: Sources = {
    hyperliquid: new HlStream(emit, undefined, { gradual: o.gradualHl }),
    sodex: new SodexStream(emit),
    lighter: null,
    arcus: new ArcusStream(emit, () => arcusMarkets(), ARCUS_WS),
  };
  s.hyperliquid!.start();
  s.sodex!.start();
  s.arcus!.start();
  const lighter = () => {
    if (stopped()) return;
    const l = new LighterStream(emit, () => lighterActiveMarkets(), LIGHTER_WS);
    void l.start().then(() => {
      if (stopped()) l.stop();
      else s.lighter = l;
    }, (e) => {
      streamLog(`standby: lighter market list not read (${String(e)}), again in a minute`);
      const t = setTimeout(lighter, 60_000);
      t.unref?.();
    });
  };
  lighter();
  return s;
}
