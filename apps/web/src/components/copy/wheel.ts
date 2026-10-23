/**
 * The hero wheel's geometry (Deck.tsx): where a card sits for its distance from
 * the front. Pure, so it can be tested without the components.
 */

/** Where a card sits for its distance `d` from the front (in cards; 0 is the front). */
export function wheelPlace(d: number): { x: number; y: number; r: number; s: number; o: number; z: number } {
  const a = Math.abs(d);
  const theta = d * 0.42; // radians per card along the circle
  return {
    x: Math.sin(theta) * 360,
    y: (1 - Math.cos(theta)) * 180,
    r: d * 11,
    s: 1 - Math.min(a, 3) * 0.06,
    // Whole to one and a half cards out, then fading: a card two and a half out is gone.
    o: a <= 1.5 ? 1 : Math.max(0, 1 - (a - 1.5) / 1.1),
    z: 100 - Math.round(a * 10),
  };
}

/** `i - at`, wrapped into [-n/2, n/2): how far card i is from the front, the short way round. */
export function wheelOffset(i: number, at: number, n: number): number {
  const d = (((i - at) % n) + n) % n;
  return d >= n / 2 ? d - n : d;
}
