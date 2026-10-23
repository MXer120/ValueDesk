/**
 * Start an executor: `npm start` here, `node valuedesk-copier.mjs` from the
 * self-host bundle, or the valuescan-executor unit on ValueDesk's server.
 */
import { join } from 'node:path';
import type { Logger } from '../../../packages/copy-engine/src/index.ts';
import { loadConfig } from './config.ts';
import { egress } from './net.ts';
import { ExecutorDb } from './db.ts';
import { Secrets } from './secrets.ts';
import { createExecutorServer } from './server.ts';
import { ExecutorService } from './service.ts';

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

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = logger(cfg.logLevel);
  if (typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'function') {
    throw new Error('This Node.js has no WebSocket; use Node 22 or newer.');
  }
  const db = new ExecutorDb(join(cfg.dataDir, 'executor.db'));
  const secrets = new Secrets(cfg.dataDir);
  const out = egress(cfg.localAddress);
  const svc = new ExecutorService(cfg, db, secrets, { fetch: out.fetch, factory: out.factory, log });
  await svc.start();
  const server = createExecutorServer(svc, cfg, log);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => resolve());
  });
  log.info('executor up', { kind: cfg.kind, id: svc.executorId, network: cfg.network, listen: `${cfg.host}:${cfg.port}`, data: cfg.dataDir, egress: out.localAddress ?? 'default route' });
  if (cfg.kind === 'self') {
    const owner = svc.owner();
    const lines = owner
      ? [`ValueDesk copier for ${owner} is running on http://${cfg.host}:${cfg.port}.`, 'In ValueDesk: Copy -> Set up -> Self-hosted, and enter that address.']
      : [
          `ValueDesk copier is running on http://${cfg.host}:${cfg.port}.`,
          'In ValueDesk: Copy -> Set up -> Self-hosted, enter that address and this pairing code:',
          '',
          `    ${svc.pairingCode}`,
          '',
          'The first wallet that signs in with the code is the only one this copier will ever serve.',
        ];
    process.stdout.write(`\n${lines.join('\n')}\n\n`);
  }
  const prune = setInterval(() => {
    try {
      const n = db.pruneActivity(Number(process.env.EXECUTOR_ACTIVITY_DAYS ?? 365));
      if (n) log.info('activity pruned', { rows: n });
    } catch (e) {
      log.warn('activity prune failed', { error: String(e) });
    }
  }, 6 * 60 * 60_000);
  prune.unref();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('executor stopping', { signal });
    server.close();
    await svc.stop().catch((e) => log.error('stop failed', { error: String(e) }));
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  process.stderr.write(`executor failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
