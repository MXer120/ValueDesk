/**
 * Who held the worker's event loop.
 *
 * Every timer, lane task and stream message marks itself here as it starts. A
 * long synchronous stretch delays the 500 ms lag tick (engine.ts); the tick
 * then names the last thing that STARTED before it was due - the one that ran
 * over. That is the diagnosis behind "every upstream request timed out" when
 * the upstream itself answers in milliseconds.
 */
/** 2,048, not 64: after a long stall the timers and messages that waited mark themselves first, and pushed the culprit out ("by": null on a 62 s stall, 2026-11-05). */
const RING = 2_048;
const marks: Array<{ label: string; at: number }> = [];

export function mark(label: string): void {
  marks.push({ label, at: Date.now() });
  if (marks.length > RING) marks.shift();
}

/** A stall worth a log line: the 8 spikes in the status are overwritten within minutes. */
export const STALL_LOG_MS = 10_000;

/** Garbage collection of the last minutes (engine.ts watches it): start and length, ms since the epoch. */
const gcs: Array<{ at: number; ms: number }> = [];

export function noteGc(at: number, ms: number): void {
  gcs.push({ at, ms });
  if (gcs.length > RING) gcs.shift();
}

/** How much of [from, to] was garbage collection, ms. */
export function gcWithin(from: number, to: number): number {
  let sum = 0;
  for (const g of gcs) sum += Math.max(0, Math.min(to, g.at + g.ms) - Math.max(from, g.at));
  return Math.round(sum);
}

/** The last mark at or before `t`. */
export function startedBefore(t: number): string | null {
  for (let i = marks.length - 1; i >= 0; i--) if (marks[i]!.at <= t) return marks[i]!.label;
  return null;
}
