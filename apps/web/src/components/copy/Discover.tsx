/**
 * The Copy page's front: who to copy.
 *
 * A hero with the three highest-scoring traders, then the grid of both copy
 * venues' top hundred - categories, filters, a sort, $ or %, cards or a list.
 * A card opens the trader; its Copy button opens the copy setup over the grid
 * (CopyModal). The figures are the public boards' (/api/vs/leaderboard); the
 * curve on a card is read from the venue in this browser when it scrolls into
 * view (TraderCard.tsx).
 */
import { useMemo, useState, type CSSProperties } from 'react';
import { useAsync, useStored } from '../../hooks';
import { DASH, fmtUsd, shortAddr } from '../../format';
import { LoadFailed, useLoadFailedToast } from '../LoadFailed';
import { VENUE_BRAND } from '../venueBrand';
import { VENUE_LABEL, vsApi, type BoardWindow, type TraderRow, type Venue } from '../../vsApi';
import {
  CATEGORIES, COPY_VENUES, EQUITY_STEPS, GRID_WINDOWS, NO_FILTERS, SCORE_STEPS, SORTS, WIN_RATE_STEPS,
  filtersActive, scoreRows, shapeGrid, type Category, type Filters, type Scored, type SortKey,
} from './gridModel';
import { Avatar, CoinRow, ScoreMeter, Spark, TraderCard, WINDOW_SHORT, useTraderPeek } from './TraderCard';
import { fmtSignedPct, fmtSignedUsd, isAddress } from './setup';
import { LOSING_CAP } from './copyScore';

interface GridPrefs {
  category: Category;
  sort: SortKey;
  window: BoardWindow;
  unit: 'usd' | 'pct';
  view: 'grid' | 'list';
  filters: Filters;
}

const DEFAULT_PREFS: GridPrefs = { category: 'top', sort: 'score', window: '30d', unit: 'usd', view: 'grid', filters: NO_FILTERS };
const PAGE = 24;

const keyOf = (r: Pick<TraderRow, 'venue' | 'address'>) => `${r.venue}:${r.address.toLowerCase()}`;

export interface DiscoverProps {
  onOpen: (row: TraderRow) => void;
  onCopy: (row: TraderRow) => void;
  /** venue:address of every trader this wallet is copying now. */
  copying: ReadonlySet<string>;
  /** A pasted address: open that trader. */
  onAddress: (address: string, venue: Venue) => void;
}

