/**
 * SoDEX's maintenance, as the executor sees it (owner 2026-11-11: SoDEX went into maintenance and its gateway
 * answered HTTP 503 on every route). While it lasts every copy, algo and bot here is HELD - nothing is sent into the
 * 503s, nothing counts as a refusal, nothing stops or closes because of it - and goes on by itself once SoDEX is back
 * (copy-engine runtime.ts / algo/runtime.ts `venue`).
 *
 * TWO SIGNALS:
 *   flag     SoDEX's own maintenance status, GET alpha-biz.sodex.dev/biz/v1/maintenance/status, read every EVERY_MS:
 *            {"code":0,"data":{"status":"NORMAL"|"ALL_MAINTENANCE"|"CHAIN_MAINTENANCE",
 *            "maintenanceDuration":<hours>,"updateTime":<unix s>}}. ENTER_AFTER readings in a row that are not NORMAL
 *            start a maintenance, LEAVE_AFTER NORMAL readings end it. A read that fails (timeout, HTTP error, a body
 *            that is not that shape) is no information: it neither counts nor resets a run, and the state stays.
 *   gateway  the gateway itself (SodexClient.reach): no answer below 500 for GATEWAY_AFTER_MS with the last one an
 *            HTTP 503 counts as a maintenance too, but only while the flag's last reading was not NORMAL or the
 *            flag could not be read. Conservative on purpose: a 503 alone can also be a SoDEX outage or trouble on
 *            the way there, and holding is not free (a copy's opens older than 5 min are not caught up after a hold).
 *            When SoDEX itself says NORMAL, a 503 stays what it was before (the unreachable alert, outcomes looked
 *            up). It ends when the gateway answers again (probed every EVERY_MS meanwhile) or the flag reads NORMAL
 *            LEAVE_AFTER times.
 *
 * TOLD ONCE: the start and the end, each one ℹ️ INFO alert (it is not our failure) and one log line; the API shows
 * it on GET /info and GET /health (`venue`). The service hands the hold to the engines and to SodexClient.maintenance.
 */
import type { FetchLike, SodexReach, VenueHold } from '../../../packages/copy-engine/src/index.ts';
import type { AlertKind } from './alerts.ts';

export const MAINTENANCE_STATUS_URL = 'https://alpha-biz.sodex.dev/biz/v1/maintenance/status';
export const EVERY_MS = 30_000;
export const READ_TIMEOUT_MS = 8_000;
export const ENTER_AFTER = 2;
export const LEAVE_AFTER = 2;
export const GATEWAY_AFTER_MS = 3 * 60_000;

/** What GET /info and /health show (the web reads it). */
export interface VenueView {
  state: 'normal' | 'maintenance';
  /** When this executor took SoDEX as in maintenance (null: normal). */
  since: number | null;
  /** When SoDEX expects to be back (its updateTime + maintenanceDuration), or null. */
  expectedEnd: number | null;
  /** SoDEX's flag at its last reading ('NORMAL', 'CHAIN_MAINTENANCE', ...), null when never read or the last read failed. */
  flag: string | null;
  /** When the flag last answered. */
  flagAt: number | null;
  /** What says maintenance now: SoDEX's flag, the gateway's 503s, or null. */
  source: 'sodex' | 'gateway' | null;
}

export interface MaintenanceWatchOptions {
  fetch: FetchLike;
  /** The gateway's reachability (SodexClient.reach). */
  reach: () => SodexReach;
  /** A cheap gateway read while the gateway signal holds (SodexClient.get of a public route): it updates `reach`. */
  probe?: () => Promise<unknown>;
  url?: string;
  alerts?: { raise(kind: AlertKind, subject: string, text: string): void } | null;
  log?: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void };
  /** The hold changed (a start, an end, a new expected end). */
  onChange?: (hold: VenueHold | null) => void;
  now?: () => number;
  everyMs?: number;
  timeoutMs?: number;
  enterAfter?: number;
  leaveAfter?: number;
  gatewayAfterMs?: number;
}

const utc = (ms: number): string => new Date(ms).toISOString().slice(11, 16) + ' UTC';

/** The flag's answer: its status and SoDEX's expected end, or null when the body is not the documented shape. */
export function readFlag(text: string): { status: string; expectedEnd: number | null } | null {
  let body: { code?: unknown; data?: { status?: unknown; maintenanceDuration?: unknown; updateTime?: unknown } | null };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return null;
  }
  if (!body || body.code !== 0 || !body.data || typeof body.data.status !== 'string' || !body.data.status.trim()) return null;
  const status = body.data.status.trim().toUpperCase();
  const hours = Number(body.data.maintenanceDuration);
  const at = Number(body.data.updateTime);
  // updateTime in unix seconds (documented); a value in ms is taken as ms.
  const startMs = Number.isFinite(at) && at > 0 ? (at < 1e11 ? at * 1000 : at) : null;
  const expectedEnd = status !== 'NORMAL' && startMs !== null && Number.isFinite(hours) && hours > 0 ? startMs + hours * 3_600_000 : null;
  return { status, expectedEnd };
}

