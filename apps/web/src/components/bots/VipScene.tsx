/**
 * The VIP scenes' look (owner 2026-11-08: "bg should look like" the launch post, marketing/video/src/launch/xbrand.tsx
 * VipPost): ink ground with a soft gold light, the dot grid, the outlined VALUE and DESK letters at the edges (VALUE
 * drifting up, DESK down), thin gold lines running along the grid, and the gold ValueDesk mark in place of a medal.
 * The pass on the right is the post's gold card: what VIP brings, worded for how the wallet got it.
 */
import { useId, type ReactNode } from 'react';

/* ------------------------------------------------------------------ the ground ----- */

/** Gold lines lying on the grid: [left %, top %, length px, vertical, delay s]. Each runs along its own line. */
const LINES: Array<[number, number, number, boolean, number]> = [
  [11, 8, 150, false, 0], [78, 3, 100, false, 1.2], [44, 92, 100, false, 2.1], [92, 82, 120, true, 0.6],
  [4, 58, 90, true, 1.8], [64, 70, 70, false, 2.8], [30, 22, 60, true, 3.4],
];

export function VipGround({ lit = 1 }: { lit?: number }) {
  return (
    <div className="vipx-ground" aria-hidden="true" style={{ ['--lit' as string]: String(lit) }}>
      <div className="vipx-ground__light" />
      <div className="vipx-ground__dots" />
      {/* Four of each in one running column; the loop moves it by two, so it never shows a seam. */}
      <div className="vipx-ghost is-value"><span>VALUE VALUE VALUE VALUE</span></div>
      <div className="vipx-ghost is-desk"><span>DESK DESK DESK DESK</span></div>
      {LINES.map(([x, y, l, v, d], i) => (
        <i key={i} className={`vipx-line${v ? ' is-v' : ''}`} style={{ left: `${x}%`, top: `${y}%`, [v ? 'height' : 'width']: l, animationDelay: `${d}s` }} />
      ))}
      <div className="vipx-ground__vignette" />
    </div>
  );
}

/* ------------------------------------------------------------------ the mark ----- */

const COLS = [0, 4, 1, 3, 2] as const;
const ROWS = [0, 0, 1, 1, 2] as const;

/** The ValueDesk mark in gold, its five blocks dropping in one by one, then a glare across them. */
/** `still`: no drop-in (a mark that arrives by flight, or sits small in a strip). */
export function GoldMark({ size = 96, still }: { size?: number; still?: boolean }) {
  // Ids of its own: several marks on one page (the strip, the pass, the lockup) must not share a gradient.
  const u = useId().replace(/:/g, '');
  return (
    <svg className={`vipx-mark${still ? ' is-still' : ''}`} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={`${u}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff1c2" /><stop offset="0.45" stopColor="#f6dc8e" /><stop offset="0.75" stopColor="#d4a748" /><stop offset="1" stopColor="#fbe3a0" />
        </linearGradient>
        <linearGradient id={`${u}l`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff8e0" stopOpacity="0" /><stop offset="0.5" stopColor="#fff8e0" stopOpacity="0.75" /><stop offset="1" stopColor="#fff8e0" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`${u}b`}>
          {COLS.map((c, i) => <rect key={i} x={c * 6.6} y={4.2 + ROWS[i]! * 8.2} width={5.6} height={7.2} rx={1.5} />)}
        </clipPath>
      </defs>
      {COLS.map((c, i) => (
        <rect key={i} className="vipx-mark__b" style={{ animationDelay: `${120 + i * 90}ms` }} x={c * 6.6} y={4.2 + ROWS[i]! * 8.2} width={5.6} height={7.2} rx={1.5} fill={`url(#${u}g)`} />
      ))}
      <g clipPath={`url(#${u}b)`}><rect className="vipx-mark__glare" x="-14" y="0" width="12" height="32" fill={`url(#${u}l)`} /></g>
    </svg>
  );
}

/* ------------------------------------------------------------------ the pass ----- */

type PerkIcon = 'tag' | 'server' | 'bolt' | 'star';

function PerkTile({ kind }: { kind: PerkIcon }) {
  return (
    <span className="vipx-perk__ic">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2a1f0b" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {kind === 'tag' && <><path d="M3 12V4h8l10 10-8 8z" /><circle cx="7.5" cy="8.5" r="1.4" /></>}
        {kind === 'server' && <><rect x="3" y="3.5" width="18" height="7" rx="2" /><rect x="3" y="13.5" width="18" height="7" rx="2" /><path d="M7 7h.01M7 17h.01" strokeWidth="3" /></>}
        {kind === 'bolt' && <path d="M13 2 4 14h7l-1 8 9-12h-7z" />}
        {kind === 'star' && <path d="M12 3c.8 4.6 4.4 8.2 9 9-4.6.8-8.2 4.4-9 9-.8-4.6-4.4-8.2-9-9 4.6-.8 8.2-4.4 9-9z" />}
      </svg>
    </span>
  );
}

export interface VipPerk { icon: PerkIcon; title: string; sub?: string; chips?: string[] }

/**
 * What VIP brings. The beta promotion lowers every product's fee; the $5M milestone the bot fee only
 * (apps/server builder/programs.ts). Faster orders: the median signed write in our tests, 420 ms from the standard
 * servers against 265 ms from the VIP ones (Nov 6) - 1.6x faster, 37% less.
 */
export function vipPerks(promo: boolean): VipPerk[] {
  return [
    promo
      ? { icon: 'tag', title: 'Lowest fees everywhere', chips: ['Futures', 'Spot', 'Copy trading', 'Bots'] }
      : { icon: 'tag', title: 'Bot fees slashed', sub: 'Down to 0.1 bp, 4× below the first tier' },
    { icon: 'server', title: 'VIP servers', sub: 'Dedicated to VIP wallets' },
    { icon: 'bolt', title: 'Orders 1.6× faster', sub: 'Latency down 37% in our tests' },
    ...(promo ? [{ icon: 'star' as const, title: 'Early access', sub: 'New features first' }] : []),
  ];
}

/** The gold pass: the mark, a pill, VIP in gold, a line, then the perks one row each. */
export function VipPass({ pill, line, perks, delay = 0 }: { pill: ReactNode; line: string; perks: VipPerk[]; delay?: number }) {
  return (
    <div className="vipx-pass" style={{ animationDelay: `${delay}ms` }}>
      <div className="vipx-pass__sheen" aria-hidden="true" />
      <div className="vipx-pass__top">
        <GoldMark size={34} />
        <span className="vipx-pass__pill">{pill}</span>
      </div>
      <div className="vipx-pass__vip">VIP</div>
      <div className="vipx-pass__line">{line}</div>
      <ul className="vipx-pass__perks">
        {perks.map((p, i) => (
          <li key={p.title} className="vipx-perk" style={{ animationDelay: `${delay + 420 + i * 120}ms` }}>
            <PerkTile kind={p.icon} />
            <span className="vipx-perk__t">
              <b>{p.title}</b>
              {p.sub && <small>{p.sub}</small>}
              {p.chips && <span className="vipx-perk__chips">{p.chips.map((c) => <em key={c}>{c}</em>)}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
