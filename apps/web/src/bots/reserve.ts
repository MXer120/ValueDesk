/**
 * How much of an order's margin comes out of what copy trading and bots set aside (components/bots/ReserveWarning.tsx):
 * what is free after your own positions, copies and bots covers the order first; past that, the rest is theirs, up to
 * all they set aside. Pure.
 */
export function intoReserve(need: number, free: number | null, reserved: number): number {
  if (!(need > 0) || free === null || !(reserved > 0)) return 0;
  return Math.min(reserved, Math.max(0, need - free));
}
