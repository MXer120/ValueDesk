/**
 * The engine's spec errors (checkAlgoSpec) in the units the ticket shows.
 *
 * The parser states its limits in its own units: milliseconds, fractions, basis
 * points - "Duration must be between 60000 and 2592000000." for a TWAP typed in
 * minutes, "Trail must be between 0.001 and 0.5." for a trail typed in percent.
 * The ticket said exactly that under the field. Here a range is put back into
 * what the field takes: "Duration must be between 1 min and 30 d.", "Trail must
 * be between 0,1 % and 50 %." - numbers in the app's number format. Every other
 * message passes unchanged.
 */
import { fmtNum } from '../../numStyle';

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Spec fields that are fractions shown as a percentage. */
const FRACTION = new Set([
  'rate', 'closeShare', 'share', 'trailPct', 'dipPct', 'makerShare', 'sizeJitter', 'timeJitter', 'displayJitter',
  'refillJitter', 'maxParticipation', 'tpPct', 'slPct', 'pct',
]);

/** Spec fields in basis points (the ticket shows bp by default, or % by the app's setting). */
const BPS = new Set(['slippageBps', 'maxChaseBps', 'maxSpreadBps', 'offsetBps']);

const RANGE = /^(.+) must be between (-?\d+(?:\.\d+)?(?:e[+-]?\d+)?) and (-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\.$/;

/** A limit in milliseconds in the largest unit it is a whole number of: "15 min", "30 d", "5 s". */
export function limitDuration(ms: number): string {
  if (ms === 0) return '0 s';
  if (ms % DAY === 0) return `${ms / DAY} d`;
  if (ms % HOUR === 0) return `${ms / HOUR} h`;
  if (ms % MIN === 0) return `${ms / MIN} min`;
  return `${fmtNum(ms / SEC, { maximumFractionDigits: 3 })} s`;
}

const pct = (f: number): string => `${fmtNum(f * 100, { maximumFractionDigits: 4 })} %`;
const plain = (n: number): string => fmtNum(n, { maximumFractionDigits: 6 });

/** One error, for the spec field at `path` ("durationMs", "exec.slippageBps", "conditions.0.windowMs"). */
export function errorInWords(path: string, message: string): string {
  const m = RANGE.exec(message);
  if (!m) return message;
  const [, label, a, b] = m;
  const key = path.split('.').pop() ?? path;
  const min = Number(a);
  const max = Number(b);
  if (/Ms$/.test(key)) return `${label} must be between ${limitDuration(min)} and ${limitDuration(max)}.`;
  if (FRACTION.has(key)) return `${label} must be between ${pct(min)} and ${pct(max)}.`;
  if (BPS.has(key)) return `${label} must be between ${plain(min)} and ${plain(max)} bp.`;
  return `${label} must be between ${plain(min)} and ${plain(max)}.`;
}

/** Every error of a spec check, in words. */
export function errorsInWords(errors: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(errors)) out[k] = errorInWords(k, v);
  return out;
}
