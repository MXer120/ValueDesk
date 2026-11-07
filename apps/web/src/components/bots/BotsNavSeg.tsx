/**
 * The Bots section's pages in the top bar, in the same switch Trade uses for Futures / Spot (NavBar.tsx nav-seg):
 * Overview, New bot, Explore, Savings. A bot's own page lights Overview. Small on purpose: NavBar imports it in every
 * build, and it draws only where BOTS_ON is set.
 */
import { goBots, useBotsView, type BotsView } from '../../bots/routes';

const PAGES: Array<{ id: Exclude<BotsView['page'], 'bot'>; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'new', label: 'New bot' },
  { id: 'explore', label: 'Explore' },
  { id: 'savings', label: 'Savings' },
];

export function BotsNavSeg({ active }: { active: boolean }) {
  const view = useBotsView();
  const on = !active ? null : view.page === 'bot' ? 'overview' : view.page;
  return (
    <nav className="nav-seg nav-seg--pages" aria-label="Bots pages">
      {PAGES.map((p) => (
        <button
          key={p.id}
          type="button"
          className={on === p.id ? 'is-on' : ''}
          aria-current={on === p.id ? 'page' : undefined}
          tabIndex={active ? undefined : -1}
          onClick={() => goBots(p.id === 'new' ? { page: 'new', market: null, kind: null } : ({ page: p.id } as BotsView))}
        >
          {p.label}
        </button>
      ))}
    </nav>
  );
}
