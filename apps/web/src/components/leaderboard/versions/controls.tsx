/**
 * The versions' controls over the board: which hundred (top or worst, window, platforms, net or single) and how the
 * page narrows it (asset group, account size, the trades filter, the search). Built from the app's own controls: the
 * kit's segments and search, the Platform select, the account tables' View pop-up.
 */
import { useRef, useState } from 'react';
import { LB_VENUES, LB_WINDOWS, type LbMode, type LbSide } from '../lbState';
export type { LbMode };
import { PlatformSelect } from '../../PlatformSelect';
import { ViewPop } from '../../ViewPop';
import { Section, Seg } from '../../accountTables/FilterBar';
import { Icon, SearchField, Segmented, Tabs } from '../../bots/kit/kit';
import { ASSET_GROUPS, SIZE_BANDS, SORT_LABEL, WINDOW_WORD, type AssetGroup, type Board, type SizeBand, type SortKey } from './useBoard';

export function SideTabs({ board, compact }: { board: Board; compact?: boolean }) {
  return (
    <Tabs<LbSide>
      label="Top or worst hundred"
      value={board.view.side}
      onChange={(side) => board.update({ side })}
      tabs={[{ value: 'top', label: compact ? 'Top' : 'Top 100' }, { value: 'worst', label: compact ? 'Worst' : 'Worst 100' }]}
    />
  );
}

export function WindowSeg({ board }: { board: Board }) {
  return (
    <Segmented
      label="Window"
      value={board.view.window}
      onChange={(window) => board.update({ window })}
      options={LB_WINDOWS.map((w) => ({ value: w, label: WINDOW_WORD[w] }))}
    />
  );
}

/** The platforms, and Net or Single once there are several (`noMode`: that choice sits in Filters, on a phone). */
export function Venues({ board, noMode }: { board: Board; noMode?: boolean }) {
  return (
    <>
      <PlatformSelect options={LB_VENUES} value={board.view.venues} onChange={board.setVenues} />
      {board.multi && !noMode && (
        <Segmented<LbMode>
          label="Net or single"
          value={board.view.mode}
          onChange={(mode) => board.update({ mode })}
          options={[
            { value: 'net', label: <span title="One row per address, summed over the chosen platforms">Net</span> },
            { value: 'single', label: <span title="Each platform's rows side by side">Single</span> },
          ]}
        />
      )}
    </>
  );
}

export function Search({ board, placeholder = 'Search address' }: { board: Board; placeholder?: string }) {
  return <SearchField className="lbv-search" value={board.draft} onChange={board.onSearch} placeholder={placeholder} label="Search this hundred by address" />;
}

export interface Narrow {
  asset: AssetGroup;
  setAsset: (a: AssetGroup) => void;
  size: SizeBand;
  setSize: (s: SizeBand) => void;
}

/**
 * The View pop-up: what narrows the hundred on the page, and (optionally) its order. `mode`: Net or Single is in here
 * (a phone's bar has no room for it). `iconOnly`: the button without its word.
 */
export function FilterButton({ board, narrow, sort, onSort, mode, iconOnly }: { board: Board; narrow: Narrow; sort?: SortKey; onSort?: (s: SortKey) => void; mode?: boolean; iconOnly?: boolean }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const count = (narrow.asset !== 'all' ? 1 : 0) + (narrow.size !== 'all' ? 1 : 0) + (board.minTrades !== 2 ? 1 : 0) + (sort && sort !== 'pnl' ? 1 : 0);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`lbv-filterbtn${open ? ' is-open' : ''}${count ? ' is-active' : ''}${iconOnly ? ' is-icon' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={iconOnly ? 'Filters' : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="gear" size={15} />{!iconOnly && <span>Filters</span>}{count > 0 && <b>{count}</b>}
      </button>
      <ViewPop
        open={open}
        anchor={btn}
        onClose={() => setOpen(false)}
        title="Filters"
        onReset={() => { narrow.setAsset('all'); narrow.setSize('all'); board.setMinTrades(2); onSort?.('pnl'); }}
        resetDisabled={count === 0}
      >
        {mode && board.multi && (
          <Section label="Across platforms">
            <Seg<LbMode> value={board.view.mode} onChange={(m) => board.update({ mode: m })} options={[['net', 'Net per address'], ['single', 'Each platform']]} />
          </Section>
        )}
        {sort && onSort && (
          <Section label="Order by">
            <Seg<SortKey> value={sort} onChange={onSort} options={(Object.keys(SORT_LABEL) as SortKey[]).map((k) => [k, SORT_LABEL[k]])} cols={3} />
          </Section>
        )}
        <Section label="Largest positions in">
          <Seg<AssetGroup> value={narrow.asset} onChange={narrow.setAsset} options={ASSET_GROUPS.map(([k, t]) => [k, t])} cols={3} />
        </Section>
        <Section label="Account size">
          <Seg<SizeBand> value={narrow.size} onChange={narrow.setSize} options={SIZE_BANDS.map(([k, t]) => [k, t])} cols={3} />
        </Section>
        <Section label="Trades in this window">
          <Seg<'2' | '0'> value={board.minTrades === 2 ? '2' : '0'} onChange={(v) => board.setMinTrades(v === '2' ? 2 : 0)} options={[['2', 'More than 1'], ['0', 'Any']]} />
        </Section>
      </ViewPop>
    </>
  );
}

/** The narrowing in force, as chips that take themselves off. */
export function ActiveChips({ board, narrow }: { board: Board; narrow: Narrow }) {
  const chips: Array<[string, () => void]> = [];
  if (narrow.asset !== 'all') chips.push([`Positions in ${ASSET_GROUPS.find(([k]) => k === narrow.asset)![1]}`, () => narrow.setAsset('all')]);
  if (narrow.size !== 'all') chips.push([SIZE_BANDS.find(([k]) => k === narrow.size)![1], () => narrow.setSize('all')]);
  if (board.minTrades !== 2) chips.push(['Any number of trades', () => board.setMinTrades(2)]);
  if (board.view.q) chips.push([`“${board.view.q}”`, () => board.onSearch('')]);
  if (!chips.length) return null;
  return (
    <div className="lbv-chips">
      {chips.map(([t, off]) => (
        <button key={t} type="button" className="lbv-chip" onClick={off} aria-label={`Remove filter ${t}`}>
          {t}<Icon name="x" size={11} />
        </button>
      ))}
    </div>
  );
}
