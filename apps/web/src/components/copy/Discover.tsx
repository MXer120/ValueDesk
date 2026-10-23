/**
 * The Copy page's front: who to copy, and who to trade against.
 *
 * A hero with a fanned deck of the best traders of both kinds, then the grid
 * of both copy venues' boards - categories, filters, a sort, $ or %, cards or a
 * list. Top traders (the default) mixes the boards' best hundred, to copy, with
 * their worst hundred, to counter-trade, each card glowing in its side's colour
 * (green or red) and read in its own kind; the Copy and Counter-trade tabs hold
 * one kind each. A card opens the trader; its Copy (or Counter) button opens the
 * copy setup over the grid (CopyModal) in that direction. The figures are the
 * public boards' (/api/vs/leaderboard); the curve on a card is read from the
 * venue in this browser when it scrolls into view (TraderCard.tsx).
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useAsync, useStored } from '../../hooks';
import { DASH, fmtUsd, shortAddr } from '../../format';
import { LoadFailed, useLoadFailedToast } from '../LoadFailed';
import { FxSelect } from '../funds/ui';
import { VENUE_BRAND } from '../venueBrand';
import { VENUE_LABEL, vsApi, type BoardWindow, type TraderRow, type Venue } from '../../vsApi';
import {
  CATEGORIES, COPY_VENUES, EQUITY_STEPS, GRID_WINDOWS, NO_FILTERS, SCORE_STEPS, SORTS, WIN_RATE_STEPS,
  deckOf, filtersActive, kindOf, mixKinds, normaliseFilters, scoreRows, shapeGrid, winRateLabel,
  type Category, type Filters, type GridKind, type Scored, type SortKey,
} from './gridModel';
import { Avatar, CoinRow, CopyButton, ScoreMeter, Spark, TraderCard, WINDOW_SHORT, WinRate, useTraderPeek } from './TraderCard';
import { Deck } from './Deck';
import { fmtSignedPct, fmtSignedUsd, isAddress } from './setup';
import { COPY_COST_BPS, WRONG_SIDE_CAP } from './copyScore';

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
  /** Open the copy setup for this trader, copying or countering. */
  onCopy: (row: TraderRow, direction: 'copy' | 'counter') => void;
  /** venue:address of every trader this wallet is copying now. */
  copying: ReadonlySet<string>;
  /** A pasted address: open that trader. */
  onAddress: (address: string, venue: Venue) => void;
}