export function Discover({ onOpen, onCopy, copying, onAddress }: DiscoverProps) {
  const [stored, setStored] = useStored<GridPrefs>('vs.copy.grid', DEFAULT_PREFS);
  const prefs: GridPrefs = { ...DEFAULT_PREFS, ...stored, filters: { ...NO_FILTERS, ...(stored?.filters ?? {}) } };
  const patch = (p: Partial<GridPrefs>) => setStored({ ...prefs, ...p });
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  const w = prefs.window;

  const boards = useAsync(
    () => Promise.all(COPY_VENUES.map((venue) =>
      vsApi.leaderboard({ venue, window: w, sort: 'pnl', limit: 100 }).then((b) => b.rows, () => [] as TraderRow[]))),
    [w],
    { pollMs: 60_000 },
  );
  useLoadFailedToast(boards.error, 'Top traders', boards.refresh);

  const scored = useMemo(() => scoreRows((boards.data ?? []).flat(), w), [boards.data, w]);
  const pasted = isAddress(q) ? q.trim().toLowerCase() : null;
  const grid = useMemo(
    () => shapeGrid(scored, { category: prefs.category, filters: prefs.filters, sort: prefs.sort, window: w, q: pasted ? '' : q }),
    [scored, prefs.category, prefs.filters, prefs.sort, w, q, pasted],
  );
  const podium = useMemo(() => shapeGrid(scored, { category: 'top', filters: NO_FILTERS, sort: 'score', window: w }).slice(0, 3), [scored, w]);
  const nFilters = filtersActive(prefs.filters);
  const loading = boards.loading && !boards.data;

  return (
    <div className="cpy-discover">
      <section className="cpy-hero">
        <div className="cpy-hero__text">
          <h1 className="cpy-hero__title">Copy the best traders, <em>trade for trade.</em></h1>
          <p className="cpy-hero__sub">
            Follow profitable SoDEX and Hyperliquid traders. Every trade they make is copied into your own SoDEX account in
            real time, under limits you set.
          </p>
          <ul className="cpy-hero__facts">
            <li>Funds stay in your account</li>
            <li>Your limits on every copy</li>
            <li>Stop any time</li>
          </ul>
        </div>
        <div className="cpy-hero__stack">
          {podium.map((s, i) => <MiniCard key={keyOf(s.row)} s={s} w={w} i={i} onOpen={onOpen} />)}
        </div>
      </section>

      <div className="cpy-bar">
        <nav className="cpy-cats" aria-label="Trader categories">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`cpy-cat${prefs.category === c.id ? ' is-on' : ''}`}
              aria-pressed={prefs.category === c.id}
              onClick={() => { patch({ category: c.id }); setShown(PAGE); }}
            >
              {c.label}
            </button>
          ))}
        </nav>
        <div className="cpy-bar__right">
          <label className="cpy-select" title="Sort">
            <span className="cpy-select__k" aria-hidden="true">⇅</span>
            <select value={prefs.sort} onChange={(e) => patch({ sort: e.target.value as SortKey })} aria-label="Sort traders">
              {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <Toggle
            label="Window"
            value={w}
            options={GRID_WINDOWS.map((g) => ({ id: g.id, label: g.label }))}
            onChange={(v) => patch({ window: v })}
          />
          <Toggle label="Show" value={prefs.unit} options={[{ id: 'usd', label: '$', title: 'PnL in dollars' }, { id: 'pct', label: '%', title: 'Return in percent' }]} onChange={(v) => patch({ unit: v })} />
          <Toggle
            label="Layout"
            value={prefs.view}
            options={[{ id: 'grid', label: <GridIcon />, title: 'Cards' }, { id: 'list', label: <ListIcon />, title: 'List' }]}
            onChange={(v) => patch({ view: v })}
          />
        </div>
      </div>

      <div className="cpy-filters">
        <div className="cpy-search">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && pasted) onAddress(pasted, 'hyperliquid'); }}
            placeholder="Search an address, or paste one"
            aria-label="Search traders by address"
            spellCheck={false}
          />
          {pasted && (
            <span className="cpy-search__open">
              {COPY_VENUES.map((v) => (
                <button key={v} type="button" className="cpy-chip" onClick={() => onAddress(pasted, v)}>Open on {VENUE_LABEL[v]}</button>
              ))}
            </span>
          )}
        </div>
        <Pick
          label="Account value"
          value={prefs.filters.minEquity}
          options={EQUITY_STEPS.map((v) => ({ v, label: v === 0 ? 'Any' : `≥ ${fmtUsd(v, 0).replace(',000,000', 'M').replace(',000', 'k')}` }))}
          onChange={(v) => patch({ filters: { ...prefs.filters, minEquity: v } })}
        />
        <Pick
          label="PnL"
          value={prefs.filters.profitableOnly ? 1 : 0}
          options={[{ v: 0, label: 'Any' }, { v: 1, label: 'Profitable only' }]}
          onChange={(v) => patch({ filters: { ...prefs.filters, profitableOnly: v === 1 } })}
        />
        <Pick
          label="Win rate"
          value={prefs.filters.minWinRate}
          options={WIN_RATE_STEPS.map((v) => ({ v, label: v === 0 ? 'Any' : `≥ ${Math.round(v * 100)}%` }))}
          onChange={(v) => patch({ filters: { ...prefs.filters, minWinRate: v } })}
        />
        <Pick
          label="Copy score"
          value={prefs.filters.minScore}
          options={SCORE_STEPS.map((v) => ({ v, label: v === 0 ? 'Any' : `≥ ${v}` }))}
          onChange={(v) => patch({ filters: { ...prefs.filters, minScore: v } })}
        />
        {nFilters > 0 && (
          <button type="button" className="cpy-clear" onClick={() => patch({ filters: NO_FILTERS })}>Clear {nFilters}</button>
        )}
        <span className="cpy-count">{loading ? 'Loading traders…' : `${grid.length} trader${grid.length === 1 ? '' : 's'}`}</span>
      </div>

      {boards.error && !boards.data ? (
        <div className="cpy-empty"><LoadFailed what="Top traders" onRetry={boards.refresh} /></div>
      ) : loading ? (
        <div className="cpy-grid" aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => <div key={i} className="cpy-card cpy-card--ghost" />)}
        </div>
      ) : grid.length === 0 ? (
        <div className="cpy-empty">
          <p>No trader matches {nFilters ? 'these filters' : 'this'}.</p>
          {nFilters > 0 && <button type="button" className="cpy-chip" onClick={() => patch({ filters: NO_FILTERS })}>Clear filters</button>}
        </div>
      ) : prefs.view === 'grid' ? (
        <div className="cpy-grid">
          {grid.slice(0, shown).map((s) => (
            <TraderCard
              key={keyOf(s.row)}
              row={s.row}
              score={s.score}
              window={w}
              unit={prefs.unit}
              onOpen={onOpen}
              onCopy={onCopy}
              copying={copying.has(keyOf(s.row))}
            />
          ))}
        </div>
      ) : (
        <TraderList rows={grid.slice(0, shown)} w={w} onOpen={onOpen} onCopy={onCopy} copying={copying} />
      )}

      {grid.length > shown && (
        <div className="cpy-more">
          <button type="button" className="cpy-chip" onClick={() => setShown(shown + PAGE)}>Show more ({grid.length - shown})</button>
        </div>
      )}

      <HowItWorks />
    </div>
  );
}

