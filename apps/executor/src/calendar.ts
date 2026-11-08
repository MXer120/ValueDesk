/**
 * The economic calendar for a bot's news gate (MmSpec.news): the API server's GET /api/vs/calendar (the Fed, BLS,
 * BEA and SoSoValue's US releases), read a day back to a week ahead every 30 minutes, kept in memory. The engine
 * reads `events()` every tick; null until the first answer (the gate then stays open, and says so).
 */
import type { FetchLike, NewsEvent } from '../../../packages/copy-engine/src/index.ts';

const EVERY_MS = 30 * 60_000;
const RETRY_MS = 60_000;

export class CalendarFeed {
  private list: NewsEvent[] | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: { url: string; fetch: FetchLike; log?: { warn(msg: string, data?: Record<string, unknown>): void } }) {}

  start(): void {
    if (this.timer) return;
    void this.read();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  events(): readonly NewsEvent[] | null {
    return this.list;
  }

  private async read(): Promise<void> {
    let next = EVERY_MS;
    try {
      const now = Date.now();
      const u = new URL(this.opts.url);
      u.searchParams.set('from', String(now - 86_400_000));
      u.searchParams.set('to', String(now + 7 * 86_400_000));
      const res = await this.opts.fetch(u.toString(), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`calendar answered ${res.status}`);
      const body = JSON.parse(await res.text()) as { data?: { events?: unknown[] }; events?: unknown[] };
      const raw = body.data?.events ?? body.events ?? [];
      this.list = raw.flatMap((x) => {
        const e = x as { time?: unknown; short?: unknown; importance?: unknown; allDay?: unknown };
        if (typeof e.time !== 'number' || typeof e.short !== 'string') return [];
        const importance = e.importance === 'high' || e.importance === 'medium' ? e.importance : 'low';
        return [{ time: e.time, short: e.short, importance, allDay: e.allDay === true }];
      });
    } catch (err) {
      next = RETRY_MS;
      this.opts.log?.warn('calendar read failed; the news gate keeps the last list', { err: err instanceof Error ? err.message : String(err) });
    }
    this.timer = setTimeout(() => void this.read(), next);
    this.timer.unref?.();
  }
}
