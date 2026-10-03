/**
 * The guide's command line. Pure: no process, no files.
 *
 * A private key is NEVER accepted here. Command lines end up in the shell
 * history and in the process list, so anything that looks like a key - and
 * every flag that asks to pass one - is refused, without echoing it.
 */
import type { StageId } from './types';

export interface GuideArgs {
  help: boolean;
  /** In run order. */
  stages: StageId[];
  /** Answer the NON-MONEY questions with their default. Never the key, never a real-funds confirmation. */
  yes: boolean;
  /** Stage D stops after the runner's read-only plan. */
  planOnly: boolean;
  /** With planOnly: no key is asked; the runner plans with a random in-memory key. */
  throwawayKey: boolean;
  /** Stage D: only these runner steps (to resume). */
  only: string[] | null;
  /** Stage D: the runner profile (core, evm-tour, all-chains, ...) instead of asking. */
  profile: string | null;
  /** Stage A: only suites whose id contains one of these. */
  suites: string[] | null;
  /** Stage B: the production smoke test - ask (default), never, or without asking. */
  smoke: 'ask' | 'no' | 'yes';
  /** The dev server (web + API proxy). */
  backend: string;
  /** The Origin header the browser-call (CORS) checks send. */
  siteOrigin: string;
  reportDir: string | null;
  /** The run config file stages C and D write and hand to the runner (default apps/web/e2e/live/config.json). */
  config: string | null;
  /** Never wait or poll (dev server, funding): say what is missing and go on. */
  noWait: boolean;
  /** Longest funding wait when nobody is at the keyboard (default 0 there, unlimited at a console). */
  waitMinutes: number | null;
  /** Stage C without questions: the builder's wallet address or account id. */
  builder: string | null;
  feePerps: number | null;
  feeSpot: number | null;
  /** Stage C: revoke the approval at the end of the live run (default yes). */
  revoke: boolean | null;
  /** Stage C: leave the server's fee-tier config alone (no `builderTiers.ts init`). */
  noTiers: boolean;
}

export const ALL_STAGES: readonly StageId[] = ['A', 'B', 'C', 'D'];

export const DEFAULT_BACKEND = 'http://127.0.0.1:5180';
/** Not a real site: any origin that is not localhost shows whether a host lets a deployed site call it. */
export const DEFAULT_SITE_ORIGIN = 'https://valuescan.example';

/** Ports that belong to another project on this machine: the guide never talks to them. */
export const FORBIDDEN_PORTS: readonly number[] = [5173, 8787];

export const USAGE = `Valuescan guided test run

  RUN-LIVE-TESTS.cmd                 the full guided run: stages A, B, C, D and the summary
  RUN-LIVE-TESTS.cmd --stages A,B    only these stages

Stages
  A  offline test suites       typechecks and every unit / offline e2e test (no network, no key)
  B  read-only live checks     exchanges, market data, our own API (GET / read only, no key)
  C  builder account           check or set up the builder account, choose the fee to test
  D  live money run            the test wallet: plan, funding, then the live run (REAL money)

Options
  --stages A,B           run only these stages (letters, comma separated; "all" = A,B,C,D)
  --yes                  answer the non-money questions with their default. The key is never
                         answered for you, and neither is a real-funds confirmation
  --plan-only            stage D stops after the read-only plan: nothing is signed or sent
  --throwaway-key        with --plan-only: ask for no key; the runner plans with a random
                         in-memory key and reads deposit addresses from the chain only
  --only a,b             stage D: run only these runner steps (to resume a stopped run)
  --profile <name>       stage D: the runner profile to run (core, evm-tour, all-chains)
                         instead of choosing it in the guide
  --suites a,b           stage A: only the suites whose id contains one of these words
  --no-smoke | --smoke   stage B: never run / run without asking the production smoke test
  --backend <origin>     the dev server (default ${DEFAULT_BACKEND})
  --site-origin <origin> the Origin the browser-call checks send (default ${DEFAULT_SITE_ORIGIN})
  --report-dir <dir>     where reports and logs go (default apps/web/e2e/live/reports)
  --config <file>        the run config stages C and D write and use (default
                         apps/web/e2e/live/config.json; keep any other file out of git too)
  --no-wait             never wait: say what is missing and go on
  --wait-minutes <n>     the longest funding wait when no one is at the keyboard (default 0)
  --builder <addr|id>    stage C without questions: check this builder wallet or account id
  --fee-perps <n>        stage C: perps fee in tenths of a basis point (0..200, default 50)
  --fee-spot <n>         stage C: spot fee in tenths of a basis point (0..2000, default 100)
  --no-revoke            stage C: keep the builder approval on the test account after the run
  --no-tiers             stage C: do not set up the server's fee tiers (the fee-change test
                         then does not run)
  --no-pause             do not wait for a key press when the window would close
  -h, --help             this text

The private key is asked for by the guide itself, with a hidden prompt. It is refused on the
command line and in the config file.`;

