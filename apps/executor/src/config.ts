/**
 * The executor's settings, from the environment.
 *
 *   EXECUTOR_KIND            self (default) | hosted; anything else is refused
 *   HOST / PORT              where it listens (default 127.0.0.1:8799)
 *   EXECUTOR_DATA_DIR        its database, the key-encryption key, the session secret (default:
 *                            hosted /var/lib/valuescan/executor; self ./copier-data where one
 *                            already is, else the user's own app-data folder - see dataDirFor)
 *   SODEX_NETWORK            mainnet (default) | testnet
 *   EXECUTOR_BUILDER_ID      the builder copied orders carry (default ValueDesk's, 234812; 0 = none)
 *   EXECUTOR_OWNER           self: the one wallet it serves (otherwise paired with a code at first use)
 *   EXECUTOR_ALLOWED_ORIGINS comma-separated web origins allowed to call it (CORS)
 *   EXECUTOR_LOCATION        shown to followers, e.g. "ap-northeast-1 (Tokyo)"
 *   EXECUTOR_ORIGIN_SECRET   hosted: the edge's X-Origin-Verify value (requests without it are refused);
 *                            a hosted executor will not start without it, unless EXECUTOR_EDGE=none
 *   EXECUTOR_EDGE            none = no edge in front (a local development run or a test): hosted
 *                            without the origin secret, and never with EXECUTOR_TRUST_EDGE
 *   EXECUTOR_ID              the executor id requests are signed for (default: hosted
 *                            valuedesk-<network>-tokyo, the one every registered key names; set
 *                            another for staging so a signed request cannot be replayed between them)
 *   EXECUTOR_LIVE_ALGOS      1 = real (non-paper) algo orders may start, for every wallet; default off (practice only)
 *   EXECUTOR_LIVE_ALGOS_WALLETS  while EXECUTOR_LIVE_ALGOS is off, the wallets real algo orders may start for:
 *                            comma-separated 0x addresses, or * for every wallet; unset: none (e.g. the
 *                            owner's live test, apps/executor/tools/live-test --target hosted, for its follower)
 *   EXECUTOR_BRAKE_FILE      the operator's emergency brake (brake.ts; default: hosted
 *                            /var/lib/valuescan/brake.json, self <data dir>/brake.json; 'none' = no brake)
 *   EXECUTOR_TRUST_EDGE      hosted: 1 = read the viewer's address and country from the edge's headers
 *   EXECUTOR_OPEN            hosted: 0 closes it to new followers (running copies continue)
 *   EXECUTOR_KEY_TTL_DAYS    the longest key lifetime a follower may register (default and at most 180)
 *   EXECUTOR_MAX_COPIES      copies per wallet (default 10)
 *   EXECUTOR_MAX_ALGOS       live algo orders (TWAP, VWAP, ...) per wallet (default 20)
 *   EXECUTOR_BUILDER_DB      hosted: the builder ledger (read-only) the copy fee tier is read from, when
 *                            it is on this server
 *   EXECUTOR_BUILDER_URL     hosted: or the API server's GET /api/vs/builder/volume, when the ledger is on
 *                            another server (with EXECUTOR_BUILDER_TOKEN = its VALUESCAN_INTERNAL_TOKEN)
 *   EXECUTOR_LOCAL_ADDRESS   send every request and socket to SoDEX / Hyperliquid from this local
 *                            IP (an address of its own, so another process's rate limit cannot stop copies)
 *   EXECUTOR_ALLOWED_HOSTS   self: host names (comma-separated) besides loopback and IP literals that
 *                            requests may name in their Host header (DNS-rebinding guard)
 *   ALERT_TELEGRAM_TOKEN     the operator's alerts (alerts.ts): a bot token and the chat it writes to,
 *   ALERT_TELEGRAM_CHAT_ID   from /etc/valuescan/alert.env (the unit's EnvironmentFile); unset: no alerts
 *   LOG_LEVEL                debug | info (default) | warn | error
 */
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
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
  maxAlgosPerOwner: number;
  builderDb: string | null;
  /** The API's builder volume route and its internal token (the ledger on another server). */
  builderUrl: string | null;
  builderToken: string | null;
  /**
   * EXECUTOR_BETA_URL: the API server's /api/vs/builder/beta (whether a wallet is on the beta list), asked with
   * the builder token. Unset: derived from EXECUTOR_BUILDER_URL (its /volume as /beta); neither: no wallet is.
   * Real bots run only from beta.valuedesk.so for listed wallets (owner, 2026-11-02: "Beta only"), plus the
   * wallets real algos are on for (EXECUTOR_LIVE_ALGOS_WALLETS: the test follower).
   */
  betaUrl: string | null;
  localAddress: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** The executor id requests are signed for; null = the default (hosted: by network; self: its own, kept in its data). */
  executorId: string | null;
  /** Real (non-paper) algo orders may start, for every wallet. Off unless EXECUTOR_LIVE_ALGOS=1. */
  liveAlgos: boolean;
  /** Besides: the wallets (lowercase) real algo orders may start for, or '*' for every wallet (EXECUTOR_LIVE_ALGOS_WALLETS). */
  liveAlgoWallets: readonly string[] | '*';
  /** The emergency brake's file (brake.ts); null: none. */
  brakeFile: string | null;
  /** Self-hosted: Host header names allowed besides loopback names and IP literals. */
  allowedHosts: string[];
  /** The operator's Telegram alerts (alerts.ts); either null: off. Never logged. */
  alertTelegramToken: string | null;
  alertTelegramChatId: string | null;
}

