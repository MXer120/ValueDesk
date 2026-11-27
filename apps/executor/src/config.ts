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
 *   EXECUTOR_MAX_LIVE_BOTS   real (non-practice) bots running on this executor, all wallets together (default 10:
 *                            ~10 bots with pushed fills per IP, measured 2026-11-05); a start past it is a 429
 *   EXECUTOR_VIP_PUBKEY      standard tier: the VIP executor's key-import public key (base64url SPKI, as its /info
 *                            shows it); a move seals the wallet's key only to this key, never to one read over the wire
 *   EXECUTOR_BUILDER_DB      hosted: the builder ledger (read-only) the copy fee tier is read from, when
 *                            it is on this server
 *   EXECUTOR_BUILDER_URL     hosted: or the API server's GET /api/vs/builder/volume, when the ledger is on
 *                            another server (with EXECUTOR_BUILDER_TOKEN = its VALUESCAN_INTERNAL_TOKEN)
 *   EXECUTOR_LOCAL_ADDRESS   send every request and socket to SoDEX / Hyperliquid from this local
 *                            IP (an address of its own, so another process's rate limit cannot stop copies)
 *   EXECUTOR_WS_ADDRESSES    hosted: more local addresses (comma-separated, e.g. IPv6 of this server) for extra SoDEX
 *                            account sockets: SoDEX follows 10 wallets per IP, so each adds 10 bot wallets that stay live
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
  /** Real bots running on this executor, every wallet together (EXECUTOR_MAX_LIVE_BOTS, default 10). */
  maxLiveBots: number;
  /** New practice (paper) bots are taken only when EXECUTOR_PRACTICE_BOTS=1 (off since 2026-11-15). */
  practiceBots: boolean;
  builderDb: string | null;
  /** The API's builder volume route and its internal token (the ledger on another server). */
  builderUrl: string | null;
  builderToken: string | null;
  /**
   * Where a wallet's VIP and fee programs are read (server 1's /api/vs/builder/volume: its `vip` and `fees`): the
   * builder URL, else that path on the beta URL's server (perksUrlFrom). Found 2026-11-27: server 2 and the VIP box
   * read the volume from their copy of the ledger (EXECUTOR_BUILDER_DB) and name server 1 only by EXECUTOR_BETA_URL,
   * so no program ever reached their fees - Beta VIP wallets paid the standard 0.2 bp on every bot order.
   */
  perksUrl?: string | null;
  /**
   * EXECUTOR_BETA_URL: the API server's /api/vs/builder/beta (whether a wallet is on the beta list), asked with
   * the builder token. Unset: derived from EXECUTOR_BUILDER_URL (its /volume as /beta); neither: no wallet is.
   * Real bots run only from beta.valuedesk.so for listed wallets (owner, 2026-11-02: "Beta only"), plus the
   * wallets real algos are on for (EXECUTOR_LIVE_ALGOS_WALLETS: the test follower).
   */
  betaUrl: string | null;
  /**
   * EXECUTOR_CALENDAR_URL: the API server's /api/vs/calendar (public), for a bot's news gate. Unset: derived from
   * EXECUTOR_BUILDER_URL (same server); neither: no calendar, and a news gate stays open (it says so).
   */
  calendarUrl: string | null;
  /**
   * VIP (vip.ts): EXECUTOR_TIER 'standard' (default) or 'vip' (the AWS Tokyo box). A standard executor with
   * EXECUTOR_VIP_URL (the VIP executor's API base, e.g. https://vip.internal/api/copy/v1) offers the move; it asks
   * EXECUTOR_VIP_CHECK_URL (else the builder URL's server /api/vs/bots/vip) whether a wallet is VIP, unless
   * EXECUTOR_VIP_OPEN=1 (tests, local runs). Both sides share EXECUTOR_VIP_TOKEN (its own secret, not the API
   * server's internal token: a leaked VIP token reads nothing on the API server). Unset: no move.
   */
  tier: 'standard' | 'vip';
  vipToken: string | null;
  vipUrl: string | null;
  vipCheckUrl: string | null;
  /**
   * EXECUTOR_VIP_WALLETS: wallets that are VIP whatever their volume - they may move, are never moved back for volume,
   * and pay the VIP bot fee (owner 2026-11-09: the overnight live test runs "as a vip ... at vip fee"). Unset: none.
   */
  vipWallets: readonly string[];
  vipOpen: boolean;
  /** EXECUTOR_VIP_PUBKEY: the VIP executor's pinned key-import public key; unset: no move (the key would go to whatever /info says). */
  vipPubkey: string | null;
  /**
   * The VIP executor's way back (vip.ts BACK): EXECUTOR_STD_URL (the standard executor's API base, https or loopback)
   * and EXECUTOR_STD_PUBKEY (its pinned key-import public key). Either unset: no wallet is moved back.
   */
  stdUrl: string | null;
  stdPubkey: string | null;
  /** How often the VIP side asks about its wallets (EXECUTOR_VIP_SWEEP_MS, default 10 min, at least 30 s: tests and live runs). */
  vipSweepMs: number;
  localAddress: string | null;
  /** Extra local addresses for SoDEX account sockets (EXECUTOR_WS_ADDRESSES). */
  wsAddresses: string[];
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

/**
 * A path on the API server (server 1), found from EXECUTOR_BUILDER_URL, else EXECUTOR_BETA_URL (both name that server).
 * Found live 2026-11-27: server 2 reads the volume from its copy of the ledger (EXECUTOR_BUILDER_DB) and names server 1
 * only by EXECUTOR_BETA_URL, so with the builder URL alone it had no VIP check (every VIP move failed "VIP status cannot
 * be checked here", every wallet not on EXECUTOR_VIP_WALLETS) and no calendar (news gates stayed open).
 */
function apiPath(path: string, builderRaw: string | undefined, betaRaw: string | undefined): string | null {
  const b = builderUrl(builderRaw) ?? builderUrl(betaRaw);
  if (!b) return null;
  const u = new URL(b);
  u.pathname = path;
  u.search = '';
  return u.toString();
}

/** EXECUTOR_CALENDAR_URL, else the API server's /api/vs/calendar (from the builder URL, else the beta URL). */
export function calendarUrlFrom(raw: string | undefined, builderRaw: string | undefined, betaRaw?: string): string | null {
  if (raw?.trim()) return builderUrl(raw);
  return apiPath('/api/vs/calendar', builderRaw, betaRaw);
}

/** EXECUTOR_VIP_CHECK_URL, else the API server's /api/vs/bots/vip (from the builder URL, else the beta URL). */
export function vipCheckUrlFrom(raw: string | undefined, builderRaw: string | undefined, betaRaw?: string): string | null {
  if (raw?.trim()) return builderUrl(raw);
  return apiPath('/api/vs/bots/vip', builderRaw, betaRaw);
}

/** The builder URL (volume, VIP and programs in one answer), else the API server's /api/vs/builder/volume from the beta URL. */
export function perksUrlFrom(builderRaw: string | undefined, betaRaw: string | undefined): string | null {
  return builderUrl(builderRaw) ?? apiPath('/api/vs/builder/volume', undefined, betaRaw);
}

/** EXECUTOR_VIP_PUBKEY: a base64url SPKI (a P-256 public key is 91 bytes, ~122 characters); unset: null. */
export function vipPubkeyFrom(raw: string | undefined, name = 'EXECUTOR_VIP_PUBKEY'): string | null {
  const v = raw?.trim();
  if (!v) return null;
  if (!/^[A-Za-z0-9_-]{60,400}$/.test(v)) throw new Error(`${name} must be the other executor's key-import public key (base64url, as its /info shows keyImport.publicKey)`);
  return v;
}

/** EXECUTOR_VIP_WALLETS: a list of addresses (no '*': EXECUTOR_VIP_OPEN is that). */
export function vipWalletsFrom(raw: string | undefined): readonly string[] {
  const list = (raw ?? '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
  for (const a of list) if (!ADDRESS.test(a)) throw new Error(`EXECUTOR_VIP_WALLETS holds "${a.slice(0, 12)}...", which is not a wallet address`);
  return list;
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
    // 20 live bots per server (owner 2026-11-08): up to 10 wallets get their fills pushed on the account socket, the
    // others are read by REST, a wallet first when a public print names it (runtime.ts onPrint).
    practiceBots: env.EXECUTOR_PRACTICE_BOTS === '1',
    maxLiveBots: Math.max(1, Math.min(1000, Math.floor(Number(env.EXECUTOR_MAX_LIVE_BOTS ?? 20)) || 20)),
    builderDb: env.EXECUTOR_BUILDER_DB?.trim() || null,
    builderUrl: builderUrl(env.EXECUTOR_BUILDER_URL),
    builderToken: env.EXECUTOR_BUILDER_TOKEN?.trim() || null,
    betaUrl: betaUrlFrom(env.EXECUTOR_BETA_URL, env.EXECUTOR_BUILDER_URL),
    perksUrl: perksUrlFrom(env.EXECUTOR_BUILDER_URL, env.EXECUTOR_BETA_URL),
    calendarUrl: calendarUrlFrom(env.EXECUTOR_CALENDAR_URL, env.EXECUTOR_BUILDER_URL, env.EXECUTOR_BETA_URL),
    tier: env.EXECUTOR_TIER?.trim() === 'vip' ? 'vip' : 'standard',
    vipToken: env.EXECUTOR_VIP_TOKEN?.trim() || null,
    vipUrl: env.EXECUTOR_VIP_URL?.trim() ? builderUrl(env.EXECUTOR_VIP_URL) : null,
    vipCheckUrl: vipCheckUrlFrom(env.EXECUTOR_VIP_CHECK_URL, env.EXECUTOR_BUILDER_URL, env.EXECUTOR_BETA_URL),
    vipOpen: env.EXECUTOR_VIP_OPEN?.trim() === '1',
    vipWallets: vipWalletsFrom(env.EXECUTOR_VIP_WALLETS),
    vipPubkey: vipPubkeyFrom(env.EXECUTOR_VIP_PUBKEY),
    stdUrl: env.EXECUTOR_STD_URL?.trim() ? builderUrl(env.EXECUTOR_STD_URL) : null,
    stdPubkey: vipPubkeyFrom(env.EXECUTOR_STD_PUBKEY, 'EXECUTOR_STD_PUBKEY'),
    vipSweepMs: Math.max(30_000, Math.floor(Number(env.EXECUTOR_VIP_SWEEP_MS ?? 600_000)) || 600_000),
    localAddress: env.EXECUTOR_LOCAL_ADDRESS?.trim() || null,
    wsAddresses: (env.EXECUTOR_WS_ADDRESSES ?? '').split(',').map((x) => x.trim()).filter(Boolean),
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