/* ------------------------------------------------------------- pieces ----- */

function Toggle<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: React.ReactNode; title?: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <span className="cpy-toggle" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" title={o.title} aria-pressed={o.id === value} className={o.id === value ? 'is-on' : undefined} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </span>
  );
}

function Pick<T extends number>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: ReadonlyArray<{ v: T; label: string }>;
  onChange: (v: T) => void;
}) {
  const on = value !== options[0]?.v;
  return (
    <label className={`cpy-pick${on ? ' is-on' : ''}`}>
      <span className="cpy-pick__k">{label}</span>
      <select value={String(value)} onChange={(e) => onChange(Number(e.target.value) as T)} aria-label={label}>
        {options.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
    </label>
  );
}

const GridIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z" fill="currentColor" /></svg>
);
const ListIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 3h12v2H2zM2 7h12v2H2zM2 11h12v2H2z" fill="currentColor" /></svg>
);

function MiniCard({ s, w, i, onOpen }: { s: Scored; w: BoardWindow; i: number; onOpen: (r: TraderRow) => void }) {
  const { ref, peek, loading } = useTraderPeek(s.row, w);
  const pnl = s.row.pnl[w] ?? null;
  return (
    <button ref={ref} type="button" className={`cpy-mini cpy-mini--${i}`} onClick={() => onOpen(s.row)} title={`Open ${shortAddr(s.row.address)}`}>
      <span className="cpy-mini__head">
        <Avatar address={s.row.address} size={24} />
        <span className="cpy-mini__addr">{shortAddr(s.row.address)}</span>
        <CoinRow assets={s.row.assets} max={3} />
      </span>
      <span className={`cpy-mini__big ${s.score.roi !== null && s.score.roi < 0 ? 'neg' : 'pos'}`}>{fmtSignedPct(s.score.roi, 1)}</span>
      <span className="cpy-mini__lbl">Return {WINDOW_SHORT[w]} · {fmtSignedUsd(pnl, 0)}</span>
      <Spark values={peek?.spark ?? null} loading={loading} className="cpy-mini__spark" />
      <span className="cpy-mini__score"><ScoreMeter s={s.score} /></span>
    </button>
  );
}

