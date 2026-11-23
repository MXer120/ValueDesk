/**
 * V5's live tape under the hero (owner 2026-11-23): running right to left, the busiest SoDEX markets with their cheapest
 * bot's all-in cost per $1M at the VIP fee, and every few markets one of the top copy traders. A market opens the New
 * bot page with exactly that bot on that coin (botHref = Explore's Configure); a trader opens their profile
 * (/scan?address=&venue=, the same "Open profile" the app links).
 *
 * Figures: markets from useLiveDesk (7 days, VIP fee, shared.tsx); traders from the public boards (/api/vs/leaderboard,
 * 30 days), scored as the Copy page scores them. Pauses off screen and on hover.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAsync } from '../../../hooks';
import { vsApi, type BoardWindow, type TraderRow } from '../../../vsApi';
import { CoinIcon } from '../../CoinIcon';
import { VenueLogo } from '../../VenueLogo';
import { COPY_VENUES, scoreRows } from '../../copy/gridModel';
import { botHref, usdShort, type MarketRow } from '../shared';

const WIN: BoardWindow = '30d';
const EVERY = 3; // a trader after every 3 markets

function perMillion(b: number | null): ReactNode {
  if (b === null) return <span className="h-dim">—</span>;
  const usd = `$${Math.round(Math.abs(b) * 100).toLocaleString('en-US')}`;
  return b <= 0 ? <b className="h-pos">+{usd}</b> : <b>{usd}</b>;
}

export function SiteTape({ rows }: { rows: MarketRow[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') { setOn(true); return; }
    const io = new IntersectionObserver(([e]) => setOn(!!e?.isIntersecting), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const boards = useAsync(
    () => Promise.all(COPY_VENUES.map((venue) => vsApi.leaderboard({ venue, window: WIN, sort: 'pnl', limit: 100 }).then((b) => b.rows, () => [] as TraderRow[]))),
    [],
    { enabled: on, pollMs: 300_000 },
  );
  const traders = useMemo(() => scoreRows((boards.data ?? []).flat(), WIN, 'copy').sort((a, b) => b.score.score - a.score.score).slice(0, 6).map((s) => s.row), [boards.data]);

  const items = useMemo(() => {
    const out: ReactNode[] = [];
    let t = 0;
    rows.forEach((r, i) => {
      out.push(
        <a key={`m${r.m.symbol}`} href={botHref(r)} className="h-tape__i" title={r.recipe ? `${r.recipe} on ${r.m.base}` : undefined}>
          <CoinIcon coin={r.m.base} size={18} />
          <b>{r.m.base}</b>
          <span className="h-dim">{usdShort(r.m.volumeUsdH)}/h</span>
          <span className="h-tape__c">{perMillion(r.bp)}<small> per $1M</small></span>
        </a>,
      );
      if ((i + 1) % EVERY === 0 && t < traders.length) {
        const x = traders[t++]!;
        const pnl = x.pnl[WIN] ?? null;
        out.push(
          <a key={`t${x.venue}${x.address}`} href={`/scan?address=${encodeURIComponent(x.address)}&venue=${x.venue}`} className="h-tape__i is-trader">
            <VenueLogo venue={x.venue} size={18} />
            <b>{x.label || `${x.address.slice(0, 6)}…${x.address.slice(-4)}`}</b>
            <span className={pnl !== null && pnl >= 0 ? 'h-tape__c h-pos' : 'h-tape__c'}>{pnl === null ? '—' : `${pnl >= 0 ? '+' : '−'}${usdShort(Math.abs(pnl))}`}<small> 30d</small></span>
            <span className="h-tape__copy">Copy</span>
          </a>,
        );
      }
    });
    return out;
  }, [rows, traders]);

  if (!rows.length) return <div ref={ref} className="h-tape is-empty" />;
  return (
    <div ref={ref} className="h-tape vd-tape" data-off={on ? undefined : ''} aria-label="SoDEX markets with their cheapest bot per $1M at the VIP fee, and top copy traders">
      <div className="h-tape__run">{items}<span aria-hidden="true" className="h-tape__dup">{items}</span></div>
    </div>
  );
}