const KEY_LIKE = /^(?:0x)?[0-9a-fA-F]{64}$/;
const KEY_FLAGS = new Set(['--key', '--private-key', '--privatekey', '--pk', '--secret', '--mnemonic', '--seed']);
const KEY_REFUSAL =
  'A private key (or a flag that passes one) was given on the command line. That is refused: command lines are kept ' +
  'in the shell history and shown in the process list. Start the guide without it - it asks for the key itself, with a hidden prompt.';

export type ParseResult = { ok: true; args: GuideArgs } | { ok: false; error: string };

export function defaultArgs(): GuideArgs {
  return {
    help: false,
    stages: [...ALL_STAGES],
    yes: false,
    planOnly: false,
    throwawayKey: false,
    only: null,
    profile: null,
    suites: null,
    smoke: 'ask',
    backend: DEFAULT_BACKEND,
    siteOrigin: DEFAULT_SITE_ORIGIN,
    reportDir: null,
    config: null,
    noWait: false,
    waitMinutes: null,
    builder: null,
    feePerps: null,
    feeSpot: null,
    revoke: null,
    noTiers: false,
  };
}

/** `http(s)://host[:port]`, nothing after it; null when it is not one. */
export function normaliseOrigin(raw: string): string | null {
  const s = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s?#]+$/.test(s)) return null;
  try {
    return new URL(s).origin;
  } catch {
    return null;
  }
}

/** Is this URL one of the ports the guide must never touch (5173 / 8787 on this machine)? */
export function isForbiddenLocal(url: string): boolean {
  try {
    const u = new URL(url);
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]' || u.hostname === '::1';
    return local && FORBIDDEN_PORTS.includes(Number(u.port));
  } catch {
    return false;
  }
}

