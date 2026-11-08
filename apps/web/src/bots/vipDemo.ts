/**
 * The demo controls beside "Demo data" (owner 2026-11-08: trigger the VIP unlock and the move, to see the
 * animations): one event the VIP card listens to. Nothing is sent anywhere; the move plays a made-up job.
 */
export type VipPlay = 'unlock' | 'move';
const subs = new Set<(p: VipPlay) => void>();

export function playVip(p: VipPlay): void {
  for (const f of subs) f(p);
}

export function onVipPlay(f: (p: VipPlay) => void): () => void {
  subs.add(f);
  return () => { subs.delete(f); };
}
