/**
 * Futures / Spot: the one market-type switch (a pill in a well, the chosen one lifted; shell.css .nav-seg). The rail's
 * navbar carries it on Trade; on a phone it sits at the end of the trade page's own market row (registry.tsx ticker),
 * where the market it switches is named - the phone's bar is one row (NavBar.tsx).
 */
import type { Engine } from '../api';

export function MarketTypeSwitch({ engine, onEngine }: { engine: Engine; onEngine: (e: Engine) => void }) {
  return (
    <div className="nav-seg" role="radiogroup" aria-label="Market type">
      {(['perps', 'spot'] as const).map((e) => (
        <button key={e} type="button" role="radio" aria-checked={engine === e} className={engine === e ? 'is-on' : ''} onClick={() => onEngine(e)}>
          {e === 'perps' ? 'Futures' : 'Spot'}
        </button>
      ))}
    </div>
  );
}
