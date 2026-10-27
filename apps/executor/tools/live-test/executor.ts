/**
 * The executor the suite tests: a REAL executor process (apps/executor/src/main.ts,
 * the same entry point the hosted and self-hosted copiers start from), on this
 * machine, on a random loopback port, and the signed requests that drive it -
 * exactly what the web app sends (paper-run.ts does the same in-process).
 *
 * It is a separate process so the restart scenarios can kill it hard (no
 * shutdown code runs, as when a server loses power) and start it again on the
 * same data folder. It runs self-hosted for the follower wallet
 * (EXECUTOR_OWNER), so no pairing code is needed, with its own executor id
 * (requests signed for it cannot be replayed to ValueDesk's executor) and, for
 * a live run only, EXECUTOR_LIVE_ALGOS=1. A dry run leaves real algo orders
 * off in the executor too: a paper spec that came out live would be refused.
 *
 * Its environment is built from scratch: the env file's private keys are never
 * in it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAddress } from '../../../../packages/sodex-core/src/index.ts';
import {
  COPY_TERMS_VERSION,
  buildCopyRequest,
  copyRequestDigest,
  type ActivityEntry,
  type AlgoEvent,
  type AlgoView,
  type CopyAction,
  type CopyView,
  type ExecutorInfo,
  type MeResponse,
} from '../../../../packages/copy-engine/src/index.ts';
import { walletSign } from './exchange.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const EXECUTOR_DIR = join(HERE, '..', '..');

export interface ExecutorOptions {
  mode: 'live' | 'dry';
  owner: string;
  dataDir: string;
  logFile: string;
  executorId: string;
}

/** A free loopback port (the OS picks one; it is released before the executor binds it). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

/** Environment a child Node process needs on Windows and elsewhere, and nothing else. */
function baseEnv(): Record<string, string> {
  const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'ComSpec', 'PATHEXT'];
  const out: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) out[k] = process.env[k]!;
  return out;
}

export class ExecutorProcess {
  private child: ChildProcess | null = null;
  private log: WriteStream | null = null;
  port = 0;
  /** Set when the process exits on its own (a crash): the scenario that is running fails with it. */
  exited: { code: number | null; at: number } | null = null;

  constructor(readonly o: ExecutorOptions) {}

