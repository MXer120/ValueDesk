/**
 * The status page, the owner's side (ops/statusNotices.ts, ops/statusCommands.ts).
 * Run in apps/server on server 1 as the valuescan user - deploy/server/bin/status.sh
 * does that - or anywhere with VALUESCAN_STATUS_DB naming a status.db.
 *
 *   status-post.ts incident "<title>" --components=executor --impact=major "<message>"
 *   status-post.ts update <id> identified "<message>"
 *   status-post.ts resolve <id> "<message>"
 *   status-post.ts maintenance "<title>" --start=2026-10-28T02:00 --end=+1h --components=api,indexer ["<message>"]
 *   status-post.ts list [--all] | show <id> | delete <id>
 *       The incidents and maintenance on www.valuedesk.so/status (the grammar:
 *       ops/statusCommands.ts). The page shows a change within about a minute.
 *
 *   journalctl -u valuescan-health.service -o json --no-pager | status-post.ts backfill [--dry-run]
 *       Uptime from before the status page's prober ran, from the health check's own
 *       record: valuescan-health.timer has run deploy/server/bin/healthcheck.mjs every
 *       minute on this server and logged each pass as one JSON line. Only minutes before
 *       the prober's first for each service are filled, each once - running it again
 *       adds nothing. A minute with no pass stays no data. What counts:
 *         website   peer:site (https://www.valuedesk.so/ answers 2xx)
 *         api       api (this API's /api/health answers ok)
 *         executor  peer:site-copy (the executor's health through the site): ok up,
 *                   "answered ok:false" degraded, anything else down
 *         indexer   indexer: ok up, a warning for streams down degraded, failed down;
 *                   "not judged" (the API did not answer) no data
 *
 *   status-post.ts restore <status-history.json>
 *       The finished days and notices from a backup (backup-offsite.sh api-state carries
 *       status-history.json) into this status.db: only what it does not have. The API
 *       does this by itself when it starts with an empty status.db.
 *
 * Exit code: 0 done, 1 nothing found, 2 not understood or not possible.
 */
import { pathToFileURL } from 'node:url';
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { StatusStore, statusDbPath, writeHistory, type Sample } from '../src/ops/status.js';
import { runStatusCommand } from '../src/ops/statusCommands.js';
import { STATUS_SERVICES, type ServiceId } from '../src/ops/statusModel.js';

export interface ToolResult {
  code: 0 | 1 | 2;
  text: string;
}

interface Check {
  ok?: unknown;
  warn?: unknown;
  note?: unknown;
}

/**
 * One journal entry of the health check (journalctl -o json) as the prober's samples
 * for its minute; [] when it is not a health pass.
 */
export function samplesFromHealthEntry(entry: unknown): Array<Sample & { minute: number }> {
  const e = entry as { __REALTIME_TIMESTAMP?: unknown; MESSAGE?: unknown } | null;
  if (!e || typeof e.MESSAGE !== 'string' || !e.MESSAGE.startsWith('{')) return [];
  const us = Number(e.__REALTIME_TIMESTAMP);
  if (!Number.isFinite(us) || us <= 0) return [];
  let pass: { ok?: unknown; checks?: Record<string, Check> };
  try {
    pass = JSON.parse(e.MESSAGE) as typeof pass;
  } catch {
    return [];
  }
  if (typeof pass?.ok !== 'boolean' || !pass.checks || typeof pass.checks !== 'object') return [];
  const minute = Math.floor(us / 1000 / 60_000);
  const c = pass.checks;
  const out: Array<Sample & { minute: number }> = [];
  const push = (service: ServiceId, state: Sample['state']) => out.push({ service, state, ms: null, minute });
  if (c['peer:site']) push('website', c['peer:site'].ok === true ? 'up' : 'down');
  if (c.api) push('api', c.api.ok === true ? 'up' : 'down');
  const ex = c['peer:site-copy'];
  if (ex) push('executor', ex.ok === true ? 'up' : /answered ok:false/.test(String(ex.note ?? '')) ? 'degraded' : 'down');
  const ix = c.indexer;
  if (ix && !/^not judged/.test(String(ix.note ?? ''))) push('indexer', ix.ok !== true ? 'down' : ix.warn === true ? 'degraded' : 'up');
  return out;
}

