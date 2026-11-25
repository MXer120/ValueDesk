/** Credits earned over time, from the wallet's credit history: a step line, the value under the pointer. */
import { useId, useMemo, useState } from 'react';
import type { InviteMe } from '@sign/invites/claim';
import { credit, day, signedUsd } from './parts';

const W = 600;
const H = 200;

export function EarnChart({ me }: { me: InviteMe | null }) {
  const id = useId();
  const [at, setAt] = useState<number | null>(null);
  const pts = useMemo(() => {
    const earns = (me?.history ?? []).filter((h) => h.kind === 'earn').sort((a, b) => a.at - b.at);
    if (!me || !earns.length) return null;
    // The history may not reach back to the first credit: the line starts at what was earned before it.
    let sum = Math.max(0, me.credits.earnedUsd - earns.reduce((x, e) => x + e.usd, 0));
    const t0 = earns[0]!.at;
    const t1 = Math.max(Date.now(), t0 + 86_400_000);
    const top = Math.max(me.credits.earnedUsd, sum + 1e-9);
    const X = (t: number) => ((t - t0) / (t1 - t0)) * W;
    const Y = (v: number) => H - 6 - (v / top) * (H - 24);
    const xs: Array<{ x: number; y: number; t: number; v: number; from: string | null; usd: number }> = [];
    for (const e of earns) { sum += e.usd; xs.push({ x: X(e.at), y: Y(sum), t: e.at, v: sum, from: e.from, usd: e.usd }); }
    const start = Y(xs[0]!.v - earns[0]!.usd);
    const line = `M0 ${start}` + xs.map((p) => `H${p.x}V${p.y}`).join('') + `H${W}`;
    return { xs, line, t0 };
  }, [me]);
  if (!pts) {
    return (
      <div className="rfc is-empty">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true"><path d="M0 178H110V160H210V142H330V104H430V72H520V38H600" /></svg>
        <p>Your credits draw here from your first referral.</p>
      </div>
    );
  }
  const read = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    pts.xs.forEach((q, i) => { if (Math.abs(q.x - x) < Math.abs(pts.xs[best]!.x - x)) best = i; });
    setAt(best);
  };
  const p = at === null ? null : pts.xs[at]!;
  return (
    <div
      className="rfc"
      role="img"
      aria-label={`Credits earned: ${signedUsd(pts.xs[pts.xs.length - 1]!.v)}`}
      onPointerDown={read}
      onPointerMove={read}
      onPointerLeave={() => setAt(null)}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--pos)" stopOpacity="0.26" /><stop offset="1" stopColor="var(--pos)" stopOpacity="0" /></linearGradient></defs>
        {[0.25, 0.5, 0.75].map((k) => <path key={k} className="rfc__g" d={`M0 ${H * k}H${W}`} />)}
        <path d={`${pts.line}V${H}H0Z`} fill={`url(#${id})`} />
        <path className="rfc__l" d={pts.line} />
      </svg>
      {p && <span className="rfc__x" style={{ left: `${(p.x / W) * 100}%` }} />}
      {p && <span className="rfc__d" style={{ left: `${(p.x / W) * 100}%`, top: `calc((100% - 24px) * ${p.y / H})` }} />}
      {p && (
        <span className="rfc__tip" style={{ left: `clamp(64px, ${(p.x / W) * 100}%, calc(100% - 64px))` }}>
          <b>{signedUsd(p.v)}</b><small>+{credit(p.usd)}{p.from ? ` · ${p.from}` : ''}</small><small>{day(p.t)}</small>
        </span>
      )}
      <span className="rfc__ax"><i>{day(pts.t0)}</i><i>Today</i></span>
    </div>
  );
}
