/**
 * Read the executor's audit log (db.ts, table `audit`): what happened, for whom, when.
 *
 *   node node_modules/tsx/dist/cli.mjs apps/executor/tools/audit.ts verify
 *   ... audit.ts wallet 0xabc...            every row of one wallet, newest first
 *   ... audit.ts ref <copy id | algo id>    every row about one copy or algo
 *   ... audit.ts kind brake                 one kind: request, order, stop, cancel, leverage, brake, process
 *   ... audit.ts since 2026-10-27T10:00Z    everything since then (add `until <time>` to bound it)
 *
 * Options: --db <path> (default: $EXECUTOR_DATA_DIR/executor.db, else /var/lib/valuescan/executor/executor.db),
 * --limit <n> (default 500), --json (one JSON object per line instead of a table).
 *
 * It opens the database read-only, so it is safe next to the running executor (sudo -u valuescan-executor ...).
 * `verify` walks the whole hash chain and exits 1 at the first row that does not follow.
 */
import { join } from 'node:path';
import { sqlite } from '../src/db.ts';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name: string): boolean => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};

const path = opt('--db') ?? join(process.env.EXECUTOR_DATA_DIR?.trim() || '/var/lib/valuescan/executor', 'executor.db');
const limit = Math.max(1, Math.min(100_000, Number(opt('--limit') ?? 500) || 500));
const asJson = flag('--json');
const [cmd, value, ...rest] = args;

const db = new (sqlite().DatabaseSync)(path, { readOnly: true });
type Row = { seq: number; at: number; kind: string; owner: string | null; ref: string | null; data: string; hash: string };

function hashOf(prev: string, r: Row): string {
  return createHash('sha256').update(`${prev}\n${r.at}\n${r.kind}\n${r.owner ?? ''}\n${r.ref ?? ''}\n${r.data}`).digest('hex');
}

function print(rows: Row[]): void {
  for (const r of rows) {
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ ...r, data: JSON.parse(r.data) })}\n`);
      continue;
    }
    process.stdout.write(`${String(r.seq).padStart(8)}  ${new Date(r.at).toISOString()}  ${r.kind.padEnd(8)}  ${(r.owner ?? '-').padEnd(42)}  ${(r.ref ?? '-').padEnd(24)}  ${r.data}\n`);
  }
}

const time = (s: string | undefined, what: string): number => {
  const t = s ? Date.parse(s) : NaN;
  if (!Number.isFinite(t)) throw new Error(`${what} needs a time, e.g. 2026-10-27T10:00Z`);
  return t;
};

const select = (where: string, ...params: Array<string | number>): Row[] =>
  db.prepare(`SELECT seq, at, kind, owner, ref, data, hash FROM audit WHERE ${where} ORDER BY seq DESC LIMIT ${limit}`).all(...params) as unknown as Row[];

try {
  if (cmd === 'verify') {
    let prev = '0'.repeat(64);
    let last = 0;
    let n = 0;
    for (const r of db.prepare('SELECT seq, at, kind, owner, ref, data, hash FROM audit ORDER BY seq').iterate() as Iterable<Row>) {
      n++;
      if (hashOf(prev, r) !== r.hash || (last && r.seq !== last + 1)) {
        process.stderr.write(`BROKEN at row ${r.seq} (${new Date(r.at).toISOString()}): it was changed, or a row before it was removed.\n`);
        process.exit(1);
      }
      prev = r.hash;
      last = r.seq;
    }
    process.stdout.write(`ok: ${n} rows, the chain holds. Head: row ${last}, ${prev}\n(compare with the newest "audit head" line in the journal: journalctl --namespace=pii -u valuescan-executor | grep "audit head" | tail -1)\n`);
  } else if (cmd === 'wallet' && value) print(select('owner = ?', value.toLowerCase()));
  else if (cmd === 'ref' && value) print(select('ref = ?', value));
  else if (cmd === 'kind' && value) print(select('kind = ?', value));
  else if (cmd === 'since') {
    const from = time(value, 'since');
    const until = rest[0] === 'until' ? time(rest[1], 'until') : Number.MAX_SAFE_INTEGER;
    print(select('at >= ? AND at < ?', from, until));
  } else {
    process.stdout.write('usage: audit.ts verify | wallet <0x...> | ref <id> | kind <kind> | since <time> [until <time>]  [--db path] [--limit n] [--json]\n');
    process.exit(2);
  }
} finally {
  db.close();
}
