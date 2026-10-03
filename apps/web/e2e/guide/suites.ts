/**
 * Stage A, the pure parts: which offline suites exist in this checkout, how
 * each is started, and how its output is read.
 *
 * The suites are DISCOVERED, not listed: every `*.test.ts` under a package's
 * test folder, every web unit test, every `*.test.mjs` of the tools and the
 * deploy scripts. A test file added tomorrow is run tomorrow.
 *
 * Tests are node:test (run through tsx), not vitest. Their counts come from
 * reporter.mjs, which prints one JSON line per test event.
 */

export type SuiteKind = 'tsc' | 'node-test' | 'command';

export interface SuiteCommand {
  /** 'node' | 'tsx' (TypeScript through tsx) | a program on PATH. */
  program: 'node' | 'tsx' | 'forge' | 'python';
  args: string[];
  label: string;
}

export interface SuiteDef {
  id: string;
  title: string;
  kind: SuiteKind;
  /** Working directory, relative to the repository root, with forward slashes. */
  cwd: string;
  /** tsc: one run per project (null = the folder's own tsconfig.json). */
  projects?: Array<string | null>;
  /** node-test: the test files, relative to cwd. */
  files?: string[];
  /** node-test: load TypeScript through tsx. */
  tsx?: boolean;
  /** command: run one after another; all must exit 0. */
  commands?: SuiteCommand[];
  /** Not run, and why. */
  skip?: string;
  timeoutMs: number;
}

/** What discovery needs to know about the disk. Paths are relative to the repository root, forward slashes. */
export interface FsView {
  exists(path: string): boolean;
  /** Every file under `dir` (recursive), relative to `dir`; [] when it does not exist. node_modules and build output are left out. */
  files(dir: string): string[];
  /** The immediate sub-folders of `dir`. */
  dirs(dir: string): string[];
}

export interface Tools {
  forge: boolean;
  python: boolean;
  pyyaml: boolean;
}

const MIN = 60_000;
const byName = (a: string, b: string): number => a.localeCompare(b);

