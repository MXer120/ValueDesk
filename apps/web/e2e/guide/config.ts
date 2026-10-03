/**
 * The live runner's config file, as the guide writes it.
 *
 * The guide never imports the runner's own config.ts (other work may be
 * changing it while this runs): it copies config.example.json, sets a handful
 * of fields and lets the runner validate the result - the runner's plan prints
 * every config error and warning, and the guide shows them.
 *
 * A private key in this file is refused: the key lives only in the guide's
 * memory and in the runner's environment.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { findKeyLike } from './scrub';

export type Json = Record<string, unknown>;

export interface BuilderChoice {
  /** The builder's SoDEX account id. */
  id: number;
  /** Its wallet, when known (written only if the runner's config takes it). */
  address?: string;
  /** Tenths of a basis point: perps 0..200, spot 0..2000. */
  feePerps: number;
  feeSpot: number;
  /** The ceiling the test wallet approves. */
  maxFee: number;
  revokeAtEnd: boolean;
  /**
   * The server's terms-signing PUBLIC keys (base64url of the raw 32 bytes, docs/BUILDER-TIERS.md section 3):
   * with them the run can verify the signed fee terms and test that the fee follows the verified volume.
   */
  termsKeys?: string[];
}

/** How the runner spells the builder section (read from its source, so a rename there does not need a change here). */
export interface BuilderKeyNames {
  max: 'maxFee' | 'maxFeeRate';
  address: boolean;
  required: boolean;
  /** The field that takes the terms public keys (`termsKeys`), or null when this runner version has none. */
  termsKeys: string | null;
}

/** A receiver as the runner's config takes it: an address, or an address with a memo rule (XRP, Stellar). */
export type ReceiverValue = string | { address: string; memo?: string; noMemo?: boolean };

export interface ConfigChoices {
  acknowledgeRealFunds?: boolean;
  allowExistingAccount?: boolean;
  backend?: string;
  /** undefined: leave the file's own section; null: no builder. */
  builder?: BuilderChoice | null;
  /** Receivers to set, by name. '' clears one (the steps that need it are then skipped). */
  receivers?: Record<string, ReceiverValue>;
  cleanupEnabled?: boolean;
  /** The spend cap - set only on the owner's explicit yes, to the runner's own suggestion (stageD.ts offerSpendCap). */
  maxSpendUsd?: number;
}

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The key names the runner's config accepts in `builder`, from its source
 * (`obj(src.builder, 'builder', [...])`) or, failing that, its example file.
 * Unknown: the shape of 2026-10-02 (maxFee, required, no address, no terms keys).
 */
export function builderKeyNames(runnerConfigSource: string | null, exampleText: string | null = null): BuilderKeyNames {
  const m = runnerConfigSource ? /obj\(\s*src\.builder\s*,\s*'builder'\s*,\s*\[([^\]]*)\]/.exec(runnerConfigSource) : null;
  if (m) {
    const keys = [...m[1]!.matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1]!);
    return {
      max: keys.includes('maxFeeRate') && !keys.includes('maxFee') ? 'maxFeeRate' : 'maxFee',
      address: keys.includes('address'),
      required: keys.includes('required'),
      termsKeys: keys.find((k) => /^terms/i.test(k)) ?? null,
    };
  }
  const text = [runnerConfigSource ?? '', exampleText ?? ''].join(' ');
  const hasRate = /\bmaxFeeRate\b/.test(text);
  const hasPlain = /\bmaxFee\b(?!Rate)/.test(text);
  return {
    max: hasRate && !hasPlain ? 'maxFeeRate' : 'maxFee',
    address: false,
    required: !text.trim() || /\brequired\b/.test(text),
    termsKeys: /\b(termsKeys?)\b/.exec(text)?.[1] ?? null,
  };
}

export function builderSection(b: BuilderChoice, names: BuilderKeyNames): Json {
  return {
    id: b.id,
    ...(names.address && b.address ? { address: b.address } : {}),
    feePerps: b.feePerps,
    feeSpot: b.feeSpot,
    [names.max]: b.maxFee,
    // docs/BUILDER-TIERS.md G1: a configured builder is REQUIRED - no approval, no order. Only a required run
    // can show that the app sends nothing once the approval is lowered or revoked.
    ...(names.required ? { required: true } : {}),
    revokeAtEnd: b.revokeAtEnd,
    ...(names.termsKeys && b.termsKeys?.length ? { [names.termsKeys]: [...b.termsKeys] } : {}),
  };
}

/** A copy of `base` with the guide's choices set; every other field (comments included) is kept as it is. */
export function applyChoices(base: Json, c: ConfigChoices, names: BuilderKeyNames): Json {
  const out = structuredClone(base);
  if (c.acknowledgeRealFunds !== undefined) out.acknowledgeRealFunds = c.acknowledgeRealFunds;
  if (c.allowExistingAccount !== undefined) out.allowExistingAccount = c.allowExistingAccount;
  if (c.backend !== undefined) out.backend = c.backend;
  if (c.builder !== undefined) out.builder = c.builder === null ? null : builderSection(c.builder, names);
  if (c.receivers !== undefined) out.receivers = { ...(isObj(out.receivers) ? out.receivers : {}), ...c.receivers };
  if (c.cleanupEnabled !== undefined) out.cleanup = { ...(isObj(out.cleanup) ? out.cleanup : {}), enabled: c.cleanupEnabled };
  if (c.maxSpendUsd !== undefined) out.maxSpendUsd = c.maxSpendUsd;
  return out;
}

