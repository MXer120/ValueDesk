/**
 * Venue source for market-wide widgets, and the position-size calculator.
 * All is the default: a widget shows SoDEX and Hyperliquid together until
 * the trader picks one venue. The choice is remembered on this browser.
 */
import { useState } from 'react';
import { positionSize } from './widgetCatalog';
import { Sketch } from './sketches';
import './sourceWidgets.css';

export type VenueSource = 'all' | 'sodex' | 'hl';

const SOURCE_KEY = (id: string) => `vs.widget.src.${id}`;

export function readSource(id: string): VenueSource {
  try {
    const v = localStorage.getItem(SOURCE_KEY(id));
    if (v === 'sodex' || v === 'hl' || v === 'all') return v;
  } catch { /* private mode */ }
  return 'all';
}

function writeSource(id: string, source: VenueSource) {
  try { localStorage.setItem(SOURCE_KEY(id), source); } catch { /* private mode */ }
}

const SOURCE_LABEL: Record<VenueSource, string> = {
  all: 'All',
  sodex: 'SoDEX',
  hl: 'Hyperliquid',
};

export function SourceWidget({ id, title }: { id: string; title: string }) {
  const [source, setSource] = useState<VenueSource>(() => readSource(id));
  const pick = (next: VenueSource) => {
    setSource(next);
    writeSource(id, next);
  };
  return (
    <section className="wg">
      <header className="wg__bar">
        <strong>{title}</strong>
        <div className="wg-src" role="group" aria-label={`${title} source`}>
          {(['all', 'sodex', 'hl'] as const).map((id_) => (
            <button
              key={id_}
              type="button"
              className={`wg-src__btn${source === id_ ? ' is-on' : ''}`}
              aria-pressed={source === id_}
              onClick={() => pick(id_)}
            >
              {SOURCE_LABEL[id_]}
            </button>
          ))}
        </div>
      </header>
      <div className="wg__stage" aria-hidden="true">
        <Sketch id={id} />
      </div>
      <p className="wg__src">{SOURCE_LABEL[source]}</p>
    </section>
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
        <input value={equity} inputMode="decimal" onChange={(e) => setEquity(e.target.value)} />
      </label>
      <label className="wg-field">Risk %
        <input value={risk} inputMode="decimal" onChange={(e) => setRisk(e.target.value)} />
      </label>
      <label className="wg-field">Stop distance %
        <input value={stop} inputMode="decimal" onChange={(e) => setStop(e.target.value)} />
      </label>
      <p className="wg-out">
        {qty == null ? 'Enter equity, risk, and a stop.' : (
          <>
            <span>{qty.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
            <span>{notional == null ? '' : `$${notional.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}</span>
          </>
        )}
      </p>
      <p className="wg__src">{px > 0 ? `Mark ${px}` : 'Waiting for a mark price'}</p>
    </section>
  );
}
