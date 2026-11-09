/**
 * "The status of everything" for the admin suite, read from what already exists -
 * nothing here probes or measures on its own:
 *
 *   status page    ops/status.ts StatusStore.report: each service's last probe, 90 days of
 *                  uptime, the open and recent incidents and maintenance
 *   indexer        its whole status row (indexer/read.ts indexerStatus) - the owner's eyes
 *                  only, so not the public projection (hosted.ts indexerHealth): build
 *                  times and steps, lanes, streams, the last error
 *   executor       server 2's own /api/copy/v1/health, read the way a visitor reaches it
 *                  (through the site): copies, algos, feed, brake, send queue
 *   brake          this server's brake file (ops/brake.ts)
 *   releases       /opt/valuescan/releases and which one is current (deploy/server/bin/release.sh)
 *   this server    load, memory, the data disk, the API process itself
 *   client errors  the reports browsers sent (ops/clientErrors.ts), most recent first
 */
import { loadavg, totalmem, freemem, uptime, cpus, hostname } from 'node:os';
import { readdirSync, readFileSync, realpathSync, statSync, statfsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { noticeLive, overallShown, shownState, type Notice, type OverallShown, type ServiceId, type ServiceState, type ShownState, type StatusReport } from '../ops/statusModel.js';
import { whyText } from '../ops/indexerJudge.js';
import { indexerHealth } from '../hosted.js';
import type { FreshDay, LastChecks } from '../ops/status.js';

export interface StatusSources {
  report: () => unknown;
  /** The prober's last round with its reasons (ops/status.ts StatusStore.lastChecks). */
  checks?: () => LastChecks | null;
  /** The indexer's freshness per UTC day, newest first (ops/status.ts StatusStore.freshDays): the daily view. */
  freshDays?: () => FreshDay[];
  indexer: () => unknown;
  brake: () => unknown;
  errors: () => unknown[];
  /** server 2's health, or why it could not be read. */
  executor: () => Promise<unknown>;
  /** /opt/valuescan, or wherever release.sh installs (VS_HOME). */
  home: string;
  dataDir: string;
}

export interface ReleaseInfo {
  current: string | null;
  previous: string | null;
  installed: Array<{ tag: string; at: number }>;
}

export function releasesIn(home: string): ReleaseInfo {
  const dir = join(home, 'releases');
  let current: string | null = null;
  try {
    current = basename(realpathSync(join(home, 'current')));
  } catch {
    /* not a released server (local dev) */
  }
  let previous: string | null = null;
  try {
    previous = readFileSync(join(dir, '.previous'), 'utf8').trim() || null;
  } catch {
    /* none */
  }
  const installed: ReleaseInfo['installed'] = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      installed.push({ tag: e.name, at: statSync(join(dir, e.name)).mtimeMs });
    }
  } catch {
    /* none */
  }
  installed.sort((a, b) => b.at - a.at);
  return { current, previous, installed };
}

export function systemInfo(dataDir: string) {
  let disk: { path: string; totalBytes: number; freeBytes: number } | null = null;
  try {
    const s = statfsSync(dataDir);
    disk = { path: dataDir, totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
  } catch {
    /* not on every platform */
  }
  const mem = process.memoryUsage();
  return {
    host: hostname(),
    cores: cpus().length,
    load: loadavg(),
    memory: { totalBytes: totalmem(), freeBytes: freemem() },
    uptimeS: Math.round(uptime()),
    disk,
    api: { pid: process.pid, uptimeS: Math.round(process.uptime()), rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, node: process.version },
  };
}

/** server 2's health as the site serves it; 5 s at most. */
export async function fetchExecutorHealth(url: string, fetchFn: typeof fetch = fetch): Promise<unknown> {
  const started = Date.now();
  try {
    const r = await fetchFn(url, { signal: AbortSignal.timeout(5_000), headers: { accept: 'application/json' } });
    const ms = Date.now() - started;
    if (!r.ok) return { reachable: false, status: r.status, ms };
    return { reachable: true, ms, health: await r.json() };
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.name : 'error', ms: Date.now() - started };
  }
}

/** One service as the admin suite shows it: the public page's verdict (shown), the raw probe, and why. */
export interface JudgedService {
  id: ServiceId;
  name: string;
  /** What the public Status page says now (statusModel.ts shownState: the probe with the open notices). */
  shown: ShownState;
  /** The last probe's own verdict. */
  probe: ServiceState;
  checkedAt: number | null;
  latencyMs: number | null;
  uptime: number | null;
  /** The checks that failed in the last probe round, as codes and words (indexer: indexerJudge.ts). */
  why: Array<{ code: string; text: string }>;
  /** The open incidents and maintenance on it, by title. */
  notices: Array<{ id: number; kind: Notice['kind']; title: string }>;
}

/**
 * The public page's judgement, with what only the owner needs beside it. It reads the same report
 * (StatusStore.report) and judges with the same function (statusModel.ts shownState), so the dev page
 * can never contradict www.valuedesk.so/status - it only says more.
 */
export function judge(report: StatusReport, checks: LastChecks | null, now: number): { overall: OverallShown; services: JudgedService[] } {
  const notices = report.notices ?? [];
  const services = report.services.map((x): JudgedService => {
    const check = checks?.checks.find((c) => c.service === x.id);
    // A reason belongs to the sample shown: an older round's reasons are not today's.
    const why = check && checks && x.checkedAt !== null && checks.at === x.checkedAt ? check.why : [];
    return {
      id: x.id,
      name: x.name,
      shown: shownState(x.state, x.id, notices, now),
      probe: x.state,
      checkedAt: x.checkedAt,
      latencyMs: x.latencyMs,
      uptime: x.uptime,
      why: why.map((code) => ({ code, text: whyText(code) ?? code })),
      notices: notices.filter((n) => n.components.includes(x.id) && noticeLive(n, now)).map((n) => ({ id: n.id, kind: n.kind, title: n.title })),
    };
  });
  return { overall: overallShown(services.map((x) => x.shown)), services };
}

/**
 * The indexer's status row cut to what the Status page shows: the health projection the prober judges
 * (hosted.ts indexerHealth: streams, lanes, loop lag, last build), the last error's text and the slowest
 * build steps. The whole row (gaps, flow, cohorts, catch-ups...) was sent before and only dumped as JSON.
 */
export function indexerView(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const steps = r.lastBuildStepMs && typeof r.lastBuildStepMs === 'object' ? Object.entries(r.lastBuildStepMs as Record<string, unknown>) : [];
  return {
    health: indexerHealth(raw),
    lastError: typeof r.lastError === 'string' ? r.lastError.slice(0, 600) : null,
    stopping: r.stopping === true,
    boardsAt: typeof r.boardsAt === 'number' ? r.boardsAt : null,
    steps: steps
      .filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8),
  };
}

export async function statusOfEverything(s: StatusSources, now = Date.now()) {
  const settle = <T>(f: () => T): T | { error: string } => {
    try {
      return f();
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
  const report = settle(s.report as () => StatusReport);
  const checks = s.checks ? settle(s.checks) : null;
  return {
    at: now,
    judged: 'error' in report ? null : judge(report, checks && !('error' in checks) ? checks : null, now),
    report,
    indexer: settle(() => indexerView(s.indexer())),
    executor: await s.executor(),
    brake: settle(s.brake),
    releases: settle(() => releasesIn(s.home)),
    system: settle(() => systemInfo(s.dataDir)),
    clientErrors: settle(s.errors),
    freshDays: s.freshDays ? settle(s.freshDays) : null,
  };
}
