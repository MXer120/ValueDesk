/**
 * Stage C: the builder account and the fee tiers.
 *
 * Everything here that touches an exchange only READS (the account id and two
 * balances, through apps/web/tools/check-builder.mjs). Two things write, and
 * both only after the owner said so:
 *   - apps/server/tools/builderTiers.ts `init` writes the server's tier config
 *     and its terms-signing key (the guide never creates those files itself and
 *     never sees the private key);
 *   - appending the VITE_BUILDER_* lines to apps/web/.env.local - offered, never
 *     done by `--yes`, never overwriting a line that is already there.
 * Creating a builder account with a second wallet is a money run of its own
 * (stage D's machinery with the runner's `builder-setup` profile), or - while
 * the runner has no such profile - precise steps in the app's own screens.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILDER_EXPLANATION,
  FEE_CAPS,
  FEE_DEFAULTS,
  appendEnvText,
  builderCheckLines,
  builderEnvLines,
  classifyBuilderInput,
  feeBp,
  feePercent,
  hasPrivateKeyField,
  judgeBuilder,
  lastJsonLine,
  makeBuilderChoice,
  manualBuilderSteps,
  parseFee,
  planEnvAppend,
  readCheckBuilderJson,
  readTiersJson,
  tierLines,
  tiersProblems,
  type BuilderCheck,
  type TiersInfo,
} from './builder';
import { applyChoices, configProblems, type BuilderChoice } from './config';
import { checkStop, logWriter, type Ctx } from './context';
import { childEnv } from './proc';
import { askValue, choose, confirm, pressEnter } from './prompt';
import { SODEX_GATEWAY, readOnlyProblem } from './readonly';
import { hasProfile } from './runner';
import { detectCapabilities, moneyRun, realDDeps, type DDeps } from './stageD';
import { TERMS_PATH, judgeTerms } from './terms';
import { STAGE_TITLES, Stopped, stageStatus, type Item, type StageResult } from './types';

export interface TiersCall {
  /** The tool file is in this checkout. */
  present: boolean;
  info: TiersInfo | null;
  /** The tool printed something that looks like a private key: nothing of its output is used or shown. */
  leaked: boolean;
  error: string | null;
}

export interface CDeps {
  /** Is this wallet's SoDEX account an eligible builder? Read-only. */
  checkBuilder(address: string): Promise<{ check: BuilderCheck | null; error: string | null }>;
  /** A SoDEX account id -> its wallet, through our own API. */
  resolveAccount(id: number): Promise<{ address: string | null; error: string | null }>;
  /** apps/server/tools/builderTiers.ts (docs/BUILDER-TIERS.md section 4). */
  tiers(cmd: 'init' | 'status', builderId?: number): Promise<TiersCall>;
  /** GET {backend}/api/vs/builder/terms - what the running server signs. */
  terms(address: string, nonce: string): Promise<{ status: number; json: unknown; cacheControl: string | null }>;
  /** apps/web/.env.local - read and written ONLY when the owner asks for the lines to be added. */
  env: { path: string; read(): string | null; write(text: string): void };
  nonce(): string;
  d: DDeps;
}

