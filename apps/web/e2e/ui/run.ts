/**
 * The UI specs, in Microsoft Edge, against the local dev web. From apps/web:
 *
 *   npx tsx e2e/ui/run.ts                       every spec, throwaway wallet, headless
 *   npx tsx e2e/ui/run.ts --only tpsl,copy      specs whose file name contains a word
 *   npx tsx e2e/ui/run.ts --headed --slow 250   watch it (250 ms per action)
 *   npx tsx e2e/ui/run.ts --web http://127.0.0.1:5181
 *   npx tsx e2e/ui/run.ts --list                the specs it found, run none
 *   npx tsx e2e/ui/run.ts --live --confirm 0xYourAddress     VS_E2E_KEY's funded wallet
 *   npx tsx e2e/ui/run.ts --viewport phone      only at a phone's 375x812 (default: desktop, then phone)
 *
 * Each spec file runs in its own node:test process with its own Edge (--jobs, default 2,
 * at a time). The wallet is a throwaway random key unless --live: then VS_E2E_KEY, and
 * --confirm must name the address it controls. Only --live hands VS_E2E_KEY to the specs.
 * Every spec runs twice by default: on a 1600x1000 desktop, then on a phone (375x812, touch,
 * a phone's user agent: mobile emulation in the same Edge; harness.ts PHONE).
 *
 * Exit: 0 all passed, 1 a spec failed (screenshots and console errors in e2e/ui/.out/),
 * 2 refused to start (no dev web, no Edge, a live run without its key or confirmation).
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { findDevWeb, launchEdge } from './browser';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..');

const argv = process.argv.slice(2);
const FLAGS = new Set(['--live', '--headed', '--list', '--help']);
const VALUED = new Set(['--only', '--web', '--slow', '--jobs', '--confirm', '--viewport']);
const opts = new Map<string, string | true>();
for (let i = 0; i < argv.length; i++) {
  const [k, inline] = argv[i]!.split(/=(.*)/s, 2) as [string, string | undefined];
  if (FLAGS.has(k)) opts.set(k, true);
  else if (VALUED.has(k)) {
    const v = inline ?? argv[++i];
    if (v === undefined) refuse(`${k} needs a value`);
    opts.set(k, v);
  } else refuse(`unknown argument ${argv[i]} (--help lists them)`);
}
const opt = (k: string): string | undefined => {
  const v = opts.get(k);
  return typeof v === 'string' ? v : undefined;
};

function refuse(why: string): never {
  console.error(`ui-e2e: ${why}`);
  process.exit(2);
}

if (opts.has('--help')) {
  console.log(
    (await import('node:fs')).readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 20).map((l) => l.replace(/^ \* ?/, '')).join('\n'),
  );
  process.exit(0);
}

const words = (opt('--only') ?? '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
const specs = readdirSync(HERE)
  .filter((f) => f.endsWith('.spec.ts'))
  .sort()
  .filter((f) => !words.length || words.some((w) => f.toLowerCase().includes(w)));
if (opts.has('--list')) {
  for (const f of specs) console.log(f);
  process.exit(0);
}
if (!specs.length) refuse(`no spec matched ${words.join(', ')}`);

const live = opts.has('--live');
let liveAddress = '';
if (live) {
  const key = process.env.VS_E2E_KEY?.trim() ?? '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) refuse('--live needs VS_E2E_KEY (0x + 64 hex) in the environment');
  try {
    liveAddress = privateKeyToAccount(key as `0x${string}`).address.toLowerCase();
  } catch {
    refuse('VS_E2E_KEY is not a valid key');
  }
  const confirm = opt('--confirm')?.toLowerCase();
  if (confirm !== liveAddress) refuse(`--live needs --confirm ${liveAddress} (the address VS_E2E_KEY controls)`);
}

let origin: string;
try {
  origin = await findDevWeb(opt('--web') ?? process.env.VS_E2E_WEB?.trim());
} catch (e) {
  refuse(String((e as Error).message));
}
try {
  const b = await launchEdge();
  console.log(`ui-e2e: Edge ${b.version()}, dev web ${origin}, ${live ? `LIVE wallet ${liveAddress}` : 'throwaway wallet'}, ${specs.length} spec file${specs.length === 1 ? '' : 's'}`);
  await b.close();
} catch (e) {
  refuse(String((e as Error).message));
}

const env: NodeJS.ProcessEnv = {
  ...process.env,
  VS_E2E_UI_WEB: origin,
  VS_E2E_UI_LIVE: live ? '1' : '0',
  VS_E2E_UI_HEADED: opts.has('--headed') ? '1' : '0',
  VS_E2E_UI_SLOWMO: opt('--slow') ?? '',
};
if (!live) delete env.VS_E2E_KEY;
const jobs = Math.max(1, Math.min(4, Number(opt('--jobs')) || 2));

/** One pass over the specs on one screen: its own node:test run, the screen in VS_E2E_UI_VIEWPORT (harness.ts). */
function pass(viewport: 'desktop' | 'phone'): Promise<{ code: number; signal: NodeJS.Signals | null }> {
  console.log(`ui-e2e: ${viewport === 'phone' ? 'phone, 375x812 (touch, mobile user agent)' : 'desktop, 1600x1000'}`);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--disable-warning=ExperimentalWarning', '--test', '--test-reporter=spec', `--test-concurrency=${jobs}`, ...specs.map((f) => relative(WEB, join(HERE, f)))],
    { cwd: WEB, env: { ...env, VS_E2E_UI_VIEWPORT: viewport }, stdio: 'inherit' },
  );
  return new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code: code ?? 1, signal })));
}

const viewport = opt('--viewport') ?? 'both';
if (!['desktop', 'phone', 'both'].includes(viewport)) refuse(`--viewport is desktop, phone or both (got ${viewport})`);
const screens = viewport === 'both' ? (['desktop', 'phone'] as const) : [viewport as 'desktop' | 'phone'];
const failed: string[] = [];
for (const s of screens) {
  const r = await pass(s);
  if (r.signal) process.exit(130);
  if (r.code) failed.push(s);
}
if (failed.length) console.log(`ui-e2e: failed on ${failed.join(' and ')} - screenshots and console errors of each failed test are in ${relative(WEB, join(HERE, '.out'))}/ (a phone's carry @phone)`);
process.exit(failed.length ? 1 : 0);
