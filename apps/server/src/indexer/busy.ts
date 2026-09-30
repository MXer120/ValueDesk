/**
 * Who held the worker's event loop.
 *
 * Every timer, lane task and stream message marks itself here as it starts. A
 * long synchronous stretch delays the 500 ms lag tick (engine.ts); the tick
 * then names the last thing that STARTED before it was due - the one that ran
 * over. That is the diagnosis behind "every upstream request timed out" when
 * the upstream itself answers in milliseconds.
 */
const RING = 64;
const marks: Array<{ label: string; at: number }> = [];

export function mark(label: string): void {
  marks.push({ label, at: Date.now() });
  if (marks.length > RING) marks.shift();
}

/** The last mark at or before `t`. */
export function startedBefore(t: number): string | null {
  for (let i = marks.length - 1; i >= 0; i--) if (marks[i]!.at <= t) return marks[i]!.label;
  return null;
}