/** The journal, line by line (months of it are too large for one string). */
async function* linesOf(input: string | NodeJS.ReadableStream): AsyncGenerator<string> {
  if (typeof input === 'string') yield* input.split('\n');
  else yield* createInterface({ input, crlfDelay: Infinity });
}

async function backfill(store: StatusStore, input: string | NodeJS.ReadableStream, dry: boolean, now: number): Promise<ToolResult> {
  const samples: Array<Sample & { minute: number }> = [];
  let lines = 0;
  let from = Infinity;
  let to = -Infinity;
  for await (const line of linesOf(input)) {
    if (!line.trim()) continue;
    lines += 1;
    try {
      for (const s of samplesFromHealthEntry(JSON.parse(line))) {
        samples.push(s);
        from = Math.min(from, s.minute * 60_000);
        to = Math.max(to, s.minute * 60_000);
      }
    } catch {
      /* not a journal entry */
    }
  }
  if (!samples.length) return { code: 1, text: `no health check passes in the input (${lines} lines). Pipe: journalctl -u valuescan-health.service -o json --no-pager` };
  const head = `${samples.length} samples from ${lines} journal lines, ${new Date(from).toISOString().slice(0, 16)}Z to ${new Date(to).toISOString().slice(0, 16)}Z`;
  const added = store.backfill(samples, now, { dryRun: dry });
  const rows: string[] = [];
  for (const { id } of STATUS_SERVICES) {
    for (const [day, [up, deg, down]] of Object.entries(added[id] ?? {}).sort()) rows.push(`  ${id.padEnd(9)} ${day}  +${up} up, +${deg} degraded, +${down} down`);
  }
  if (!dry && rows.length) writeHistory(store);
  return {
    code: rows.length ? 0 : 1,
    text: [head, rows.length ? `${dry ? 'would add' : 'added'}:` : 'nothing to add: the record already begins before these minutes', ...rows].join('\n'),
  };
}

/** The tool without the process around it (tests). */
export async function runTool(argv: readonly string[], o: { path?: string; now?: number; stdin?: string | NodeJS.ReadableStream } = {}): Promise<ToolResult> {
  const now = o.now ?? Date.now();
  const [cmd, ...rest] = argv;
  if (cmd === 'backfill' || cmd === 'restore') {
    const store = new StatusStore(o.path ?? statusDbPath());
    try {
      if (cmd === 'restore') {
        if (!rest[0]) return { code: 2, text: 'usage: status-post.ts restore <status-history.json>' };
        const r = store.restoreHistory(readFileSync(rest[0], 'utf8'), now);
        if (r.days || r.notices) writeHistory(store);
        return { code: r.days || r.notices ? 0 : 1, text: `restored ${r.days} days and ${r.notices} notices (what was here is unchanged)` };
      }
      const bad = rest.find((a) => a !== '--dry-run' && !a.startsWith('--file='));
      if (bad) return { code: 2, text: `usage: status-post.ts backfill [--file=<journal.json>] [--dry-run] (not "${bad}")` };
      const file = rest.find((a) => a.startsWith('--file='))?.slice(7);
      const input = file ? createReadStream(file) : (o.stdin ?? process.stdin);
      return await backfill(store, input, rest.includes('--dry-run'), now);
    } catch (e) {
      return { code: 2, text: e instanceof Error ? e.message : String(e) };
    } finally {
      store.close();
    }
  }
  const store = new StatusStore(o.path ?? statusDbPath());
  try {
    const r = runStatusCommand(argv, store.notices, { now, allowDelete: true, site: process.env.VALUESCAN_STATUS_SITE_URL?.trim() || undefined });
    if (r.changed) writeHistory(store);
    return { code: r.code, text: r.text };
  } finally {
    store.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = await runTool(process.argv.slice(2));
  (r.code === 2 ? process.stderr : process.stdout).write(`${r.text}\n`);
  process.exitCode = r.code;
}
