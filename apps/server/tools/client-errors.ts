/**
 * Client error reports: the owner's view (src/ops/clientErrors.ts). Run in apps/server,
 * on the server as the valuescan user (or with VALUESCAN_CLIENT_ERRORS_DB set).
 *
 *   npx tsx tools/client-errors.ts top [--days <n>] [--limit <n>] [--recent] [--json]
 *       The errors seen most often (or, with --recent, most recently) in the last
 *       <n> days (default 7): count, first and last seen, kind, message, the page.
 *   npx tsx tools/client-errors.ts show <fingerprint>
 *       One error in full: every stored frame, the last build, page and browser.
 *   npx tsx tools/client-errors.ts clear <fingerprint> | --all
 *       Forget one error (fixed) or every one. A fingerprint seen again afterwards
 *       counts as new, and alerts again.
 *
 * Read-only for `top` and `show` (the database is opened read-only).
 * Exit code: 0 done, 1 nothing found, 2 not understood.
 */
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { ClientErrorStore, clientErrorsDbPath, type ErrorRow } from '../src/ops/clientErrors.js';

export interface ToolResult {
  code: 0 | 1 | 2;
  text: string;
}

const USAGE = 'usage: client-errors.ts top [--days <n>] [--limit <n>] [--recent] [--json] | show <fingerprint> | clear <fingerprint> | clear --all';
const FP = /^[0-9a-f]{16}$/;

const ago = (ms: number, now: number): string => {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 129_600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
};

function table(rows: ErrorRow[], now: number): string {
  if (!rows.length) return 'no client errors in that window';
  const lines = rows.map((r) => {
    const where = r.boundary ? `${r.kind} in ${r.boundary}` : r.kind;
    return [
      `${String(r.count).padStart(7)}  ${r.fp}  ${where.padEnd(18)} last ${ago(r.lastAt, now).padEnd(8)} first ${ago(r.firstAt, now)}`,
      `         ${r.name}: ${r.message}`,
      `         ${r.lastRoute} · ${r.lastBrowser} · ${r.lastBuild}${r.frames[0] ? ` · at ${r.frames[0]}` : ''}`,
    ].join('\n');
  });
  return [`  count  fingerprint       kind`, ...lines].join('\n');
}

/** The tool without the process around it (tests). */
export function runTool(argv: readonly string[], o: { path?: string; now?: number } = {}): ToolResult {
  const path = o.path ?? clientErrorsDbPath();
  const now = o.now ?? Date.now();
  const [cmd, ...rest] = argv;
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const num = (name: string, dflt: number, max: number): number | null => {
    const v = flag(name);
    if (v === undefined) return rest.includes(name) ? null : dflt;
    return /^\d{1,4}$/.test(v) && Number(v) >= 1 && Number(v) <= max ? Number(v) : null;
  };
  if (!existsSync(path)) return { code: 1, text: `no error database at ${path} (nothing was reported yet, or VALUESCAN_CLIENT_ERRORS_DB points elsewhere)` };

  if (cmd === 'top') {
    const days = num('--days', 7, 3650);
    const limit = num('--limit', 20, 1000);
    if (days === null || limit === null) return { code: 2, text: USAGE };
    const store = new ClientErrorStore(path, { readOnly: true });
    try {
      const rows = store.top({ limit, sinceMs: now - days * 86_400_000, order: rest.includes('--recent') ? 'recent' : 'count' });
      return { code: 0, text: rest.includes('--json') ? JSON.stringify(rows, null, 2) : table(rows, now) };
    } finally {
      store.close();
    }
  }
  if (cmd === 'show') {
    const fp = rest[0];
    if (!fp || !FP.test(fp)) return { code: 2, text: USAGE };
    const store = new ClientErrorStore(path, { readOnly: true });
    try {
      const r = store.top({ limit: 1000 }).find((x) => x.fp === fp);
      if (!r) return { code: 1, text: `no error with fingerprint ${fp}` };
      return {
        code: 0,
        text: [
          `${r.name}: ${r.message}`,
          ...r.frames.map((f) => `  at ${f}`),
          '',
          `kind ${r.kind}${r.boundary ? ` (boundary ${r.boundary})` : ''} · ${r.count} times in ${r.reports} reports`,
          `first ${new Date(r.firstAt).toISOString()} · last ${new Date(r.lastAt).toISOString()}`,
          `last seen on ${r.lastRoute} · ${r.lastBrowser} · build ${r.lastBuild}`,
        ].join('\n'),
      };
    } finally {
      store.close();
    }
  }
  if (cmd === 'clear') {
    const target = rest[0];
    if (target !== '--all' && !(target && FP.test(target))) return { code: 2, text: USAGE };
    const store = new ClientErrorStore(path);
    try {
      const n = store.clear(target === '--all' ? undefined : target);
      return { code: n ? 0 : 1, text: `cleared ${n} error${n === 1 ? '' : 's'}` };
    } finally {
      store.close();
    }
  }
  return { code: 2, text: USAGE };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = runTool(process.argv.slice(2));
  (r.code === 0 ? process.stdout : process.stderr).write(`${r.text}\n`);
  process.exit(r.code);
}
