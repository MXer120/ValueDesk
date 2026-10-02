/**
 * Valuescan LIVE end-to-end runner for the app's money flows on SoDEX mainnet.
 *
 *   npx tsx e2e/live/run.ts [plan|live] --config e2e/live/config.json
 *                           [--confirm <walletAddress>] [--only step1,step2]
 *                           [--throwaway-key] [--registry-only]
 *                           [--backend http://127.0.0.1:5180] [--report-dir <dir>]
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
import type { StepId } from './context';

const STEPS: readonly string[] = [
  'deposit-external',
  'enable-trading',
  'transfers',
  'orders',
  'spot-to-evm',
  'evm-to-spot',
  'withdraw-valuechain-self',
  'withdraw-valuechain-other',
  'withdraw-external',
  'extra-deposits',
  'extra-withdrawals',
  'cleanup',
  'revoke-builder',
];

const USAGE = `usage: npx tsx e2e/live/run.ts [plan|live] --config e2e/live/config.json [options]

  plan                    read-only (default): checks, routes, estimates, funding checklist
  live                    moves real funds (needs --confirm and acknowledgeRealFunds)
  --config <file>         the run's config (see config.example.json); plan falls back to the defaults
  --confirm <address>     live: the wallet address VS_E2E_KEY controls
  --only a,b              run only these steps (preflight always runs): ${STEPS.join(', ')}
  --throwaway-key         plan only: use a random in-memory key instead of VS_E2E_KEY
  --registry-only         plan only: read deposit addresses from the on-chain registry alone
                          (does not ask the backend, which asks SoDEX to issue addresses)
  --backend <origin>      override config.backend (default http://127.0.0.1:5180)
  --report-dir <dir>      where the JSON report goes (default e2e/live/reports)

The key comes only from the environment: VS_E2E_KEY=0x<64 hex>.`;

interface Args {
  mode: 'plan' | 'live';
  config: string | null;
  confirm: string | null;
  only: StepId[] | null;
  throwaway: boolean;
  registryOnly: boolean;
  backend: string | null;
  reportDir: string | null;
}

function parseArgs(argv: string[]): Args | string {
  const a: Args = { mode: 'plan', config: null, confirm: null, only: null, throwaway: false, registryOnly: false, backend: null, reportDir: null };
  const rest = [...argv];
  if (rest[0] === 'plan' || rest[0] === 'live') a.mode = rest.shift() as 'plan' | 'live';
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
        case '--only': {
          const list = val().split(',').map((s) => s.trim()).filter(Boolean);
          const bad = list.filter((s) => !STEPS.includes(s));
          if (bad.length) return `unknown step(s): ${bad.join(', ')}`;
          a.only = list as StepId[];
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

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === 'string') {
    process.stderr.write(`${args}\n\n${USAGE}\n`);
    return 2;
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
  return runE2E({
    mode: args.mode,
    configPath: args.config,
    confirm: args.confirm,
    only: args.only,
    keyHex,
    throwaway: args.throwaway,
    registryOnly: args.registryOnly,
    reportDir: args.reportDir ?? fileURLToPath(new URL('./reports/', import.meta.url)),
    backendOverride: args.backend,
  });
}

main().then(
  (code) => process.exit(code),
  (e) => {
    // Never print a raw error object here: it could only ever carry what the runner
    // already scrubbed, but a stack of our own code is all that is useful anyway.
    process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
