/**
 * Always on: the indexer's thread sampled every SAMPLE_US, and the last minute of samples written out when the loop
 * stalls for STALL_MS or more (at most once in GAP_MS), so the next stall shows what really ran, not just the label of
 * the last timer (busy.ts). The SIGUSR2 profile (cpuProfile.ts) needs someone at the console while it happens; stalls
 * of 10-77 s came and went all through 2026-11-06 with nobody there.
 *
 * Cost: V8's sampler runs on its own thread; at 10 ms a minute is ~6,000 samples. The profile is cut every SEGMENT_MS
 * (stopped and started again), the last cut is kept, and a stall writes the kept one and the running one, merged and
 * trimmed to the last KEEP_MS: `<dir>/<name>-<time>.cpuprofile` (DevTools, speedscope, deploy/server/bin/profile-top.mjs).
 * The newest MAX_FILES are kept.
 */
import { Session } from 'node:inspector';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STALL_MS = 5_000;
export const GAP_MS = 10 * 60_000;
const SAMPLE_US = 10_000;
const SEGMENT_MS = 60_000;
const KEEP_MS = 60_000;
const MAX_FILES = 20;

/** The parts of a V8 CPU profile this needs (times in microseconds). */
export interface CpuProfile {
  nodes: Array<{ id: number; callFrame: { functionName: string; scriptId: string; url: string; lineNumber: number; columnNumber: number }; hitCount?: number; children?: number[]; positionTicks?: unknown }>;
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

/**
 * Profiles taken one after another as one: their trees under one root, their samples in time order, only those of the
 * last `keepUs` before the last one's end.
 */
export function mergeProfiles(parts: readonly CpuProfile[], keepUs = KEEP_MS * 1_000): CpuProfile {
  const root = { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, hitCount: 0, children: [] as number[] };
  const nodes: CpuProfile['nodes'] = [root];
  const times: number[] = [];
  const ids: number[] = [];
  let next = 2;
  for (const p of parts) {
    const map = new Map<number, number>();
    for (const n of p.nodes) map.set(n.id, next++);
    const childIds = new Set<number>();
    for (const n of p.nodes) for (const c of n.children ?? []) childIds.add(c);
    for (const n of p.nodes) {
      nodes.push({ ...n, id: map.get(n.id)!, hitCount: 0, children: (n.children ?? []).map((c) => map.get(c)!) });
      if (!childIds.has(n.id)) root.children.push(map.get(n.id)!);
    }
    let t = p.startTime;
    const s = p.samples ?? [];
    const d = p.timeDeltas ?? [];
    for (let i = 0; i < s.length; i++) {
      t += d[i] ?? 0;
      times.push(t);
      ids.push(map.get(s[i]!) ?? 1);
    }
  }
  const end = parts.length ? parts[parts.length - 1]!.endTime : 0;
  const from = end - keepUs;
  let first = times.findIndex((t) => t >= from);
  if (first < 0) first = times.length;
  const samples = ids.slice(first);
  const kept = times.slice(first);
  const start = kept.length ? kept[0]! : end;
  const timeDeltas = kept.map((t, i) => (i === 0 ? 0 : t - kept[i - 1]!));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const id of samples) {
    const n = byId.get(id);
    if (n) n.hitCount = (n.hitCount ?? 0) + 1;
  }
  return { nodes, startTime: start, endTime: Math.max(end, start), samples, timeDeltas };
}

export class StallProfiler {
  private session: Session | null = null;
  private kept: CpuProfile | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastDump = 0;
  private busy = false;
  lastFile: string | null = null;
  lastError: string | null = null;

  constructor(
    private readonly dir: string,
    private readonly name: string,
    private readonly o: { stallMs?: number; gapMs?: number; segmentMs?: number; sampleUs?: number; log?: (line: string) => void } = {},
  ) {}

  private post<T>(method: string, params?: object): Promise<T> {
    return new Promise((ok, no) => {
      if (!this.session) return no(new Error('profiler stopped'));
      this.session.post(method, params ?? {}, (e, r) => (e ? no(e) : ok(r as T)));
    });
  }

  start(): void {
    if (this.session) return;
    try {
      this.session = new Session();
      this.session.connect();
    } catch (e) {
      this.lastError = String(e);
      this.session = null;
      return;
    }
    void (async () => {
      try {
        await this.post('Profiler.enable');
        await this.post('Profiler.setSamplingInterval', { interval: this.o.sampleUs ?? SAMPLE_US });
        await this.post('Profiler.start');
      } catch (e) {
        this.lastError = String(e);
        this.stop();
        return;
      }
      this.timer = setInterval(() => void this.cut(), this.o.segmentMs ?? SEGMENT_MS);
      this.timer.unref();
    })();
  }

  /** The running profile ends here and becomes the kept one; another starts. */
  private async cut(): Promise<CpuProfile | null> {
    if (this.busy || !this.session) return null;
    this.busy = true;
    try {
      const { profile } = await this.post<{ profile: CpuProfile }>('Profiler.stop');
      await this.post('Profiler.start');
      this.kept = profile;
      return profile;
    } catch (e) {
      this.lastError = String(e);
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** Each loop-lag tick: a stall long enough, and none written lately, writes the last minute. */
  onLag(lateMs: number, now = Date.now()): void {
    if (lateMs < (this.o.stallMs ?? STALL_MS) || !this.session || this.busy) return;
    if (this.lastDump && now - this.lastDump < (this.o.gapMs ?? GAP_MS)) return;
    this.lastDump = now;
    void this.dump(lateMs, now);
  }

  private async dump(lateMs: number, now: number): Promise<void> {
    const before = this.kept;
    const cur = await this.cut();
    if (!cur) return;
    try {
      const merged = mergeProfiles(before ? [before, cur] : [cur]);
      mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, `${this.name}-${new Date(now).toISOString().replace(/[:.]/g, '-')}-${Math.round(lateMs / 1000)}s.cpuprofile`);
      writeFileSync(file, JSON.stringify(merged));
      this.lastFile = file;
      (this.o.log ?? ((l: string) => console.log(l)))(`[indexer] thread stalled ${Math.round(lateMs / 1000)} s: the last minute of samples is in ${file}`);
      this.prune();
    } catch (e) {
      this.lastError = String(e);
    }
  }

  private prune(): void {
    const mine = readdirSync(this.dir).filter((f) => f.startsWith(`${this.name}-`) && f.endsWith('.cpuprofile')).sort();
    for (const f of mine.slice(0, Math.max(0, mine.length - MAX_FILES))) rmSync(join(this.dir, f), { force: true });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const s = this.session;
    this.session = null;
    if (!s) return;
    try {
      s.post('Profiler.stop', () => { try { s.disconnect(); } catch { /* gone */ } });
    } catch {
      try { s.disconnect(); } catch { /* gone */ }
    }
  }
}
