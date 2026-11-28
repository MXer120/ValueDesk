/**
 * What an index holds underneath (owner 2026-11-28: "include the holding by allocation diretly from sodex, below the
 * wealth products"): each fund's own holdings as sodex.com shows them (server routes/wealthInfo.ts: SoSoValue's
 * holdings of the ETF behind the token, or SoDEX's own list), each weighted by the fund's share of the index and added
 * up by ticker. A fund with no published holdings (USDC Earn, a single stock, a list SoSoValue lacks) counts as itself.
 * Only each fund's top 25 are known, so the rows cover part of the index; the page says how much.
 */
import { useEffect, useMemo, useState } from 'react';
import { Panel, Shell, ShellHeader, Skeleton } from '../bots/kit/kit';
import { useLanguage } from '../../i18n/store';
import type { WealthFund } from '../../trading/wealth';
import type { VdIndex } from '../../trading/vdIndexes';
import { holdingLogo, readInfo, type FundInfo } from './FundAbout';
import { CoinIcon } from '../CoinIcon';
import { fundNameOf, legColor } from './indexParts';

interface Row { key: string; name: string; ticker: string | null; weight: number; via: number[]; self: boolean }

/** Each fund's holdings weighted by its share and added up by ticker (or name); the funds without any count as themselves. */
export function lookThrough(ix: Pick<VdIndex, 'legs'>, infos: ReadonlyMap<string, FundInfo | null>, funds: readonly WealthFund[] | null): { rows: Row[]; covered: number } {
  const by = new Map<string, Row>();
  let covered = 0;
  ix.legs.forEach((l, i) => {
    const h = infos.get(l.fundId)?.holdings;
    const usable = h && h.rows.some((r) => r.weight > 0) && !(h.rows.length === 1 && h.rows[0]!.weight >= 0.999);
    if (!usable) {
      const self = h?.rows[0];
      const key = `fund:${l.fundId}`;
      by.set(key, { key, name: self?.name ?? fundNameOf(funds, l.fundId), ticker: self?.ticker ?? null, weight: l.weight, via: [i], self: true });
      covered += l.weight;
      return;
    }
    for (const r of h!.rows) {
      const key = (r.ticker ?? r.name).toUpperCase();
      const w = r.weight * l.weight;
      const cur = by.get(key);
      if (cur) { cur.weight += w; if (!cur.via.includes(i)) cur.via.push(i); } else by.set(key, { key, name: r.name, ticker: r.ticker, weight: w, via: [i], self: false });
      covered += w;
    }
  });
  return { rows: [...by.values()].sort((a, b) => b.weight - a.weight), covered: Math.min(1, covered) };
}

export function IndexHoldings({ ix, funds }: { ix: VdIndex; funds: readonly WealthFund[] | null }) {
  const lang = useLanguage();
  const key = `${lang}|${ix.legs.map((l) => l.fundId).join(',')}`;
  const [infos, setInfos] = useState<{ key: string; map: Map<string, FundInfo | null> } | null>(null);
  useEffect(() => {
    let off = false;
    void Promise.allSettled(ix.legs.map((l) => readInfo(l.fundId, lang))).then((rs) => {
      if (off) return;
      setInfos({ key, map: new Map(ix.legs.map((l, i) => [l.fundId, rs[i]!.status === 'fulfilled' ? (rs[i] as PromiseFulfilledResult<FundInfo | null>).value : null])) });
    });
    return () => { off = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = infos?.key === key ? infos.map : null;
  const lt = useMemo(() => (ready ? lookThrough(ix, ready, funds) : null), [ready, ix, funds]);
  const top = lt?.rows.slice(0, 20) ?? [];
  const max = top[0]?.weight ?? 1;
  return (
    <Shell className="wp-sec">
      <ShellHeader
        title="Holdings underneath"
        subtitle={lt ? `What the funds hold, by the index’s weights · the rows cover ${Math.round(lt.covered * 100)}% of it` : 'What the funds hold, by the index’s weights'}
      />
      <Panel className="wp-sec__p wp-hold">
        {!lt ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="wp-bone wp-bone--row" />) : top.map((r, i) => (
          <div key={r.key} className="wp-hold__r wp-hold__r--lt">
            <span className="wp-hold__i">{i + 1}</span>
            <CoinIcon coin={holdingLogo(r.ticker, r.name)} size={20} />
            <span className="wp-hold__n" data-no-i18n=""><b>{r.name}</b>{r.ticker && r.ticker !== r.name && <small>{r.ticker}</small>}</span>
            <span className="wp-hold__via" aria-label="Through">{r.via.map((v) => <i key={v} className="wp-dot" style={{ background: legColor(v) }} title={fundNameOf(funds, ix.legs[v]!.fundId)} />)}</span>
            <span className="wp-hold__w"><b>{`${(r.weight * 100).toFixed(r.weight >= 0.1 ? 1 : 2)}%`}</b><i style={{ width: `${Math.min(100, (r.weight / max) * 100)}%` }} aria-hidden="true" /></span>
          </div>
        ))}
      </Panel>
    </Shell>
  );
}
