/**
 * Valuescan LIVE end-to-end runner for the app's money flows on SoDEX mainnet.
 *
 *   npx tsx e2e/live/run.ts [plan|live] --config e2e/live/config.json
 *                           [--profile core|evm-tour|all-chains|builder-rerun] [--confirm <walletAddress>]
 *                           [--only step1,step2] [--throwaway-key] [--registry-only]
 *                           [--backend http://127.0.0.1:5180] [--report-dir <dir>]
 *   npx tsx e2e/live/run.ts capabilities      (what this runner can do, as JSON; no key, no network)
 *
 * Run it from apps/web (its tsconfig maps '@sodex-core').
 *
 * THE KEY comes ONLY from the environment variable VS_E2E_KEY (0x + 64 hex).
 * It is read once, removed from process.env, never printed and never written.
 * `plan --throwaway-key` generates a random key in memory instead (plan only).
 *
 * `plan` (the default) is read-only - the network guard refuses every write.
 * `live` moves real funds and refuses to start unless --confirm equals the
 * wallet address the key controls AND the config says acknowledgeRealFunds.
 * See README.md.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey } from 'viem/accounts';
import { CHECKS } from './checks';
import { coverageList } from './coverage';
import { STEP_ALIASES, STEP_ORDER, STEP_TITLES, type StepId } from './context';
import { ALL_EVM } from './chains';
import { PROFILES, PROFILE_TITLES, profileSteps } from './profiles';

/** The checks declared per coin and chain at run time, by kind (their ids are patterns). */
export const ROUTE_KINDS = [
  { id: 'route-<coin>-<chain>', direction: null, steps: ['preflight'], what: "read-only, every plan: open/closed, minimum, fee (config and chain), maintenance, the deposit address, the app's receiver check" },
  { id: 'deposit-<coin>-<chain>', direction: 'deposit', steps: ['deposit-external', 'extra-deposits', 'evm-tour'], what: "a deposit the runner sends (USDC through the app's sendUsdcDeposit; a native coin by a DIRECT transfer) is credited to Spot" },
  { id: 'withdraw-<coin>-<chain>', direction: 'withdraw', steps: ['withdraw-external', 'extra-withdrawals', 'evm-tour', 'chain-withdrawals'], what: "a withdrawal through the app's withdrawFunds is final in SoDEX's record, and (EVM) arrived on the chain" },
  { id: 'manual-deposit-<coin>-<chain>', direction: 'deposit', steps: ['manual-deposits'], what: 'a deposit the owner sends by hand to the verified address is credited to Spot' },
] as const;
const FLAGS = ['--config', '--profile', '--confirm', '--only', '--throwaway-key', '--registry-only', '--backend', '--report-dir'] as const;

const USAGE = `usage: npx tsx e2e/live/run.ts [plan|live|capabilities] --config e2e/live/config.json [options]

  plan                    read-only (default): checks, routes, estimates, funding checklist
  live                    moves real funds (needs --confirm and acknowledgeRealFunds)
  capabilities            print what this runner can do (steps, profiles, flags, checks) as JSON
  --config <file>         the run's config (see config.example.json); plan falls back to the defaults
  --confirm <address>     live: the wallet address VS_E2E_KEY controls
  --throwaway-key         plan only: use a random in-memory key instead of VS_E2E_KEY
  --registry-only         plan only: read deposit addresses from the on-chain registry alone
                          (does not ask the backend, which asks SoDEX to issue addresses)
  --backend <origin>      override config.backend (default http://127.0.0.1:5180)
  --report-dir <dir>      where the JSON report goes (default e2e/live/reports)
  --profile <name>        what the run covers: ${PROFILES.join(', ')}
  --only a,b              run only these steps (preflight always runs; "orders" = orders-spot,orders-perps): ${STEP_ORDER.join(', ')}

The key comes only from the environment: VS_E2E_KEY=0x<64 hex>.`;

interface Args {
  mode: 'plan' | 'live' | 'capabilities';
  config: string | null;
  confirm: string | null;
  only: StepId[] | null;
  profile: (typeof PROFILES)[number] | null;
  throwaway: boolean;
  registryOnly: boolean;
  backend: string | null;
  reportDir: string | null;
}

