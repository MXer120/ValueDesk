/**
 * Builder fee tiers: the configuration file (docs/BUILDER-TIERS.md §4).
 *
 * One JSON file names the builder, the tiers, hand-set fees for single wallets
 * and what an underpaid order costs. It is read when the server starts and
 * again whenever it changes on disk - no restart.
 *
 * THE RULES A FILE HAS TO PASS, all or nothing:
 *   - fees are whole numbers in tenths of a basis point (20 = 2 bp);
 *   - no fee is above SoDEX's cap for its engine (perps 200, spot 2000), above
 *     `maxFeeRate`, or above the first tier's fee for that engine. The first
 *     tier is the DEFAULT fee: what a wallet nothing is known about pays, and
 *     what the web build must be built with;
 *   - tiers start at volume 0 and rise strictly;
 *   - `volumeDays`, when set, is a whole number of days from 1 to 90: the tiers then go by the volume of
 *     the last that many days (UTC calendar days, today included) - a wallet whose trading stops drops
 *     back tier by tier. Absent: lifetime volume;
 *   - a name this code does not know is a mistake, not something to skip: a
 *     misspelt "overides" would otherwise switch a partner's fee off in silence.
 *     (Names starting with "_" are free for notes.)
 * A file that fails is rejected as a whole. The last valid one stays in force
 * and the problems are logged; a file that is GONE switches the feature off.
 *
 * Nothing here reaches a request: the terms route reads the copy in memory.
 * The file is looked at by a timer, off the event loop.
 */
import { readFileSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

export type Engine = 'perps' | 'spot';
export const ENGINES: readonly Engine[] = ['perps', 'spot'];

/** A fee per engine, in tenths of a basis point. */
export interface Fee {
  perps: number;
  spot: number;
}

export interface Tier extends Fee {
  /** Counted volume (perps + spot; of the last `volumeDays` days, else lifetime) from which this tier applies, in USD. */
  minVolumeUsd: number;
}

export interface Override extends Fee {
  /** For the operator only. Never sent to anyone. */
  note?: string;
}

export interface UnderpaidPolicy {
  /** `default-fee`: a wallet with an underpaid (or tampered) order in the last `days` days pays the default fee. */
  policy: 'default-fee' | 'ignore';
  days: number;
}

export interface TiersConfig {
  builderId: number;
  maxFeeRate: number;
  tiers: readonly Tier[];
  /** Keyed by lower-case wallet address. */
  overrides: Readonly<Record<string, Override>>;
  underpaid: UnderpaidPolicy;
  /** The tiers go by the volume of the last this many days (UTC days, today included). Null: lifetime volume. */
  volumeDays: number | null;
}

/** The longest volume window a file may set (the ledger keeps its day counts a little longer). */
export const MAX_VOLUME_DAYS = 90;

/** The highest fee an order may carry (SoDEX: perps 0.2 %, spot 2 %). */
export const FEE_CAP: Readonly<Record<Engine, number>> = { perps: 200, spot: 2000 };
/** The highest maximum a wallet can approve. */
export const MAX_APPROVAL_RATE = 2000;

export const DEFAULT_UNDERPAID: UnderpaidPolicy = { policy: 'default-fee', days: 30 };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_TIERS = 32;
const MAX_OVERRIDES = 5_000;
const MAX_VOLUME_USD = 1e12;
const MAX_NOTE = 200;
/** Larger than any real file: 5,000 overrides are about 600 KB. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** The first tier's fees: what a wallet pays when nothing lowers it. */
export const defaultFee = (cfg: TiersConfig): Fee => ({ perps: cfg.tiers[0]!.perps, spot: cfg.tiers[0]!.spot });

/**
 * Check a parsed file. `config` is set only when there is no problem at all.
 */
export function validateTiers(raw: unknown): { config: TiersConfig | null; problems: string[] } {
  const problems: string[] = [];
  if (!isObject(raw)) return { config: null, problems: ['the file must hold one JSON object'] };

  const known = new Set(['builderId', 'maxFeeRate', 'tiers', 'overrides', 'underpaid', 'volumeDays']);
  for (const k of Object.keys(raw)) {
    if (!known.has(k) && !k.startsWith('_')) problems.push(`unknown setting "${k}"`);
  }

  const builderId = raw.builderId;
  if (!isWhole(builderId) || builderId <= 0 || !Number.isSafeInteger(builderId)) {
    problems.push('builderId must be the builder account id, a positive whole number');
  }

  const maxFeeRate = raw.maxFeeRate;
  const maxOk = isWhole(maxFeeRate) && maxFeeRate >= 0 && maxFeeRate <= MAX_APPROVAL_RATE;
  if (!maxOk) problems.push(`maxFeeRate must be a whole number from 0 to ${MAX_APPROVAL_RATE}`);
  const ceiling = (engine: Engine): number => Math.min(FEE_CAP[engine], maxOk ? (maxFeeRate as number) : FEE_CAP[engine]);

  /** One fee field: a whole number within SoDEX's cap and `maxFeeRate`. */
  const feeOf = (holder: Record<string, unknown>, engine: Engine, where: string): number | null => {
    const v = holder[engine];
    if (!isWhole(v) || v < 0) {
      problems.push(`${where}: ${engine} must be a whole number of tenths of a basis point, 0 or more`);
      return null;
    }
    if (v > ceiling(engine)) {
      problems.push(`${where}: ${engine} ${v} is above ${ceiling(engine)} (SoDEX's cap for ${engine} is ${FEE_CAP[engine]}, maxFeeRate ${maxOk ? maxFeeRate : 'is not set'})`);
      return null;
    }
    return v;
  };

  const tiers: Tier[] = [];
  let tiersOk = true;
  if (!Array.isArray(raw.tiers) || raw.tiers.length === 0) {
    problems.push('tiers must be a list with at least one tier');
    tiersOk = false;
  } else if (raw.tiers.length > MAX_TIERS) {
    problems.push(`tiers: at most ${MAX_TIERS}`);
    tiersOk = false;
  } else {
    raw.tiers.forEach((t, i) => {
      const where = `tiers[${i}]`;
      if (!isObject(t)) {
        problems.push(`${where} must be an object`);
        tiersOk = false;
        return;
      }
      for (const k of Object.keys(t)) {
        if (!['minVolumeUsd', 'perps', 'spot'].includes(k) && !k.startsWith('_')) problems.push(`${where}: unknown setting "${k}"`);
      }
      const min = t.minVolumeUsd;
      const minOk = typeof min === 'number' && Number.isFinite(min) && min >= 0 && min <= MAX_VOLUME_USD;
      if (!minOk) problems.push(`${where}: minVolumeUsd must be a number from 0 to ${MAX_VOLUME_USD}`);
      const perps = feeOf(t, 'perps', where);
      const spot = feeOf(t, 'spot', where);
      if (!minOk || perps === null || spot === null) {
        tiersOk = false;
        return;
      }
      tiers.push({ minVolumeUsd: min as number, perps, spot });
    });
    if (tiersOk) {
      if (tiers[0]!.minVolumeUsd !== 0) problems.push('tiers[0]: the first tier is the default fee and must start at minVolumeUsd 0');
      for (let i = 1; i < tiers.length; i++) {
        if (tiers[i]!.minVolumeUsd <= tiers[i - 1]!.minVolumeUsd) {
          problems.push(`tiers[${i}]: minVolumeUsd must be above the tier before it (${tiers[i - 1]!.minVolumeUsd})`);
        }
        for (const engine of ENGINES) {
          if (tiers[i]![engine] > tiers[0]![engine]) {
            problems.push(`tiers[${i}]: ${engine} ${tiers[i]![engine]} is above the default fee ${tiers[0]![engine]} of the first tier`);
          }
        }
      }
    }
  }

  const overrides: Record<string, Override> = {};
  if (raw.overrides !== undefined) {
    if (!isObject(raw.overrides)) problems.push('overrides must be an object keyed by wallet address');
    else if (Object.keys(raw.overrides).length > MAX_OVERRIDES) problems.push(`overrides: at most ${MAX_OVERRIDES}`);
    else {
      for (const [key, o] of Object.entries(raw.overrides)) {
        const where = `overrides[${key.slice(0, 44)}]`;
        if (!ADDRESS_RE.test(key)) {
          problems.push(`${where}: the key must be a wallet address (0x and 40 hex characters)`);
          continue;
        }
        const address = key.toLowerCase();
        if (overrides[address]) {
          problems.push(`${where}: this wallet is listed twice`);
          continue;
        }
        if (!isObject(o)) {
          problems.push(`${where} must be an object`);
          continue;
        }
        for (const k of Object.keys(o)) {
          if (!['perps', 'spot', 'note'].includes(k) && !k.startsWith('_')) problems.push(`${where}: unknown setting "${k}"`);
        }
        const perps = feeOf(o, 'perps', where);
        const spot = feeOf(o, 'spot', where);
        if (o.note !== undefined && (typeof o.note !== 'string' || o.note.length > MAX_NOTE)) {
          problems.push(`${where}: note must be text of at most ${MAX_NOTE} characters`);
        }
        if (perps === null || spot === null) continue;
        if (tiersOk && tiers.length) {
          for (const [engine, fee] of [['perps', perps], ['spot', spot]] as const) {
            if (fee > tiers[0]![engine]) problems.push(`${where}: ${engine} ${fee} is above the default fee ${tiers[0]![engine]} of the first tier`);
          }
        }
        overrides[address] = typeof o.note === 'string' ? { perps, spot, note: o.note } : { perps, spot };
      }
    }
  }

  let underpaid: UnderpaidPolicy = { ...DEFAULT_UNDERPAID };
  if (raw.underpaid !== undefined) {
    const u = raw.underpaid;
    if (!isObject(u)) problems.push('underpaid must be an object');
    else {
      for (const k of Object.keys(u)) {
        if (!['policy', 'days'].includes(k) && !k.startsWith('_')) problems.push(`underpaid: unknown setting "${k}"`);
      }
      const policy = u.policy;
      if (policy !== 'default-fee' && policy !== 'ignore') problems.push('underpaid.policy must be "default-fee" or "ignore"');
      const days = u.days === undefined ? DEFAULT_UNDERPAID.days : u.days;
      if (!isWhole(days) || days < 1 || days > 3650) problems.push('underpaid.days must be a whole number from 1 to 3650');
      if (policy === 'default-fee' || policy === 'ignore') {
        if (isWhole(days)) underpaid = { policy, days };
      }
    }
  }

  let volumeDays: number | null = null;
  if (raw.volumeDays !== undefined) {
    if (!isWhole(raw.volumeDays) || raw.volumeDays < 1 || raw.volumeDays > MAX_VOLUME_DAYS) {
      problems.push(`volumeDays must be a whole number of days from 1 to ${MAX_VOLUME_DAYS} (leave it out for lifetime volume)`);
    } else volumeDays = raw.volumeDays;
  }

  if (problems.length) return { config: null, problems };
  return {
    config: Object.freeze({
      builderId: builderId as number,
      maxFeeRate: maxFeeRate as number,
      tiers: Object.freeze(tiers.map((t) => Object.freeze(t))),
      overrides: Object.freeze(overrides),
      underpaid: Object.freeze(underpaid),
      volumeDays,
    }),
    problems: [],
  };
}

/** Parse and check the text of a file. */
export function parseTiers(text: string): { config: TiersConfig | null; problems: string[] } {
  if (text.length > MAX_FILE_BYTES) return { config: null, problems: [`the file is larger than ${MAX_FILE_BYTES} bytes`] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { config: null, problems: [`not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  return validateTiers(raw);
}

/**
 * The tiers the owner's test starts from: 2 bp on both engines, 1.5 bp on perps
 * from 10 USD of counted volume. What `tools/builderTiers.ts init --test-tiers` writes.
 */
export const testTiers = (builderId: number): Record<string, unknown> => ({
  builderId,
  maxFeeRate: 20,
  tiers: [
    { minVolumeUsd: 0, perps: 20, spot: 20 },
    { minVolumeUsd: 10, perps: 15, spot: 20 },
  ],
  underpaid: { policy: 'default-fee', days: 30 },
});

// --- the file on disk ---------------------------------------------------------------

export interface LogLike {
  info(o: Record<string, unknown>, msg: string): void;
  warn(o: Record<string, unknown>, msg: string): void;
  error(o: Record<string, unknown>, msg: string): void;
}

export const silentLog: LogLike = { info() {}, warn() {}, error() {} };

export interface TiersStatus {
  path: string;
  exists: boolean;
  /** The file on disk passed every rule. */
  valid: boolean;
  problems: string[];
  /** When the configuration in force was read (null: none is in force). */
  loadedAt: number | null;
}

/**
 * The configuration in force, kept current with the file.
 *
 * `loadSync` reads it once (boot, the command line tool); `refresh` looks at
 * the file's size and time and re-reads it only when they moved.
 */
export class TiersSource {
  private cfg: TiersConfig | null = null;
  private seen = '';
  private exists = false;
  private valid = false;
  private problems: string[] = [];
  private loadedAt: number | null = null;

  constructor(readonly path: string, private readonly log: LogLike = silentLog) {}

  /** The configuration in force; null = the feature is off. */
  current(): TiersConfig | null {
    return this.cfg;
  }

  status(): TiersStatus {
    return { path: this.path, exists: this.exists, valid: this.valid, problems: [...this.problems], loadedAt: this.loadedAt };
  }

  loadSync(): void {
    let stamp: string;
    try {
      const st = statSync(this.path);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      this.gone();
      return;
    }
    if (stamp === this.seen) return;
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (e) {
      this.take(stamp, { config: null, problems: [`cannot be read: ${e instanceof Error ? e.message : String(e)}`] });
      return;
    }
    this.take(stamp, parseTiers(text));
  }

  /** Look at the file again. True when the configuration in force changed. */
  async refresh(): Promise<boolean> {
    const before = this.cfg;
    let stamp: string;
    try {
      const st = await stat(this.path);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      this.gone();
      return before !== this.cfg;
    }
    if (stamp === this.seen) return false;
    let parsed: { config: TiersConfig | null; problems: string[] };
    try {
      parsed = parseTiers(await readFile(this.path, 'utf8'));
    } catch (e) {
      parsed = { config: null, problems: [`cannot be read: ${e instanceof Error ? e.message : String(e)}`] };
    }
    this.take(stamp, parsed);
    return before !== this.cfg;
  }

  private gone(): void {
    if (this.exists || this.cfg) this.log.warn({ path: this.path }, 'builder tiers: the configuration file is gone - the feature is off, the app charges the fees of its build');
    this.cfg = null;
    this.seen = '';
    this.exists = false;
    this.valid = false;
    this.problems = [];
    this.loadedAt = null;
  }

  private take(stamp: string, parsed: { config: TiersConfig | null; problems: string[] }): void {
    this.seen = stamp;
    this.exists = true;
    if (parsed.config) {
      this.cfg = parsed.config;
      this.valid = true;
      this.problems = [];
      this.loadedAt = Date.now();
      this.log.info(
        { path: this.path, builderId: parsed.config.builderId, tiers: parsed.config.tiers.length, overrides: Object.keys(parsed.config.overrides).length },
        'builder tiers: configuration loaded',
      );
      return;
    }
    this.valid = false;
    this.problems = parsed.problems;
    this.log.error(
      { path: this.path, problems: parsed.problems, inForce: this.cfg ? 'the last valid configuration' : 'none - the feature is off' },
      'builder tiers: the configuration file was rejected',
    );
  }
}
