/**
 * Venue source for market-wide widgets (whale trades), and the position-size
 * calculator. All is the default: a widget shows SoDEX and Hyperliquid
 * together until the trader picks one venue. The choice is remembered on this
 * browser.
 */
import { decimalInput } from '../components/numberInput';
import { useState } from 'react';
import { positionSize } from './widgetCatalog';
import './sourceWidgets.css';
import { fmtNum, toInputText } from '../numStyle';

export type VenueSource = 'all' | 'sodex' | 'hl';

const SOURCE_KEY = (id: string) => `vs.widget.src.${id}`;

export function readSource(id: string): VenueSource {
  try {
    const v = localStorage.getItem(SOURCE_KEY(id));
    if (v === 'sodex' || v === 'hl' || v === 'all') return v;
  } catch { /* private mode */ }
  return 'all';
}

export function writeSource(id: string, source: VenueSource) {
  try { localStorage.setItem(SOURCE_KEY(id), source); } catch { /* private mode */ }
}

const SOURCE_LABEL: Record<VenueSource, string> = {
  all: 'All',
  sodex: 'SoDEX',
  hl: 'Hyperliquid',
};

/** All / SoDEX / Hyperliquid, for a widget whose feed can be read per venue. */
export function SourcePick({ label, value, onChange }: { label: string; value: VenueSource; onChange: (next: VenueSource) => void }) {
  return (
    <div className="wg-src" role="group" aria-label={label}>
      {(['all', 'sodex', 'hl'] as const).map((id) => (
        <button
          key={id}
          type="button"
          className={`wg-src__btn${value === id ? ' is-on' : ''}`}
          aria-pressed={value === id}
          onClick={() => onChange(id)}
        >
          {SOURCE_LABEL[id]}
        </button>
      ))}
    </div>
  );
}

export function SizeCalc({ price }: { price: string }) {
  const [equity, setEquity] = useState('1000');
  const [risk, setRisk] = useState('1');
  const [stop, setStop] = useState('2');
  const px = Number(price);
  const qty = positionSize(Number(equity), Number(risk), Number(stop), px);
  const notional = qty != null && px > 0 ? qty * px : null;
  return (
    <section className="wg wg-calc">
      <header className="wg__bar"><strong>Position size</strong></header>
      <label className="wg-field">Equity, USD
        <input value={toInputText(equity)} inputMode="decimal" onChange={(e) => setEquity(decimalInput(e.target.value, { prev: equity }))} />
      </label>
      <label className="wg-field">Risk %
        <input value={toInputText(risk)} inputMode="decimal" onChange={(e) => setRisk(decimalInput(e.target.value, { prev: risk }))} />
      </label>
      <label className="wg-field">Stop distance %
        <input value={toInputText(stop)} inputMode="decimal" onChange={(e) => setStop(decimalInput(e.target.value, { prev: stop }))} />
      </label>
      <p className="wg-out">
        {qty == null ? 'Enter equity, risk, and a stop.' : (
          <>
            <span>{fmtNum(qty, { maximumFractionDigits: 4 })}</span>
            <span>{notional == null ? '' : `$${fmtNum(notional, { maximumFractionDigits: 0 })}`}</span>
          </>
        )}
      </p>
      <p className="wg__src">{px > 0 ? `Mark ${px}` : 'Waiting for a mark price'}</p>
    </section>
  );
}
