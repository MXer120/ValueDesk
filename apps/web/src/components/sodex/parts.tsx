/**
 * What the three SoDEX programme pages share: the page frame, the hero with SoDEX's mark beside the
 * title, figure tiles, pills, the locked state and the live clock. Everything else on them is the app's
 * own Card/Group/Row and `lbp-seg`. A kind or state is a pill, a dot or an icon, never a coloured edge.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { SodexMark } from '../funds/ui';
import { fmt } from '../../format';
import '../Portfolio.css';
import './sodex.css';

/** `.pf` is the scope the Card/Group/Row rules match against; it carries no geometry of its own. */
export function ProgrammePage({ children, label }: { children: ReactNode; label: string }) {
  return (
    <main className="pf sdx" aria-label={label}>
      <div className="sdx-col">{children}</div>
    </main>
  );
}

export function ProgrammeHero({ title, line, pills, aside }: { title: string; line: ReactNode; pills?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="sdx-hero">
      <span className="sdx-hero__mark"><SodexMark size={36} /></span>
      <div className="sdx-hero__text">
        <div className="sdx-hero__titleline">
          <h1 className="sdx-hero__title">{title}</h1>
          {pills}
        </div>
        <p className="sdx-hero__line">{line}</p>
      </div>
      {aside && <div className="sdx-hero__aside">{aside}</div>}
    </header>
  );
}

export function Tiles({ children }: { children: ReactNode }) {
  return <section className="sdx-tiles">{children}</section>;
}

export function Tile({ label, value, sub, cls, title }: { label: ReactNode; value: ReactNode; sub?: ReactNode; cls?: string; title?: string }) {
  return (
    <div className="sdx-tile" title={title}>
      <span className="sdx-tile__label">{label}</span>
      <span className={`sdx-tile__value ${cls ?? ''}`}>{value}</span>
      {sub && <span className="sdx-tile__sub">{sub}</span>}
    </div>
  );
}

export type PillTone = 'live' | 'quiet' | 'warn' | 'neg' | 'info';

export function Pill({ tone = 'quiet', dot, children, title }: { tone?: PillTone; dot?: boolean; children: ReactNode; title?: string }) {
  return (
    <span className={`sdx-pill is-${tone}`} title={title}>
      {dot && <i aria-hidden="true" />}
      {children}
    </span>
  );
}

const LOCK = (
  <svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4.500" y="9" width="11" height="8" rx="2" />
    <path d="M7 9V6.500a3 3 0 0 1 6 0V9" />
  </svg>
);

/**
 * A section that needs SoDEX's sign-in while it is off: what it would show, why it cannot here, and
 * where it can be used today. Never a button that does nothing.
 */
export function LockedSection({ title, items, href, hrefLabel }: { title: string; items: readonly string[]; href: string; hrefLabel: string }) {
  return (
    <section className="sdx-locked">
      <span className="sdx-locked__icon">{LOCK}</span>
      <div className="sdx-locked__text">
        <h2 className="sdx-locked__title">{title}</h2>
        <p className="sdx-locked__line">SoDEX's sign-in only opens on sodex.com so far, so these cannot be read here yet.</p>
        <ul className="sdx-locked__items">
          {items.map((i) => <li key={i}>{i}</li>)}
        </ul>
      </div>
      <a className="pf-btn sdx-locked__go" href={href} target="_blank" rel="noopener noreferrer">{hrefLabel}</a>
    </section>
  );
}

/** A switch: the leaderboard's own control. */
export function SegSwitch<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: ReadonlyArray<{ v: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="lbp sdx-seg">
      <div className="lbp-seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o.v} type="button" role="radio" aria-checked={value === o.v} className={value === o.v ? 'is-on' : ''} onClick={() => onChange(o.v)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The clock, ticking only while something on the page counts down. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

/** "4d 14h 22m 10s"; seconds always, so it visibly runs. Null target: a dash from the caller. */
export function fmtLeft(targetMs: number, now: number): string {
  const s = Math.max(0, Math.floor((targetMs - now) / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d > 0 ? `${d}d ` : ''}${pad(h)}h ${pad(m)}m ${pad(s % 60)}s`;
}

/** A moment in the reader's own clock: "Tue, Nov 10, 13:00". */
export const fmtWhen = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export const fmtDate = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** A reward's token amount: enough places that a small one (0.0014 vQQQ) is not printed as nothing. */
export function fmtTokens(raw: string): string {
  const n = Number(raw);
  return fmt(raw, Number.isFinite(n) && Math.abs(n) < 1 ? 6 : 2);
}

/** "3m ago", "2h ago", "4d ago". */
export function fmtAgo(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** The page's failed read: says so, and offers the one thing that can be done. */
export function ReadFailed({ what, error, onRetry }: { what: string; error: string | null; onRetry: () => void }) {
  return (
    <div className="sdx-failed" role="status">
      <b>{what} could not be read</b>
      {error && <span>{error}</span>}
      <button type="button" className="pf-btn" onClick={onRetry}>Try again</button>
    </div>
  );
}

export function SkelRows({ rows = 5, height = 44 }: { rows?: number; height?: number }) {
  return (
    <div className="sdx-skel" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="sdx-skel__row" style={{ height }} />)}
    </div>
  );
}

export function SkelTiles({ tiles = 4 }: { tiles?: number }) {
  return (
    <section className="sdx-tiles" aria-hidden="true">
      {Array.from({ length: tiles }, (_, i) => <div key={i} className="sdx-tile sdx-skel__row" style={{ height: 88 }} />)}
    </section>
  );
}
