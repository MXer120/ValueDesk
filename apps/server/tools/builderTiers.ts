/**
 * Builder fee tiers: the operator's tool (docs/BUILDER-TIERS.md §4). Run in apps/server.
 *
 *   npx tsx tools/builderTiers.ts init --builder-id <n> (--test-tiers | --fee-perps <n> --fee-spot <n>) [--force]
 *       Writes the configuration and the signing key where they do not exist yet.
 *       --force replaces the CONFIGURATION. The key is never replaced: builds pin it.
 *   npx tsx tools/builderTiers.ts status [--address 0x...]
 *       What is on disk and whether it is valid; with an address, what the ledger holds for that wallet.
 *   npx tsx tools/builderTiers.ts forget --address 0x...
 *       Removes everything the ledger holds about ONE wallet, while the server runs.
 *
 * Changing the fees while the server runs (the server reads the file again within 5 s; an app
 * takes the new fee with its next signed terms, at the latest when its terms expire - 10 min):
 *   npx tsx tools/builderTiers.ts set-tier --from-usd <volume> --perps <n> --spot <n>
 *       Adds the milestone at that counted volume, or changes its fees. --from-usd 0 is the
 *       DEFAULT fee; the web build pins it too (VITE_BUILDER_FEE_*), and the app never charges
 *       more than its build's default.
 *   npx tsx tools/builderTiers.ts remove-tier --from-usd <volume>
 *   npx tsx tools/builderTiers.ts set-fee --address 0x... --perps <n> --spot <n> [--note <text>]
 *       A hand-set fee for ONE wallet (a partner, a deal); it wins over the tiers.
 *   npx tsx tools/builderTiers.ts clear-fee --address 0x...
 * Fees are tenths of a basis point (20 = 2 bp = 0.02 %). Every change is checked as a whole
 * file (no fee above the default, milestones rising, ...) and written in one step; a change
 * that would make the file invalid is refused and nothing is written.
 *
 * Each prints one JSON object and nothing else. None prints the private key:
 * this file never holds its text (src/builder/terms.ts writes and reads it).
 *
 * Exit code: 0 done, 1 refused (the output says why), 2 not understood.
 *
 * The files are the server's (src/builder/paths.ts): VALUESCAN_BUILDER_TIERS_FILE,
 * VALUESCAN_BUILDER_TERMS_KEY_FILE and VALUESCAN_BUILDER_DB, else the data directory.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TiersSource, parseTiers, testTiers, validateTiers, type TiersConfig } from '../src/builder/config.js';
import { builderDbPath, termsKeyPath, tiersPath } from '../src/builder/paths.js';
import { BuilderStore } from '../src/builder/store.js';
import { ADDRESS_RE, KeySource, signerFromPem, writeNewKeyFile } from '../src/builder/terms.js';
import { MICRO } from '../src/builder/tiers.js';

export interface ToolResult {
  code: 0 | 1 | 2;
  out: Record<string, unknown>;
}

const USAGE =
  'usage: builderTiers.ts init --builder-id <n> (--test-tiers | --fee-perps <n> --fee-spot <n>) [--force] | status [--address 0x...] | forget --address 0x...' +
  ' | set-tier --from-usd <volume> --perps <n> --spot <n> | remove-tier --from-usd <volume> | set-fee --address 0x... --perps <n> --spot <n> [--note <text>] | clear-fee --address 0x...';

const usage = (error: string): ToolResult => ({ code: 2, out: { error, usage: USAGE } });

/** `--name value` and `--flag` arguments. Null when one is unknown, repeated or lacks its value. */
function parseArgs(args: string[], values: readonly string[], flags: readonly string[]): Map<string, string | true> | null {
  const out = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (out.has(a)) return null;
    if (flags.includes(a)) out.set(a, true);
    else if (values.includes(a)) {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) return null;
      out.set(a, v);
    } else return null;
  }
  return out;
}

const wholeOf = (v: string | true | undefined): number | null => (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : null);

