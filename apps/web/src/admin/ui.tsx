/** The admin suite's small pieces: a loader hook, tiles, panels, notes. */
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

export function Tile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'warn' | 'neg' | 'pos' }) {
  return (
    <div className={`ad-tile${tone ? ` ad-tile--${tone}` : ''}`}>
      <div className="ad-tile__label">{label}</div>
      <div className="ad-tile__value">{value}</div>
      {sub !== undefined && <div className="ad-tile__sub">{sub}</div>}
    </div>
  );
}

export function Panel({ title, actions, children, wide }: { title: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`ad-panel${wide ? ' ad-panel--wide' : ''}`}>
      <header className="ad-panel__head">
        <h2 className="ad-panel__title">{title}</h2>
        {actions && <div className="ad-panel__actions">{actions}</div>}
      </header>
      <div className="ad-panel__body">{children}</div>
    </section>
  );
}

export function PageHead({ title, loaded, children }: { title: string; loaded?: Pick<Loaded<unknown>, 'loading' | 'at' | 'reload' | 'error'>; children?: ReactNode }) {
  return (
    <div className="ad-pagehead">
      <h1 className="ad-pagehead__title">{title}</h1>
      <div className="ad-pagehead__tools">
        {children}
        {loaded && (
          <>
            <span className="ad-dim">{loaded.loading ? 'Loading…' : loaded.at ? `as of ${new Date(loaded.at).toISOString().slice(11, 19)} UTC` : ''}</span>
            <button type="button" className="ad-btn" onClick={loaded.reload}>Reload</button>
          </>
        )}
      </div>
    </div>
  );
}

export function Note({ kind = 'info', children }: { kind?: 'info' | 'error' | 'warn'; children: ReactNode }) {
  return <div className={`ad-note ad-note--${kind}`} role={kind === 'error' ? 'alert' : undefined}>{children}</div>;
}

export function Badge({ tone, children }: { tone: 'pos' | 'neg' | 'warn' | 'dim'; children: ReactNode }) {
  return <span className={`ad-badge ad-badge--${tone}`}>{children}</span>;
}

/** Rows of [label, count]: the share as a hairline bar beside the number. */
export function CountList({ rows, empty = 'Nothing yet.', label = (k: string) => k }: { rows: ReadonlyArray<{ key: string; n: number }>; empty?: string; label?: (k: string) => ReactNode }) {
  if (!rows.length) return <p className="ad-dim">{empty}</p>;
  const total = rows.reduce((s, r) => s + r.n, 0) || 1;
  return (
    <table className="ad-table ad-table--compact">
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{label(r.key)}</td>
            <td className="num">{r.n.toLocaleString('en-US')}</td>
            <td className="ad-share"><span style={{ width: `${Math.max(2, (r.n / total) * 100)}%` }} /></td>
            <td className="num ad-dim">{((r.n / total) * 100).toFixed(1)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Any value as a readable tree: what the status page shows for structures it does not name. */
export function JsonView({ value }: { value: unknown }) {
  return <pre className="ad-json">{JSON.stringify(value, null, 2)}</pre>;
}
