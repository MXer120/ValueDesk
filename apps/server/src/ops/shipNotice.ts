/**
 * The maintenance notice of a release (deploy/release/ship.sh, `status.sh ship`): one per
 * ship that restarts anything. It names what the release does to each part of ValueDesk -
 * down, partly down or not affected, with a line on what a visitor notices - and when it
 * should be over, from what was measured (ship.sh's header, DOWNTIME). The app shows it
 * as a blue notification with that countdown and turns it green once ship.sh completes
 * it (apps/web/src/status/maintState.ts). It is held open past its planned end until then
 * (Notice.holdOpen), so a release that takes longer is never shown as done.
 */
import { STATUS_SERVICES, type NoticePart, type PartImpact, type ServiceId } from './statusModel.js';
import type { NewNotice } from './statusNotices.js';

/** What ship.sh releases (its parts), and the service on the status page each one is. */
export const SHIP_PARTS = { web: 'website', api: 'api', indexer: 'indexer', executor: 'executor' } as const satisfies Record<string, ServiceId>;
export type ShipPart = keyof typeof SHIP_PARTS;

/**
 * What a restart of each costs (measured on v0.2.57 and v0.2.60, 2026-10-28/29), and how
 * long ship.sh is busy with it - its checks included, which is when the notice completes:
 *   web       none: Vercel switches at once
 *   api       away ~6 s, Caddy holds each request meanwhile; with the install about a minute
 *   executor  back in seconds; copies and algos held by the brake for about a minute; with the
 *             install, the preflight on a snapshot and the wait for a quiet send queue ~3 min
 *   indexer   up, the boards a few minutes staler (start ~35 s, first build ~70 s); ship.sh then
 *             waits for every stream, Lighter's 3.5-8 min - ~8 min; the first build after
 *             midnight UTC took 5-8 min (v0.2.60, 01:27 UTC) - ~10 min then
 */
export const SHIP_EFFECTS: Record<ServiceId, { impact: PartImpact; minutes: number; text: string }> = {
  website: { impact: 'none', minutes: 0, text: 'No interruption: the new version loads with your next page.' },
  api: { impact: 'partial', minutes: 1, text: 'Pauses for a few seconds; requests wait and are then answered. Live charts reconnect by themselves.' },
  executor: { impact: 'partial', minutes: 3, text: 'Copies and algo orders pause for about a minute, then go on. Stops already on SoDEX stay.' },
  indexer: { impact: 'partial', minutes: 8, text: 'Leaderboards, cohorts and the heatmap stay up; their figures may be a few minutes behind.' },
};
/** The indexer's after midnight UTC (its first build of the day is the long one). */
const INDEXER_AFTER_MIDNIGHT_MIN = 10;
/** Before the first restart: the notice goes up once the uploads are done. */
const OVERHEAD_MIN = 1;

/** The parts ship.sh names (`indexer,api,executor,web`), checked; an unknown one is an error. */
export function shipPartsOf(list: string): ShipPart[] {
  const out = new Set<ShipPart>();
  for (const raw of list.split(',')) {
    const p = raw.trim().toLowerCase();
    if (!p) continue;
    if (!(p in SHIP_PARTS)) throw new Error(`unknown part "${raw.trim()}" (${Object.keys(SHIP_PARTS).join(', ')})`);
    out.add(p as ShipPart);
  }
  return [...out];
}

/** How long a release of these parts should take from now, minutes. */
export function shipMinutes(parts: readonly ShipPart[], now: number): number {
  const services = new Set(parts.map((p) => SHIP_PARTS[p]));
  let min = 0;
  for (const s of services) min += s === 'indexer' && new Date(now).getUTCHours() < 2 ? INDEXER_AFTER_MIDNIGHT_MIN : SHIP_EFFECTS[s].minutes;
  return min ? min + OVERHEAD_MIN : 0;
}

/**
 * The maintenance a release of `parts` posts, or null when it restarts nothing (a web-only
 * ship: no downtime, no notice). Every service is named: those it does not restart as not
 * affected.
 */
export function shipNotice(tag: string, parts: readonly ShipPart[], now: number): NewNotice | null {
  const minutes = shipMinutes(parts, now);
  const released = new Set(parts.map((p) => SHIP_PARTS[p]));
  const noticeParts: NoticePart[] = STATUS_SERVICES.map(({ id }) =>
    released.has(id) ? { id, impact: SHIP_EFFECTS[id].impact, text: SHIP_EFFECTS[id].text } : { id, impact: 'none', text: '' },
  );
  const affected = noticeParts.filter((p) => p.impact !== 'none');
  if (!affected.length || !minutes) return null;
  return {
    kind: 'maintenance',
    title: `Update ${tag}`.trim(),
    components: affected.map((p) => p.id),
    startsAt: now,
    endsAt: now + minutes * 60_000,
    stage: 'in_progress',
    text: `We are updating ValueDesk; it should take about ${minutes} minutes. ${affected.map((p) => p.text).join(' ')}`,
    parts: noticeParts,
    holdOpen: true,
  };
}