function TraderList({ rows, w, onOpen, onCopy, copying }: {
  rows: Scored[];
  w: BoardWindow;
  onOpen: (r: TraderRow) => void;
  onCopy: (r: TraderRow) => void;
  copying: ReadonlySet<string>;
}) {
  return (
    <div className="cpy-list">
      <table>
        <thead>
          <tr>
            <th>Trader</th>
            <th>Copy score</th>
            <th className="num">PnL {WINDOW_SHORT[w]}</th>
            <th className="num">Return</th>
            <th className="num">Equity</th>
            <th className="num">Win rate</th>
            <th>Trades</th>
            <th aria-label="Copy" />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ row, score }) => {
            const pnl = row.pnl[w] ?? null;
            return (
              <tr key={keyOf(row)} tabIndex={0} onClick={() => onOpen(row)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(row); }}>
                <td>
                  <span className="cpy-list__who">
                    <Avatar address={row.address} size={22} />
                    <span className="cpy-card__addr">{shortAddr(row.address)}</span>
                    <span className="cpy-venue" style={{ '--venue': VENUE_BRAND[row.venue] } as CSSProperties}>{VENUE_LABEL[row.venue]}</span>
                  </span>
                </td>
                <td><ScoreMeter s={score} /></td>
                <td className={`num ${pnl === null ? '' : pnl >= 0 ? 'pos' : 'neg'}`}>{fmtSignedUsd(pnl, 0)}</td>
                <td className={`num ${score.roi === null ? '' : score.roi >= 0 ? 'pos' : 'neg'}`}>{fmtSignedPct(score.roi, 1)}</td>
                <td className="num">{row.accountValue == null ? DASH : fmtUsd(row.accountValue, 0)}</td>
                <td className="num">{row.winRate == null ? DASH : `${Math.round(row.winRate * 100)}%`}</td>
                <td><CoinRow assets={row.assets} /></td>
                <td className="num">
                  <button type="button" className={`cpy-copybtn${copying.has(keyOf(row)) ? ' is-copying' : ''}`} onClick={(e) => { e.stopPropagation(); onCopy(row); }}>
                    {copying.has(keyOf(row)) ? 'Copying' : 'Copy'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    ['Pick a trader', 'Sorted by a copy score from public figures: profit, return, win rate, account size and track record.'],
    ['Set your rules', 'Size, leverage cap, position cap, slippage, stop loss and drawdown stop. A replay of their last 30 days shows what those rules would have done.'],
    ['Choose where it runs', 'In this browser, on the ValueDesk executor in Tokyo around the clock, or on a copier you host yourself.'],
    ['Copy, pause, stop', 'Copies trade in your own SoDEX account. Pause or stop any copy, stop them all at once, or revoke the copy key on SoDEX.'],
  ];
  return (
    <section className="cpy-how" aria-label="How copy trading works">
      <ol>
        {steps.map(([t, d], i) => (
          <li key={t}>
            <span className="cpy-how__n">{i + 1}</span>
            <b>{t}</b>
            <span>{d}</span>
          </li>
        ))}
      </ol>
      <p className="cpy-how__note">
        The copy score is a summary of public figures, the same formula for everyone (a trader with a loss scores at most {LOSING_CAP}); it is
        not a recommendation. Past results do not predict future ones. Copy fee up to 0.025% per copied order, on top of SoDEX's fees.
        Not available in the US or sanctioned countries; in the EU and EEA copies are limited to 2x leverage.{' '}
        <a className="fx-link" href="/copy-terms">Copy terms and risks</a>.
      </p>
    </section>
  );
}
