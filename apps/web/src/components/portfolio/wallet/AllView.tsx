/**
 * The Portfolio's All tab (owner 2026-11-27: "Add an all tab too ... as we also need to include allocations through a
 * bar or something, figure it out").
 *
 * - Where the money is: the four accounts on one bar (each dollar once, summary.ts), each named with its figure and
 *   share; a click opens that account's tab.
 * - What runs inside them: copies and bots trade from Perps and Spot, so they are not a fifth slice; what they may use is
 *   shown as a share of those accounts, apart from the bar.
 * - What it all is: every asset across the accounts, merged (USDC in Perps, Spot and on Base is one row), with where it
 *   sits and its share of the total. The rows add up to the total: Wealth shares count under Wealth, never twice.
 */
import { useMemo, useState } from 'react';
import { Button, Icon } from '../../bots/kit/kit';
import { CoinIcon } from '../../CoinIcon';
import { coinLogo } from '../../../logos';
import { DASH, fmtUsd } from '../../../format';
import { Private } from '../../../privacy';
import { requestConnect } from '../../account/actions';
import { claimedCoins, shareKey } from '../summary';
import { AllocBar, BucketIcon, ViewAll, share, useCopies, useMasks, type Section } from './blocks';
import type { Bucket, PfData } from './data';

const ROWS = 10;

interface Piece { bucket: Bucket; where: string; usd: number }
interface AssetRow { key: string; symbol: string; icon: { coin?: string; bucket?: Bucket; chain?: string }; name: string; usd: number; pieces: Piece[] }

/** Every asset across the four accounts, merged by coin, each dollar once (the same rules as summary.ts). */
export function assetRows(d: PfData): AssetRow[] {
  const by = new Map<string, AssetRow>();
  const put = (symbol: string, piece: Piece, chain?: string) => {
    if (!(piece.usd > 0.005)) return;
    const key = shareKey(symbol);
    const row = by.get(key) ?? { key, symbol: symbol.replace(/^v(?=[A-Z])/, ''), icon: { coin: symbol }, name: '', usd: 0, pieces: [] };
    if (chain && !row.icon.chain) row.icon.chain = chain;
    row.usd += piece.usd;
    const same = row.pieces.find((p) => p.bucket === piece.bucket && p.where === piece.where);
    if (same) same.usd += piece.usd; else row.pieces.push({ ...piece });
    by.set(key, row);
  };
  // Perps: the account's value as SoDEX reports it (margin and open PnL), one row.
  if (d.s.perps !== null && d.s.perps > 0.005) by.set('#PERPS', { key: '#PERPS', symbol: 'Perps account', icon: { bucket: 'perps' }, name: 'Margin and open positions', usd: d.s.perps, pieces: [{ bucket: 'perps', where: 'Perps', usd: d.s.perps }] });
  const claimed = claimedCoins(d.w.rows);
  for (const c of d.spotCoins ?? []) if (c.usd !== null && !claimed.has(shareKey(c.coin))) put(c.coin, { bucket: 'spot', where: 'Spot', usd: c.usd });
  // Wealth: each priced fund, less the shares pledged as Perps margin (the Perps row holds those), plus what is in flight.
  for (const r of d.w.rows ?? []) {
    if (r.marketValue === null) continue;
    const pledged = r.shares > 0 && r.perpShares > 0 ? r.marketValue * Math.min(1, r.perpShares / r.shares) : 0;
    put(r.coin, { bucket: 'wealth', where: 'Wealth', usd: Math.max(0, r.marketValue - pledged) + (r.inFlight || 0) });
  }
  if (d.s.slp) by.set('#SLP', { key: '#SLP', symbol: 'SLP', icon: { bucket: 'wealth' }, name: 'Liquidity vault', usd: d.s.slp, pieces: [{ bucket: 'wealth', where: 'Vault', usd: d.s.slp }] });
  for (const h of d.evmRows) put(h.symbol, { bucket: 'evm', where: h.chainLabel, usd: h.usd }, h.chainIcon ?? h.chain);
  for (const r of by.values()) r.pieces.sort((a, b) => b.usd - a.usd);
  return [...by.values()].sort((a, b) => b.usd - a.usd);
}