export class SodexMaintenanceWatch {
  private flagMaint = false;
  private gatewayMaint = false;
  private maintRun = 0;
  private normalRun = 0;
  private flag: string | null = null;
  private flagAt: number | null = null;
  private expectedEnd: number | null = null;
  private since: number | null = null;
  private current: VenueHold | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(private readonly o: MaintenanceWatchOptions) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  get active(): boolean {
    return this.current !== null;
  }

  /** What the engines hold for, or null. */
  hold(): VenueHold | null {
    return this.current;
  }

  view(): VenueView {
    return {
      state: this.current ? 'maintenance' : 'normal',
      since: this.since,
      expectedEnd: this.current ? this.expectedEnd : null,
      flag: this.flag,
      flagAt: this.flagAt,
      source: this.flagMaint ? 'sodex' : this.gatewayMaint ? 'gateway' : null,
    };
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.o.everyMs ?? EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One reading of the flag (and the gateway), then the state. Never throws. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const reading = await this.read();
      const now = this.now();
      this.flag = reading?.status ?? null;
      if (reading) {
        this.flagAt = now;
        if (reading.status === 'NORMAL') {
          this.normalRun++;
          this.maintRun = 0;
        } else {
          this.maintRun++;
          this.normalRun = 0;
          this.expectedEnd = reading.expectedEnd;
        }
      }
      if (!this.flagMaint && this.maintRun >= (this.o.enterAfter ?? ENTER_AFTER)) this.flagMaint = true;
      if (this.flagMaint && this.normalRun >= (this.o.leaveAfter ?? LEAVE_AFTER)) this.flagMaint = false;
      // The gateway: probed while it alone holds, so its answer (not a stale failure) decides the end.
      if (this.gatewayMaint && this.o.probe) await this.o.probe().catch(() => undefined);
      const r = this.o.reach();
      const at = this.now();
      const failing503 = r.failingSince > 0 && at - r.failingSince >= (this.o.gatewayAfterMs ?? GATEWAY_AFTER_MS) && /\bHTTP 503\b/.test(r.lastError ?? '');
      // The flag's latest word is not NORMAL, or there was none (unreachable): only then do the gateway's 503s count.
      if (!this.gatewayMaint && failing503 && this.flag !== 'NORMAL') this.gatewayMaint = true;
      else if (this.gatewayMaint && (r.failingSince === 0 || this.normalRun >= (this.o.leaveAfter ?? LEAVE_AFTER))) this.gatewayMaint = false;
      this.settle(at);
    } catch (e) {
      this.o.log?.warn('venue: maintenance check failed', { error: String(e) });
    } finally {
      this.polling = false;
    }
  }

  private async read(): Promise<{ status: string; expectedEnd: number | null } | null> {
    try {
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(this.o.timeoutMs ?? READ_TIMEOUT_MS) : undefined;
      const res = await this.o.fetch(this.o.url ?? MAINTENANCE_STATUS_URL, { method: 'GET', headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) });
      if (res.status !== 200) return null;
      return readFlag(await res.text());
    } catch {
      return null;
    }
  }

  private reason(): string {
    const end = this.expectedEnd;
    const when = end === null ? '' : end > this.now() ? ` (SoDEX expects it back about ${utc(end)})` : ` (SoDEX expected it back at ${utc(end)})`;
    return `SoDEX is in maintenance${when}. Nothing is sent until it is back.`;
  }

  private settle(now: number): void {
    const on = this.flagMaint || this.gatewayMaint;
    if (on && !this.current) {
      this.since = now;
      this.current = { reason: this.reason(), since: now, expectedEnd: this.expectedEnd };
      const source = this.flagMaint ? `SoDEX's status says ${this.flag ?? 'maintenance'}` : `SoDEX's gateway answered HTTP 503 for ${Math.round(GATEWAY_AFTER_MS / 60_000)}+ min and its status ${this.flag === null ? 'could not be read' : `says ${this.flag}`}`;
      this.o.log?.warn('venue: SoDEX is in maintenance', { flag: this.flag, source: this.flagMaint ? 'sodex' : 'gateway', expectedEnd: this.expectedEnd });
      this.o.alerts?.raise(
        'sodex-maintenance',
        '',
        `SoDEX is in maintenance (${source})${this.expectedEnd !== null ? `; expected back about ${utc(this.expectedEnd)}` : ''}. Copies, algos and bots are held: nothing is sent, nothing counts as a refusal. They go on by themselves once SoDEX is back.`,
      );
      this.o.onChange?.(this.current);
      return;
    }
    if (!on && this.current) {
      const mins = Math.round((now - this.current.since) / 60_000);
      this.current = null;
      this.since = null;
      this.o.log?.info('venue: SoDEX is back from maintenance', { minutes: mins });
      this.o.alerts?.raise('sodex-maintenance-end', '', `SoDEX is back from maintenance (held ${mins} min here). Copies catch up on what their leaders did, algos and bots go on.`);
      this.o.onChange?.(null);
      return;
    }
    // A new expected end while it lasts: the words the held copies and algos show follow it.
    if (this.current && this.current.expectedEnd !== this.expectedEnd) {
      this.current = { reason: this.reason(), since: this.current.since, expectedEnd: this.expectedEnd };
      this.o.onChange?.(this.current);
    }
  }
}
