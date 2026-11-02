/**
 * The wallet's bots on the ValueDesk executor (hosted, 24/7): its algos whose spec is a bot (spec.bot), read
 * every 5 s while the page is shown, and one bot's log on demand. Starting, stopping and changing one is one
 * wallet signature each (algo/executorAlgos.ts); the executor's answer replaces the row at once.
 *
 * Bots run on the hosted executor only: a bot quotes around the clock, and a browser tab is not.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FINAL_STATUSES, type AlgoEvent, type AlgoUpdatePatch, type AlgoView } from '@copy-engine';
import { actOn, eventsOn, listOn, startOn, updateOn } from '../algo/executorAlgos';
import { pollEvery } from '../exchange/visibility';
import { newSeed } from '@copy-engine';

export const BOTS_POLL_MS = 5_000;

export interface BotsState {
  bots: AlgoView[];
  /** The first read is still out. */
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  start: (spec: Record<string, unknown>) => Promise<AlgoView>;
  act: (op: 'pause' | 'resume' | 'cancel' | 'archive', id: string) => Promise<void>;
  stopAll: () => Promise<void>;
  update: (id: string, patch: AlgoUpdatePatch) => Promise<void>;
}

/** Running first (newest first), then ended (newest first). */
export function sortBots(list: AlgoView[]): AlgoView[] {
  return [...list].sort((a, b) => Number(FINAL_STATUSES.has(a.algo.status)) - Number(FINAL_STATUSES.has(b.algo.status)) || b.algo.createdAt - a.algo.createdAt);
}

export function useBots(owner: string | null, signedIn: boolean): BotsState {
  const [bots, setBots] = useState<AlgoView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!owner || !signedIn) {
      setBots([]);
      setLoading(false);
      return;
    }
    try {
      const list = await listOn('hosted');
      if (!alive.current) return;
      setBots(sortBots(list.filter((v) => v.algo.spec.bot === true)));
      setError(null);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [owner, signedIn]);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    void refresh();
    const stop = pollEvery(BOTS_POLL_MS, () => void refresh());
    return () => {
      alive.current = false;
      stop();
    };
  }, [refresh]);

  /** The executor's answer for these bots, in place. */
  const merge = useCallback((views: AlgoView[]) => {
    setBots((cur) => {
      const byId = new Map(cur.map((v) => [v.algo.id, v]));
      for (const v of views) byId.set(v.algo.id, v);
      return sortBots([...byId.values()].filter((v) => !v.algo.k.archived));
    });
  }, []);

  const start = useCallback(async (spec: Record<string, unknown>) => {
    const v = await startOn('hosted', spec, newSeed());
    merge([v]);
    return v;
  }, [merge]);
  const act = useCallback(async (op: 'pause' | 'resume' | 'cancel' | 'archive', id: string) => merge(await actOn('hosted', op, id)), [merge]);
  const stopAll = useCallback(async () => merge(await actOn('hosted', 'cancel-all')), [merge]);
  const update = useCallback(async (id: string, patch: AlgoUpdatePatch) => merge(await updateOn('hosted', id, patch)), [merge]);

  return { bots, loading, error, refresh, start, act, stopAll, update };
}

/** One bot's log, newest first, read while `open` (every 10 s). */
export function useBotEvents(id: string | null, open: boolean): { events: AlgoEvent[] | null; error: string | null } {
  const [events, setEvents] = useState<AlgoEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id || !open) return;
    let live = true;
    setEvents(null);
    const read = () =>
      eventsOn('hosted', id, 300)
        .then((e) => {
          if (!live) return;
          setEvents([...e].sort((a, b) => b.at - a.at));
          setError(null);
        })
        .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    void read();
    const stop = pollEvery(10_000, () => void read());
    return () => {
      live = false;
      stop();
    };
  }, [id, open]);
  return { events, error };
}