export function discoverSuites(fs: FsView, tools: Tools): SuiteDef[] {
  const out: SuiteDef[] = [];
  const tests = (dir: string, re: RegExp): string[] => fs.files(dir).filter((f) => re.test(f)).sort(byName);
  const TS_TEST = /\.test\.tsx?$/;
  const MJS_TEST = /\.test\.mjs$/;

  // --- the web app --------------------------------------------------------------------------
  if (fs.exists('apps/web/tsconfig.json')) {
    out.push({ id: 'web-typecheck', title: 'web typecheck', kind: 'tsc', cwd: 'apps/web', projects: [null], timeoutMs: 10 * MIN });
    const unit = tests('apps/web/src', TS_TEST).map((f) => `src/${f}`);
    out.push({ id: 'web-unit', title: 'web unit tests', kind: 'node-test', cwd: 'apps/web', files: unit, tsx: true, timeoutMs: 20 * MIN, ...(unit.length ? {} : { skip: 'no test files under apps/web/src' }) });
    const tools_ = tests('apps/web/tools', MJS_TEST).map((f) => `tools/${f}`);
    if (tools_.length) out.push({ id: 'web-tools', title: 'web tools tests', kind: 'node-test', cwd: 'apps/web', files: tools_, tsx: false, timeoutMs: 5 * MIN });
  }
  if (fs.exists('apps/web/e2e/live/tsconfig.json')) {
    out.push({ id: 'e2e-typecheck', title: 'live runner typecheck', kind: 'tsc', cwd: 'apps/web', projects: ['e2e/live'], timeoutMs: 10 * MIN });
  }
  const e2e = tests('apps/web/e2e/live', TS_TEST).filter((f) => !f.includes('/')).map((f) => `e2e/live/${f}`);
  if (e2e.length) out.push({ id: 'e2e-offline', title: 'offline e2e (live runner)', kind: 'node-test', cwd: 'apps/web', files: e2e, tsx: true, timeoutMs: 20 * MIN });
  if (fs.exists('apps/web/e2e/guide/tsconfig.json')) {
    out.push({ id: 'guide-typecheck', title: 'test guide typecheck', kind: 'tsc', cwd: 'apps/web', projects: ['e2e/guide'], timeoutMs: 5 * MIN });
  }
  const guide = tests('apps/web/e2e/guide', TS_TEST).filter((f) => !f.includes('/')).map((f) => `e2e/guide/${f}`);
  if (guide.length) out.push({ id: 'guide-tests', title: 'test guide self-tests', kind: 'node-test', cwd: 'apps/web', files: guide, tsx: true, timeoutMs: 10 * MIN });

  // --- the server -----------------------------------------------------------------------------
  if (fs.exists('apps/server/tsconfig.json')) {
    out.push({ id: 'server-typecheck', title: 'server typecheck', kind: 'tsc', cwd: 'apps/server', projects: [null], timeoutMs: 10 * MIN });
    const st = tests('apps/server/test', TS_TEST).filter((f) => !f.includes('/')).map((f) => `test/${f}`);
    out.push({ id: 'server-tests', title: 'server tests', kind: 'node-test', cwd: 'apps/server', files: st, tsx: true, timeoutMs: 20 * MIN, ...(st.length ? {} : { skip: 'no test files under apps/server/test' }) });
  }

  // --- every package ----------------------------------------------------------------------------
  for (const name of fs.dirs('packages').sort(byName)) {
    const dir = `packages/${name}`;
    const projects = ['tsconfig.json', 'tsconfig.test.json'].filter((p) => fs.exists(`${dir}/${p}`));
    if (projects.length) out.push({ id: `${name}-typecheck`, title: `${name} typecheck`, kind: 'tsc', cwd: dir, projects, timeoutMs: 10 * MIN });
    const pt = tests(`${dir}/test`, TS_TEST).filter((f) => !f.includes('/')).map((f) => `test/${f}`);
    if (pt.length) out.push({ id: `${name}-tests`, title: `${name} tests`, kind: 'node-test', cwd: dir, files: pt, tsx: true, timeoutMs: 15 * MIN });
  }

  // --- the contract bindings against the contract build ------------------------------------------
  if (fs.exists('packages/copy-contract/tools/extract-abi.ts')) {
    const built = fs.exists('contracts/out/ValuescanCopyTrading.sol/ValuescanCopyTrading.json');
    const cmds: SuiteCommand[] = [{ program: 'tsx', args: ['tools/extract-abi.ts', '--check'], label: 'committed ABI = contract build' }];
    if (fs.exists('packages/copy-contract/tools/gen-vectors.ts')) cmds.push({ program: 'tsx', args: ['tools/gen-vectors.ts', '--check'], label: 'committed test vectors are current' });
    out.push({
      id: 'copy-contract-checks',
      title: 'copy-contract ABI + vectors',
      kind: 'command',
      cwd: 'packages/copy-contract',
      commands: cmds,
      timeoutMs: 5 * MIN,
      ...(built ? {} : { skip: 'contracts/out has no build (run "forge build" in contracts/ once)' }),
    });
  }

  // --- deploy scripts ----------------------------------------------------------------------------
  const deploy = tests('deploy', MJS_TEST).map((f) => `deploy/${f}`);
  if (deploy.length) out.push({ id: 'deploy-tests', title: 'deploy script tests', kind: 'node-test', cwd: '.', files: deploy, tsx: false, timeoutMs: 15 * MIN });
  if (fs.exists('deploy/aws/validate_offline.py')) {
    out.push({
      id: 'deploy-templates',
      title: 'deploy templates (offline validation)',
      kind: 'command',
      cwd: '.',
      commands: [{ program: 'python', args: ['deploy/aws/validate_offline.py'], label: 'CloudFormation templates and project rules' }],
      timeoutMs: 10 * MIN,
      ...(tools.python ? (tools.pyyaml ? {} : { skip: 'Python has no PyYAML (pip install pyyaml)' }) : { skip: 'Python is not installed' }),
    });
  }

  // --- the contracts -----------------------------------------------------------------------------
  if (fs.exists('contracts/tools/storage-layout.mjs')) {
    const artifact = fs.exists('contracts/out/StorageLayoutHarness.sol/CopyTradingStorageLayoutHarness.json');
    out.push({
      id: 'contracts-layout',
      title: 'contract storage-layout guard',
      kind: 'command',
      cwd: 'contracts',
      commands: [
        { program: 'node', args: ['tools/storage-layout.mjs', 'selftest'], label: 'the guard rejects incompatible layouts' },
        ...(artifact ? [{ program: 'node' as const, args: ['tools/storage-layout.mjs', 'check'], label: 'build = committed snapshot' }] : []),
      ],
      timeoutMs: 5 * MIN,
    });
  }
  if (fs.exists('contracts/foundry.toml')) {
    out.push({
      id: 'contracts-forge',
      title: 'contracts (forge test)',
      kind: 'command',
      cwd: 'contracts',
      commands: [{ program: 'forge', args: ['test'], label: 'forge test' }],
      timeoutMs: 45 * MIN,
      ...(tools.forge ? {} : { skip: 'forge (Foundry) is not installed on this computer' }),
    });
  }
  return out;
}

/** `--suites web,server`: suites whose id contains one of the words. */
export function filterSuites(all: readonly SuiteDef[], words: readonly string[] | null): SuiteDef[] {
  if (!words || !words.length) return [...all];
  return all.filter((s) => words.some((w) => s.id.includes(w)));
}

/** The arguments after `node` for a node:test suite. */
export function nodeTestArgs(def: Pick<SuiteDef, 'files' | 'tsx'>, o: { reporterUrl: string; logFile: string }): string[] {
  return [
    ...(def.tsx ? ['--import', 'tsx'] : []),
    '--test',
    '--test-reporter', o.reporterUrl,
    '--test-reporter-destination', 'stdout',
    '--test-reporter', 'spec',
    '--test-reporter-destination', o.logFile,
    ...(def.files ?? []),
  ];
}

