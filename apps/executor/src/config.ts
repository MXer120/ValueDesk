/**
 * The executor's settings, from the environment.
 *
 *   EXECUTOR_KIND            self (default) | hosted
 *   HOST / PORT              where it listens (default 127.0.0.1:8799)
 *   EXECUTOR_DATA_DIR        its database, the key-encryption key, the session secret
 *                            (default ./copier-data for self, /var/lib/valuescan/executor for hosted)
 *   SODEX_NETWORK            mainnet (default) | testnet
 *   EXECUTOR_BUILDER_ID      the builder copied orders carry (default ValueDesk's, 221909; 0 = none)
 *   EXECUTOR_OWNER           self: the one wallet it serves (otherwise paired with a code at first use)
 *   EXECUTOR_ALLOWED_ORIGINS comma-separated web origins allowed to call it (CORS)
 *   EXECUTOR_LOCATION        shown to followers, e.g. "ap-northeast-1 (Tokyo)"
 *   EXECUTOR_ORIGIN_SECRET   hosted: the edge's X-Origin-Verify value (requests without it are refused)
 *   EXECUTOR_TRUST_EDGE      hosted: 1 = read the viewer's address and country from the edge's headers
 *   EXECUTOR_OPEN            hosted: 0 closes it to new followers (running copies continue)
 *   EXECUTOR_KEY_TTL_DAYS    the longest key lifetime a follower may register (default 90)
 *   EXECUTOR_MAX_COPIES      copies per wallet (default 10)
 *   EXECUTOR_BUILDER_DB      hosted: the builder ledger (read-only) the copy fee tier is read from
 *   EXECUTOR_LOCAL_ADDRESS   send every request and socket to SoDEX / Hyperliquid from this local
 *                            IP (an address of its own, so another process's rate limit cannot stop copies)
 *   LOG_LEVEL                debug | info (default) | warn | error
 */
import { join, resolve } from 'node:path';

export type ExecutorKind = 'hosted' | 'self';

export interface ExecutorConfig {
  kind: ExecutorKind;
  host: string;
  port: number;
  dataDir: string;
  network: 'mainnet' | 'testnet';
  builderId: number;
  owner: string | null;
  allowedOrigins: string[];
  location: string;
  originSecrets: string[];
  trustEdge: boolean;
  open: boolean;
  keyTtlDaysMax: number;
  maxCopiesPerOwner: number;
  builderDb: string | null;
  localAddress: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const DEFAULT_ORIGINS = ['https://valuedeskapp.vercel.app', 'https://valuexplorer.vercel.app', 'http://localhost:5180', 'http://127.0.0.1:5180'];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ExecutorConfig {
  const kind: ExecutorKind = env.EXECUTOR_KIND === 'hosted' ? 'hosted' : 'self';
  const port = Number(env.PORT ?? 8799);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`PORT must be a port number (got ${env.PORT})`);
  const owner = env.EXECUTOR_OWNER?.trim() || null;
  if (owner && !ADDRESS.test(owner)) throw new Error('EXECUTOR_OWNER must be a 0x wallet address');
  const network = env.SODEX_NETWORK === 'testnet' ? 'testnet' : 'mainnet';
  const builderId = Number(env.EXECUTOR_BUILDER_ID ?? 221909);
  if (!Number.isSafeInteger(builderId) || builderId < 0) throw new Error('EXECUTOR_BUILDER_ID must be a SoDEX account id (or 0 for none)');
  const ttl = Number(env.EXECUTOR_KEY_TTL_DAYS ?? 90);
  const level = env.LOG_LEVEL;
  return {
    kind,
    host: env.HOST?.trim() || '127.0.0.1',
    port,
    dataDir: resolve(env.EXECUTOR_DATA_DIR?.trim() || (kind === 'hosted' ? '/var/lib/valuescan/executor' : join(process.cwd(), 'copier-data'))),
    network,
    builderId,
    owner: owner ? owner.toLowerCase() : null,
    allowedOrigins: (env.EXECUTOR_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? DEFAULT_ORIGINS),
    location: env.EXECUTOR_LOCATION?.trim() || (kind === 'hosted' ? 'ap-northeast-1 (Tokyo)' : 'your own machine'),
    originSecrets: [env.EXECUTOR_ORIGIN_SECRET, env.EXECUTOR_ORIGIN_SECRET_2].map((s) => s?.trim() ?? '').filter(Boolean),
    trustEdge: env.EXECUTOR_TRUST_EDGE === '1',
    open: env.EXECUTOR_OPEN !== '0',
    // 90 days is what the copy terms promise and what the web app registers at most.
    keyTtlDaysMax: Number.isFinite(ttl) && ttl >= 1 ? Math.min(Math.floor(ttl), 90) : 90,
    maxCopiesPerOwner: Math.max(1, Math.min(50, Number(env.EXECUTOR_MAX_COPIES ?? 10) || 10)),
    builderDb: env.EXECUTOR_BUILDER_DB?.trim() || null,
    localAddress: env.EXECUTOR_LOCAL_ADDRESS?.trim() || null,
    logLevel: level === 'debug' || level === 'warn' || level === 'error' ? level : 'info',
  };
}
