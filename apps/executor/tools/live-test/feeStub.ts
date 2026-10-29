/**
 * The follower's 14-day volume as the runner wants the executor to see it: a
 * loopback stand-in for the API server's GET /api/vs/builder/volume, where a
 * hosted executor reads the volume its copy fee step comes from
 * (EXECUTOR_BUILDER_URL and EXECUTOR_BUILDER_TOKEN, apps/executor/src/service.ts
 * volumeFromApi). Self target only (capability localFeeStub): the executor
 * started here is given its URL and token, and asks it exactly as it would ask
 * the API server - so the fee scenarios (scenarios/fees.ts) can put the
 * follower on any step of the ladder and read on SoDEX what the orders carry.
 *
 * It answers $0 (the ladder's first step, what a local executor charged before
 * it had a volume source) unless a fee scenario sets another volume or a
 * failure. The executor keeps an answer 10 minutes (VOLUME_TTL_MS): a scenario
 * restarts it after changing the answer, and the runner's cleanup sets the
 * default again and restarts it, so the next scenario starts on the first step.
 *
 * Every read is recorded and checked as the API server checks it, and more:
 * the internal token (else 404, like the server), the follower's address, the
 * builder, and the ladder's window of 14 days (COPY_FEE_WINDOW_DAYS).
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { COPY_FEE_WINDOW_DAYS } from '../../../../packages/copy-engine/src/index.ts';

export const VOLUME_PATH = '/api/vs/builder/volume';

/** What the stub answers: a volume in USD, or an HTTP failure (500: the ledger cannot be read). */
export type VolumeAnswer = { usd: number } | { status: number };
export const DEFAULT_VOLUME: VolumeAnswer = { usd: 0 };

/** One read the executor made. */
export interface VolumeRead {
  at: number;
  address: string | null;
  builder: string | null;
  days: string | null;
  /** The HTTP status it was answered with. */
  status: number;
  /** What was wrong with the request, or null. */
  problem: string | null;
}

export class VolumeStub {
  readonly token = randomBytes(24).toString('hex');
  answer: VolumeAnswer = DEFAULT_VOLUME;
  readonly reads: VolumeRead[] = [];
  /** The builder the executor's orders carry (its /info), once known: a read for another is a problem. */
  builder: number | null = null;
  private server: Server | null = null;
  private port = 0;

  constructor(readonly follower: string) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}${VOLUME_PATH}`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const s = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => resolve());
    });
    // It must not keep the runner alive on its own.
    s.unref();
    this.server = s;
    this.port = (s.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  /** Back to the default answer; true when it was another (the executor may still hold that one: restart it). */
  reset(): boolean {
    const was = this.answer;
    this.answer = DEFAULT_VOLUME;
    return !('usd' in was && was.usd === 0);
  }

  /** What was wrong with the reads from index `from` on: a missing token, another wallet or builder, another window. */
  problems(from = 0): string[] {
    return this.reads.slice(from).flatMap((r) => (r.problem ? [r.problem] : []));
  }

  /** The answer to one request (its path and query, its X-Internal-Token), and what is recorded of it. */
  judge(path: string, token: string | undefined): { status: number; body: unknown; read: VolumeRead } {
    const u = new URL(path, 'http://127.0.0.1');
    const q = u.searchParams;
    const read: VolumeRead = { at: Date.now(), address: q.get('address'), builder: q.get('builder'), days: q.get('days'), status: 200, problem: null };
    const answer = (status: number, body: unknown, problem: string | null = null) => {
      read.status = status;
      read.problem = problem;
      return { status, body, read };
    };
    if (u.pathname !== VOLUME_PATH) return answer(404, { error: 'not found' }, `asked ${u.pathname}`);
    // As the API server: without the internal token the path does not exist.
    if (token !== this.token) return answer(404, { error: 'not found' }, 'without the internal token (X-Internal-Token)');
    if (read.address?.toLowerCase() !== this.follower.toLowerCase()) return answer(400, { ok: false, error: 'another wallet' }, `for ${read.address}, not the follower ${this.follower}`);
    if (this.builder !== null && read.builder !== String(this.builder)) return answer(400, { ok: false, error: 'another builder' }, `for builder ${read.builder}, not ${this.builder}`);
    if (read.days !== String(COPY_FEE_WINDOW_DAYS)) return answer(400, { ok: false, error: 'another window' }, `over ${read.days} days, not the ladder's ${COPY_FEE_WINDOW_DAYS}`);
    const a = this.answer;
    if ('status' in a) return answer(a.status, { ok: false, code: 'unavailable', error: 'the builder ledger is not open' });
    return answer(200, { ok: true, usd: a.usd, days: COPY_FEE_WINDOW_DAYS });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const t = req.headers['x-internal-token'];
    const r = this.judge(req.url ?? '/', Array.isArray(t) ? t[0] : t);
    this.reads.push(r.read);
    res.statusCode = r.status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(r.body));
  }
}
