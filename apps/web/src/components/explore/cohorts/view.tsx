/**
 * The cohort pages' "View": the leaderboard's / portfolio's View panel
 * (ViewPop + FilterBar `Section`), here to show or hide each part of the page
 * and any cohort. Both choices are kept per browser (localStorage); a hidden
 * cohort drops out of the cards, the charts' lines and the tables, not out of
 * the rail (that is navigation).
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { PNL_COHORTS, SIZE_COHORTS, isCohortId, type CohortDef, type CohortId } from '@sign/valuescan/cohorts/model.js';
import { useStored } from '../../../hooks';
import { ViewPop } from '../../ViewPop';
import { Section } from '../../accountTables/FilterBar';
import { CohortIcon } from './CohortIcon';

export type ViewPage = 'overview' | 'detail' | 'focus' | 'map';

/** What each page can hide, in page order. */
const PARTS: Record<ViewPage, Array<[string, string]>> = {
  overview: [['pnl', 'PnL cohorts'], ['size', 'Size cohorts']],
  detail: [['meters', 'Summary'], ['chart', 'Chart'], ['map', 'Heatmap'], ['tables', 'Tables']],
  focus: [['meters', 'Summary'], ['chart', 'Chart'], ['price', 'Price'], ['tables', 'Table'], ['assets', 'Asset map']],
  map: [['meters', 'Summary'], ['map', 'Map']],
};

export interface CohortView {
  /** Whether a part of a page is shown. */
  show: (page: ViewPage, part: string) => boolean;
  /** Whether a cohort is shown in the page's content. */
  cohortOn: (id: CohortId) => boolean;
}

const ALL: CohortView = { show: () => true, cohortOn: () => true };
const Ctx = createContext<CohortView>(ALL);
export const CohortViewProvider = Ctx.Provider;
export const useCohortView = (): CohortView => useContext(Ctx);

/** The stored choices and the panel's state; the page provides `view` to everything under it. */
export function useCohortViewState() {
  const [partsRaw, setParts] = useStored<string[]>('vs.cohorts.hideParts', []);
  const [cohortsRaw, setCohorts] = useStored<string[]>('vs.cohorts.hidden', []);
  const hiddenParts = useMemo(() => new Set(Array.isArray(partsRaw) ? partsRaw : []), [partsRaw]);
  const hiddenCohorts = useMemo(
    () => new Set((Array.isArray(cohortsRaw) ? cohortsRaw : []).filter(isCohortId)),
    [cohortsRaw],
  );
  const view = useMemo<CohortView>(() => ({
    show: (page, part) => !hiddenParts.has(`${page}:${part}`),
    cohortOn: (id) => !hiddenCohorts.has(id),
  }), [hiddenParts, hiddenCohorts]);
  const togglePart = useCallback((page: ViewPage, part: string) => {
    const k = `${page}:${part}`;
    const next = new Set(hiddenParts);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setParts([...next]);
  }, [hiddenParts, setParts]);
  const toggleCohort = useCallback((id: CohortId) => {
    const next = new Set(hiddenCohorts);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCohorts([...next]);
  }, [hiddenCohorts, setCohorts]);
  const setGroup = useCallback((defs: readonly CohortDef[], on: boolean) => {
    const next = new Set(hiddenCohorts);
    for (const d of defs) {
      if (on) next.delete(d.id);
      else next.add(d.id);
    }
    setCohorts([...next]);
  }, [hiddenCohorts, setCohorts]);
  const reset = useCallback(() => { setParts([]); setCohorts([]); }, [setParts, setCohorts]);
  return { view, hiddenParts, hiddenCohorts, togglePart, toggleCohort, setGroup, reset };
}

type ViewState = ReturnType<typeof useCohortViewState>;

/** The bar's View button and its panel, for the page on screen. */
export function CohortViewButton({ state, page, omit = [] }: { state: ViewState; page: ViewPage; omit?: readonly string[] }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const parts = PARTS[page].filter(([k]) => !omit.includes(k));
  const partsOff = parts.filter(([k]) => state.hiddenParts.has(`${page}:${k}`)).length;
  const count = partsOff + state.hiddenCohorts.size;
  // The overview has no parts beyond the two groups; the map has no cohorts to hide.
  const cohorts = page !== 'map';

  const group = (label: string, defs: readonly CohortDef[]) => {
    const on = defs.filter((d) => !state.hiddenCohorts.has(d.id)).length;
    return (
      <Section
        label={label}
        aside={(
          <button type="button" className="coh-view__all" onClick={() => state.setGroup(defs, on < defs.length)}>
            {on < defs.length ? 'Show all' : 'Hide all'}
          </button>
        )}
      >
        <div className="acctf-seg coh-view__grid" role="group" aria-label={label}>
          {defs.map((d) => {
            const shown = !state.hiddenCohorts.has(d.id);
            return (
              <button key={d.id} type="button" aria-pressed={shown} className={shown ? 'is-on' : ''} onClick={() => state.toggleCohort(d.id)}>
                <CohortIcon id={d.id} size={13} />
                <span>{d.name}</span>
              </button>
            );
          })}
        </div>
      </Section>
    );
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`acctf-view coh-view${open ? ' is-open' : ''}${count > 0 ? ' is-active' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <SlidersGlyph />
        <span>View</span>
        {count > 0 && <span className="acctf-count">{count}</span>}
      </button>
      <ViewPop open={open} anchor={btn} onClose={() => setOpen(false)} onReset={state.reset} resetDisabled={count === 0}>
        <Section label="Show">
          <div className="acctf-seg" role="group" aria-label="Parts of the page" style={{ gridTemplateColumns: `repeat(${Math.min(parts.length, 3)}, minmax(0, 1fr))` }}>
            {parts.map(([k, label]) => {
              const shown = !state.hiddenParts.has(`${page}:${k}`);
              return (
                <button key={k} type="button" aria-pressed={shown} className={shown ? 'is-on' : ''} onClick={() => state.togglePart(page, k)}>
                  {label}
                </button>
              );
            })}
          </div>
        </Section>
        {cohorts && group('All-time PnL cohorts', PNL_COHORTS)}
        {cohorts && group('Account size cohorts', SIZE_COHORTS)}
      </ViewPop>
    </>
  );
}

/** Shown in place of a page whose every part is hidden. */
export function AllHidden() {
  return (
    <div className="coh-hidden" role="status">
      <b>Everything here is hidden</b>
      <span>Turn parts or cohorts back on under View.</span>
    </div>
  );
}

const SlidersGlyph = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 4.5h12M2 11.5h12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.55" /><circle cx="10.5" cy="4.5" r="1.8" fill="var(--bg-panel)" stroke="currentColor" strokeWidth="1.3" /><circle cx="5.5" cy="11.5" r="1.8" fill="var(--bg-panel)" stroke="currentColor" strokeWidth="1.3" /></svg>
);