export function realCDeps(ctx: Ctx): CDeps {
  const tool = join(ctx.paths.web, 'tools', 'check-builder.mjs');
  const tierTool = join(ctx.paths.repo, 'apps', 'server', 'tools', 'builderTiers.ts');
  const envPath = join(ctx.paths.web, '.env.local');
  const get = async (url: string): Promise<{ status: number; json: unknown; headers: Headers }> => {
    const refused = readOnlyProblem('GET', url, null, { backend: ctx.args.backend });
    if (refused) throw new Error(refused);
    const res = await ctx.fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, headers: res.headers };
  };
  return {
    d: realDDeps(ctx),
    nonce: () => randomBytes(18).toString('base64url'),
    env: {
      path: envPath,
      read: () => {
        try {
          return readFileSync(envPath, 'utf8');
        } catch {
          return null;
        }
      },
      write: (text) => writeFileSync(envPath, text, 'utf8'),
    },
    checkBuilder: async (address) => {
      if (existsSync(tool)) {
        const lines: string[] = [];
        const errs: string[] = [];
        const r = await ctx.run(ctx.tools.node, [tool, address, '--json'], { cwd: ctx.paths.web, env: childEnv(ctx.env), timeoutMs: 60_000, onLine: (l, from) => (from === 'out' ? lines : errs).push(l) });
        const check = readCheckBuilderJson(lines.join('\n'));
        if (check) return { check, error: null };
        return { check: null, error: r.startError ?? (errs.join(' ').trim() || `check-builder exited with code ${r.code}`) };
      }
      // The tool is not in this checkout: the same three public reads.
      try {
        const data = async (path: string): Promise<unknown> => {
          const g = await get(`${SODEX_GATEWAY}${path}`);
          const o = g.json as { code?: unknown; data?: unknown; error?: unknown } | null;
          if (g.status !== 200 || !o || o.code !== 0) {
            if (/user not found|account not found/i.test(String(o?.error ?? ''))) return null;
            throw new Error(`${path}: ${String(o?.error ?? `HTTP ${g.status}`)}`);
          }
          return o.data;
        };
        const sub = (await data(`/api/v1/user/${address}/subaccounts`)) as { primaryAccountID?: unknown } | null;
        const id = Number(sub?.primaryAccountID) || 0;
        if (!id) return { check: judgeBuilder({ address, builderId: null, spot: null, perps: null }), error: null };
        const usdc = async (engine: string): Promise<{ total: number | null; locked: number }> => {
          const d = await data(`/api/v1/${engine}/accounts/${address}/balances?accountID=${id}`);
          const list = (Array.isArray(d) ? d : Array.isArray((d as { balances?: unknown[] } | null)?.balances) ? (d as { balances: unknown[] }).balances : []) as Array<Record<string, unknown>>;
          const row = list.find((b) => /^v?USDC$/i.test(String(b.coin ?? b.a ?? '')));
          const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
          return { total: row ? num(row.total ?? row.t ?? row.wb) : 0, locked: row ? num(row.locked ?? row.l) : 0 };
        };
        const spot = await usdc('spot');
        const perps = await usdc('perps');
        return { check: judgeBuilder({ address, builderId: id, spot: spot.total, perps: perps.total, spotLocked: spot.locked }), error: null };
      } catch (e) {
        return { check: null, error: (e as Error).message };
      }
    },
    resolveAccount: async (id) => {
      try {
        const g = await get(`${ctx.args.backend}/api/feed/account?id=${id}`);
        const o = g.json as { ok?: unknown; resolved?: unknown; address?: unknown; error?: unknown } | null;
        if (g.status === 200 && o?.resolved === true && typeof o.address === 'string') return { address: o.address, error: null };
        return { address: null, error: String(o?.error ?? (o?.resolved === false ? 'SoDEX knows no account with that id' : `HTTP ${g.status}`)) };
      } catch (e) {
        return { address: null, error: (e as Error).message };
      }
    },
    tiers: async (cmd, builderId) => {
      if (!existsSync(tierTool)) return { present: false, info: null, leaked: false, error: null };
      if (!ctx.tools.tsxCli) return { present: true, info: null, leaked: false, error: 'tsx is not installed' };
      const args = cmd === 'init' ? ['tools/builderTiers.ts', 'init', '--builder-id', String(builderId), '--test-tiers'] : ['tools/builderTiers.ts', 'status'];
      const outLines: string[] = [];
      const errLines: string[] = [];
      // The tool's output is captured, never streamed to the screen or a log: only the fields read below are used.
      const r = await ctx.run(ctx.tools.node, [ctx.tools.tsxCli, ...args], { cwd: join(ctx.paths.repo, 'apps', 'server'), env: childEnv(ctx.env), timeoutMs: 120_000, onLine: (l, from) => (from === 'out' ? outLines : errLines).push(l) });
      const text = outLines.join('\n');
      const parsed = lastJsonLine(text);
      if (/PRIVATE KEY/.test(text) || /PRIVATE KEY/.test(errLines.join('\n')) || hasPrivateKeyField(parsed)) return { present: true, info: null, leaked: true, error: 'the tool printed something that looks like a private key' };
      // A refusal (exit 1) is still one JSON object: { error, problem? | problems? } - its words, not just a code.
      const p = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      const more = typeof p?.problem === 'string' ? p.problem : Array.isArray(p?.problems) ? p.problems.filter((x): x is string => typeof x === 'string').join('; ') : '';
      const said = typeof p?.error === 'string' ? `${p.error}${more ? ` (${more})` : ''}`.slice(0, 400) : null;
      const info = readTiersJson(text);
      if (!info) return { present: true, info: null, leaked: false, error: r.startError ?? said ?? (errLines.filter((l) => l.trim() && !/ExperimentalWarning|--trace-warnings/.test(l)).slice(-2).join(' ').slice(0, 300) || `the tool exited with code ${r.code} and printed no JSON`) };
      return { present: true, info, leaked: false, error: r.code === 0 ? null : said ?? `the tool exited with code ${r.code}` };
    },
    terms: async (address, nonce) => {
      const g = await get(`${ctx.args.backend}${TERMS_PATH}?address=${address}&nonce=${nonce}`);
      return { status: g.status, json: g.json, cacheControl: g.headers.get('cache-control') };
    },
  };
}