export type ParsedConfig = { ok: true; config: Json } | { ok: false; problem: string };

export function parseConfigText(text: string, where: string): ParsedConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, problem: `${where} is not valid JSON (${(e as Error).message}).` };
  }
  if (!isObj(raw)) return { ok: false, problem: `${where} must be a JSON object.` };
  return { ok: true, config: raw };
}

/** Why this config may not be used at all. (Amounts, routes and receivers are checked by the runner's plan.) */
export function configProblems(cfg: Json): string[] {
  const paths = findKeyLike(cfg);
  return paths.length
    ? [`The config holds something the size of a private key at: ${paths.join(', ')}. A key must never be in a file - remove it. The guide asks for the key itself, with a hidden prompt.`]
    : [];
}

const str = (v: unknown, dflt = '?'): string => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : dflt);

/** The receivers a config has set, as `name address`. */
export function receiversSet(cfg: Json): Array<{ name: string; address: string }> {
  const rc = isObj(cfg.receivers) ? cfg.receivers : {};
  return Object.entries(rc).flatMap(([name, v]) => {
    const address = typeof v === 'string' ? v.trim() : isObj(v) ? str(v.address, '').trim() : '';
    return address ? [{ name, address }] : [];
  });
}

/** The settings of a config that decide what a live run does, in plain words. */
export function describeConfig(cfg: Json): string[] {
  const dep = isObj(cfg.deposit) ? cfg.deposit : {};
  const wx = isObj(cfg.withdrawExternal) ? cfg.withdrawExternal : {};
  const cl = isObj(cfg.cleanup) ? cfg.cleanup : {};
  const b = isObj(cfg.builder) ? cfg.builder : null;
  const set = receiversSet(cfg);
  return [
    `spend cap ............ $${str(cfg.maxSpendUsd)} (the most the wallet may lose: fees, gas, activation, trading costs, anything sent elsewhere)`,
    `deposit .............. ${str(dep.amount)} USDC from ${str(dep.chain)}`,
    `withdrawal ........... ${str(wx.amount)} ${str(wx.coin)} to ${str(wx.chain)} (receiver: ${str(wx.receiver)})`,
    `other receivers ...... ${set.length ? set.map((r) => `${r.name} = ${r.address}`).join(', ') : 'none - steps that send to another address are skipped'}`,
    `cleanup at the end ... ${cl.enabled === true ? `yes - all USDC back to ${str(cl.chain)} (one more withdrawal fee)` : 'no - what is left stays on SoDEX and in the wallet'}`,
    `builder fee .......... ${
      b
        ? `builder account #${str(b.id)}, perps ${str(b.feePerps)} / spot ${str(b.feeSpot)} tenths of a basis point${b.revokeAtEnd === true ? ', revoked at the end' : ', left approved'}${Object.keys(b).some((k) => /^terms/i.test(k)) ? ', fee tiers on (signed terms)' : ''}`
        : 'off'
    }`,
    `existing account ..... ${cfg.allowExistingAccount === true ? 'allowed (a resume)' : 'refused - a brand-new wallet is expected'}`,
  ];
}

export const serializeConfig = (cfg: Json): string => `${JSON.stringify(cfg, null, 2)}\n`;

// --- files ------------------------------------------------------------------------------------

export interface ConfigFiles {
  /** apps/web/e2e/live/config.json (gitignored). */
  config: string;
  /** apps/web/e2e/live/config.example.json. */
  example: string;
  /** apps/web/e2e/live/config.ts - read as TEXT, for the builder key names. */
  runnerSource: string;
}

const readText = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

export function readBuilderKeyNames(f: ConfigFiles): BuilderKeyNames {
  return builderKeyNames(readText(f.runnerSource), readText(f.example));
}

/** The example config, or why it cannot be used. */
export function loadExample(f: ConfigFiles): ParsedConfig {
  const text = readText(f.example);
  if (text === null) return { ok: false, problem: `${f.example} is missing - the live runner is not in this checkout.` };
  return parseConfigText(text, 'config.example.json');
}

/** The existing run config: null when there is none yet. */
export function loadExisting(f: ConfigFiles): ParsedConfig | null {
  if (!existsSync(f.config)) return null;
  return parseConfigText(readText(f.config) ?? '', 'config.json');
}

export function saveConfig(path: string, cfg: Json): void {
  const problems = configProblems(cfg);
  if (problems.length) throw new Error(problems[0]);
  writeFileSync(path, serializeConfig(cfg), 'utf8');
}
