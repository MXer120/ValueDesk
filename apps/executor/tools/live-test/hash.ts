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
 *
 * PER TARGET (target.ts). Self runs this checkout's executor: its hash is what
 * it always was. Hosted runs ValueDesk's released executor: its hash adds the
 * version its /info names (and a commit, once /info carries one) to the same
 * files - the checkout is the nearest record of what was released, so a local
 * change re-runs it too. Browser runs the web app's own runtime: its hash adds
 * those files (the `web` group).
 *
 * PER LEADER VENUE (leader.ts). The copy scenarios also hash the leader's
 * driver (the `leader` group: leader.ts and the Hyperliquid client), and with
 * a Hyperliquid leader the venue too: a pass with a SoDEX leader never stands
 * for one with a Hyperliquid leader. With a SoDEX leader the hash stays what it
 * was before venues.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { LeaderVenueName } from './leader.ts';
import type { TargetName } from './target.ts';

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
    'packages/copy-engine/src/index.ts',
    'apps/executor/src',
  ],
  /** Algo orders. */
  algo: ['packages/copy-engine/src/algo', 'packages/copy-engine/src/oracle.ts', 'packages/copy-engine/src/priceGuard.ts', 'packages/copy-engine/src/store.ts'],
  /**
   * Copy trading. types.ts and store.ts are the copy's state and storage: the algo engine takes only types from types.ts,
   * gone at run time (store.ts's structuredCopy it runs, so store.ts is in the algo group too) - so a change to a copy's state reruns the copy scenarios, not the algo ones (2026-10-30: one field
   * added to SubState reran all 124 scenarios on two targets, 4.4 h, where the 44 copy ones were what it touched).
   */
  copy: ['packages/copy-engine/src/runtime.ts', 'packages/copy-engine/src/planner.ts', 'packages/copy-engine/src/feeds.ts', 'packages/copy-engine/src/settings.ts', 'packages/copy-engine/src/types.ts', 'packages/copy-engine/src/store.ts'],
  /**
   * The harness itself (its drivers and checks): changed checks are new code too. The scenario
   * files are not in it: each scenario hashes its own file (`source`), so editing the copy
   * scenarios does not re-run the algo ones. Nor is the leader's driver (`leader`).
   */
  harness: ['apps/executor/tools/live-test'],
  /** The leader the copy scenarios trade: its venues (SoDEX through exchange.ts, Hyperliquid's own client). */
  leader: ['apps/executor/tools/live-test/leader.ts', 'apps/executor/tools/live-test/hyperliquid.ts'],
  /** The web app's runtime of algos and copies, and its trading layer: what the browser target runs. */
  web: ['apps/web/src/algo', 'apps/web/src/copy', 'apps/web/src/trading'],
  /**
   * The pages the UI scenarios work (scenarios/ui.ts, the browser target): the components (.tsx too),
   * the account reads behind the tables, and the steps that click them (e2e/ui/uiSteps.ts).
   */
  ui: ['apps/web/src/components', 'apps/web/src/exchange', 'apps/web/src/api.ts', 'apps/web/src/accountFeeds.ts', 'apps/web/e2e/ui/uiSteps.ts', 'apps/web/e2e/ui/ticket.ts', 'apps/web/e2e/ui/algo.ts'],
} as const;

/**
 * The driver that runs the targets one after another (all.ts): it starts the runner as a child
 * and reads its output, and no scenario runs any of it, so a change to it re-runs nothing.
 */
export const DRIVER_FILES = ['apps/executor/tools/live-test/all.ts', 'apps/executor/tools/live-test/allParts.ts'] as const;

/** Folders of a group that are left out of it (hashed per scenario instead, or not code a scenario runs). */
const GROUP_SKIP: Partial<Record<keyof typeof DEP_GROUPS, readonly string[]>> = {
  harness: ['apps/executor/tools/live-test/scenarios/', ...DEP_GROUPS.leader, ...DRIVER_FILES],
};

export type DepGroup = keyof typeof DEP_GROUPS;

/** Groups only some targets run (and hash): the web runtime is the browser target's alone. */
const TARGET_GROUPS: Partial<Record<DepGroup, readonly TargetName[]>> = { web: ['browser'], ui: ['browser'] };

/** What a hash is taken for: the target, (hosted) the release it names, and where the leader trades. */
export interface HashTarget {
  name: TargetName;
  release?: string | null;
  /** The leader's venue (LIVE_LEADER_VENUE); default sodex. */
  leader?: LeaderVenueName;
}

const SKIP_DIRS = new Set(['node_modules', '.state', '.git', 'dist', '.cache']);

/** Groups whose React components count too (.tsx); the others hash .ts only, as they always did. */
const TSX_GROUPS: ReadonlySet<DepGroup> = new Set<DepGroup>(['ui']);

/** Every .ts file (and .tsx with `tsx`) under `rel` (a file or a folder), repository-relative with forward slashes, sorted. */
export function filesOf(repo: string, rel: string, tsx = false): string[] {
  const abs = join(repo, rel);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const code = tsx ? /\.(ts|tsx|mts|json)$/ : /\.(ts|mts|json)$/;
  const walk = (p: string) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) if (!SKIP_DIRS.has(name)) walk(join(p, name));
    } else if (st.isFile() && code.test(p) && !/\.(test)\.tsx?$/.test(p)) {
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
  constructor(
    readonly repo: string,
    readonly target: HashTarget = { name: 'self' },
  ) {}

  /** The groups of these this target runs. */
  private used(groups: readonly DepGroup[]): DepGroup[] {
    return groups.filter((g) => TARGET_GROUPS[g]?.includes(this.target.name) ?? true);
  }

  group(g: DepGroup): string {
    let v = this.cache.get(g);
    if (!v) {
      const skip = GROUP_SKIP[g] ?? [];
      v = hashFiles(
        this.repo,
        DEP_GROUPS[g].flatMap((rel) => filesOf(this.repo, rel, TSX_GROUPS.has(g))).filter((f) => !skip.some((p) => f.startsWith(p))),
      );
      this.cache.set(g, v);
    }
    return v;
  }

  /**
   * A scenario's hash: its groups (always core and harness, and the target's own), the file it
   * is written in, the target (but self, whose hash stays what it was before targets), for a
   * scenario with the leader its venue (but SoDEX, as before venues), its id and its revision.
   * 16 hex digits are plenty to tell versions apart.
   */
  scenario(s: { id: string; deps: readonly DepGroup[]; source?: string; rev?: number; leader?: boolean }): string {
    const groups = [...new Set<DepGroup>(['core', 'harness', ...s.deps, ...this.used(['web'])])].sort();
    const h = createHash('sha256');
    for (const g of groups) h.update(`${g}:${this.group(g)}\n`);
    if (s.source) h.update(`source:${hashFiles(this.repo, [s.source])}\n`);
    if (this.target.name !== 'self') h.update(`target:${this.target.name}@${this.target.release ?? ''}\n`);
    if (s.leader && (this.target.leader ?? 'sodex') !== 'sodex') h.update(`leader:${this.target.leader}\n`);
    h.update(`${s.id}#${s.rev ?? 1}`);
    return h.digest('hex').slice(0, 16);
  }

  /** The whole code base the suite covers on this target, for the run log. */
  all(): string {
    const h = createHash('sha256').update(this.used(Object.keys(DEP_GROUPS) as DepGroup[]).map((g) => this.group(g)).join(','));
    if (this.target.name !== 'self') h.update(`,target:${this.target.name}@${this.target.release ?? ''}`);
    return h.digest('hex').slice(0, 16);
  }
}
