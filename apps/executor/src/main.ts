/**
 * Start an executor: `npm start` here, `node valuedesk-copier.mjs` from the
 * self-host bundle, or the valuescan-executor unit on ValueDesk's server.
 *
 * The order matters. The port is bound first: a second copier on the same
 * port stops there, before it could trade. The database is opened next, and
 * its lock refuses a second executor on the same data folder. Only then do the
 * copies and algos start. A stray error anywhere is logged and the executor
 * shuts down cleanly (systemd, Docker or the user starts it again) rather than
 * running on in a state nobody checked.
 */
import { join } from 'node:path';
import type { Logger } from '../../../packages/copy-engine/src/index.ts';
import { loadConfig } from './config.ts';
import { egress } from './net.ts';
import { ExecutorDb } from './db.ts';
import { Secrets } from './secrets.ts';
import { createExecutorServer } from './server.ts';
import { ApiError, ExecutorService } from './service.ts';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

function logger(level: keyof typeof LEVELS): Logger {
  const at = LEVELS[level];
  const out = (l: keyof typeof LEVELS) => (msg: string, data?: Record<string, unknown>) => {
    if (LEVELS[l] < at) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level: l, msg, ...(data ?? {}) });
    (l === 'error' || l === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return { debug: out('debug'), info: out('info'), warn: out('warn'), error: out('error') };
}

/** What a person running their own copier needs to read first: where it is and how to connect it. */
function selfBanner(o: { url: string; dataDir: string; owner: string | null; code: string | null }): string {
  const lines = [
    '',
    `  ValueDesk copier is running on ${o.url}`,
    '',
    ...(o.owner
      ? [`  It serves the wallet ${o.owner}.`, '  In ValueDesk (https://www.valuedesk.so): Copy -> Set up -> Self-hosted, and enter the address above.']
      : [
          '  To connect it: in ValueDesk (https://www.valuedesk.so) open Copy -> Set up -> Self-hosted,',
          '  enter the address above and this pairing code:',
          '',
          `      ${o.code}`,
          '',
          '  The first wallet that signs in with the code is the only one this copier will ever serve.',
        ]),
    '',
    `  Its data (keep this folder private, and back it up): ${o.dataDir}`,
    '  Keep this window open while you copy. Ctrl+C stops it; open positions and their stop orders stay on SoDEX.',
    '',
  ];
  return lines.join('\n') + '\n';
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = logger(cfg.logLevel);
  if (typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'function') {
    throw new Error(`This Node.js (${process.version}) has no WebSocket; the copier needs Node.js 22.13 or newer.`);
  }

  let svc: ExecutorService | null = null;
  let db: ExecutorDb | null = null;
  let stopping = false;
  const shutdown = async (why: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    log.info('executor stopping', { why });
    db?.audit('process', null, null, { event: 'stop', why, pid: process.pid });
    server.close();
    await svc?.stop().catch((e) => log.error('stop failed', { error: String(e) }));
    db?.close();
    process.exit(code);
  };
  // One unexpected error must not leave a half-working executor running every wallet's copies.
  process.on('unhandledRejection', (e) => {
    log.error('unhandled rejection', { error: e instanceof Error ? e.stack ?? e.message : String(e) });
    void shutdown('unhandled rejection', 1);
  });
  process.on('uncaughtException', (e) => {
    log.error('uncaught exception', { error: e.stack ?? e.message });
    void shutdown('uncaught exception', 1);
  });
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // The service is made below; until then every request is answered "starting".
  const server = createExecutorServer(
    new Proxy({} as ExecutorService, {
      get: (_t, prop) => {
        if (!svc) throw new ApiError(503, 'starting', 'The executor is starting; try again in a moment.');
        const v = (svc as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(svc) : v;
      },
    }),
    cfg,
    log,
  );
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'EADDRINUSE' ? new Error(`Port ${cfg.port} on ${cfg.host} is already in use - is another copier (or another program) running? Set PORT to use another one.`) : e),
    );
    server.listen(cfg.port, cfg.host, () => resolve());
  });

  db = new ExecutorDb(join(cfg.dataDir, 'executor.db'));
  const secrets = new Secrets(cfg.dataDir);
  const out = egress(cfg.localAddress);
  svc = new ExecutorService(cfg, db, secrets, { fetch: out.fetch, factory: out.factory, log });
  if (cfg.kind === 'self') {
    const shownHost = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
    process.stdout.write(selfBanner({ url: `http://${shownHost}:${cfg.port}`, dataDir: cfg.dataDir, owner: svc.owner(), code: svc.pairingCode }));
  }
  db.audit('process', null, null, { event: 'start', pid: process.pid, kind: cfg.kind, id: svc.executorId, network: cfg.network, liveAlgos: cfg.liveAlgos, brake: svc.brake.current() });
  await svc.start();
  log.info('executor up', { kind: cfg.kind, id: svc.executorId, network: cfg.network, listen: `${cfg.host}:${cfg.port}`, data: cfg.dataDir, egress: out.localAddress ?? 'default route', liveAlgos: cfg.liveAlgos });

  const prune = setInterval(() => {
    try {
      const n = db?.pruneActivity(Number(process.env.EXECUTOR_ACTIVITY_DAYS ?? 365)) ?? 0;
      if (n) log.info('activity pruned', { rows: n });
    } catch (e) {
      log.warn('activity prune failed', { error: String(e) });
    }
  }, 6 * 60 * 60_000);
  prune.unref();

  // The audit log's head, into the service log (journald, kept a year and backed up apart from the
  // database) every hour: a row cut from the end of the chain would otherwise leave no trace.
  const anchor = () => {
    const head = db?.auditRows({ limit: 1 })[0];
    if (head) log.info('audit head', { seq: head.seq, at: head.at, hash: head.hash });
  };
  anchor();
  const anchoring = setInterval(anchor, 60 * 60_000);
  anchoring.unref();
}

main().catch((e) => {
  // Most people who read this run their own copier; the hosted executor's journal gets the same line.
  const what = process.env.EXECUTOR_KIND?.trim() === 'hosted' ? 'The executor' : 'The copier';
  process.stderr.write(`\n${what} could not start: ${e instanceof Error ? e.message : String(e)}\n\n`);
  process.exit(1);
});