// --- reading results ----------------------------------------------------------------------------

export interface TestFailure {
  name: string;
  file: string | null;
  error: string;
}

export interface TestCounts {
  tests: number;
  pass: number;
  fail: number;
  skipped: number;
  todo: number;
  cancelled: number;
  failures: TestFailure[];
  /** node's own totals arrived (they replace the running count). */
  final: boolean;
  /** Per test file, the first error line it wrote to stderr (why a file that cannot load failed). */
  stderrErrors: Record<string, string>;
}

export const newCounts = (): TestCounts => ({ tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0, failures: [], final: false, stderrErrors: {} });

/** node's whole message for a test file that failed outside any test (it did not load, or it threw at the top). */
const vague = (e: string): boolean => e === '' || e === 'test failed';

/**
 * One line of reporter.mjs's output. Returns false for a line that is not one
 * of its events (a test printing to stdout, a warning) - the caller logs those.
 */
export function applyReporterLine(c: TestCounts, line: string): boolean {
  if (!line.startsWith('{"t":')) return false;
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (ev.t === 'stderr' && typeof ev.file === 'string' && typeof ev.error === 'string') {
    if (!c.stderrErrors[ev.file]) c.stderrErrors[ev.file] = ev.error;
    for (const f of c.failures) if (f.file === ev.file && vague(f.error)) f.error = ev.error;
    return true;
  }
  if (ev.t === 'pass' || ev.t === 'fail') {
    const suite = ev.kind === 'suite';
    if (ev.t === 'fail') {
      const file = typeof ev.file === 'string' ? ev.file : null;
      const error = String(ev.err ?? '').split('\n')[0]!.slice(0, 300);
      c.failures.push({ name: String(ev.name ?? '?'), file, error: vague(error) && file && c.stderrErrors[file] ? c.stderrErrors[file]! : error });
    }
    if (c.final || suite) return true;
    c.tests++;
    if (ev.skip === true) c.skipped++;
    else if (ev.todo === true) c.todo++;
    else if (ev.t === 'pass') c.pass++;
    else c.fail++;
    return true;
  }
  if (ev.t === 'diag' && typeof ev.message === 'string') {
    const m = /^(tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(ev.message);
    if (m && (ev.nesting === 0 || ev.nesting === undefined)) {
      // node's totals at the end of the run: authoritative.
      c.final = true;
      c[m[1] as 'tests' | 'pass' | 'fail' | 'cancelled' | 'skipped' | 'todo'] = Number(m[2]);
    }
    return true;
  }
  return ev.t === 'summary';
}

/** "1234 passed, 2 failed, 3 skipped". */
export function countsText(c: TestCounts): string {
  const parts = [`${c.pass} passed`, `${c.fail} failed`];
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  if (c.todo) parts.push(`${c.todo} todo`);
  if (c.cancelled) parts.push(`${c.cancelled} cancelled`);
  return parts.join(', ');
}

/** A node:test suite passed when the process said so AND something ran AND nothing failed. */
export function testVerdict(c: TestCounts, exitCode: number | null, timedOut: boolean): { ok: boolean; detail: string } {
  if (timedOut) return { ok: false, detail: `timed out (${countsText(c)} before that)` };
  if (c.fail > 0 || c.cancelled > 0) return { ok: false, detail: `${countsText(c)}${c.failures[0] ? ` - first: ${c.failures[0].name}` : ''}` };
  if (exitCode !== 0) return { ok: false, detail: `the test runner exited with code ${exitCode} (${countsText(c)})` };
  if (c.tests === 0) return { ok: false, detail: 'no test ran' };
  return { ok: true, detail: countsText(c) };
}

export interface TscResult {
  errors: number;
  files: number;
  first: string[];
}

/** tsc's output: `path(line,col): error TS1234: message`. */
export function parseTscOutput(lines: readonly string[]): TscResult {
  const errs = lines.filter((l) => /\berror TS\d+:/.test(l));
  const files = new Set(errs.map((l) => /^(.+?)\(\d+,\d+\): error/.exec(l)?.[1]).filter(Boolean));
  return { errors: errs.length, files: files.size, first: errs.slice(0, 5).map((l) => l.trim().slice(0, 240)) };
}

/** `Ran 12 test suites in 3.4s (...): 310 tests passed, 0 failed, 2 skipped (312 total tests)`. */
export function parseForgeOutput(lines: readonly string[]): { passed: number; failed: number; skipped: number } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /(\d+) tests? passed, (\d+) failed, (\d+) skipped/.exec(lines[i]!);
    if (m) return { passed: Number(m[1]), failed: Number(m[2]), skipped: Number(m[3]) };
  }
  return null;
}
