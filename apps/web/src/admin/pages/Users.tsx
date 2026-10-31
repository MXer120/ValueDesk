/**
 * Every wallet ValueDesk knows: those the builder ledger counted (volume, fees paid,
 * tier), those that connected while analytics was allowed (visits, time, features),
 * those with a feedback chat. A wallet only one source knows shows "–" for the others.
 */
import { useMemo, useState } from 'react';
import { ago, bp, duration, int, short, usd, usdShort } from '../format';
import { Note, PageHead, Tile, useAdmin } from '../ui';
import type { UserRow } from '../types';

type SortKey = 'fees' | 'volume' | 'volume30d' | 'window' | 'lastTrade' | 'visits' | 'time' | 'lastSeen' | 'firstSeen';

const value = (u: UserRow, k: SortKey): number => {
  const b = u.builder;
  const a = u.activity;
  switch (k) {
    case 'fees': return b ? b.fees.perps + b.fees.spot : -1;
    case 'volume': return b ? b.volume.perps + b.volume.spot : -1;
    case 'volume30d': return b?.volume30d ?? -1;
    case 'window': return b?.windowVolume ?? -1;
    case 'lastTrade': return b?.lastTradeAt ?? -1;
    case 'visits': return a?.visits ?? -1;
    case 'time': return a?.activeMs ?? -1;
    case 'lastSeen': return a?.lastSeen ?? -1;
    case 'firstSeen': return b?.firstSeen ?? -1;
  }
};