/**
 * A self-hosted copier's data folder when none is set: `./copier-data` if the
 * folder it is started from already has one (every copier before 2026-10-27
 * kept it there - its keys and pairing live in it), else the user's own
 * app-data folder, so starting it from another folder never makes a second,
 * empty copier, and the key-encryption key does not land in a synced folder.
 */
export function dataDirFor(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const here = join(cwd, 'copier-data');
  if (existsSync(here)) return here;
  const base =
    platform() === 'win32' ? env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : platform() === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'ValueDesk', 'copier');
}

const DEFAULT_ORIGINS = ['https://valuedesk.so', 'https://www.valuedesk.so', 'https://valuedeskapp.vercel.app', 'https://valuexplorer.vercel.app', 'http://localhost:5180', 'http://127.0.0.1:5180'];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function builderUrl(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error('EXECUTOR_BUILDER_URL must be a URL (the API server\'s /api/vs/builder/volume)');
  }
  if (u.protocol !== 'https:' && u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') throw new Error('EXECUTOR_BUILDER_URL must be https (or a loopback address)');
  return u.toString();
}

/** EXECUTOR_BETA_URL, else the builder URL's /volume as /beta (same server, same token). */
export function betaUrlFrom(raw: string | undefined, builderRaw: string | undefined): string | null {
  if (raw?.trim()) return builderUrl(raw);
  const b = builderUrl(builderRaw);
  if (!b) return null;
  const u = new URL(b);
  if (!/\/volume$/.test(u.pathname)) return null;
  u.pathname = u.pathname.replace(/\/volume$/, '/beta');
  u.search = '';
  return u.toString();
}

/** EXECUTOR_LIVE_ALGOS_WALLETS: unset is no wallet; '*' every wallet; else a list of addresses. */
export function liveAlgoWalletsFrom(raw: string | undefined): readonly string[] | '*' {
  const s = raw?.trim() ?? '';
  if (!s) return [];
  if (s === '*') return '*';
  const list = s.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
  for (const a of list) if (!ADDRESS.test(a)) throw new Error(`EXECUTOR_LIVE_ALGOS_WALLETS holds "${a.slice(0, 12)}...", which is not a wallet address`);
  return list;
}