export async function runStageC(ctx: Ctx, deps: CDeps = realCDeps(ctx)): Promise<StageResult> {
  const { out, args } = ctx;
  const startedAt = new Date(ctx.now()).toISOString();
  const t0 = ctx.now();
  const items: Item[] = [];
  ctx.shared.partial = items;
  const notes: string[] = [];
  const done = (reason?: string, status = stageStatus(items)): StageResult => ({ id: 'C', title: STAGE_TITLES.C, status, startedAt, ms: ctx.now() - t0, items, notes, ...(reason ? { reason } : {}) });
  const say = (t: string): void => out.say(t, '   ');

  out.lines(BUILDER_EXPLANATION, ' ');
  out.line();

  // --- which builder -----------------------------------------------------------------------
  let input: string | null = args.builder;
  if (!input) {
    const pick = await choose(
      ctx.ask,
      'Which describes you?',
      [
        { key: 'have', label: 'I already have a builder account' },
        { key: 'create', label: 'Create one now with a second, fresh wallet (about 205 USDC, parked)' },
        { key: 'skip', label: 'Skip the builder tests' },
      ],
      'skip',
    );
    if (pick === 'skip') {
      ctx.shared.builder = null;
      say('Skipped. The live run then tests everything else; the builder-fee checks will read "not run".');
      return done('you chose to skip the builder tests', 'SKIPPED');
    }
    if (pick === 'create') {
      const created = await createBuilder(ctx, deps, items, notes);
      if (created.next === 'stop') return done('the builder account was not set up');
      // After a setup run the builder's wallet is known: check that one.
      input = created.address;
    }
  }

  // --- the check (read-only), until it is eligible or the owner gives up ---------------------
  let check: BuilderCheck | null = null;
  for (let round = 0; ; round++) {
    checkStop(ctx);
    if (!input) {
      out.prompt(' The builder\'s wallet address or its SoDEX account ID: ');
      const typed = await ctx.ask.prompter.ask('');
      if (typed === null) throw new Stopped('the input ended');
      input = typed.trim();
    }
    const what = classifyBuilderInput(input);
    if (what.kind === 'bad') {
      say(what.problem);
      if (args.builder) return fail(items, done, 'builder account', what.problem);
      input = null;
      continue;
    }
    let address: string;
    if (what.kind === 'id') {
      out.line(`   Looking up the wallet of account #${what.id} (our own API, read-only)...`);
      const r = await deps.resolveAccount(what.id);
      if (!r.address) {
        say(`Account #${what.id} could not be resolved: ${r.error}. Enter the builder's wallet address instead.`);
        if (args.builder) return fail(items, done, 'builder account', `account #${what.id} could not be resolved: ${r.error}`);
        input = null;
        continue;
      }
      address = r.address;
    } else address = what.address;

    out.line('   Checking the account on SoDEX (three public reads; no key, nothing is signed)...');
    const r = await deps.checkBuilder(address);
    if (!r.check) {
      say(`The check could not be made: ${r.error}`);
      if (ctx.ask.auto || !(await confirm(ctx.ask, 'Try again?', true))) return fail(items, done, 'builder account', `the check could not be made: ${r.error}`);
      continue;
    }
    check = r.check;
    out.lines(builderCheckLines(check), '      ');
    if (what.kind === 'id' && check.builderId !== null && check.builderId !== what.id) {
      say(`Note: #${what.id} is not that wallet's primary account. The builder ID is the primary account's: #${check.builderId}.`);
    }
    for (const n of check.notes) say(`Note: ${n}`);
    if (check.eligible) break;
    out.line('   NOT ELIGIBLE YET:');
    for (const m of check.missing) out.say(`- ${m}`, '      ');
    say('Top it up in the app: Deposit, then Transfer between "SoDEX Spot" and "SoDEX Futures" (Perps).');
    if (ctx.ask.auto || args.noWait) return fail(items, done, 'builder account eligible', check.missing.join(' '));
    const again = await choose(ctx.ask, 'What now?', [{ key: 'again', label: 'Check again (after topping it up)' }, { key: 'other', label: 'Check another wallet or account ID' }, { key: 'skip', label: 'Skip the builder tests' }], 'again');
    if (again === 'skip') {
      ctx.shared.builder = null;
      items.push({ id: 'builder-eligible', title: 'builder account eligible', status: 'FAIL', detail: check.missing.join(' ') });
      return done('the builder account is not eligible');
    }
    if (again === 'other') input = null;
    if (round > 50) return fail(items, done, 'builder account eligible', check.missing.join(' '));
  }
  const builderId = check.builderId!;
  const address = check.address!;
  ctx.shared.builderAddress = address;
  items.push({ id: 'builder-eligible', title: 'builder account eligible', status: 'PASS', detail: `builder ID ${builderId}: Spot ${check.spot} vUSDC, Perps ${check.perps} vUSDC` });
  out.line(`   ELIGIBLE. The builder ID is ${builderId}.`);

  // --- fee tiers -----------------------------------------------------------------------------
  out.line();
  let tiers: TiersInfo | null = null;
  if (args.noTiers) {
    items.push({ id: 'tiers', title: 'fee tiers set up', status: 'SKIPPED', detail: 'switched off with --no-tiers' });
  } else {
    say('FEE TIERS. The fee can follow how much a wallet has traded through Valuescan. For the test the server gets two tiers: 2 bp on perps to start with, and 1.5 bp once more than 10 USDC of volume is verified - so the run can prove that the fee changes, and that it cannot be gamed.');
    say('Setting this up writes two files into the server\'s data folder on this computer (the tier list and a signing key for it), if they are not there yet. The running server picks them up by itself; nothing is restarted.');
    if (await confirm(ctx.ask, 'Set up the test fee tiers now?', true)) tiers = await setupTiers(ctx, deps, builderId, address, items);
    else items.push({ id: 'tiers', title: 'fee tiers set up', status: 'SKIPPED', detail: 'not set up - you answered no' });
  }

  // --- the fee for the run ---------------------------------------------------------------------
  out.line();
  let feePerps: number;
  let feeSpot: number;
  if (tiers?.tiers.length) {
    feePerps = tiers.tiers[0]!.perps;
    feeSpot = tiers.tiers[0]!.spot;
    out.line(`   The run starts on the first tier: perps ${feeBp(feePerps)} (${feePercent(feePerps)}), spot ${feeBp(feeSpot)} (${feePercent(feeSpot)}).`);
  } else {
    say('The fee to test with, in tenths of a basis point: 10 = 1 bp = 0.01 % of a fill. It is charged on top of SoDEX\'s own fee - on every perps fill, and on spot sells.');
    feePerps = args.feePerps ?? (await askValue(ctx.ask, `Perps fee, 0 to ${FEE_CAPS.perps} [${FEE_DEFAULTS.perps} = ${feePercent(FEE_DEFAULTS.perps)}]:`, (s) => parseFee(s, FEE_CAPS.perps, FEE_DEFAULTS.perps), { auto: '' }));
    feeSpot = args.feeSpot ?? (await askValue(ctx.ask, `Spot fee,  0 to ${FEE_CAPS.spot} [${FEE_DEFAULTS.spot} = ${feePercent(FEE_DEFAULTS.spot)}]:`, (s) => parseFee(s, FEE_CAPS.spot, FEE_DEFAULTS.spot), { auto: '' }));
    if (feePerps === 0 && feeSpot === 0) {
      say('Both fees are 0: that is the same as no builder. The builder tests are skipped.');
      ctx.shared.builder = null;
      return done('both fees are 0');
    }
    out.line(`   Perps ${feePercent(feePerps)} of each fill, spot ${feePercent(feeSpot)} of each sell.`);
  }
  const revoke = args.revoke ?? (await confirm(ctx.ask, 'Revoke the fee approval on the test account at the end of the run?', true));
  const builder: BuilderChoice = makeBuilderChoice({ id: builderId, address, feePerps, feeSpot, revokeAtEnd: revoke, maxFeeRate: tiers?.maxFeeRate ?? null, ...(tiers?.publicKey ? { termsKeys: [tiers.publicKey] } : {}) });
  ctx.shared.builder = builder;

  // --- the run config ---------------------------------------------------------------------------
  const loaded = deps.d.loadConfig();
  const base = loaded.existing ?? loaded.example;
  if (!base || loaded.problem) {
    items.push({ id: 'config', title: 'builder section in the run config', status: 'FAIL', detail: loaded.problem ?? 'config.example.json could not be read' });
  } else if (configProblems(base).length) {
    items.push({ id: 'config', title: 'builder section in the run config', status: 'FAIL', detail: configProblems(base)[0]! });
  } else {
    try {
      deps.d.saveConfig(ctx.paths.config.config, applyChoices(base, { builder, acknowledgeRealFunds: false }, loaded.names));
      const lacksTerms = !!builder.termsKeys?.length && !loaded.names.termsKeys;
      items.push({
        id: 'config',
        title: 'builder section in the run config',
        status: lacksTerms ? 'WARN' : 'PASS',
        detail: `written to ${ctx.paths.config.config}${lacksTerms ? ' - WITHOUT the terms key: this version of the live runner has no builder.termsKeys field, so it cannot test the fee change' : ''}`,
      });
      out.line(`   The builder section is in the run config: ${ctx.paths.config.config}`);
      if (lacksTerms) say('Note: this version of the live runner does not take the terms key yet (no "builder.termsKeys" in its config). The live run will test the builder fee, but not the change of the fee.');
    } catch (e) {
      items.push({ id: 'config', title: 'builder section in the run config', status: 'FAIL', detail: (e as Error).message });
    }
  }

  // --- the app's settings ------------------------------------------------------------------------
  const lines = builderEnvLines(builder);
  ctx.shared.envLines = lines;
  out.line();
  out.line('   To test the fee BY HAND in the browser, the web app needs these lines in');
  out.line(`   ${deps.env.path}`);
  out.line();
  for (const l of lines) out.line(`      ${l}`);
  out.line();
  const withTermsKey = lines.some((l) => l.startsWith('VITE_BUILDER_TERMS_KEYS='));
  say(`The live run does not need them: it takes the builder from the run config. The first three switch the fee on; MAX_FEE is the ceiling a user approves${withTermsKey ? '; TERMS_KEYS lets the app check the server\'s signed fee (without it the app ignores a lower fee and charges the default)' : '. (No TERMS_KEYS line: the fee tiers were not set up in this run, so the app always charges the fee above.)'}`);
  say('The guide can add the lines that are missing. It never changes a line that is already there. Saving that file makes the web dev server reload by itself, and every open Valuescan tab reloads with it.');
  // The default is NO, so `--yes` (which only ever takes defaults) never writes that file.
  if (await confirm(ctx.ask, 'Add the missing lines to .env.local now?', false)) {
    const text = deps.env.read() ?? '';
    const plan = planEnvAppend(text, lines);
    for (const c of plan.conflicts) say(`NOT changed: ${c.name} is already set to "${c.existing}" (this run uses "${c.wanted}"). Change that line by hand if you want the new value.`);
    if (!plan.append.length) out.line(`   Nothing to add: ${plan.same.length} of the lines are already there${plan.conflicts.length ? `, ${plan.conflicts.length} differ` : ''}.`);
    else {
      try {
        deps.env.write(appendEnvText(text, plan, new Date(ctx.now()).toISOString().slice(0, 10)));
        out.line(`   Added ${plan.append.length} line(s): ${plan.append.map((l) => l.split('=')[0]).join(', ')}. The dev server reloads now.`);
        notes.push(`Added to apps/web/.env.local: ${plan.append.map((l) => l.split('=')[0]).join(', ')}.`);
      } catch (e) {
        say(`The file could not be written (${(e as Error).message}). Add the lines by hand.`);
      }
    }
    if (plan.conflicts.length) ctx.shared.next.push(`apps/web/.env.local already sets ${plan.conflicts.map((c) => c.name).join(', ')} to other values than this run uses - change them by hand to test the same fee in the browser.`);
  } else {
    ctx.shared.next.push('To test the builder fee by hand in the browser, add the VITE_BUILDER_* lines of this summary to apps/web/.env.local (saving it reloads the dev server).');
  }
  return done();
}