function Automation({ d, onSection }: { d: PfData; onSection: (s: Section) => void }) {
  const m = useMasks();
  const copies = useCopies();
  const base = (d.s.perps ?? 0) + (d.s.spot ?? 0);
  const used = copies.allocated;
  return (
    <div className="pfa-auto">
      <span className="pfa-auto__k">Inside Perps and Spot</span>
      <button type="button" className="pfa-auto__item" onClick={() => onSection('copy')}>
        <span className="pfa-auto__t"><b>Copy trading</b><small>{copies.live ? `${copies.live} live${copies.paper ? `, ${copies.paper} practice` : ''}` : copies.paper ? `${copies.paper} practice` : 'None running'}</small></span>
        <span className="pfa-auto__v">
          <b>{used > 0 ? m.funds(fmtUsd(used)) : DASH}</b>
          <small>{used > 0 && base > 0 ? `may use ${share(Math.min(1, used / base))}` : 'allocated'}</small>
        </span>
        <Icon name="arrowRight" size={14} />
      </button>
      <button type="button" className="pfa-auto__item" onClick={() => onSection('bots')}>
        <span className="pfa-auto__t"><b>Bots</b><small>Market making and grids</small></span>
        <span className="pfa-auto__v"><small>See your bots</small></span>
        <Icon name="arrowRight" size={14} />
      </button>
    </div>
  );
}

export function AllView({ d, onSection }: { d: PfData; onSection: (s: Section) => void }) {
  const m = useMasks();
  const rows = useMemo(() => assetRows(d), [d]);
  const [all, setAll] = useState(false);
  const total = d.s.total;
  const shown = all ? rows : rows.slice(0, ROWS);
  // Each row's bar is measured against the largest row (the text gives the share of the total).
  const top = rows[0]?.usd ?? 0;
  const tab: Record<Bucket, Section> = { perps: 'perps', spot: 'spot', wealth: 'wealth', evm: 'onchain' };
  return (
    <div className="pfa">
      <div className="pfa-top">
        <span className="pfa-total"><small>Total value</small><b>{total === null ? DASH : m.equity(fmtUsd(total))}</b></span>
        <AllocBar parts={d.parts} size="lg" />
        <ul className="pfa-parts">
          {d.parts.map((p) => (
            <li key={p.key}>
              <button type="button" onClick={() => onSection(tab[p.key])}>
                <i className={`pfv-dot is-${p.key}`} aria-hidden="true" />
                <span className="pfa-parts__t"><b>{p.label}</b><small>{p.share === null ? DASH : share(p.share)}</small></span>
                <span className="pfa-parts__v">{p.usd === null ? (p.key === 'evm' && d.evmLoading ? '…' : DASH) : m.funds(fmtUsd(p.usd))}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <Automation d={d} onSection={onSection} />
      {rows.length > 0 && (
        <div className="pfa-assets">
          <div className="pfv-scroll">
            <table className="pfo-tbl pfa-tbl">
              <thead><tr><th>Asset</th><th>Where</th><th className="pfo-tbl__num">Value</th><th className="pfa-tbl__share">Share</th></tr></thead>
              <tbody>
                {shown.map((r) => {
                  const sh = total && total > 0 ? r.usd / total : null;
                  return (
                    <tr key={r.key}>
                      <td><div className="pfo-tbl__asset">
                        <span className="pfv-coins__ic">{r.icon.bucket ? <BucketIcon k={r.icon.bucket} size={26} />
                          // A coin no icon set knows shows its chain's icon, not the app's fallback (SoDEX's mark).
                          : coinLogo(r.icon.coin) || !r.icon.chain ? <CoinIcon coin={r.icon.coin} size={26} /> : <CoinIcon chain={r.icon.chain} size={26} />}</span>
                        <span className="pfo-tbl__t"><b>{r.symbol}</b>{r.name && <small>{r.name}</small>}</span>
                      </div></td>
                      <td className="pfa-where">
                        {r.pieces.map((p) => (
                          <span key={`${p.bucket}:${p.where}`} className="pfa-where__p" title={`${p.where}: ${fmtUsd(p.usd)}`}><i className={`pfv-dot is-${p.bucket}`} aria-hidden="true" />{p.where}</span>
                        ))}
                      </td>
                      <td className="pfo-tbl__num"><b>{m.funds(fmtUsd(r.usd))}</b></td>
                      <td className="pfa-tbl__share">
                        <Private k="charts">
                          <span className="pfa-share" aria-hidden="true">
                            {r.pieces.map((p) => <i key={`${p.bucket}:${p.where}`} className={`is-${p.bucket}`} style={{ width: `${top > 0 ? (p.usd / top) * 100 : 0}%` }} />)}
                          </span>
                        </Private>
                        <small>{share(sh)}</small>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > ROWS && <div className="pfo-foot"><ViewAll label={all ? 'Show fewer' : `Show all ${rows.length}`} dir={all ? 'up' : 'down'} onClick={() => setAll(!all)} /></div>}
        </div>
      )}
      {!d.c.address && <div className="pfa-connect"><Button variant="primary" icon="wallet" onClick={requestConnect}>Connect a wallet to see yours</Button></div>}
    </div>
  );
}
