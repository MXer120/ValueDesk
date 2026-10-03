/**
 * Child processes: started without a shell (the repository path has spaces),
 * their output read line by line, and - above all - their ENVIRONMENT built
 * here on purpose.
 *
 * `childEnv` is the only place an environment for a child is made. It never
 * carries VS_E2E_KEY unless a key is handed to that one call, and the guide
 * hands it to exactly one kind of child: the live runner.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GUIDE_DIR = dirname(fileURLToPath(import.meta.url));
export const WEB_DIR = resolve(GUIDE_DIR, '..', '..');
export const REPO_DIR = resolve(WEB_DIR, '..', '..');

/** The environment variable the live runner reads its key from. Nothing else may ever receive it. */
export const KEY_ENV = 'VS_E2E_KEY';

/**
 * An environment for a child: this process's, without the key variable, with
 * colour switched off. `key` set: that child - and only that child - gets it.
 */
export function childEnv(base: NodeJS.ProcessEnv, key: string | null = null, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (k.toUpperCase() !== KEY_ENV && v !== undefined) env[k] = v;
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  Object.assign(env, extra);
  if (key) env[KEY_ENV] = key;
  return env;
}

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  onLine?: (line: string, from: 'out' | 'err') => void;
  timeoutMs?: number;
  /** Called with the child once it has started (so Ctrl+C handling knows about it). */
  onStart?: (child: ChildProcess) => void;
  /**
   * Lines typed while the child runs are handed to its stdin (the live run reads "s" to skip a
   * deposit the owner sends by hand). Without it the child's stdin is closed.
   */
  input?: { next: (ms: number) => Promise<string | null> };
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  ms: number;
  timedOut: boolean;
  /** The program could not be started at all (not installed, not found). */
  startError: string | null;
}

/** Stop a child and everything it started. */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Run a program to its end, handing each line of its output to `onLine`. Never throws. */
export function runProcess(program: string, args: readonly string[], o: RunOptions): Promise<RunResult> {
  return new Promise((done) => {
    const t0 = Date.now();
    let child: ChildProcess;
    try {
      child = spawn(program, [...args], { cwd: o.cwd, env: o.env, stdio: [o.input ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch (e) {
      done({ code: null, signal: null, ms: 0, timedOut: false, startError: (e as Error).message });
      return;
    }
    let timedOut = false;
    let settled = false;
    const timer = o.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, o.timeoutMs)
      : null;
    const flushers: Array<() => void> = [];
    for (const [stream, from] of [[child.stdout, 'out'], [child.stderr, 'err']] as const) {
      if (!stream) continue;
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          o.onLine?.(buf.slice(0, i).replace(/\r$/, ''), from);
          buf = buf.slice(i + 1);
        }
      });
      flushers.push(() => {
        if (buf) o.onLine?.(buf.replace(/\r$/, ''), from);
        buf = '';
      });
    }
    const finish =(r: Omit<RunResult, 'ms' | 'timedOut'>): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const f of flushers) f();
      done({ ...r, ms: Date.now() - t0, timedOut });
    };
    child.once('error', (e) => finish({ code: null, signal: null, startError: e.message }));
    child.once('close', (code, signal) => finish({ code, signal, startError: null }));
    o.onStart?.(child);
    if (o.input && child.stdin) {
      const stdin = child.stdin;
      stdin.on('error', () => undefined);
      void (async () => {
        while (!settled) {
          const line = await o.input!.next(1000).catch(() => null);
          if (line !== null && !settled && stdin.writable) stdin.write(`${line}\n`);
        }
      })();
    }
  });
}

/** Is this program installed (does `program --version` run)? */
export function hasProgram(program: string, args: readonly string[] = ['--version']): boolean {
  try {
    const r = spawnSync(program, [...args], { windowsHide: true, timeout: 20_000, stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

const requireFromWeb = createRequire(join(WEB_DIR, 'package.json'));

/** The file a package's `bin` points at (resolved the way apps/web resolves packages), or null. */
export function packageBin(pkg: string, bin?: string): string | null {
  try {
    const manifest = requireFromWeb.resolve(`${pkg}/package.json`);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const j = requireFromWeb(`${pkg}/package.json`) as { bin?: string | Record<string, string> };
    const rel = typeof j.bin === 'string' ? j.bin : j.bin?.[bin ?? pkg];
    return rel ? join(dirname(manifest), rel) : null;
  } catch {
    return null;
  }
}

export interface Toolchain {
  /** This Node. */
  node: string;
  /** tsx's command line (dist/cli.mjs). */
  tsxCli: string | null;
  /** TypeScript's compiler (bin/tsc). */
  tsc: string | null;
}

export function toolchain(): Toolchain {
  return { node: process.execPath, tsxCli: packageBin('tsx'), tsc: packageBin('typescript', 'tsc') };
}
