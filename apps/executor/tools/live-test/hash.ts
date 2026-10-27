/**
 * The code a scenario passed on: a SHA-256 over the source files it depends
 * on, so a re-run skips what passed on the same code and runs again what a
 * change to the engine, the executor or the harness may have broken.
 *
 * Files are read as text with line endings made LF first: a checkout on
 * Windows (CRLF) and one on Linux hash the same, and OneDrive touching a file
 * without changing it changes nothing. Paths are hashed relative to the
 * repository and in sorted order, so the folder a checkout lives in does not
 * matter.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** What the hash groups are made of (repository-relative folders or files; folders are walked for .ts files). */
export const DEP_GROUPS = {
  /** Shared by everything: the SoDEX signing layer, the engine's SoDEX client and rules, the executor. */
  core: [
    'packages/sodex-core/src',
    'packages/copy-engine/src/sodex.ts',
    'packages/copy-engine/src/markets.ts',
    'packages/copy-engine/src/io.ts',
    'packages/copy-engine/src/socket.ts',
    'packages/copy-engine/src/policy.ts',
    'packages/copy-engine/src/api.ts',
    'packages/copy-engine/src/orders.ts',
    'packages/copy-engine/src/types.ts',
    'packages/copy-engine/src/store.ts',
    'packages/copy-engine/src/index.ts',
    'apps/executor/src',
  ],
  /** Algo orders. */
  algo: ['packages/copy-engine/src/algo', 'packages/copy-engine/src/oracle.ts', 'packages/copy-engine/src/priceGuard.ts'],
  /** Copy trading. */
  copy: ['packages/copy-engine/src/runtime.ts', 'packages/copy-engine/src/planner.ts', 'packages/copy-engine/src/feeds.ts', 'packages/copy-engine/src/settings.ts'],
  /**
   * The harness itself (its drivers and checks): changed checks are new code too. The scenario
   * files are not in it: each scenario hashes its own file (`source`), so editing the copy
   * scenarios does not re-run the algo ones.
   */
  harness: ['apps/executor/tools/live-test'],
} as const;

/** Folders of a group that are left out of it (hashed per scenario instead). */
const GROUP_SKIP: Partial<Record<keyof typeof DEP_GROUPS, string[]>> = { harness: ['apps/executor/tools/live-test/scenarios/'] };

export type DepGroup = keyof typeof DEP_GROUPS;

const SKIP_DIRS = new Set(['node_modules', '.state', '.git', 'dist', '.cache']);

/** Every .ts file under `rel` (a file or a folder), repository-relative with forward slashes, sorted. */
export function filesOf(repo: string, rel: string): string[] {
  const abs = join(repo, rel);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (p: string) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) if (!SKIP_DIRS.has(name)) walk(join(p, name));
    } else if (st.isFile() && /\.(ts|mts|json)$/.test(p) && !/\.(test)\.ts$/.test(p)) {
      out.push(relative(repo, p).split(sep).join('/'));
    }
  };
  walk(abs);
  return out.sort();
}

/** SHA-256 (hex) over the given repository-relative files: path, NUL, LF-normalised text, NUL, for each in sorted order. */
export function hashFiles(repo: string, files: readonly string[]): string {
  const h = createHash('sha256');
  for (const f of [...new Set(files)].sort()) {
    h.update(f);
    h.update('\0');
    h.update(readFileSync(join(repo, f), 'utf8').replace(/\r\n?/g, '\n'));
    h.update('\0');
  }
  return h.digest('hex');
}

/** One hash per group, read once per run. */
export class CodeHashes {
  private readonly cache = new Map<DepGroup, string>();
  constructor(readonly repo: string) {}

  group(g: DepGroup): string {
    let v = this.cache.get(g);
    if (!v) {
      const skip = GROUP_SKIP[g] ?? [];
      v = hashFiles(
        this.repo,
        DEP_GROUPS[g].flatMap((rel) => filesOf(this.repo, rel)).filter((f) => !skip.some((p) => f.startsWith(p))),
      );
      this.cache.set(g, v);
    }
    return v;
  }

  /**
   * A scenario's hash: its groups (always core and harness), the file it is written in,
   * its id and its revision. 16 hex digits are plenty to tell versions apart.
   */
  scenario(s: { id: string; deps: readonly DepGroup[]; source?: string; rev?: number }): string {
    const groups = [...new Set<DepGroup>(['core', 'harness', ...s.deps])].sort();
    const h = createHash('sha256');
    for (const g of groups) h.update(`${g}:${this.group(g)}\n`);
    if (s.source) h.update(`source:${hashFiles(this.repo, [s.source])}\n`);
    h.update(`${s.id}#${s.rev ?? 1}`);
    return h.digest('hex').slice(0, 16);
  }

  /** The whole code base the suite covers, for the run log. */
  all(): string {
    return createHash('sha256')
      .update((Object.keys(DEP_GROUPS) as DepGroup[]).map((g) => this.group(g)).join(','))
      .digest('hex')
      .slice(0, 16);
  }
}