export function Users() {
  const r = useAdmin<{ users: UserRow[]; builderId: number | null }>('users');
  const [sort, setSort] = useState<SortKey>('fees');
  const [q, setQ] = useState('');
  const users = r.data?.users ?? [];
  const shown = useMemo(
    () => users.filter((u) => !q || u.address.includes(q.toLowerCase()) || String(u.builder?.accountId ?? '').includes(q)).sort((a, b) => value(b, sort) - value(a, sort)),
    [users, sort, q],
  );
  const traded = users.filter((u) => u.builder && u.builder.volume.perps + u.builder.volume.spot > 0).length;
  const fees = users.reduce((s, u) => s + (u.builder ? u.builder.fees.perps + u.builder.fees.spot : 0), 0);
  const th = (k: SortKey, label: string) => (
    <th className="num"><button type="button" className={`ad-sort${sort === k ? ' is-on' : ''}`} onClick={() => setSort(k)} aria-sort={sort === k ? 'descending' : 'none'}>{label}</button></th>
  );
  const csv = () => {
    const rows = [['wallet', 'account', 'volume_usd', 'volume_30d_usd', 'tier_window_usd', 'fees_paid_usd', 'orders', 'tier', 'fee_perps_bp', 'fee_spot_bp', 'flags', 'last_trade', 'visits', 'active_min', 'last_seen', 'countries', 'ticket']];
    for (const u of shown) {
      const b = u.builder;
      const a = u.activity;
      rows.push([
        u.address, String(b?.accountId ?? ''), b ? String((b.volume.perps + b.volume.spot) / 1e6) : '', b ? String(b.volume30d / 1e6) : '', b ? String(b.windowVolume / 1e6) : '',
        b ? String((b.fees.perps + b.fees.spot) / 1e6) : '', String(b?.orders ?? ''), b ? String(b.tier.index) : '', b ? String(b.tier.fee.perps / 10) : '', b ? String(b.tier.fee.spot / 10) : '',
        b?.flags.join(' ') ?? '', b?.lastTradeAt ? new Date(b.lastTradeAt).toISOString() : '', String(a?.visits ?? ''), a ? String(Math.round(a.activeMs / 60_000)) : '',
        a?.lastSeen ? new Date(a.lastSeen).toISOString() : '', a?.countries.join(' ') ?? '', String(u.ticket ?? ''),
      ]);
    }
    const blob = new Blob([rows.map((row) => row.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `valuedesk-users-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <>
      <PageHead title="Users" line="Every wallet ValueDesk knows: what the builder ledger counted, what analytics saw, who wrote feedback." loaded={r}>
        <input className="ad-input ad-input--small" placeholder="0x… or account id" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search wallets" />
        <button type="button" className="ad-btn" onClick={csv} disabled={!shown.length}>CSV</button>
      </PageHead>
      {r.error && <Note kind="error">{r.error}</Note>}
      <div className="ad-tiles">
        <Tile label="Wallets known" value={int(users.length)} sub={`builder ${r.data?.builderId ?? '–'}`} />
        <Tile label="Traded through ValueDesk" value={int(traded)} sub="counted builder volume > 0" />
        <Tile label="Builder fees paid, all wallets" value={usdShort(fees)} />
        <Tile label="Seen with analytics allowed" value={int(users.filter((u) => u.activity).length)} />
      </div>
      <div className="ad-tablewrap">
        <table className="ad-table">
          <thead>
            <tr>
              <th>Wallet</th>
              <th className="num">Account</th>
              {th('volume', 'Volume')}
              {th('volume30d', '30 d')}
              {th('window', 'Tier window')}
              {th('fees', 'Fees paid')}
              <th className="num">Orders</th>
              <th>Tier · fee</th>
              <th>Flags</th>
              {th('lastTrade', 'Last trade')}
              {th('visits', 'Visits')}
              {th('time', 'Time')}
              {th('lastSeen', 'Last seen')}
              <th>From</th>
              <th>Top features</th>
              <th>Ticket</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((u) => {
              const b = u.builder;
              const a = u.activity;
              return (
                <tr key={u.address}>
                  <td className="ad-mono" title={u.address}>{short(u.address)}</td>
                  <td className="num">{b?.accountId ?? '–'}</td>
                  <td className="num" title={b ? `perps ${usd(b.volume.perps)} · spot ${usd(b.volume.spot)}` : undefined}>{b ? usdShort(b.volume.perps + b.volume.spot) : '–'}</td>
                  <td className="num">{b ? usdShort(b.volume30d) : '–'}</td>
                  <td className="num">{b ? usdShort(b.windowVolume) : '–'}</td>
                  <td className="num" title={b ? `perps ${usd(b.fees.perps)} · spot ${usd(b.fees.spot)}` : undefined}>{b ? usd(b.fees.perps + b.fees.spot) : '–'}</td>
                  <td className="num">{b ? int(b.orders) : '–'}</td>
                  <td title={b?.signedFee ? `last signed ${bp(b.signedFee.perps)} / ${bp(b.signedFee.spot)} (${ago(b.signedFee.at)})` : undefined}>
                    {b ? `${b.tier.index} · ${bp(b.tier.fee.perps)}${b.tier.fee.spot !== b.tier.fee.perps ? ` / ${bp(b.tier.fee.spot)}` : ''}` : '–'}
                    {b?.tier.nextAtUsd ? <span className="ad-dim"> next at ${int(b.tier.nextAtUsd)}</span> : null}
                  </td>
                  <td>{b?.flags.length ? <span className="ad-warn">{b.flags.join(', ')}</span> : b?.pending ? <span className="ad-dim">{b.pending} to check</span> : ''}</td>
                  <td className="num">{b?.lastTradeAt ? ago(b.lastTradeAt) : '–'}</td>
                  <td className="num">{a ? int(a.visits) : '–'}</td>
                  <td className="num">{a ? duration(a.activeMs) : '–'}</td>
                  <td className="num">{a ? ago(a.lastSeen) : '–'}</td>
                  <td>{a?.countries.join(', ') || '–'}</td>
                  <td className="ad-dim">{a?.features.map((f) => `${f.key} ${f.n}`).join(', ') || '–'}</td>
                  <td>{u.ticket ? <a href={`#/tickets/${u.ticket}`}>#{u.ticket}</a> : ''}</td>
                </tr>
              );
            })}
            {!shown.length && !r.loading && <tr><td colSpan={16} className="ad-dim">No wallet yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="ad-dim">Volume and fees come from the builder ledger: fills that paid ValueDesk's builder fee on orders SoDEX's explorer shows naming our builder at the fee owed. Fee = counted notional × the order's fee. Visits and features only exist for visitors who allowed analytics and connected this wallet.</p>
    </>
  );
}