function init(args: string[]): ToolResult {
  const a = parseArgs(args, ['--builder-id', '--fee-perps', '--fee-spot'], ['--test-tiers', '--force']);
  if (!a) return usage('init: an argument was not understood');
  const builderId = wholeOf(a.get('--builder-id'));
  if (builderId === null || builderId <= 0) return usage('init: --builder-id <the builder account id> is required');
  const test = a.has('--test-tiers');
  const perps = wholeOf(a.get('--fee-perps'));
  const spot = wholeOf(a.get('--fee-spot'));
  if (test && (a.has('--fee-perps') || a.has('--fee-spot'))) return usage('init: --test-tiers and --fee-perps / --fee-spot exclude each other');

  const configPath = tiersPath();
  const keyPath = termsKeyPath();
  let configWritten = false;
  if (!existsSync(configPath) || a.has('--force')) {
    if (!test && (perps === null || spot === null)) return usage('init: say --test-tiers, or the default fee with --fee-perps <n> --fee-spot <n> (tenths of a basis point)');
    const raw = test ? testTiers(builderId) : { builderId, maxFeeRate: Math.max(perps!, spot!), tiers: [{ minVolumeUsd: 0, perps, spot }], underpaid: { policy: 'default-fee', days: 30 } };
    const text = JSON.stringify(raw, null, 2) + '\n';
    const checked = parseTiers(text);
    if (!checked.config) return { code: 1, out: { error: 'these settings are not a valid configuration', problems: checked.problems, configPath } };
    mkdirSync(dirname(configPath), { recursive: true });
    // Whole or not at all: the server may read the file at any moment.
    const tmp = `${configPath}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, configPath);
    configWritten = true;
  }

  const onDisk = parseTiers(readFileSync(configPath, 'utf8'));
  if (!onDisk.config) {
    return { code: 1, out: { error: 'the configuration file that exists is not valid; --force replaces it', problems: onDisk.problems, configPath } };
  }
  if (onDisk.config.builderId !== builderId) {
    return { code: 1, out: { error: `the configuration file that exists names builder ${onDisk.config.builderId}; --force replaces it`, configPath } };
  }

  let keyWritten = false;
  let signer;
  try {
    if (existsSync(keyPath)) signer = signerFromPem(readFileSync(keyPath, 'utf8'));
    else {
      signer = writeNewKeyFile(keyPath);
      keyWritten = true;
    }
  } catch (e) {
    // The reason, never the file: an error about a key does not quote it.
    return { code: 1, out: { error: 'the signing key file cannot be used (it is not replaced by this tool)', problem: e instanceof Error ? e.message.slice(0, 160) : 'unknown', keyPath } };
  }
  return {
    code: 0,
    out: { configPath, keyPath, publicKey: signer.publicKey, keyId: signer.keyId, builderId: onDisk.config.builderId, tiers: onDisk.config.tiers, configWritten, keyWritten },
  };
}

function status(args: string[]): ToolResult {
  const a = parseArgs(args, ['--address'], []);
  if (!a) return usage('status: an argument was not understood');
  const address = a.get('--address');
  if (address !== undefined && (typeof address !== 'string' || !ADDRESS_RE.test(address))) return usage('status: --address must be one wallet address (0x and 40 hex characters)');

  const tiers = new TiersSource(tiersPath());
  tiers.loadSync();
  const st = tiers.status();
  const cfg = tiers.current();
  const keys = new KeySource(termsKeyPath());
  keys.loadSync();
  const ks = keys.status();
  const dbPath = builderDbPath();
  const out: Record<string, unknown> = {
    configPath: st.path,
    configExists: st.exists,
    valid: st.valid,
    problems: st.exists ? st.problems : ['the file does not exist: the feature is off'],
    builderId: cfg?.builderId ?? null,
    tiers: cfg?.tiers ?? null,
    overrides: cfg ? Object.keys(cfg.overrides).length : null,
    underpaid: cfg?.underpaid ?? null,
    keyPath: ks.path,
    keyExists: ks.exists,
    keyProblem: ks.problem,
    publicKey: ks.publicKey,
    keyId: ks.keyId,
    dbPath,
    dbExists: existsSync(dbPath),
  };
  if (typeof address === 'string') {
    out.wallet = walletReport(dbPath, address.toLowerCase(), cfg?.builderId ?? null);
    out.handSetFee = cfg?.overrides[address.toLowerCase()] ?? null;
  }
  return { code: 0, out };
}

/** What the ledger holds for one wallet. Read-only: nothing is created. */
function walletReport(dbPath: string, address: string, builderId: number | null): Record<string, unknown> | null {
  if (!existsSync(dbPath)) return null;
  const store = new BuilderStore(dbPath, { readOnly: true });
  try {
    const w = builderId === null ? null : store.wallet(builderId, address);
    return {
      address,
      rows: store.rowsOf(address),
      forgottenAt: store.floorOf(address) || null,
      known: w !== null,
      volume: w ? { perpsUsd: w.perpsMicro / MICRO, spotUsd: w.spotMicro / MICRO } : null,
      verifiedAt: w?.verifiedAt || null,
      countsFrom: w?.floor ?? null,
      ordersWaitingForExplorer: w?.openN ?? 0,
      flags: w
        ? {
            underpaid: { n: w.underpaidN, at: w.underpaidAt || null },
            tampered: { n: w.tamperedN, at: w.tamperedAt || null },
            'no-builder': { n: w.noBuilderN, at: w.noBuilderAt || null },
          }
        : null,
      fees: builderId === null ? [] : store.feeHistory(builderId, address),
      appKeys: [...store.keysOf(address)].map(([key, name]) => ({ name, key })),
      evidence: builderId === null ? [] : store.evidenceOf(builderId, address),
    };
  } finally {
    store.close();
  }
}

function forget(args: string[], now: number): ToolResult {
  const a = parseArgs(args, ['--address'], []);
  const address = a?.get('--address');
  // One wallet, spelled out. No list, no pattern, no "all".
  if (!a || a.size !== 1 || typeof address !== 'string' || !ADDRESS_RE.test(address)) {
    return usage('forget: --address must be exactly one wallet address (0x and 40 hex characters)');
  }
  const wallet = address.toLowerCase();
  const dbPath = builderDbPath();
  const none = { wallets: 0, engines: 0, orders: 0, fills: 0, fees: 0, keys: 0, evidence: 0 };
  if (!existsSync(dbPath)) return { code: 0, out: { address: wallet, dbPath, dbExists: false, removed: none, total: 0, countsFrom: null } };
  const store = new BuilderStore(dbPath);
  try {
    const removed = store.forget(wallet, now);
    return {
      code: 0,
      out: { address: wallet, dbPath, dbExists: true, removed, total: Object.values(removed).reduce((n, v) => n + v, 0), countsFrom: now },
    };
  } finally {
    store.close();
  }
}

// --- changing the fees while the server runs ------------------------------------------------

/** A volume in USD as typed: 0 or more, up to two decimals. */
const usdOf = (v: string | true | undefined): number | null => (typeof v === 'string' && /^\d{1,13}(\.\d{1,2})?$/.test(v) ? Number(v) : null);

/**
 * Read the file as it is (notes and all), let `change` edit it, check the WHOLE result as the
 * server will, and write it in one step. Nothing is written when the file is missing or invalid,
 * or when the change would make it invalid.
 */
function editConfig(what: string, change: (raw: Record<string, unknown>) => string | null): ToolResult {
  const configPath = tiersPath();
  if (!existsSync(configPath)) return { code: 1, out: { error: `${what}: there is no configuration yet (init writes one)`, configPath } };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    return { code: 1, out: { error: `${what}: the configuration file is not valid JSON - fix it first`, problem: e instanceof Error ? e.message : String(e), configPath } };
  }
  const before = validateTiers(raw);
  if (!before.config || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { code: 1, out: { error: `${what}: the configuration file is not valid - fix it first`, problems: before.problems, configPath } };
  }
  const next = structuredClone(raw) as Record<string, unknown>;
  const refused = change(next);
  if (refused) return { code: 1, out: { error: `${what}: ${refused}`, configPath } };
  const after = validateTiers(next);
  if (!after.config) return { code: 1, out: { error: `${what}: refused - the file would not be valid, nothing was written`, problems: after.problems, configPath } };
  const tmp = `${configPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, configPath);
  return { code: 0, out: { done: what, configPath, ...summary(after.config), appliesWithin: 'the server reads it within 5 s; an app takes it with its next signed terms (10 min at the latest)' } };
}

const summary = (c: TiersConfig): Record<string, unknown> => ({
  defaultFee: { perps: c.tiers[0]!.perps, spot: c.tiers[0]!.spot },
  tiers: c.tiers,
  handSetFees: Object.keys(c.overrides).length,
});

const tiersOf = (raw: Record<string, unknown>): Array<Record<string, unknown>> => (Array.isArray(raw.tiers) ? (raw.tiers as Array<Record<string, unknown>>) : []);

function setTier(args: string[]): ToolResult {
  const a = parseArgs(args, ['--from-usd', '--perps', '--spot'], []);
  const from = usdOf(a?.get('--from-usd'));
  const perps = wholeOf(a?.get('--perps'));
  const spot = wholeOf(a?.get('--spot'));
  if (!a || a.size !== 3 || from === null || perps === null || spot === null) {
    return usage('set-tier: --from-usd <counted volume in USD> --perps <n> --spot <n> (fees in tenths of a basis point)');
  }
  const r = editConfig(from === 0 ? 'set the default fee' : `set the milestone at $${from}`, (raw) => {
    const list = tiersOf(raw).filter((t) => t.minVolumeUsd !== from);
    list.push({ minVolumeUsd: from, perps, spot });
    list.sort((x, y) => Number(x.minVolumeUsd) - Number(y.minVolumeUsd));
    raw.tiers = list;
    return null;
  });
  if (r.code === 0 && from === 0) {
    r.out.note = 'the web build pins the default fee too (VITE_BUILDER_FEE_PERPS / VITE_BUILDER_FEE_SPOT): the app never charges more than its build - a higher default needs a new web build, and above VITE_BUILDER_MAX_FEE every user approves again';
  }
  return r;
}

function removeTier(args: string[]): ToolResult {
  const a = parseArgs(args, ['--from-usd'], []);
  const from = usdOf(a?.get('--from-usd'));
  if (!a || a.size !== 1 || from === null) return usage('remove-tier: --from-usd <the milestone volume in USD>');
  if (from === 0) return { code: 1, out: { error: 'remove-tier: the tier at $0 is the default fee and cannot be removed (set-tier --from-usd 0 changes it)' } };
  return editConfig(`remove the milestone at $${from}`, (raw) => {
    const list = tiersOf(raw);
    const kept = list.filter((t) => t.minVolumeUsd !== from);
    if (kept.length === list.length) return `there is no milestone at $${from} (they are at ${list.map((t) => `$${t.minVolumeUsd}`).join(', ')})`;
    raw.tiers = kept;
    return null;
  });
}

/** The key the file already uses for this wallet (any spelling), else the lower-case address. */
const overrideKey = (raw: Record<string, unknown>, address: string): string => {
  const o = raw.overrides && typeof raw.overrides === 'object' ? (raw.overrides as Record<string, unknown>) : {};
  return Object.keys(o).find((k) => k.toLowerCase() === address) ?? address;
};

function setFee(args: string[]): ToolResult {
  const a = parseArgs(args, ['--address', '--perps', '--spot', '--note'], []);
  const address = a?.get('--address');
  const perps = wholeOf(a?.get('--perps'));
  const spot = wholeOf(a?.get('--spot'));
  const note = a?.get('--note');
  if (!a || typeof address !== 'string' || !ADDRESS_RE.test(address) || perps === null || spot === null || note === true) {
    return usage('set-fee: --address 0x... --perps <n> --spot <n> [--note <text>] (fees in tenths of a basis point)');
  }
  const wallet = address.toLowerCase();
  return editConfig(`set the fee of ${wallet}`, (raw) => {
    const o = raw.overrides && typeof raw.overrides === 'object' && !Array.isArray(raw.overrides) ? { ...(raw.overrides as Record<string, unknown>) } : {};
    delete o[overrideKey(raw, wallet)];
    o[wallet] = typeof note === 'string' ? { perps, spot, note } : { perps, spot };
    raw.overrides = o;
    return null;
  });
}

function clearFee(args: string[]): ToolResult {
  const a = parseArgs(args, ['--address'], []);
  const address = a?.get('--address');
  if (!a || a.size !== 1 || typeof address !== 'string' || !ADDRESS_RE.test(address)) return usage('clear-fee: --address 0x... (one wallet)');
  const wallet = address.toLowerCase();
  return editConfig(`clear the hand-set fee of ${wallet}`, (raw) => {
    const o = raw.overrides && typeof raw.overrides === 'object' && !Array.isArray(raw.overrides) ? { ...(raw.overrides as Record<string, unknown>) } : {};
    const key = overrideKey(raw, wallet);
    if (!(key in o)) return 'this wallet has no hand-set fee';
    delete o[key];
    raw.overrides = o;
    return null;
  });
}

/** Run one command. `argv` is what follows the script name. */
export function runTool(argv: string[], now: number = Date.now()): ToolResult {
  const [command, ...args] = argv;
  try {
    if (command === 'init') return init(args);
    if (command === 'status') return status(args);
    if (command === 'forget') return forget(args, now);
    if (command === 'set-tier') return setTier(args);
    if (command === 'remove-tier') return removeTier(args);
    if (command === 'set-fee') return setFee(args);
    if (command === 'clear-fee') return clearFee(args);
    return usage(command ? `unknown command "${command}"` : 'a command is required');
  } catch (e) {
    return { code: 1, out: { error: e instanceof Error ? e.message : String(e) } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = runTool(process.argv.slice(2));
  console.log(JSON.stringify(r.out, null, 2));
  process.exitCode = r.code;
}
