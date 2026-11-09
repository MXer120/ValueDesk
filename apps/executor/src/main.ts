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
import { Alerts, ReachWatch, lastRunCrashed, maintenanceFor, telegramSender } from './alerts.ts';

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
  // A copier on someone's own machine: nothing it writes (its database, the WAL, the lock) is for other accounts there.
  if (cfg.kind === 'self') process.umask(0o077);
  const alerts = new Alerts({
    sender: telegramSender({ token: cfg.alertTelegramToken, chatId: cfg.alertTelegramChatId }),
    label: `${process.env.EXECUTOR_ID?.trim() || (cfg.kind === 'hosted' ? 'hosted executor' : 'self-hosted copier')} (${cfg.network})`,
    log,
  });
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
    alerts.stop();
    server.close();
    await svc?.stop().catch((e) => log.error('stop failed', { error: String(e) }));
    db?.close();
    await alerts.drain(2_000);
    process.exit(code);
  };
  // One unexpected error must not leave a half-working executor running every wallet's copies.
  // The operator hears of it (the message carries the error's first line, not its stack); the send gets a moment before exit.
  const fatal = (why: string, e: unknown) => {
    const first = (e instanceof Error ? e.message : String(e)).split(/\r?\n/)[0] ?? '';
    alerts.raise('fatal', '', `${why}: ${first.slice(0, 200)}. systemd starts it again.`);
    void shutdown(why, 1);
  };
  process.on('unhandledRejection', (e) => {
    log.error('unhandled rejection', { error: e instanceof Error ? e.stack ?? e.message : String(e) });
    fatal('unhandled rejection', e);
  });
  process.on('uncaughtException', (e) => {
    log.error('uncaught exception', { error: e.stack ?? e.message });
    fatal('uncaught exception', e);
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
  alerts.start();
  const crashed = lastRunCrashed(db);
  if (crashed) {
    // Killed inside a maintenance window for the executor (maint.sh: the live suite's crash test, a planned
    // restart): planned, so the log only - every one of those kills was a Telegram FAILURE until 2026-10-31.
    const planned = cfg.kind === 'hosted' ? maintenanceFor(process.env.EXECUTOR_MAINT_FILE?.trim() || '/var/lib/valuescan/maintenance.json', 'executor') : null;
    log.warn('executor: the last run crashed', { what: crashed, ...(planned ? { maintenance: planned } : {}) });
    if (!planned) alerts.raise('crash-restart', '', `Started again: ${crashed}.`);
  }
  // The whole audit chain, once at start (then hourly, only the rows added since).
  let auditHead: { seq: number; hash: string } | null = null;
  const verifyAudit = () => {
    try {
      const t0 = Date.now();
      const v = db!.verifyAudit(auditHead ?? undefined);
      if (v.brokenAt !== null) {
        log.error('executor: the audit chain is broken', { at: v.brokenAt });
        alerts.raise('audit-broken', '', `The audit log's hash chain breaks at row ${v.brokenAt}: a row was changed or removed. Run tools/audit.ts verify on the server.`);
        auditHead = null;
      } else {
        auditHead = v.head;
        log.info('audit verified', { rows: v.rows, ms: Date.now() - t0 });
      }
    } catch (e) {
      log.warn('audit verify failed', { error: String(e) });
    }
  };
  verifyAudit();
  // One more account socket per extra address: SoDEX follows 10 wallets per IP (bots always live, owner 2026-11-09).
  const accountFactories = cfg.wsAddresses.map((a) => egress(a).factory);
  svc = new ExecutorService(cfg, db, secrets, { fetch: out.fetch, factory: out.factory, log, alerts, accountFactories });
  if (cfg.kind === 'self') {
    const shownHost = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
    process.stdout.write(selfBanner({ url: `http://${shownHost}:${cfg.port}`, dataDir: cfg.dataDir, owner: svc.owner(), code: svc.pairingCode }));
  }
  db.audit('process', null, null, { event: 'start', pid: process.pid, kind: cfg.kind, id: svc.executorId, network: cfg.network, liveAlgos: cfg.liveAlgos, liveAlgoWallets: cfg.liveAlgoWallets, brake: svc.brake.current() });
  await svc.start();
  log.info('executor up', { kind: cfg.kind, id: svc.executorId, network: cfg.network, listen: `${cfg.host}:${cfg.port}`, data: cfg.dataDir, egress: out.localAddress ?? 'default route', liveAlgos: cfg.liveAlgos, liveAlgoWallets: cfg.liveAlgoWallets });

  const prune = setInterval(() => {
    try {
      // Only with the owner's word: EXECUTOR_ACTIVITY_DAYS set (unset keeps every row - nothing is
      // deleted for being old without it, server retention.ts).
      const days = Number(process.env.EXECUTOR_ACTIVITY_DAYS);
      const n = days > 0 ? db?.pruneActivity(days) ?? 0 : 0;
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
  const anchoring = setInterval(() => {
    anchor();
    // Rows the chain did not have an hour ago: a break shows within the hour, not at the next restart.
    if (auditHead) verifyAudit();
  }, 60 * 60_000);
  anchoring.unref();

  // SoDEX unreachable for 3 minutes (and back): from the REST answers every copy and algo reads.
  const reach = new ReachWatch(alerts);
  const watching = setInterval(() => {
    if (svc) reach.check(svc.sodex.reach);
    alerts.flush();
  }, 30_000);
  watching.unref();
}

main().catch((e) => {
  // Most people who read this run their own copier; the hosted executor's journal gets the same line.
  const what = process.env.EXECUTOR_KIND?.trim() === 'hosted' ? 'The executor' : 'The copier';
  process.stderr.write(`\n${what} could not start: ${e instanceof Error ? e.message : String(e)}\n\n`);
  process.exit(1);
});
