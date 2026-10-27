/**
 * Stage C, the pure parts: what a builder account is, whether one is eligible,
 * the fee units, the fee tiers, the settings to print.
 *
 * The account check itself is apps/web/tools/check-builder.mjs (read-only:
 * three GETs) and the tier setup is apps/server/tools/builderTiers.ts
 * (docs/BUILDER-TIERS.md section 4) - this file only reads what they print.
 */
import type { BuilderChoice } from './config';

export const BUILDER_MIN_USDC = 100;
/** Tenths of a basis point. */
export const FEE_CAPS = { perps: 200, spot: 2000, max: 2000 } as const;
/** The fees asked for when no fee tiers are set up (with tiers, the first tier is the fee). */
export const FEE_DEFAULTS = { perps: 50, spot: 100 } as const;

export const BUILDER_EXPLANATION: readonly string[] = [
  'A BUILDER ACCOUNT is the SoDEX account that receives the ValueDesk fee.',
  '',
  '  - It is an ordinary, activated SoDEX account - nothing to register.',
  `  - It must hold at least ${BUILDER_MIN_USDC} vUSDC in Spot AND at least ${BUILDER_MIN_USDC} vUSDC in Perps.`,
  '    That money is PARKED, not spent: it stays yours and can be withdrawn later',
  '    (then the fee stops working).',
  '  - Its numeric account ID is the "builder ID" the app is configured with.',
  '  - It must be a DIFFERENT wallet from the test wallet: the test wallet is the user',
  '    who approves and pays the fee, the builder account is who receives it.',
  '  - It is YOUR account: the guide and the live run only read it (its id and two',
  '    balances). Nothing here creates, funds or moves money on a builder account.',
];

/** 50 -> "0.05 %", 20 -> "0.02 %", 15 -> "0.015 %". */
export const feePercent = (tenthsOfBp: number): string => `${+(tenthsOfBp / 1000).toFixed(4)} %`;
/** 20 -> "2 bp", 15 -> "1.5 bp". */
export const feeBp = (tenthsOfBp: number): string => `${+(tenthsOfBp / 10).toFixed(1)} bp`;

export type FeeResult = { ok: true; value: number } | { ok: false; problem: string };

/** A typed fee: empty = the default; otherwise a whole number 0..cap. */
export function parseFee(input: string, cap: number, dflt: number): FeeResult {
  const s = input.trim();
  if (!s) return { ok: true, value: dflt };
  if (!/^\d{1,5}$/.test(s)) return { ok: false, problem: `Type a whole number from 0 to ${cap} (tenths of a basis point: 10 = 0.01 %, 50 = 0.05 %), or press Enter for ${dflt}.` };
  const n = Number(s);
  if (n > cap) return { ok: false, problem: `${n} is above the cap of ${cap} (${feePercent(cap)}).` };
  return { ok: true, value: n };
}

export function makeBuilderChoice(o: {
  id: number;
  address?: string | null;
  feePerps: number;
  feeSpot: number;
  revokeAtEnd: boolean;
  /** A ceiling given by the tier config; used when it covers both fees. */
  maxFeeRate?: number | null;
  termsKeys?: readonly string[];
}): BuilderChoice {
  const need = Math.max(o.feePerps, o.feeSpot);
  return {
    id: o.id,
    ...(o.address ? { address: o.address } : {}),
    feePerps: o.feePerps,
    feeSpot: o.feeSpot,
    // The ceiling the test wallet approves: what is charged, nothing above it - unless the tier config names a ceiling that covers it.
    maxFee: typeof o.maxFeeRate === 'number' && o.maxFeeRate >= need && o.maxFeeRate <= FEE_CAPS.max ? o.maxFeeRate : need,
    revokeAtEnd: o.revokeAtEnd,
    ...(o.termsKeys?.length ? { termsKeys: [...o.termsKeys] } : {}),
  };
}

export type BuilderInput = { kind: 'address'; address: string } | { kind: 'id'; id: number } | { kind: 'bad'; problem: string };