/** Whether real (non-paper) algo orders may start for this wallet: every wallet with EXECUTOR_LIVE_ALGOS=1, else the ones EXECUTOR_LIVE_ALGOS_WALLETS names. */
export const liveAlgosFor = (cfg: Pick<ExecutorConfig, 'liveAlgos' | 'liveAlgoWallets'>, owner: string): boolean =>
  cfg.liveAlgos || cfg.liveAlgoWallets === '*' || cfg.liveAlgoWallets.includes(owner.toLowerCase());

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ExecutorConfig {
  const rawKind = (env.EXECUTOR_KIND ?? 'self').trim();
  if (rawKind !== 'hosted' && rawKind !== 'self') throw new Error(`EXECUTOR_KIND must be hosted or self (got "${env.EXECUTOR_KIND}")`);
  const kind: ExecutorKind = rawKind;
  const originSecrets = [env.EXECUTOR_ORIGIN_SECRET, env.EXECUTOR_ORIGIN_SECRET_2].map((s) => s?.trim() ?? '').filter(Boolean);
  const noEdge = env.EXECUTOR_EDGE?.trim() === 'none';
  const trustEdge = env.EXECUTOR_TRUST_EDGE === '1';
  // Behind the edge, the origin secret is what keeps anyone else from reaching it - and from
  // forging the edge's viewer address and country (the region rules, the rate limit).
  if (kind === 'hosted' && !originSecrets.length && !noEdge) throw new Error('A hosted executor needs EXECUTOR_ORIGIN_SECRET (the edge\'s X-Origin-Verify value); EXECUTOR_EDGE=none runs it without an edge, locally');
  if (trustEdge && !originSecrets.length) throw new Error('EXECUTOR_TRUST_EDGE=1 needs EXECUTOR_ORIGIN_SECRET: without it anyone could forge the viewer\'s address and country');
  const executorId = env.EXECUTOR_ID?.trim() || null;
  if (executorId && !/^[A-Za-z0-9_.-]{3,64}$/.test(executorId)) throw new Error('EXECUTOR_ID must be 3 to 64 letters, digits, dots, dashes or underscores');
  const port = Number(env.PORT ?? 8799);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`PORT must be a port number (got ${env.PORT})`);
  const owner = env.EXECUTOR_OWNER?.trim() || null;
  if (owner && !ADDRESS.test(owner)) throw new Error('EXECUTOR_OWNER must be a 0x wallet address');
  const network = env.SODEX_NETWORK === 'testnet' ? 'testnet' : 'mainnet';
  // An empty line (`EXECUTOR_BUILDER_ID=`) is the default, not 0: Number('') is 0, and 0 means "no builder" -
  // every copy and algo order without our fee, silently. Only a written 0 turns it off.
  const builderId = Number(env.EXECUTOR_BUILDER_ID?.trim() || 234812);
  if (!Number.isSafeInteger(builderId) || builderId < 0) throw new Error('EXECUTOR_BUILDER_ID must be a SoDEX account id (or 0 for none)');
  const ttl = Number(env.EXECUTOR_KEY_TTL_DAYS ?? 180);
  const level = env.LOG_LEVEL;
  const dataDir = resolve(env.EXECUTOR_DATA_DIR?.trim() || (kind === 'hosted' ? '/var/lib/valuescan/executor' : dataDirFor(process.cwd(), env)));
  const brake = env.EXECUTOR_BRAKE_FILE?.trim();
  return {
    kind,
    host: env.HOST?.trim() || '127.0.0.1',
    port,
    dataDir,
    network,
    builderId,
    owner: owner ? owner.toLowerCase() : null,
    allowedOrigins: (env.EXECUTOR_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? DEFAULT_ORIGINS),
    location: env.EXECUTOR_LOCATION?.trim() || (kind === 'hosted' ? 'ap-northeast-1 (Tokyo)' : 'your own machine'),
    originSecrets,
    trustEdge,
    open: env.EXECUTOR_OPEN !== '0',
    // 180 days is what the copy terms promise and what the web app registers at most.
    keyTtlDaysMax: Number.isFinite(ttl) && ttl >= 1 ? Math.min(Math.floor(ttl), 180) : 180,
    maxCopiesPerOwner: Math.max(1, Math.min(50, Number(env.EXECUTOR_MAX_COPIES ?? 10) || 10)),
    maxAlgosPerOwner: Math.max(1, Math.min(100, Number(env.EXECUTOR_MAX_ALGOS ?? 20) || 20)),
    builderDb: env.EXECUTOR_BUILDER_DB?.trim() || null,
    builderUrl: builderUrl(env.EXECUTOR_BUILDER_URL),
    builderToken: env.EXECUTOR_BUILDER_TOKEN?.trim() || null,
    betaUrl: betaUrlFrom(env.EXECUTOR_BETA_URL, env.EXECUTOR_BUILDER_URL),
    localAddress: env.EXECUTOR_LOCAL_ADDRESS?.trim() || null,
    logLevel: level === 'debug' || level === 'warn' || level === 'error' ? level : 'info',
    executorId,
    liveAlgos: env.EXECUTOR_LIVE_ALGOS === '1',
    liveAlgoWallets: liveAlgoWalletsFrom(env.EXECUTOR_LIVE_ALGOS_WALLETS),
    brakeFile: brake === 'none' ? null : brake ? resolve(brake) : kind === 'hosted' ? '/var/lib/valuescan/brake.json' : join(dataDir, 'brake.json'),
    allowedHosts: env.EXECUTOR_ALLOWED_HOSTS?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) ?? [],
    alertTelegramToken: env.ALERT_TELEGRAM_TOKEN?.trim() || null,
    alertTelegramChatId: env.ALERT_TELEGRAM_CHAT_ID?.trim() || null,
  };
}
