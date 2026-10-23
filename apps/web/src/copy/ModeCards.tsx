/**
 * Where a copier runs, as three cards to pick from: this browser, the
 * ValueDesk executor, a copier of your own. Shared by the setup sheet
 * (CopySetupSheet.tsx) and the copy dialog's second step (CopyModal.tsx).
 * Each card says where the key lives and when the copy runs; the steps the
 * mode still needs follow it (CopySetupSteps).
 */
import type { CopyModeId } from './live';

export const MODE_ORDER: readonly CopyModeId[] = ['browser', 'hosted', 'self'];

const NAME: Record<CopyModeId, string> = { browser: 'This browser', hosted: 'ValueDesk executor', self: 'Self-hosted' };
const WHEN: Record<CopyModeId, string> = { browser: 'While this tab is open', hosted: 'Around the clock · Tokyo', self: 'On your own machine' };
const KEY: Record<CopyModeId, string> = {
  browser: 'The key stays in this browser.',
  hosted: 'ValueDesk’s server holds the key for you.',
  self: 'The key stays with your copier.',
};

const ICON: Record<CopyModeId, JSX.Element> = {
  browser: <><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d="M2.5 7.5h15" /><circle cx="5" cy="5.5" r=".6" fill="currentColor" /><circle cx="7" cy="5.5" r=".6" fill="currentColor" /></>,
  hosted: <><rect x="3" y="3.5" width="14" height="5" rx="1.4" /><rect x="3" y="11.5" width="14" height="5" rx="1.4" /><path d="M6 6h.01M6 14h.01M9 6h5M9 14h5" /></>,
  self: <><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d="m6 8.5 2.5 2-2.5 2M10.5 12.5h3.5" /></>,
};

export function ModeCards({ value, onChange, label = 'Where the copier runs' }: {
  value: CopyModeId;
  onChange: (m: CopyModeId) => void;
  label?: string;
}) {
  return (
    <div className="cs-modes" role="radiogroup" aria-label={label}>
      {MODE_ORDER.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          className={`cs-mode${value === m ? ' is-on' : ''}`}
          onClick={() => onChange(m)}
        >
          <span className="cs-mode__ic" aria-hidden="true">
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{ICON[m]}</svg>
          </span>
          <span className="cs-mode__t">{NAME[m]}</span>
          <span className="cs-mode__when">{WHEN[m]}</span>
          <span className="cs-mode__d">{KEY[m]}</span>
          <span className="cs-mode__tick" aria-hidden="true">
            <svg viewBox="0 0 12 12" width="10" height="10"><path d="M2.5 6.4 4.9 8.7 9.6 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
        </button>
      ))}
    </div>
  );
}