/** What the owner typed for "its wallet address or account ID". */
export function classifyBuilderInput(raw: string): BuilderInput {
  const s = raw.trim().replace(/^#/, '');
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return { kind: 'address', address: s };
  if (/^\d{1,15}$/.test(s) && Number(s) > 0) return { kind: 'id', id: Number(s) };
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(s)) return { kind: 'bad', problem: 'That is the size of a PRIVATE KEY. Never enter a key here - this question wants the wallet ADDRESS (0x + 40 hex characters) or the account ID (a number).' };
  return { kind: 'bad', problem: 'Type the wallet address (0x followed by 40 hex characters) or the account ID (a number).' };
}

export interface BuilderCheck {
  address: string | null;
  /** The account's primary account id = the builder id. null: no SoDEX account. */
  builderId: number | null;
  spot: number | null;
  perps: number | null;
  spotLocked: number;
  eligible: boolean;
  /** Exactly what is missing, in words. Empty when eligible. */
  missing: string[];
  notes: string[];
}

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (x: number): number => +x.toFixed(6);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The verdict from balances - the same rule check-builder.mjs applies, so the two cannot disagree. */
export function judgeBuilder(o: { address: string | null; builderId: number | null; spot: number | null; perps: number | null; spotLocked?: number }): BuilderCheck {
  const missing: string[] = [];
  const notes: string[] = [];
  const locked = o.spotLocked ?? 0;
  if (!o.builderId) {
    missing.push('This wallet has no SoDEX account yet. A first deposit opens it (SoDEX keeps 1 USDC of it as the activation fee).');
    missing.push(`After that it needs ${BUILDER_MIN_USDC} vUSDC in Spot and ${BUILDER_MIN_USDC} vUSDC in Perps.`);
  } else {
    if (o.spot === null) missing.push('The Spot balance could not be read.');
    else if (o.spot < BUILDER_MIN_USDC) missing.push(`Spot holds ${round(o.spot)} vUSDC - it needs ${BUILDER_MIN_USDC}: short by ${round(BUILDER_MIN_USDC - o.spot)} vUSDC.`);
    if (o.perps === null) missing.push('The Perps balance could not be read.');
    else if (o.perps < BUILDER_MIN_USDC) missing.push(`Perps holds ${round(o.perps)} vUSDC - it needs ${BUILDER_MIN_USDC}: short by ${round(BUILDER_MIN_USDC - o.perps)} vUSDC.`);
    if (o.spot !== null && o.spot >= BUILDER_MIN_USDC && o.spot - locked < BUILDER_MIN_USDC) {
      notes.push(`Only ${round(o.spot - locked)} vUSDC of the Spot balance is free (the rest is locked in open orders) - keep ${BUILDER_MIN_USDC} out of orders to be safe.`);
    }
  }
  return { address: o.address, builderId: o.builderId || null, spot: o.spot, perps: o.perps, spotLocked: locked, eligible: missing.length === 0, missing, notes };
}

