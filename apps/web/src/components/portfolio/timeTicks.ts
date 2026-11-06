/**
 * The chart's date axis: labels on round times at one fixed step, placed by time, so the gaps are equal and a 24-hour
 * chart reads in hours.
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Smallest step first; the first one that fits the width is used. A month step is calendar months. */
const STEPS: ReadonlyArray<{ ms: number; unit: 'hour' | 'day' | 'month'; n: number }> = [
  { ms: HOUR, unit: 'hour', n: 1 },
  { ms: 2 * HOUR, unit: 'hour', n: 2 },
  { ms: 3 * HOUR, unit: 'hour', n: 3 },
  { ms: 6 * HOUR, unit: 'hour', n: 6 },
  { ms: 12 * HOUR, unit: 'hour', n: 12 },
  { ms: DAY, unit: 'day', n: 1 },
  { ms: 2 * DAY, unit: 'day', n: 2 },
  { ms: 3 * DAY, unit: 'day', n: 3 },
  { ms: 7 * DAY, unit: 'day', n: 7 },
  { ms: 14 * DAY, unit: 'day', n: 14 },
  { ms: 30 * DAY, unit: 'month', n: 1 },
  { ms: 91 * DAY, unit: 'month', n: 3 },
  { ms: 182 * DAY, unit: 'month', n: 6 },
  { ms: 365 * DAY, unit: 'month', n: 12 },
];

export interface TimeTick { t: number; label: string }

export function timeTicks(from: number, to: number, maxLabels: number): TimeTick[] {
  if (!(to > from) || maxLabels < 1) return [];
  const span = to - from;
  const step = STEPS.find((s) => span / s.ms <= maxLabels) ?? STEPS[STEPS.length - 1]!;
  const showYear = step.unit === 'month' && (new Date(from).getFullYear() !== new Date(to).getFullYear());

  // Start at a round time in local time, then walk through the calendar, so a daylight-saving day stays on the hour.
  const at = new Date(from);
  at.setMinutes(0, 0, 0);
  if (step.unit !== 'hour') at.setHours(0);
  if (step.unit === 'month') {
    at.setDate(1);
    at.setMonth(at.getMonth() - (at.getMonth() % step.n));
  }
  if (step.unit === 'hour') at.setHours(at.getHours() - (at.getHours() % step.n));

  const out: TimeTick[] = [];
  for (let guard = 0; guard < 500; guard++) {
    const t = at.getTime();
    if (t > to) break;
    if (t >= from) out.push({ t, label: labelOf(at, step.unit, showYear) });
    if (step.unit === 'hour') at.setHours(at.getHours() + step.n);
    else if (step.unit === 'day') at.setDate(at.getDate() + step.n);
    else at.setMonth(at.getMonth() + step.n);
  }
  return out;
}

function labelOf(d: Date, unit: 'hour' | 'day' | 'month', showYear: boolean): string {
  if (unit === 'month') {
    const month = d.toLocaleDateString('en-US', { month: 'short' });
    return showYear ? `${month} ${d.getFullYear()}` : month;
  }
  if (unit === 'hour' && (d.getHours() !== 0)) return `${String(d.getHours()).padStart(2, '0')}:00`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