  get base(): string {
    return `http://127.0.0.1:${this.port}/api/copy/v1`;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get running(): boolean {
    return this.child !== null && this.exited === null;
  }

  /** Start it (on the same port and data folder as before, after a kill) and wait until /health answers ok. */
  async start(): Promise<void> {
    if (this.running) return;
    mkdirSync(this.o.dataDir, { recursive: true });
    mkdirSync(dirname(this.o.logFile), { recursive: true });
    if (!this.port) this.port = await freePort();
    this.log ??= createWriteStream(this.o.logFile, { flags: 'a' });
    this.log.write(`\n--- start ${new Date().toISOString()} ---\n`);
    const env: Record<string, string> = {
      ...baseEnv(),
      EXECUTOR_KIND: 'self',
      EXECUTOR_OWNER: this.o.owner,
      EXECUTOR_ID: this.o.executorId,
      EXECUTOR_DATA_DIR: this.o.dataDir,
      HOST: '127.0.0.1',
      PORT: String(this.port),
      SODEX_NETWORK: 'mainnet',
      EXECUTOR_ALLOWED_ORIGINS: 'http://localhost',
      LOG_LEVEL: 'info',
      ...(this.o.mode === 'live' ? { EXECUTOR_LIVE_ALGOS: '1' } : {}),
    };
    // One process (no tsx wrapper), so a kill stops the executor itself and not just a launcher.
    const loader = import.meta.resolve('tsx');
    this.exited = null;
    const child = spawn(process.execPath, ['--import', loader, '--disable-warning=ExperimentalWarning', join(EXECUTOR_DIR, 'src', 'main.ts')], {
      cwd: EXECUTOR_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.on('data', (d: Buffer) => this.log?.write(d));
    child.stderr?.on('data', (d: Buffer) => this.log?.write(d));
    child.once('exit', (code) => {
      if (this.child === child) this.exited = { code, at: Date.now() };
      this.log?.write(`--- exit ${code} ${new Date().toISOString()} ---\n`);
    });
    const until = Date.now() + 90_000;
    while (Date.now() < until) {
      const ex = this.exited as { code: number | null } | null;
      if (ex) throw new Error(`the executor exited at start (code ${ex.code}); see ${this.o.logFile}`);
      try {
        const r = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(2_000) });
        if (r.ok && ((await r.json()) as { ok?: boolean }).ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`the executor did not answer /health within 90 s; see ${this.o.logFile}`);
  }

  /** Kill it hard: no shutdown code runs. Resolves once the process is gone. */
  async kill(): Promise<void> {
    const c = this.child;
    if (!c || this.exited) {
      this.child = null;
      return;
    }
    const gone = new Promise<void>((r) => c.once('exit', () => r()));
    c.kill('SIGKILL');
    await Promise.race([gone, new Promise((r) => setTimeout(r, 10_000))]);
    this.child = null;
    this.exited = { code: null, at: Date.now() };
  }

  async restart(downMs = 0): Promise<void> {
    await this.kill();
    if (downMs) await new Promise((r) => setTimeout(r, downMs));
    this.exited = null;
    await this.start();
  }

  close(): void {
    this.log?.end();
    this.log = null;
  }
}

/** A wallet that signs CopyRequests: the follower's master key (live) or a throwaway one (dry). */
export class CopyWallet {
  readonly address: string;
  private last = 0;
  constructor(private readonly pk: Uint8Array) {
    this.address = privateKeyToAddress(pk).toLowerCase();
  }

  sign(executor: string, action: CopyAction, payload: unknown) {
    // The nonce is the time in ms: two requests in one millisecond would be the same request.
    const now = Math.max(Date.now(), this.last + 1);
    this.last = now;
    const r = buildCopyRequest({ action, owner: this.address, executor, payload, chainId: 286623, now });
    return { ...r, signature: walletSign(copyRequestDigest(r), this.pk) };
  }
}

export class ExecutorError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Every `paper` flag in a spec (its own and a conditional's inner algo's): a dry run refuses anything but true. */
export function assertPaper(spec: Record<string, unknown>): void {
  if (spec.paper !== true) throw new Error(`dry run: refusing a spec that is not paper (${String(spec.kind)})`);
  const then = spec.then as { type?: string; algo?: Record<string, unknown> } | undefined;
  if (then?.type === 'algo' && then.algo && then.algo.paper !== undefined && then.algo.paper !== true) throw new Error('dry run: refusing a conditional whose algo is not paper');
}

/** The executor's API as the web app uses it, signed by the follower's wallet. */
export class ExecutorClient {
  private token: string | null = null;

  constructor(
    private readonly proc: ExecutorProcess,
    readonly wallet: CopyWallet,
    readonly executorId: string,
    readonly mode: 'live' | 'dry',
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, auth = false): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (auth) headers.Authorization = `Bearer ${await this.session()}`;
      let res: Response;
      try {
        res = await fetch(this.proc.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
      } catch (e) {
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1_000));
          continue;
        }
        throw e;
      }
      const data = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
      if (res.ok) return data as T;
      // The executor's own limiter (40 writes, 240 reads a minute per client): wait and go on.
      if (res.status === 429 && data.code === 'rate' && attempt < 6) {
        await new Promise((r) => setTimeout(r, 10_000));
        continue;
      }
      if (res.status === 401 && auth && attempt < 1) {
        this.token = null;
        continue;
      }
      throw new ExecutorError(res.status, String(data.code ?? res.status), `${path}: ${res.status} ${data.code ?? ''} ${data.error ?? ''}`.trim());
    }
  }

  private post<T>(path: string, action: CopyAction, payload: unknown): Promise<T> {
    return this.call<T>('POST', path, { request: this.wallet.sign(this.executorId, action, payload) });
  }

  async session(): Promise<string> {
    if (!this.token) this.token = (await this.post<{ token: string }>('/session', 'session', {})).token;
    return this.token;
  }

  info(): Promise<ExecutorInfo> {
    return this.call('GET', '/info');
  }

  acceptTerms(country: string, termsHash: string): Promise<MeResponse> {
    return this.post('/terms', 'accept-terms', { termsVersion: COPY_TERMS_VERSION, termsHash, country, adult: true, notUsPerson: true, ownDecision: true, risksUnderstood: true });
  }

  me(): Promise<MeResponse> {
    return this.call('GET', '/me', undefined, true);
  }

  createKey(days: number): Promise<{ address: string; name: string; maxDays: number; days: number }> {
    return this.post('/keys', 'create-key', { days });
  }

  async verifyKey(): Promise<MeResponse['key']> {
    return (await this.call<{ key: MeResponse['key'] }>('POST', '/keys/verify', {}, true)).key;
  }

  async importKey(name: string, envelope: unknown): Promise<MeResponse['key']> {
    return (await this.call<{ key: MeResponse['key'] }>('POST', '/keys/import', { name, envelope }, true)).key;
  }

  /* ------------------------------------------------------------ algos ----- */

  async algoStart(spec: Record<string, unknown>, seed = Math.floor(Math.random() * 2 ** 32)): Promise<AlgoView> {
    if (this.mode === 'dry') assertPaper(spec);
    return this.post('/algos', 'algo-start', { spec, seed });
  }

  async algoAct(op: 'pause' | 'resume' | 'cancel' | 'cancel-all', id?: string): Promise<AlgoView[]> {
    return (await this.post<{ algos: AlgoView[] }>('/algos/action', 'algo-action', id ? { op, id } : { op })).algos;
  }

  async algos(): Promise<AlgoView[]> {
    return (await this.call<{ algos: AlgoView[] }>('GET', '/algos', undefined, true)).algos;
  }

  async algo(id: string): Promise<AlgoView> {
    const v = (await this.algos()).find((x) => x.algo.id === id);
    if (!v) throw new Error(`the executor does not list algo ${id}`);
    return v;
  }

  async events(id: string, limit = 200): Promise<AlgoEvent[]> {
    return (await this.call<{ events: AlgoEvent[] }>('GET', `/algos/${id}/events?limit=${limit}`, undefined, true)).events;
  }

  /* ----------------------------------------------------------- copies ----- */

  async subscribe(settings: Record<string, unknown>): Promise<CopyView> {
    if (this.mode === 'dry' && settings.paper !== true) throw new Error('dry run: refusing a copy that is not paper');
    return this.post('/copies', 'subscribe', { settings, termsVersion: COPY_TERMS_VERSION });
  }

  async copyAct(action: 'update' | 'pause' | 'resume' | 'stop' | 'stop-all', payload: Record<string, unknown>): Promise<CopyView[]> {
    if (this.mode === 'dry' && action === 'update' && (payload.settings as { paper?: unknown } | undefined)?.paper !== true) throw new Error('dry run: refusing a copy update that is not paper');
    return (await this.post<{ copies: CopyView[] }>('/copies/action', action, payload)).copies;
  }

  async copy(id: string): Promise<CopyView> {
    const v = (await this.me()).copies.find((c) => c.subscription.id === id);
    if (!v) throw new Error(`the executor does not list copy ${id}`);
    return v;
  }

  async activity(id: string, limit = 200): Promise<ActivityEntry[]> {
    return (await this.call<{ entries: ActivityEntry[] }>('GET', `/copies/${id}/activity?limit=${limit}`, undefined, true)).entries;
  }

  /** Everything this wallet runs here stops: the kill switch for algos, every copy stopped and closed. */
  async stopEverything(): Promise<void> {
    await this.algoAct('cancel-all').catch(() => undefined);
    await this.copyAct('stop-all', { close: true }).catch(() => undefined);
  }
}