function fail(items: Item[], done: (reason?: string) => StageResult, title: string, detail: string): StageResult {
  items.push({ id: 'builder-eligible', title, status: 'FAIL', detail });
  return done(detail);
}

/**
 * The server's tier config and terms key, through its own tool, and a check
 * that the RUNNING server signs terms the app would accept.
 */
async function setupTiers(ctx: Ctx, deps: CDeps, builderId: number, address: string, items: Item[]): Promise<TiersInfo | null> {
  const { out } = ctx;
  const say = (t: string): void => out.say(t, '   ');
  const init = await deps.tiers('init', builderId);
  if (!init.present) {
    say('The fee-tier tool (apps/server/tools/builderTiers.ts) is not in this checkout yet. The tiers cannot be set up, so the fee-change test will not run; the builder fee itself is still tested.');
    items.push({ id: 'tiers', title: 'fee tiers set up', status: 'SKIPPED', detail: 'apps/server/tools/builderTiers.ts is not in this checkout yet' });
    ctx.shared.next.push('The fee tiers could not be set up: apps/server/tools/builderTiers.ts is missing. Run stage C again once it is there.');
    return null;
  }
  if (init.leaked) {
    say('STOP: the tier tool printed something that looks like a private key. Nothing of its output was shown, logged or used. The tool must never print the key - report this before using it.');
    items.push({ id: 'tiers', title: 'fee tiers set up', status: 'FAIL', detail: 'the tier tool printed something that looks like a private key; its output was discarded' });
    return null;
  }
  if (!init.info) {
    say(`The tier tool did not answer as expected: ${init.error}`);
    items.push({ id: 'tiers', title: 'fee tiers set up', status: 'FAIL', detail: `builderTiers.ts init: ${init.error}` });
    return null;
  }
  // `init` leaves existing files alone, so `status` is what says what is in force.
  const st = await deps.tiers('status');
  const info = st.info ?? init.info;
  const merged: TiersInfo = { ...init.info, ...info, publicKey: info.publicKey ?? init.info.publicKey, keyId: info.keyId ?? init.info.keyId, tiers: info.tiers.length ? info.tiers : init.info.tiers };
  const problems = [
    ...(init.error ? [`builderTiers.ts init refused: ${init.error}`] : []),
    ...(st.leaked ? ['the tool\'s status printed something that looks like a private key'] : []),
    ...tiersProblems(merged, builderId),
  ];
  if (problems.length) {
    for (const p of problems) out.say(`- ${p}`, '      ');
    if (merged.builderId !== null && merged.builderId !== builderId) {
      say(`The tier files on this computer belong to another builder. The guide does not overwrite them. To replace them yourself, run this in apps\\server:  npx tsx tools/builderTiers.ts init --builder-id ${builderId} --test-tiers --force`);
      ctx.shared.next.push(`The server's fee tiers are for builder #${merged.builderId}, not #${builderId}. Replace them (apps\\server: npx tsx tools/builderTiers.ts init --builder-id ${builderId} --test-tiers --force) and run stage C again.`);
    }
    items.push({ id: 'tiers', title: 'fee tiers set up', status: 'FAIL', detail: problems.join('; ') });
    return null;
  }
  out.line(`   Tier file ...... ${merged.configPath ?? '(the tool did not say where)'}`);
  out.line(`   Signing key .... ${merged.keyPath ?? '(the tool did not say where)'}   (the private key stays in that file)`);
  out.line(`   Public key ..... ${merged.publicKey}   (id ${merged.keyId ?? '?'})`);
  out.lines(tierLines(merged.tiers), '      ');
  items.push({ id: 'tiers', title: 'fee tiers set up', status: 'PASS', detail: `${merged.tiers.length} tiers for builder #${builderId}: ${merged.tiers.map((t) => `from $${t.minVolumeUsd} perps ${feeBp(t.perps)}`).join(', ')}` });

  // Does the RUNNING server sign with that key? (It re-reads the file by itself; give it a moment.)
  const log = logWriter(ctx, 'C-terms.log');
  let verdict = { status: 'FAIL' as 'PASS' | 'WARN' | 'FAIL', detail: 'no answer' };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await ctx.sleep(3000);
    const nonce = deps.nonce();
    try {
      const r = await deps.terms(address, nonce);
      verdict = judgeTerms(r.status, r.json, { address, nonce, builderId, publicKeys: merged.publicKey ? [merged.publicKey] : [], cacheControl: r.cacheControl, now: ctx.now() });
    } catch (e) {
      verdict = { status: 'FAIL', detail: `the request failed: ${(e as Error).message}` };
    }
    log.write(`attempt ${attempt + 1}: ${verdict.status} ${verdict.detail}`);
    if (verdict.status !== 'FAIL') break;
  }
  items.push({ id: 'terms', title: 'the running server signs fee terms the app accepts', status: verdict.status, detail: verdict.detail, log: log.path });
  out.result(verdict.status, 'the running server signs the fee terms', verdict.detail);
  if (verdict.status === 'FAIL') ctx.shared.next.push('The running backend does not serve signed fee terms that verify (stage C). Until it does, every order carries the default fee and the fee-change test cannot pass.');
  return merged;
}