/** The last line of `stdout` that is one JSON object, parsed - how both tools print their answer. */
export function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const whole = stdout.trim();
  const a = whole.indexOf('{');
  const b = whole.lastIndexOf('}');
  // The whole answer as one object (compact or pretty-printed); else the last line that is an object by itself
  // (a tool that printed log lines around its answer).
  const candidates = [...(a >= 0 && b > a ? [whole.slice(a, b + 1)] : []), ...whole.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{') && l.endsWith('}')).reverse()];
  for (const c of candidates) {
    try {
      const j = obj(JSON.parse(c));
      if (j) return j;
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

/** check-builder.mjs `--json` prints one JSON line; this reads it. null: not that. */
export function readCheckBuilderJson(stdout: string): BuilderCheck | null {
  const o = lastJsonLine(stdout);
  if (!o || typeof o.address !== 'string') return null;
  const side = (v: unknown): { total: number | null; locked: number } => {
    const s = obj(v) ?? {};
    return { total: n(s.total), locked: n(s.locked) ?? 0 };
  };
  const spot = side(o.spot);
  return judgeBuilder({ address: o.address, builderId: n(o.builderId), spot: spot.total, perps: side(o.perps).total, spotLocked: spot.locked });
}

/** The account ID and both balances, as printed after a check. */
export function builderCheckLines(c: BuilderCheck): string[] {
  const bal = (v: number | null): string => (v === null ? 'could not be read' : `${round(v)} vUSDC   ${v >= BUILDER_MIN_USDC ? `ok (at least ${BUILDER_MIN_USDC})` : `NOT ENOUGH (needs ${BUILDER_MIN_USDC})`}`);
  return [
    `wallet ............ ${c.address ?? '?'}`,
    `builder ID ........ ${c.builderId ?? 'none - no SoDEX account yet'}${c.builderId ? '   (the account ID)' : ''}`,
    ...(c.builderId ? [`Spot  ............. ${bal(c.spot)}`, `Perps ............. ${bal(c.perps)}`] : []),
  ];
}

// --- fee tiers (docs/BUILDER-TIERS.md section 4) ------------------------------------------------

export interface Tier {
  minVolumeUsd: number;
  perps: number;
  spot: number;
}

/** What `builderTiers.ts init` / `status` print. Every field is optional here: a tool version may print less. */
export interface TiersInfo {
  configPath: string | null;
  keyPath: string | null;
  /** base64url of the raw 32 bytes. Never a private key: the tool does not print one. */
  publicKey: string | null;
  keyId: string | null;
  builderId: number | null;
  tiers: Tier[];
  maxFeeRate: number | null;
  /** status only. */
  valid: boolean | null;
  problems: string[];
}

export function readTiersJson(stdout: string): TiersInfo | null {
  const o = lastJsonLine(stdout);
  if (!o) return null;
  const tiers: Tier[] = (Array.isArray(o.tiers) ? o.tiers : []).flatMap((t) => {
    const x = obj(t);
    const min = n(x?.minVolumeUsd);
    const perps = n(x?.perps);
    const spot = n(x?.spot);
    return x && min !== null && perps !== null && spot !== null ? [{ minVolumeUsd: min, perps, spot }] : [];
  });
  const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  if (!('tiers' in o) && !('publicKey' in o) && !('configPath' in o)) return null;
  return {
    configPath: s(o.configPath),
    keyPath: s(o.keyPath),
    publicKey: s(o.publicKey),
    keyId: s(o.keyId),
    builderId: n(o.builderId),
    tiers: tiers.sort((a, b) => a.minVolumeUsd - b.minVolumeUsd),
    maxFeeRate: n(o.maxFeeRate),
    valid: typeof o.valid === 'boolean' ? o.valid : null,
    problems: Array.isArray(o.problems) ? o.problems.filter((p): p is string => typeof p === 'string') : [],
  };
}

/** The tiers in words: "up to $10 of volume: perps 2 bp ...; from $10: perps 1.5 bp ...". */
export function tierLines(tiers: readonly Tier[]): string[] {
  return tiers.map((t, i) => {
    const next = tiers[i + 1];
    const range = next ? `from $${t.minVolumeUsd} to $${next.minVolumeUsd} of volume` : `from $${t.minVolumeUsd} of volume`;
    return `${range.padEnd(34)} perps ${feeBp(t.perps)} (${t.perps}), spot ${feeBp(t.spot)} (${t.spot})`;
  });
}

/** Why this tier setup cannot be used for builder `id` (empty: it can). */
export function tiersProblems(t: TiersInfo, id: number): string[] {
  const out: string[] = [];
  if (t.valid === false) out.push(`the tiers file is not valid${t.problems.length ? `: ${t.problems.join('; ')}` : ''}`);
  if (t.builderId !== null && t.builderId !== id) out.push(`the tiers file is for builder #${t.builderId}, not #${id}`);
  if (!t.tiers.length) out.push('the tool printed no tiers');
  else if (t.tiers[0]!.minVolumeUsd !== 0) out.push('the first tier does not start at 0');
  if (!t.publicKey) out.push('the tool printed no public key (is the terms key file there?)');
  return out;
}

/** The secret-looking fields a tool answer must not have (the tool never prints the private key; if it did, stop). */
export function hasPrivateKeyField(o: Record<string, unknown> | null): boolean {
  if (!o) return false;
  return Object.entries(o).some(([k, v]) => /private|secret|pem/i.test(k) || (typeof v === 'string' && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v)));
}

// --- the app's settings ------------------------------------------------------------------------

/**
 * The lines for apps/web/.env.local. ID + the two fees switch the fee on; MAX_FEE
 * is the ceiling a user approves; TERMS_KEYS (only with fee tiers) lets the app
 * verify the server's signed terms.
 */
export function builderEnvLines(b: BuilderChoice): string[] {
  return [
    `VITE_BUILDER_ID=${b.id}`,
    `VITE_BUILDER_FEE_PERPS=${b.feePerps}`,
    `VITE_BUILDER_FEE_SPOT=${b.feeSpot}`,
    `VITE_BUILDER_MAX_FEE=${b.maxFee}`,
    ...(b.termsKeys?.length ? [`VITE_BUILDER_TERMS_KEYS=${b.termsKeys.join(',')}`] : []),
  ];
}

export interface EnvAppendPlan {
  /** Lines the file does not have yet. */
  append: string[];
  /** Already there with the same value. */
  same: string[];
  /** Already there with ANOTHER value: never overwritten - shown, for the owner to change by hand. */
  conflicts: Array<{ name: string; existing: string; wanted: string }>;
}

/** The value a `.env` file gives each variable (the last assignment wins; comments and blanks are not assignments). */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || raw.trim().startsWith('#')) continue;
    out.set(m[1]!, m[2]!.replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2'));
  }
  return out;
}

