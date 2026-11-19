/**
 * New bot > Markets on spot (owner 2026-11-19: futures or spot): SoDEX's USDC spot markets, live from its tickers and
 * market list - the price, a day's traded volume, the spread now and SoDEX's own spot maker / taker fee. There is no
 * bot estimate per $1M here: those come from futures prints the server records, and spot has none yet - said so, no
 * number made up. Ticked markets stay on top; one real bot per market as on futures.
 */
import { useMemo, useState } from 'react';
import { DASH, fmtUsd } from '../../format';
import { useSymbols, useTickers } from '../../hooks';
import { coinOf, isBotSpot, marketLabel } from '../../bots/engines';
import { CoinIcon } from '../CoinIcon';
import { Icon, Panel, SearchField, Segmented, Skeleton, StatusPill } from './kit/kit';

type Sort = 'volume' | 'spread' | 'fee';
const bp = (frac: number) => `${(frac * 10_000).toFixed(1)} bp`;

export function SpotMarketStep({ picked, toggle, running, real }: {
  picked: string[];
  toggle: (s: string) => void;
  running: ReadonlySet<string>;
  real: boolean;
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('volume');
  const [all, setAll] = useState(false);
  const { symbols } = useSymbols('spot');
  const tickers = useTickers('spot', { pollMs: 15_000 });
  const rows = useMemo(() => {
    const t = new Map((tickers.data?.tickers ?? []).map((x) => [x.symbol, x]));
    return symbols.filter((s) => isBotSpot(s.name) && s.status === 'TRADING').map((s) => {
      const k = t.get(s.name);
      const bid = Number(k?.bidPx);
      const ask = Number(k?.askPx);
      const mid = bid > 0 && ask > bid ? (bid + ask) / 2 : Number(k?.lastPx) || null;
      return {
        symbol: s.name,
        price: mid,
        volume: Number(k?.quoteVolume) || 0,
        spreadBps: bid > 0 && ask > bid ? ((ask - bid) / ((ask + bid) / 2)) * 10_000 : null,
        maker: Number(s.makerFee),
        taker: Number(s.takerFee),
      };
    });
  }, [symbols, tickers.data]);
  const needle = q.trim().toLowerCase();
  const list = useMemo(() => {
    const xs = rows.filter((r) => !needle || r.symbol.toLowerCase().includes(needle) || marketLabel(r.symbol).toLowerCase().includes(needle));
    const by: Record<Sort, (r: (typeof rows)[number]) => number> = { volume: (r) => -r.volume, spread: (r) => r.spreadBps ?? 1e9, fee: (r) => r.maker };
    return [...xs].sort((x, y) => by[sort](x) - by[sort](y));
  }, [rows, needle, sort]);
  const shown = useMemo(() => {
    const top = needle ? [] : list.filter((r) => picked.includes(r.symbol));
    const rest = list.filter((r) => !top.includes(r));
    return [...top, ...(all || needle ? rest : rest.slice(0, Math.max(0, 10 - top.length)))];
  }, [list, picked, all, needle]);
  if (!symbols.length) return <div className="bots-skels">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="bots-skel" />)}</div>;
  const head = (k: Sort, label: string, title?: string) => (
    <th className="right" title={title}>
      <button type="button" className={`bots-th${sort === k ? ' is-on' : ''}`} onClick={() => setSort(k)}>{label}{sort === k && <Icon name="down" size={10} />}</button>
    </th>
  );
  return (
    <Panel className="bots-mstep">
      <div className="bots-toolbar">
        <SearchField value={q} onChange={setQ} placeholder="Search a spot market (BTC, SOL, NVDA…)" label="Search a spot market" className="bots-toolbar__search" />
        <span className="bots-toolbar__n">{picked.length} selected</span>
        <span className="bots-toolbar__sp" />
        <Segmented value={all ? 'all' : 'top'} label="Markets shown" onChange={(v) => setAll(v === 'all')} options={[{ value: 'top', label: 'Most traded' }, { value: 'all', label: `All ${rows.length}` }]} />
      </div>
      <div className="bots-tablewrap">
        <table className="bots-table bots-mt" aria-label="Spot markets">
          <colgroup><col style={{ width: 36 }} /><col /><col style={{ width: 110 }} /><col style={{ width: 130 }} /><col style={{ width: 100 }} /><col style={{ width: 150 }} /></colgroup>
          <thead>
            <tr>
              <th />
              <th>Market</th>
              <th className="right">Price</th>
              {head('volume', 'Volume / 24h', "The market's traded volume over the last day")}
              {head('spread', 'Spread', 'The gap between the best bid and ask now')}
              {head('fee', 'Maker / taker', "SoDEX's spot fees on this market (before the ValueDesk bot fee)")}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const on = picked.includes(r.symbol);
              const busy = running.has(r.symbol);
              const locked = real && busy && !on;
              const flip = () => { if (!locked) toggle(r.symbol); };
              return (
                <tr key={r.symbol} role="checkbox" aria-checked={on} aria-disabled={locked || undefined} aria-label={marketLabel(r.symbol)} tabIndex={0} className={`bots-row${on ? ' is-picked' : ''}${locked ? ' is-blocked' : ''}`} onClick={flip} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } }}>
                  <td className="bots-mt__pick"><span className={`bots-tick${on ? ' is-on' : ''}`} aria-hidden="true">{on && <Icon name="check" size={11} />}</span></td>
                  <td>
                    <span className="bots-mt__name">
                      <CoinIcon coin={coinOf(r.symbol)} size={22} />
                      <span><b>{marketLabel(r.symbol)}</b><small>Spot</small></span>
                      {busy && <StatusPill size="sm" tone={real ? 'warning' : 'neutral'} dot>running</StatusPill>}
                      {r.volume < 10_000 && <StatusPill size="sm">little traded</StatusPill>}
                    </span>
                  </td>
                  <td className="right num dim">{r.price ? fmtUsd(r.price) : DASH}</td>
                  <td className="right num">{r.volume ? fmtUsd(r.volume, 0) : DASH}</td>
                  <td className="right num dim">{r.spreadBps !== null ? `${r.spreadBps.toFixed(1)} bp` : DASH}</td>
                  <td className="right num dim">{r.maker > 0 || r.taker > 0 ? `${bp(r.maker)} / ${bp(r.taker)}` : DASH}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!all && !needle && list.length > shown.length && <button type="button" className="bots-more__t" onClick={() => setAll(true)}>Show {list.length - shown.length} more<Icon name="arrowRight" size={13} /></button>}
      <p className="bots-method">On spot a bot buys with your spot USDC and sells only what it bought. Estimates per $1M are not shown here: they come from futures prints, and spot has none recorded yet.</p>
    </Panel>
  );
}
