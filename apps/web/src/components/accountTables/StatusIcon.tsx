/**
 * The order-status glyphs: one 14px set, drawn in currentColor on a 14x14 box,
 * 1.3px strokes - the weight of the funds sheets' line icons at this size.
 *
 *   filled          ✓  ring + checkmark
 *   open            ○  ring
 *   partial         ◔  ring + a pie wedge of exactly executedQty / origQty, set
 *                      in from the ring by a small gap so the two read apart
 *   partial-ended   ◔  the same pie (the label says "· cancelled" / "· expired")
 *   cancelled       ⊗  ring + X
 *   expired         ⚠  alert triangle (IOC / FOK / market / post-only, nothing filled)
 *   rejected        ⊘  ring + slash
 *   untriggered     ◌  dashed ring (a stop waiting for its trigger)
 *   triggered       ⚡  ring + bolt
 *   pending         ◌  dashed ring + dot
 *   pending-cancel  ◌  dashed ring + X
 *   replaced        ↻  ring + turn arrow
 *   unknown         ?  ring + question mark
 */
import type { OrderStatusInfo, StatusKind } from './orderStatus';

const C = 7;
const R = 5.6;
/** The pie sits inside the ring with a visible gap. */
const PIE_R = 3.7;

/** The pie wedge for `f` in (0, 1), clockwise from 12 o'clock. */
export function wedgePath(f: number, r = R): string {
  const a = Math.min(0.9999, Math.max(0.0001, f)) * Math.PI * 2;
  const x = C + r * Math.sin(a);
  const y = C - r * Math.cos(a);
  return `M${C} ${C}L${C} ${C - r}A${r} ${r} 0 ${a > Math.PI ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)}Z`;
}

const ring = <circle cx={C} cy={C} r={R} fill="none" stroke="currentColor" strokeWidth="1.3" />;
const dashed = <circle cx={C} cy={C} r={R} fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.2 1.9" />;
const cross = <path d="M4.9 4.9 9.1 9.1M9.1 4.9 4.9 9.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />;

function glyph(kind: StatusKind, filled: number | null) {
  switch (kind) {
    case 'filled':
      return <>{ring}<path d="M4.5 7.2 6.3 9 9.6 5.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></>;
    case 'open':
      return ring;
    case 'partial':
    case 'partial-ended': {
      const f = filled ?? 0;
      return (
        <>
          {ring}
          {f >= 1 ? <circle cx={C} cy={C} r={PIE_R} fill="currentColor" /> : f > 0 ? <path d={wedgePath(f, PIE_R)} fill="currentColor" /> : null}
        </>
      );
    }
    case 'cancelled':
      return <>{ring}{cross}</>;
    case 'expired':
      return (
        <>
          <path d="M7 1.6 12.9 11.9H1.1Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M7 5.4V8.3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="7" cy="10.1" r="0.75" fill="currentColor" />
        </>
      );
    case 'rejected':
      return <>{ring}<path d="M3.2 10.8 10.8 3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></>;
    case 'untriggered':
      return dashed;
    case 'triggered':
      return <>{ring}<path d="M7.7 3.6 5.1 7.5H7.1L6.3 10.4 8.9 6.5H6.9Z" fill="currentColor" /></>;
    case 'pending':
      return <>{dashed}<circle cx={C} cy={C} r="1.3" fill="currentColor" /></>;
    case 'pending-cancel':
      return <>{dashed}{cross}</>;
    case 'replaced':
      return (
        <>
          {ring}
          <path d="M9.4 6.1A2.5 2.5 0 1 0 9.1 8.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <path d="M9.8 4.6V6.5H7.9" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    default:
      return (
        <>
          {ring}
          <path d="M5.6 5.7A1.45 1.45 0 1 1 7.6 7C7.2 7.2 7 7.5 7 7.9" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <circle cx="7" cy="9.7" r="0.7" fill="currentColor" />
        </>
      );
  }
}

export function StatusIcon({ info, title, size = 14 }: { info: Pick<OrderStatusInfo, 'kind' | 'tone' | 'filled'>; title?: string; size?: number }) {
  return (
    <svg
      className={`acct-st acct-st--${info.tone}`}
      viewBox="0 0 14 14"
      width={size}
      height={size}
      role="img"
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {glyph(info.kind, info.filled)}
    </svg>
  );
}