export function Discover({ onOpen, onCopy, copying, onAddress }: DiscoverProps) {
  const [stored, setStored] = useStored<GridPrefs>('vs.copy.grid', DEFAULT_PREFS);
  const prefs: GridPrefs = { ...DEFAULT_PREFS, ...stored, filters: normaliseFilters(stored?.filters) };
  if (!CATEGORIES.some((c) => c.id === prefs.category)) prefs.category = 'top';
  if (!SORTS[kindOf(prefs.category)].some((o) => o.id === prefs.sort)) prefs.sort = 'score';
  const kind: GridKind = kindOf(prefs.category);
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
  // Each venue's worst hundred: the traders to counter (all but the Copy tab show them).
  const worst = useAsync(
    () => Promise.all(COPY_VENUES.map((venue) =>
      vsApi.leaderboard({ venue, window: w, sort: 'pnl', limit: 100, side: 'worst' }).then((b) => b.rows, () => [] as TraderRow[]))),
    [w],
    { pollMs: 60_000 },
  );
  useLoadFailedToast(worst.error, 'Counter-trade candidates', worst.refresh);

  const scored = useMemo(() => scoreRows((boards.data ?? []).flat(), w, 'copy'), [boards.data, w]);
  const scoredCounter = useMemo(() => scoreRows((worst.data ?? []).flat(), w, 'counter'), [worst.data, w]);
  const pasted = isAddress(q) ? q.trim().toLowerCase() : null;
  const mixed = useMemo(() => mixKinds(scored, scoredCounter), [scored, scoredCounter]);
  const grid = useMemo(
    () => shapeGrid(kind === 'counter' ? scoredCounter : kind === 'copy' ? scored : mixed, { category: prefs.category, filters: prefs.filters, sort: prefs.sort, window: w, q: pasted ? '' : q }),
    [kind, scored, scoredCounter, mixed, prefs.category, prefs.filters, prefs.sort, w, q, pasted],
  );
  const deck = useMemo(() => deckOf(scored, scoredCounter, w, 10), [scored, scoredCounter, w]);
  const nFilters = filtersActive(prefs.filters);
  // What the grid waits on: the board(s) its kind reads.
  const sources = kind === 'counter' ? [worst] : kind === 'copy' ? [boards] : [boards, worst];
  const loading = sources.some((x) => x.loading && !x.data);
  const failed = sources.every((x) => x.error && !x.data) ? sources[0]! : null;
  const what = kind === 'counter' ? 'Counter-trade candidates' : 'Top traders';

  return (
    <div className="cpy-discover">
      <section className="cpy-hero">
        <div className="cpy-hero__text">
          <h1 className="cpy-hero__title">Copy the best traders, <em>trade for trade.</em></h1>
          <p className="cpy-hero__sub">
            Follow profitable SoDEX and Hyperliquid traders, or trade against the worst. Each trade lands in your SoDEX
            account, within your limits.
          </p>
          <ul className="cpy-hero__facts">
            <li>Funds stay in your account</li>
            <li>Your limits on every copy</li>
            <li>Stop any time</li>
          </ul>
        </div>
        <Deck picks={deck} w={w} total={mixed.length} loading={(boards.loading && !boards.data) || (worst.loading && !worst.data)} onOpen={onOpen} />
      </section>

      <div className="cpy-bar">
        <nav className="cpy-cats" aria-label="Trader categories">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`cpy-cat${c.id === 'counter' ? ' cpy-cat--counter' : ''}${prefs.category === c.id ? ' is-on' : ''}`}
              aria-pressed={prefs.category === c.id}
              onClick={() => { patch({ category: c.id }); setShown(PAGE); }}
            >
              {c.label}
            </button>
          ))}
        </nav>
        <div className="cpy-bar__right">
          <FxSelect
            label="Sort traders"
            value={prefs.sort}
            options={SORTS[kind].map((o) => ({ value: o.id, label: o.label }))}
            onChange={(v) => patch({ sort: v as SortKey })}
            searchable={false}
            triggerClassName="cpy-select"
            listMinWidth={290}
            listAlign="end"
            trigger={(o) => (
              <>
                <SortIcon />
                <span className="cpy-select__v">{o?.label}</span>
              </>
            )}
          />
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
          value={prefs.filters.sideOnly ? 1 : 0}
          options={[{ v: 0, label: 'Any' }, kind === 'copy' ? { v: 1, label: 'Profitable only' } : kind === 'counter' ? { v: 1, label: 'Losing only' } : { v: 1, label: 'Winners to copy, losers to counter', short: 'Winners / losers' }]}
          onChange={(v) => patch({ filters: { ...prefs.filters, sideOnly: v === 1 } })}
        />
        <Pick
          label="Win rate"
          value={(WIN_RATE_STEPS as readonly number[]).includes(prefs.filters.winRate) ? prefs.filters.winRate : 0}
          options={WIN_RATE_STEPS.map((v) => ({ v, label: winRateLabel(kind, v), short: winRateLabel(kind, v, true) }))}
          onChange={(v) => patch({ filters: { ...prefs.filters, winRate: v } })}
        />
        <Pick
          label={kind === 'copy' ? 'Copy score' : kind === 'counter' ? 'Counter score' : 'Score'}
          value={prefs.filters.minScore}
          options={SCORE_STEPS.map((v) => ({ v, label: v === 0 ? 'Any' : `≥ ${v}` }))}
          onChange={(v) => patch({ filters: { ...prefs.filters, minScore: v } })}
        />
        {nFilters > 0 && (
          <button type="button" className="cpy-clear" onClick={() => patch({ filters: NO_FILTERS })}>Clear {nFilters}</button>
        )}
        <span className="cpy-count" title={kind === 'mixed' ? 'One score for both, 0 to 100: how well copying, or countering, would have worked.' : undefined}>
          {kind === 'mixed' && !loading && grid.length > 0 && (
            <span className="cpy-legend" aria-label="Green cards are traders to copy, red ones traders to counter">
              <span className="cpy-legend__copy">copy</span>
              <span className="cpy-legend__counter">counter</span>
            </span>
          )}
          {loading ? 'Loading traders…' : `${grid.length} trader${grid.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {kind === 'counter' && (
        <p className="cpy-counter-note">
          Counter-trading takes the other side of every trade: these are the boards' biggest losers, ranked by how well
          trading against them would have worked - their loss beyond ~{COPY_COST_BPS} bps of costs per traded dollar, a win rate
          that is surely low, and the size and record to keep trading. A losing streak can end at any time.
        </p>
      )}

      {failed ? (
        <div className="cpy-empty"><LoadFailed what={what} onRetry={() => sources.forEach((x) => x.refresh())} /></div>
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
              kind={s.score.kind}
              onOpen={onOpen}
              onCopy={(r) => onCopy(r, s.score.kind)}
              copying={copying.has(keyOf(s.row))}
            />
          ))}
        </div>
      ) : (
        <TraderList rows={grid.slice(0, shown)} w={w} kind={kind} onOpen={onOpen} onCopy={onCopy} copying={copying} />
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
  options: ReadonlyArray<{ id: T; label: ReactNode; title?: string }>;
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

/** A filter: a pill that opens a list. `short`: what the pill shows for an option with a long label. */
function Pick<T extends number>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: ReadonlyArray<{ v: T; label: string; short?: string }>;
  onChange: (v: T) => void;
}) {
  const on = value !== options[0]?.v;
  const shortOf = (v: string | undefined) => options.find((o) => String(o.v) === v)?.short;
  return (
    <FxSelect
      label={label}
      value={String(value)}
      options={options.map((o) => ({ value: String(o.v), label: o.label }))}
      onChange={(v) => onChange(Number(v) as T)}
      searchable={false}
      triggerClassName={`cpy-pick${on ? ' is-on' : ''}`}
      listMinWidth={270}
      trigger={(o) => (
        <>
          <span className="cpy-pick__k">{label}</span>
          <span className="cpy-pick__v">{shortOf(o?.value) ?? o?.label}</span>
        </>
      )}
    />
  );
}

const SortIcon = () => (
  <svg className="cpy-select__k" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path d="M5 3v10M2.5 10.5 5 13l2.5-2.5M11 13V3M8.5 5.5 11 3l2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const GridIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z" fill="currentColor" /></svg>
);
const ListIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 3h12v2H2zM2 7h12v2H2zM2 11h12v2H2z" fill="currentColor" /></svg>
);

function TraderList({ rows, w, kind, onOpen, onCopy, copying }: {
  rows: Scored[];
  w: BoardWindow;
  kind: GridKind;
  onOpen: (r: TraderRow) => void;
  onCopy: (r: TraderRow, direction: 'copy' | 'counter') => void;
  copying: ReadonlySet<string>;
}) {
  return (
    <div className="cpy-list">
      <table>
        <thead>
          <tr>
            <th>Trader</th>
            <th>{kind === 'copy' ? 'Copy score' : kind === 'counter' ? 'Counter score' : 'Score'}</th>
            <th className="num">PnL {WINDOW_SHORT[w]}</th>
            <th className="num">Return</th>
            <th className="num">Equity</th>
            <th>PnL curve</th>
            <th className="num">Win rate</th>
            <th>Trades</th>
            <th aria-label="Copy" />
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <ListRow key={keyOf(s.row)} s={s} w={w} onOpen={onOpen} onCopy={onCopy} copying={copying.has(keyOf(s.row))} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One trader in the list; its curve is read from the venue once the row is on screen, like a card's. */
function ListRow({ s, w, onOpen, onCopy, copying }: {
  s: Scored;
  w: BoardWindow;
  onOpen: (r: TraderRow) => void;
  onCopy: (r: TraderRow, direction: 'copy' | 'counter') => void;
  copying: boolean;
}) {
  const { row, score } = s;
  const { ref, peek, loading } = useTraderPeek(row, w);
  const pnl = row.pnl[w] ?? null;
  return (
    <tr ref={ref} className={`cpy-list__row cpy-list__row--${score.kind}`} tabIndex={0} onClick={() => onOpen(row)} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(row); }}>
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
      <td className="cpy-list__curve"><Spark values={peek?.spark ?? null} loading={loading} className="cpy-list__spark" /></td>
      <td className="num"><WinRate value={row.winRate} closes={row.winRateCloses} /></td>
      <td><CoinRow assets={row.assets} /></td>
      <td className="num">
        <CopyButton kind={score.kind} copying={copying} onClick={(e) => { e.stopPropagation(); onCopy(row, score.kind); }} />
      </td>
    </tr>
  );
}

function HowItWorks() {
  const steps = [
    ['Pick a trader', `Sorted by a copy score from public figures: return, edge per traded dollar beyond ~${COPY_COST_BPS} bps of copy costs, profit, a win rate that holds up, account size and track record. The red cards are the worst traders, to trade against.`],
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
        The copy and counter scores summarise public figures, the same formula for everyone, ranked against the traders on the board (a
        trader on the wrong side of the window scores at most {WRONG_SIDE_CAP}); they are not a recommendation. Past results do not predict future ones. Copy fee up to 0.025% per copied order, on top of SoDEX's fees.
        Not available in the US or sanctioned countries; in the EU and EEA copies are limited to 2x leverage.{' '}
        <a className="fx-link" href="/copy-terms">Copy terms and risks</a>.
      </p>
    </section>
  );
}
