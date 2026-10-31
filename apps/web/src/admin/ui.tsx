/**
 * The admin suite's pieces, built from the main app's own: the Status page's frame
 * (status.css st-card, st-hero, st-updated, st-refresh, st-h2, st-pill, st-none), the
 * Excluded page's figures (excluded.css ex-stats, ex-stat), the leaderboard's switch
 * and search (LeaderboardPage.css lbp-seg, lbp-search) - so a page here reads exactly
 * like one of ValueDesk's. Plus the loader hook.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AdminApiError, call } from './api';

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  at: number | null;
  reload: () => void;
}

/** POST /api/admin/<path> with `body`, again every `everyMs` (0: only on reload) and when `body` changes. */
export function useAdmin<T>(path: string, body: unknown = {}, everyMs = 0): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean; at: number | null }>({ data: null, error: null, loading: true, at: null });
  const key = JSON.stringify(body);
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    call<T>(path, JSON.parse(key))
      .then((data) => n === seq.current && setState({ data, error: null, loading: false, at: Date.now() }))
      .catch((e: unknown) => n === seq.current && setState((s) => ({ ...s, error: e instanceof AdminApiError || e instanceof Error ? e.message : String(e), loading: false })));
  }, [path, key]);
  useEffect(() => {
    load();
    if (!everyMs) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, everyMs);
    return () => clearInterval(t);
  }, [load, everyMs]);
  return { ...state, reload: load };
}

type Tone = 'pos' | 'warn' | 'down' | 'unknown';

const HERO_ICON: Record<Tone, string> = {
  pos: 'M6.2 10.3 8.8 12.8 13.9 7.4',
  warn: 'M10 7v4.2M10 13.6v.01',
  down: 'M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6',
  unknown: 'M8 8.2a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.3M10 13.6v.01',
};

/** The Status page's headline icon: a tinted circle (a triangle for a warning) with its sign. */
function HeroIcon({ tone }: { tone: Tone }) {
  return (
    <svg className="st-hero__icon" viewBox="0 0 20 20" width="36" height="36" aria-hidden="true">
      {tone === 'warn' ? <path className="st-hero__shape" d="M10 2.2 18.4 17H1.6Z" strokeLinejoin="round" /> : <circle className="st-hero__shape" cx="10" cy="10" r="8.6" />}
      <path className="st-hero__sign" d={HERO_ICON[tone]} fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" transform={tone === 'warn' ? 'translate(0 1.2)' : undefined} />
    </svg>
  );
}

const ST_TONE: Record<Tone, string> = { pos: '', warn: ' is-warn', down: ' is-down', unknown: ' is-unknown' };

/**
 * One page: the Status page's card on the page, its toned hero (icon, title, line,
 * "Updated hh:mm" with the refresh button), then the page's sections.
 */
export function Page({ title, line, tone = 'unknown', loaded, wide, tools, children }: {
  title: ReactNode; line?: ReactNode; tone?: Tone; loaded?: Pick<Loaded<unknown>, 'loading' | 'at' | 'reload'>; wide?: boolean; tools?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="st ad-page">
      <article className={`st-card${wide ? ' ad-card--wide' : ''}`}>
        <header className={`st-hero${ST_TONE[tone]}`}>
          <HeroIcon tone={tone} />
          <div className="st-hero__text">
            <h1 className="st-hero__title">{title}</h1>
            {line && <p className="st-hero__line">{line}</p>}
          </div>
          {loaded && (
            <span className="st-updated">
              {loaded.at ? `Updated ${new Date(loaded.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : loaded.loading ? 'Loading…' : ''}
              <button type="button" className="st-refresh" onClick={loaded.reload} disabled={loaded.loading} aria-label="Load again" title="Load again">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
                </svg>
              </button>
            </span>
          )}
        </header>
        {tools && <div className="ad-tools">{tools}</div>}
        {children}
      </article>
    </div>
  );
}

/** A section of a card: a hairline above, the Status page's section head, its body. */
export function Section({ title, aside, children, flush }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className={`ad-section${flush ? ' ad-section--flush' : ''}`}>
      {(title || aside) && (
        <div className="st-notices__head ad-section__head">
          {title && <h2 className="st-h2">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/** The Excluded page's figures: up to four tiles in a row. */
export function Figures({ children }: { children: ReactNode }) {
  return <div className="ex-stats ad-figures">{children}</div>;
}

export function Figure({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'warn' | 'neg' | 'pos' }) {
  return (
    <div className={`ex-stat${tone ? ` ad-fig--${tone}` : ''}`}>
      <span className="ex-stat__label">{label}</span>
      <span className="ex-stat__value">{value}</span>
      {sub !== undefined && <span className="ex-stat__sub">{sub}</span>}
    </div>
  );
}

/** The app's segmented switch (the leaderboard's lbp-seg). */
export function Seg<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: ReadonlyArray<{ value: T; label: ReactNode }>; onChange: (v: T) => void }) {
  return (
    <div className="lbp-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? 'is-on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The leaderboard's search well. */
export function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="lbp-search">
      <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="m13.2 13.2 3.6 3.6" /></svg>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} spellCheck={false} autoComplete="off" />
    </label>
  );
}

/** A state as the Status page shows it: a dot and a word, in the state's colour. */
export function Pill({ tone, children }: { tone: 'pos' | 'warn' | 'neg' | 'dim'; children: ReactNode }) {
  const cls = tone === 'pos' ? '' : tone === 'warn' ? ' is-degraded' : tone === 'neg' ? ' is-down' : ' is-unknown';
  return <span className={`st-pill${cls}`}><i />{children}</span>;
}

/** Nothing to show, and why - one quiet line (the Status page's st-none). */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="st-none">{children}</p>;
}

export function Note({ kind = 'info', children }: { kind?: 'info' | 'error' | 'warn'; children: ReactNode }) {
  return <div className={`ad-note ad-note--${kind}`} role={kind === 'error' ? 'alert' : undefined}>{children}</div>;
}

/** Rows of [label, count]: the share as a bar beside the number. */
/** The server's placeholders for "not known" (ops/analytics.ts), in words. */
const plain = (k: string): string => (k === '(none)' || k === 'null' ? 'Unknown' : k === '(direct)' ? 'Direct' : k === '- / - / -' ? 'No campaign' : k);

export function CountList({ rows, empty = 'Nothing yet.', label = plain }: { rows: ReadonlyArray<{ key: string; n: number }>; empty?: string; label?: (k: string) => ReactNode }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  const total = rows.reduce((s, r) => s + r.n, 0) || 1;
  return (
    <ul className="ad-counts">
      {rows.map((r) => (
        <li key={r.key}>
          <span className="ad-counts__k">{label(r.key)}</span>
          <span className="ad-counts__bar"><i style={{ width: `${Math.max(2, (r.n / total) * 100)}%` }} /></span>
          <span className="ad-counts__n">{r.n.toLocaleString('en-US')}</span>
        </li>
      ))}
    </ul>
  );
}

/** Any value as a readable tree: what the status page shows for structures it does not name. */
export function JsonView({ value }: { value: unknown }) {
  return <pre className="ad-json">{JSON.stringify(value, null, 2)}</pre>;
}