/** What appending `lines` to an env file would do. Existing lines are never touched. */
export function planEnvAppend(existingText: string, lines: readonly string[]): EnvAppendPlan {
  const have = parseEnv(existingText);
  const plan: EnvAppendPlan = { append: [], same: [], conflicts: [] };
  for (const line of lines) {
    const eq = line.indexOf('=');
    const name = line.slice(0, eq);
    const wanted = line.slice(eq + 1);
    if (!have.has(name)) plan.append.push(line);
    else if (have.get(name) === wanted) plan.same.push(line);
    else plan.conflicts.push({ name, existing: have.get(name)!, wanted });
  }
  return plan;
}

/** The file's text with the plan's lines added at the end (nothing else changes). */
export function appendEnvText(existingText: string, plan: EnvAppendPlan, stamp: string): string {
  if (!plan.append.length) return existingText;
  const base = existingText.length && !existingText.endsWith('\n') ? `${existingText}\n` : existingText;
  return `${base}\n# Builder fee test settings - added by RUN-LIVE-TESTS on ${stamp} (docs/BUILDER-TIERS.md)\n${plan.append.join('\n')}\n`;
}

/**
 * What the owner has to move (in the app, with the builder wallet) so the
 * account holds 100 vUSDC in Spot AND in Perps - exact amounts, the cheapest
 * way: a transfer between the two where one has enough to spare, a deposit only
 * for what neither can spare. The guide never moves it itself.
 */
export function whatToMove(c: BuilderCheck): string[] {
  if (c.eligible) return [];
  const min = BUILDER_MIN_USDC;
  if (!c.builderId) return [`Deposit at least ${min * 2 + 1} USDC to this wallet's SoDEX account (the first deposit opens it; SoDEX keeps 1 USDC of it), then Transfer ${min} vUSDC from "SoDEX Spot" to "SoDEX Futures" (Perps).`];
  if (c.spot === null || c.perps === null) return ['A balance could not be read: check again later - nothing needs moving yet.'];
  const spotShort = Math.max(0, min - c.spot);
  const perpsShort = Math.max(0, min - c.perps);
  const spotSpare = Math.max(0, c.spot - min);
  const perpsSpare = Math.max(0, c.perps - min);
  if (perpsShort > 0 && spotShort === 0 && spotSpare >= perpsShort) return [`Transfer ${round(perpsShort)} vUSDC from "SoDEX Spot" to "SoDEX Futures" (Perps).`];
  if (spotShort > 0 && perpsShort === 0 && perpsSpare >= spotShort) return [`Transfer ${round(spotShort)} vUSDC from "SoDEX Futures" (Perps) to "SoDEX Spot".`];
  // Not enough in the two together: deposit what is missing (it lands in Spot), then move it where it is short.
  const deposit = round(spotShort + perpsShort - spotSpare - perpsSpare);
  const out = [`Deposit ${deposit} USDC (or more) to the builder account - it lands in "SoDEX Spot".`];
  if (spotShort > 0 && perpsSpare > 0) out.push(`Transfer ${round(perpsSpare)} vUSDC from "SoDEX Futures" (Perps) to "SoDEX Spot".`);
  if (perpsShort > 0) out.push(`Then Transfer ${round(perpsShort)} vUSDC from "SoDEX Spot" to "SoDEX Futures" (Perps).`);
  return out;
}