export function parseArgs(argv: readonly string[]): ParseResult {
  const a = defaultArgs();
  // Refuse a key before anything else, and never repeat the offending token.
  for (const raw of argv) {
    const eq = raw.indexOf('=');
    const name = (eq > 0 && raw.startsWith('--') ? raw.slice(0, eq) : raw).toLowerCase();
    const value = eq > 0 && raw.startsWith('--') ? raw.slice(eq + 1) : raw;
    if (KEY_FLAGS.has(name) || KEY_LIKE.test(value.trim().replace(/^["']|["']$/g, ''))) return { ok: false, error: KEY_REFUSAL };
  }

  // `--flag=value` and `--flag value` both work.
  const rest: string[] = [];
  for (const raw of argv) {
    const m = /^(--[A-Za-z][\w-]*)=(.*)$/.exec(raw);
    if (m) rest.push(m[1]!, m[2]!);
    else rest.push(raw);
  }

  const fail = (error: string): ParseResult => ({ ok: false, error });
  const list = (v: string): string[] => v.split(',').map((s) => s.trim()).filter(Boolean);

  while (rest.length) {
    const k = rest.shift()!;
    const value = (): string | null => {
      const v = rest[0];
      if (v === undefined || v.startsWith('--')) return null;
      rest.shift();
      return v;
    };
    switch (k) {
      case '-h':
      case '--help':
      case '/?':
        a.help = true;
        break;
      case '-y':
      case '--yes':
        a.yes = true;
        break;
      case '--plan-only':
        a.planOnly = true;
        break;
      case '--throwaway-key':
        a.throwawayKey = true;
        break;
      case '--no-smoke':
        a.smoke = 'no';
        break;
      case '--smoke':
        a.smoke = 'yes';
        break;
      case '--no-wait':
        a.noWait = true;
        break;
      case '--no-revoke':
        a.revoke = false;
        break;
      case '--no-tiers':
        a.noTiers = true;
        break;
      case '--profile': {
        const v = value();
        if (v === null || !/^[a-z][a-z0-9-]{1,40}$/.test(v)) return fail('--profile needs a runner profile name, like core, evm-tour or all-chains');
        a.profile = v;
        break;
      }
      case '--no-pause':
        break; // the launcher's own switch
      case '--stages': {
        const v = value();
        if (v === null) return fail('--stages needs a list like A,B');
        const want = list(v).map((s) => s.toUpperCase());
        if (!want.length) return fail('--stages needs a list like A,B');
        if (want.length === 1 && want[0] === 'ALL') {
          a.stages = [...ALL_STAGES];
          break;
        }
        const bad = want.filter((s) => !(ALL_STAGES as readonly string[]).includes(s));
        if (bad.length) return fail(`unknown stage ${bad.join(', ')} - the stages are A, B, C and D`);
        a.stages = ALL_STAGES.filter((s) => want.includes(s));
        break;
      }
      case '--only': {
        const v = value();
        const steps = v === null ? [] : list(v);
        if (!steps.length) return fail('--only needs a list of runner steps, like withdraw-external,cleanup');
        const bad = steps.filter((s) => !/^[a-z][a-z0-9-]{1,40}$/.test(s));
        if (bad.length) return fail(`--only: "${bad[0]}" is not a runner step name`);
        a.only = steps;
        break;
      }
      case '--suites': {
        const v = value();
        const names = v === null ? [] : list(v).map((s) => s.toLowerCase());
        if (!names.length) return fail('--suites needs a list like web-unit,server');
        a.suites = names;
        break;
      }
      case '--backend': {
        const v = value();
        const o = v === null ? null : normaliseOrigin(v);
        if (!o) return fail('--backend needs an origin like http://127.0.0.1:5180');
        if (isForbiddenLocal(o)) return fail(`--backend: port ${new URL(o).port} belongs to another project on this machine - the guide never talks to it`);
        a.backend = o;
        break;
      }
      case '--site-origin': {
        const v = value();
        const o = v === null ? null : normaliseOrigin(v);
        if (!o) return fail('--site-origin needs an origin like https://valuescan.example');
        a.siteOrigin = o;
        break;
      }
      case '--report-dir': {
        const v = value();
        if (v === null) return fail('--report-dir needs a folder');
        a.reportDir = v;
        break;
      }
      case '--config': {
        const v = value();
        if (v === null || !/\.json$/i.test(v)) return fail('--config needs a .json file');
        a.config = v;
        break;
      }
      case '--wait-minutes': {
        const v = value();
        const n = v === null ? NaN : Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 24 * 60) return fail('--wait-minutes needs a number of minutes from 0 to 1440');
        a.waitMinutes = n;
        break;
      }
      case '--builder': {
        const v = value();
        if (v === null || !(/^0x[0-9a-fA-F]{40}$/.test(v) || /^\d{1,15}$/.test(v))) return fail('--builder needs a wallet address (0x + 40 hex) or a SoDEX account id (a number)');
        a.builder = v;
        break;
      }
      case '--fee-perps':
      case '--fee-spot': {
        const v = value();
        const cap = k === '--fee-perps' ? 200 : 2000;
        const n = v === null ? NaN : Number(v);
        if (!Number.isInteger(n) || n < 0 || n > cap) return fail(`${k} needs a whole number from 0 to ${cap} (tenths of a basis point: 10 = 0.01 %)`);
        if (k === '--fee-perps') a.feePerps = n;
        else a.feeSpot = n;
        break;
      }
      default:
        return fail(k.startsWith('-') ? `unknown option ${k}` : `unexpected argument "${k}"`);
    }
  }

  if (a.throwawayKey && !a.planOnly) return fail('--throwaway-key only works with --plan-only: a random key controls no funds, so it cannot run live');
  if (a.only && !a.stages.includes('D')) return fail('--only is for stage D (the live money run), which is not selected');
  if (a.profile && !a.stages.includes('D')) return fail('--profile is for stage D (the live money run), which is not selected');
  return { ok: true, args: a };
}