export function parseArgs(argv: string[]): Args | string {
  const a: Args = { mode: 'plan', config: null, confirm: null, only: null, profile: null, throwaway: false, registryOnly: false, backend: null, reportDir: null };
  const rest = [...argv];
  if (rest[0] === 'plan' || rest[0] === 'live' || rest[0] === 'capabilities') a.mode = rest.shift() as Args['mode'];
  while (rest.length) {
    const k = rest.shift()!;
    const val = (): string => {
      const v = rest.shift();
      if (v === undefined || v.startsWith('--')) throw new Error(`${k} needs a value`);
      return v;
    };
    try {
      switch (k) {
        case '--config':
          a.config = val();
          break;
        case '--confirm':
          a.confirm = val();
          break;
        case '--profile': {
          const p = val();
          if (!(PROFILES as readonly string[]).includes(p)) return `unknown profile ${p} (this runner has: ${PROFILES.join(', ')})`;
          a.profile = p as Args['profile'];
          break;
        }
        case '--only': {
          const list = val().split(',').map((s) => s.trim()).filter(Boolean);
          const out: StepId[] = [];
          const bad: string[] = [];
          for (const s of list) {
            if ((STEP_ORDER as readonly string[]).includes(s)) out.push(s as StepId);
            else if (STEP_ALIASES[s]) out.push(...STEP_ALIASES[s]!);
            else bad.push(s);
          }
          if (bad.length) return `unknown step(s): ${bad.join(', ')}`;
          a.only = [...new Set(out)];
          break;
        }
        case '--throwaway-key':
          a.throwaway = true;
          break;
        case '--registry-only':
          a.registryOnly = true;
          break;
        case '--backend':
          a.backend = val();
          break;
        case '--report-dir':
          a.reportDir = val();
          break;
        case '-h':
        case '--help':
          return USAGE;
        default:
          return `unknown argument ${k}`;
      }
    } catch (e) {
      return (e as Error).message;
    }
  }
  return a;
}

/** What `capabilities` prints: read by the guided launcher (apps/web/e2e/guide). */
export function capabilities(): Record<string, unknown> {
  return {
    tool: 'valuescan-live-e2e',
    steps: [...STEP_ORDER],
    stepTitles: STEP_TITLES,
    aliases: STEP_ALIASES,
    profiles: [...PROFILES],
    profileInfo: PROFILES.map((p) => ({ name: p, title: PROFILE_TITLES[p], steps: profileSteps(p) })),
    routeKinds: ROUTE_KINDS,
    // The EVM chains the runner reads and signs on; every other chain SoDEX lists: withdrawals to your own address (record only) and manual deposits.
    chains: Object.values(ALL_EVM).map((c) => ({ key: c.key, chainId: c.chainId, name: c.name, source: c.source })),
    flags: [...FLAGS],
    checks: CHECKS.map((c) => ({ id: c.id, area: c.area, title: c.title, step: c.step })),
    // Every function of the app's trading and funds layer, and the checks that exercise it (coverage.ts).
    coverage: coverageList(),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === 'string') {
    process.stderr.write(`${args}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.mode === 'capabilities') {
    // One line: a launcher reads the last line of the output.
    process.stdout.write(`${JSON.stringify(capabilities())}\n`);
    return 0;
  }
  if (!existsSync('tsconfig.json') || !existsSync('src/trading/funds.ts')) {
    process.stderr.write('Run this from apps/web (its tsconfig maps @sodex-core):  cd apps/web && npx tsx e2e/live/run.ts plan ...\n');
    return 2;
  }
  if (args.mode === 'live' && !args.config) {
    process.stderr.write('live mode needs --config (the defaults are for planning only)\n');
    return 2;
  }

  let keyHex: string;
  if (args.throwaway) {
    if (args.mode !== 'plan') {
      process.stderr.write('--throwaway-key is for plan mode only\n');
      return 2;
    }
    keyHex = generatePrivateKey();
  } else {
    keyHex = (process.env.VS_E2E_KEY ?? '').trim();
    // Out of the environment at once: nothing started from here inherits it.
    delete process.env.VS_E2E_KEY;
    if (!keyHex) {
      process.stderr.write('Set VS_E2E_KEY to the test wallet\'s private key (0x + 64 hex), or use `plan --throwaway-key`.\n');
      return 2;
    }
  }

  const { runE2E } = await import('./runner');
  const { stdinOwnerInput } = await import('./ownerInput');
  return runE2E({
    // Live: the owner may skip a hand-sent deposit by typing "s" (read only while such a wait runs).
    ownerInput: args.mode === 'live' ? stdinOwnerInput() : null,
    mode: args.mode,
    configPath: args.config,
    confirm: args.confirm,
    only: args.only,
    ...(args.profile ? { profile: args.profile } : {}),
    keyHex,
    throwaway: args.throwaway,
    registryOnly: args.registryOnly,
    reportDir: args.reportDir ?? fileURLToPath(new URL('./reports/', import.meta.url)),
    backendOverride: args.backend,
  });
}

// Run only as the entry point (tests import parseArgs / capabilities).
if (process.argv[1] && /run\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      // Never print a raw error object here: it could only ever carry what the runner
      // already scrubbed, but a stack of our own code is all that is useful anyway.
      process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