/** Choice 2: a builder account with a second, fresh wallet. `address`: the wallet a setup run used. */
async function createBuilder(ctx: Ctx, deps: CDeps, items: Item[], notes: string[]): Promise<{ next: 'check' | 'stop'; address: string | null }> {
  const { out } = ctx;
  const say = (t: string): void => out.say(t, '   ');
  const caps = await detectCapabilities(ctx, deps.d);
  if (hasProfile(caps, 'builder-setup')) {
    say('The live runner can set the builder account up: with the key of a SECOND fresh wallet it deposits, enables trading, moves 102 USDC to Perps and checks the result. It needs about 205 USDC and a little ETH for gas on Arbitrum One in that wallet. The money is parked in the builder account, not spent (the activation fee of 1 USDC and the gas are).');
    if (!ctx.ask.prompter.interactive) {
      say('That is a live money run, which only a person at a console can start. Here are the steps to do it by hand instead.');
    } else if (await confirm(ctx.ask, 'Set it up with the runner now?', true, { money: true })) {
      // The setup run is a run of its own: what it leaves behind must not be taken for the test wallet's run.
      const keep = { ...ctx.shared };
      const r = await moneyRun(ctx, deps.d, { what: 'the BUILDER wallet (the second, fresh wallet)', profile: 'builder-setup', headings: false });
      const wallet = ctx.shared.wallet;
      Object.assign(ctx.shared, { wallet: keep.wallet, profile: keep.profile, planReport: keep.planReport, liveReport: keep.liveReport, liveReportPath: keep.liveReportPath, runnerSummaryMd: keep.runnerSummaryMd, runnerSummaryPath: keep.runnerSummaryPath, partial: keep.partial });
      items.push(...r.items.map((x) => ({ ...x, id: `setup-${x.id}`, group: 'builder setup run' })));
      notes.push(...r.notes);
      if (!r.completed) {
        say(`The builder setup did not finish${r.reason ? `: ${r.reason}` : ''}.`);
        if (!(await confirm(ctx.ask, 'Check a builder account anyway (for example after finishing it by hand)?', true))) return { next: 'stop', address: null };
      }
      return { next: 'check', address: wallet };
    }
  } else {
    say('This version of the live runner cannot set a builder account up by itself yet (it has no "builder-setup" profile). Do it by hand in the app - it takes a few minutes:');
  }
  out.line();
  out.lines(manualBuilderSteps(ctx.args.backend), '      ');
  out.line();
  if (ctx.ask.auto) return { next: 'stop', address: null };
  await pressEnter(ctx.ask, 'Press Enter when that is done (or to check how far it is).');
  return { next: 'check', address: null };
}
