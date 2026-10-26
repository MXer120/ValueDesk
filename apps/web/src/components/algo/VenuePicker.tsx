/**
 * Fill fast's oracle venues, as the Settings window lists news sources: a
 * search, the venues in two groups (perpetuals, spot), each with its logo, a
 * line on what it gives the oracle and whether it is fresh now, and a switch.
 * At least one stays on.
 */
import { useState } from 'react';
import { ORACLE_VENUES, ORACLE_VENUE_NAMES, type OracleVenue } from '@copy-engine';
import { logoUrl } from '../news/newsSources';

/** Each venue's site, for its logo. */
export const VENUE_SITE: Readonly<Record<OracleVenue, string>> = {
  binanceFutures: 'binance.com',
  binanceSpot: 'binance.com',
  bybit: 'bybit.com',
  bybitSpot: 'bybit.com',
  okx: 'okx.com',
  okxSpot: 'okx.com',
  bitget: 'bitget.com',
  bitgetSpot: 'bitget.com',
  hyperliquid: 'hyperliquid.xyz',
  coinbase: 'coinbase.com',
  kraken: 'kraken.com',
  gateFutures: 'gate.com',
  gateSpot: 'gate.com',
  mexcFutures: 'mexc.com',
  mexcSpot: 'mexc.com',
  kucoinFutures: 'kucoin.com',
  kucoinSpot: 'kucoin.com',
  htx: 'htx.com',
  deribit: 'deribit.com',
};

/** Perpetuals that publish a mark price (the oracle's fair price uses it). */
const MARKED: ReadonlySet<OracleVenue> = new Set(['binanceFutures', 'bybit', 'okx', 'bitget', 'gateFutures', 'mexcFutures', 'deribit']);
const PERPS: ReadonlySet<OracleVenue> = new Set([...MARKED, 'hyperliquid', 'kucoinFutures']);
const USD: ReadonlySet<OracleVenue> = new Set(['coinbase', 'kraken', 'deribit']);

function lineOf(v: OracleVenue): string {
  const quote = USD.has(v) ? 'USD' : 'USDT';
  return PERPS.has(v) ? `Perpetual, ${quote} · ${MARKED.has(v) ? 'book and mark price' : 'book only'}` : `Spot, ${quote} · book`;
}

export function VenuePicker({ value, onChange, live, err }: {
  value: readonly OracleVenue[];
  onChange: (v: OracleVenue[]) => void;
  /** The oracle as read now: which venues it is made of and which are stale. */
  live: { used: readonly OracleVenue[]; stale: readonly OracleVenue[] } | null;
  err?: string | null;
}) {
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const match = (v: OracleVenue) => !term || ORACLE_VENUE_NAMES[v].toLowerCase().includes(term) || VENUE_SITE[v].includes(term);
  const groups: Array<[string, OracleVenue[]]> = [
    ['Perpetuals', ORACLE_VENUES.filter((v) => PERPS.has(v) && match(v))],
    ['Spot', ORACLE_VENUES.filter((v) => !PERPS.has(v) && match(v))],
  ];
  const set = (v: OracleVenue, on: boolean) => onChange(on ? ORACLE_VENUES.filter((x) => x === v || value.includes(x)) : value.filter((x) => x !== v));
  const state = (v: OracleVenue): string | null => {
    if (!live || !value.includes(v)) return null;
    if (live.used.includes(v)) return 'live';
    if (live.stale.includes(v)) return 'stale, left out';
    return 'no quote';
  };
  return (
    <section className="algo-group" aria-label="Venues">
      <div className="stg__label">
        <span>Venues · {value.length} of {ORACLE_VENUES.length}</span>
        {value.length < ORACLE_VENUES.length && (
          <button type="button" className="stg__link" onClick={() => onChange([...ORACLE_VENUES])}>Use all</button>
        )}
      </div>
      <p className="stg__note stg__note--top">The oracle is the median of these. Our server reads each one at most once a second; a venue older than 5 s is left out. With none fresh it uses the SoDEX mark, and with that stale too it pauses.</p>
      <label className="stg__find">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a venue" aria-label="Find a venue" spellCheck={false} autoComplete="off" />
      </label>
      {groups.map(([label, list]) =>
        list.length ? (
          <div key={label}>
            <div className="stg__label"><span>{label}</span></div>
            <div className="stg__card stg__card--outlets">
              {list.map((v) => {
                const on = value.includes(v);
                const only = on && value.length === 1;
                const st = state(v);
                return (
                  <div key={v} className={`stg__row${on ? '' : ' is-off'}`}>
                    <img className="stg__logo" src={logoUrl(VENUE_SITE[v])} alt="" width={20} height={20} loading="lazy" />
                    <span className="stg__rowtext">
                      <b>{ORACLE_VENUE_NAMES[v]}</b>
                      <small>
                        {lineOf(v)}
                        {st && <span className={`algo-vstate is-${st === 'live' ? 'live' : 'bad'}`}> · {st}</span>}
                      </small>
                    </span>
                    <button type="button" role="switch" aria-checked={on} aria-label={ORACLE_VENUE_NAMES[v]} disabled={only} title={only ? 'At least one venue' : undefined} className={`stg__switch${on ? ' is-on' : ''}`} onClick={() => set(v, !on)}>
                      <i className="stg__track"><i /></i>
                      <span aria-hidden="true">{on ? 'Used' : 'Left out'}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null,
      )}
      {groups.every(([, l]) => !l.length) && <p className="stg__note">No venue matches “{q.trim()}”.</p>}
      {err && <p className="oe-hint algo-ferr">{err}</p>}
    </section>
  );
}
