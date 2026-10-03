/**
 * The guide's command line and its step numbering.
 *   npx tsx --test e2e/guide/args.test.ts        (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BACKEND, DEFAULT_SITE_ORIGIN, isForbiddenLocal, normaliseOrigin, parseArgs, type GuideArgs } from './args';
import { mayMoveFunds, needsDevServer, planSteps, stepHeading } from './stages';

const ok = (argv: string[]): GuideArgs => {
  const r = parseArgs(argv);
  if (!r.ok) throw new Error(`expected the arguments to parse: ${r.error}`);
  return r.args;
};
const err = (argv: string[]): string => {
  const r = parseArgs(argv);
  if (r.ok) throw new Error('expected the arguments to be refused');
  return r.error;
};

// A key-sized string made up for the test; it controls nothing.
const KEYLIKE = `0x${'ab12'.repeat(16)}`;

test('no arguments: the full guided run, asking everything', () => {
  const a = ok([]);
  assert.deepEqual(a.stages, ['A', 'B', 'C', 'D']);
  assert.equal(a.yes, false);
  assert.equal(a.planOnly, false);
  assert.equal(a.throwawayKey, false);
  assert.equal(a.smoke, 'ask');
  assert.equal(a.backend, DEFAULT_BACKEND);
  assert.equal(a.siteOrigin, DEFAULT_SITE_ORIGIN);
  assert.equal(a.profile, null);
  assert.equal(a.noTiers, false);
});

test('--stages: letters in any case and order, kept in run order; "all"; unknown ones refused', () => {
  assert.deepEqual(ok(['--stages', 'b,a']).stages, ['A', 'B']);
  assert.deepEqual(ok(['--stages=D']).stages, ['D']);
  assert.deepEqual(ok(['--stages', 'all']).stages, ['A', 'B', 'C', 'D']);
  assert.match(err(['--stages', 'A,Z']), /unknown stage Z/);
  assert.match(err(['--stages']), /needs a list/);
});

test('a private key on the command line is refused, in every form, and never echoed', () => {
  for (const argv of [[KEYLIKE], [KEYLIKE.slice(2)], ['--key', KEYLIKE], ['--private-key=whatever'], [`--confirm=${KEYLIKE}`], ['--stages', 'A', `"${KEYLIKE}"`], ['--pk', 'x']]) {
    const e = err(argv);
    assert.match(e, /refused/);
    assert.ok(!e.includes(KEYLIKE.slice(2)), 'the refusal must not repeat the key');
  }
});

test('--throwaway-key only with --plan-only; --only and --profile only with stage D', () => {
  assert.match(err(['--throwaway-key']), /only works with --plan-only/);
  const a = ok(['--plan-only', '--throwaway-key', '--stages', 'D']);
  assert.equal(a.planOnly && a.throwawayKey, true);
  assert.match(err(['--stages', 'A', '--only', 'cleanup']), /stage D/);
  assert.match(err(['--stages', 'A,B', '--profile', 'core']), /stage D/);
  assert.deepEqual(ok(['--only', 'withdraw-external,cleanup']).only, ['withdraw-external', 'cleanup']);
  assert.match(err(['--only', 'Bad Step']), /not a runner step name/);
  assert.equal(ok(['--profile', 'evm-tour']).profile, 'evm-tour');
  assert.match(err(['--profile', 'Core!']), /profile name/);
});

test('the dev ports of the other project (5173, 8787) can never be the backend', () => {
  assert.match(err(['--backend', 'http://127.0.0.1:5173']), /belongs to another project/);
  assert.match(err(['--backend=http://localhost:8787']), /belongs to another project/);
  assert.equal(ok(['--backend', 'http://127.0.0.1:5180/']).backend, 'http://127.0.0.1:5180');
  assert.match(err(['--backend', 'not a url']), /origin/);
  assert.equal(isForbiddenLocal('http://127.0.0.1:8787/api/health'), true);
  assert.equal(isForbiddenLocal('http://127.0.0.1:5180/api/health'), false);
  assert.equal(isForbiddenLocal('https://example.com:8787/'), false);
});

test('origins: scheme and host only', () => {
  assert.equal(normaliseOrigin('https://valuescan.example/'), 'https://valuescan.example');
  assert.equal(normaliseOrigin('https://valuescan.example/path'), null);
  assert.equal(normaliseOrigin('ftp://x'), null);
});

test('builder switches: an address or an id, fees inside SoDEX caps', () => {
  assert.equal(ok(['--builder', '223169']).builder, '223169');
  assert.equal(ok(['--builder', `0x${'1'.repeat(40)}`]).builder, `0x${'1'.repeat(40)}`);
  assert.match(err(['--builder', 'me']), /wallet address/);
  assert.equal(ok(['--fee-perps', '20']).feePerps, 20);
  assert.match(err(['--fee-perps', '201']), /0 to 200/);
  assert.equal(ok(['--fee-spot=2000']).feeSpot, 2000);
  assert.match(err(['--fee-spot', '1.5']), /whole number/);
  assert.equal(ok(['--no-revoke']).revoke, false);
  assert.equal(ok(['--no-tiers']).noTiers, true);
});

test('other switches, and what is not one', () => {
  const a = ok(['--yes', '--no-smoke', '--no-wait', '--wait-minutes', '15', '--suites', 'Web-Unit,server', '--site-origin', 'https://x.test', '--no-pause']);
  assert.equal(a.yes, true);
  assert.equal(a.smoke, 'no');
  assert.equal(a.noWait, true);
  assert.equal(a.waitMinutes, 15);
  assert.deepEqual(a.suites, ['web-unit', 'server']);
  assert.equal(a.siteOrigin, 'https://x.test');
  assert.equal(ok(['--config', 'C:\\somewhere\\base-chain.json']).config, 'C:\\somewhere\\base-chain.json');
  assert.equal(ok([]).config, null);
  assert.match(err(['--config', 'notes.txt']), /\.json file/);
  assert.equal(ok(['-h']).help, true);
  assert.match(err(['--nope']), /unknown option --nope/);
  assert.match(err(['stray']), /unexpected argument/);
});

// --- step numbering ---------------------------------------------------------------------------

test('the full run has nine numbered steps, in order', () => {
  const steps = planSteps(ok([]));
  assert.deepEqual(steps.map((s) => s.key), ['prep', 'A', 'B', 'C', 'D-profile', 'D-key', 'D-fund', 'D-live', 'E']);
  assert.deepEqual(stepHeading(steps, 'B'), { n: 3, total: 9, title: 'Read-only live checks', stage: 'B' });
  assert.equal(stepHeading(steps, 'E').n, 9);
});

test('--stages A,B: check, A, B, summary', () => {
  const steps = planSteps(ok(['--stages', 'A,B']));
  assert.deepEqual(steps.map((s) => s.key), ['prep', 'A', 'B', 'E']);
  assert.throws(() => stepHeading(steps, 'D-live'), /not part of this run/);
});

test('plan-only runs never have a funding or a live step; a throwaway key has no key step either', () => {
  assert.deepEqual(planSteps(ok(['--stages', 'D', '--plan-only'])).map((s) => s.key), ['prep', 'D-profile', 'D-key', 'D-plan', 'E']);
  assert.deepEqual(planSteps(ok(['--stages', 'D', '--plan-only', '--throwaway-key'])).map((s) => s.key), ['prep', 'D-plan', 'E']);
});

test('which runs need the dev server, and which could move funds', () => {
  assert.equal(needsDevServer(ok(['--stages', 'A'])), false);
  assert.equal(needsDevServer(ok(['--stages', 'A,B'])), true);
  assert.equal(mayMoveFunds(ok([])), true);
  assert.equal(mayMoveFunds(ok(['--plan-only'])), false);
  assert.equal(mayMoveFunds(ok(['--stages', 'A,B,C'])), false);
});

test('--go: the full test straight away - stage D only, the full profile, no menus', () => {
  const r = parseArgs(['--go']);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.args.go, true);
  assert.deepEqual(r.args.stages, ['D']);
  assert.equal(r.args.profile, 'full');
});
