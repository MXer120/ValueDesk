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

export interface StatusSources {
  report: () => unknown;
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

export async function statusOfEverything(s: StatusSources, now = Date.now()) {
  const settle = <T>(f: () => T): T | { error: string } => {
    try {
      return f();
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
  return {
    at: now,
    report: settle(s.report),
    indexer: settle(s.indexer),
    executor: await s.executor(),
    brake: settle(s.brake),
    releases: settle(() => releasesIn(s.home)),
    system: settle(() => systemInfo(s.dataDir)),
    clientErrors: settle(s.errors),
  };
}
