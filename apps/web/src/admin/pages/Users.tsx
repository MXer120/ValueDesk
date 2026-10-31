/**
 * Every wallet ValueDesk knows: those the builder ledger counted (volume, fees paid,
 * tier), those that connected while analytics was allowed (visits, time, features),
 * those with a feedback chat. A wallet only one source knows shows "–" for the others.
 * The table is the leaderboard's (dv-sheet: its head, row height, number font, hover tint).
 */
import { useMemo, useState } from 'react';
import { ago, bp, duration, int, short, usd, usdShort } from '../format';
import { Empty, Figure, Figures, Note, Page, Search, Section, useAdmin } from '../ui';
import type { UserRow } from '../types';

type SortKey = 'fees' | 'volume' | 'volume30d' | 'window' | 'lastTrade' | 'visits' | 'time' | 'lastSeen';

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
  }
};

function csv(rows: UserRow[]): void {
  const head = ['wallet', 'account', 'volume_usd', 'volume_30d_usd', 'tier_window_usd', 'fees_paid_usd', 'orders', 'tier', 'fee_perps_bp', 'fee_spot_bp', 'flags', 'last_trade', 'visits', 'active_min', 'last_seen', 'countries', 'ticket'];
  const out = [head];
  for (const u of rows) {
    const b = u.builder;
    const a = u.activity;
    out.push([
      u.address, String(b?.accountId ?? ''), b ? String((b.volume.perps + b.volume.spot) / 1e6) : '', b ? String(b.volume30d / 1e6) : '', b ? String(b.windowVolume / 1e6) : '',
      b ? String((b.fees.perps + b.fees.spot) / 1e6) : '', String(b?.orders ?? ''), b ? String(b.tier.index) : '', b ? String(b.tier.fee.perps / 10) : '', b ? String(b.tier.fee.spot / 10) : '',
      b?.flags.join(' ') ?? '', b?.lastTradeAt ? new Date(b.lastTradeAt).toISOString() : '', String(a?.visits ?? ''), a ? String(Math.round(a.activeMs / 60_000)) : '',
      a?.lastSeen ? new Date(a.lastSeen).toISOString() : '', a?.countries.join(' ') ?? '', String(u.ticket ?? ''),
    ]);
  }
  const quote = (c: string) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  const blob = new Blob([out.map((r) => r.map(quote).join(',')).join('\n')], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `valuedesk-users-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

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
  const volume = users.reduce((s, u) => s + (u.builder ? u.builder.volume.perps + u.builder.volume.spot : 0), 0);
  const th = (k: SortKey, label: string) => (
    <th className="right"><button type="button" className={`dv-sort${sort === k ? ' is-on' : ''}`} onClick={() => setSort(k)} aria-sort={sort === k ? 'descending' : 'none'}>{label}{sort === k ? ' ↓' : ''}</button></th>
  );
  return (
    <Page
      title={`${int(users.length)} wallet${users.length === 1 ? '' : 's'}`}
      line="Every wallet ValueDesk knows: what the builder ledger counted on SoDEX, what analytics saw (only visitors who allowed it), who wrote feedback."
      loaded={r}
      wide
      tools={
        <>
          <Search value={q} onChange={setQ} placeholder="Search 0x… or account id" />
          <button type="button" className="dv-btn dv-right" onClick={() => csv(shown)} disabled={!shown.length}>Download CSV</button>
        </>
      }
    >
      {r.error && <Section><Note kind="error">{r.error}</Note></Section>}
      <Section>
        <Figures>
          <Figure label="Wallets known" value={int(users.length)} sub={`builder ${r.data?.builderId ?? '–'}`} />
          <Figure label="Traded through ValueDesk" value={int(traded)} sub="counted builder volume above 0" />
          <Figure label="Volume, all wallets" value={usdShort(volume)} />
          <Figure label="Builder fees paid" value={usd(fees)} />
        </Figures>
      </Section>
      <Section flush>
        <div className="dv-sheet">
          <table className="dv-table">
            <thead>
              <tr>
                <th>Wallet</th>
                <th className="right">Account</th>
                {th('volume', 'Volume')}
                {th('volume30d', '30 days')}
                {th('window', 'Tier window')}
                {th('fees', 'Fees paid')}
                <th className="right">Orders</th>
                <th>Tier · fee</th>
                <th>Flags</th>
                {th('lastTrade', 'Last trade')}
                {th('visits', 'Visits')}
                {th('time', 'Time')}
                {th('lastSeen', 'Last seen')}
                <th>From</th>
                <th>Most used</th>
                <th>Ticket</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => {
                const b = u.builder;
                const a = u.activity;
                return (
                  <tr key={u.address}>
                    <td className="dv-mono" title={u.address}>{short(u.address)}</td>
                    <td className="right">{b?.accountId ?? '–'}</td>
                    <td className="right" title={b ? `perps ${usd(b.volume.perps)} · spot ${usd(b.volume.spot)}` : undefined}>{b ? usdShort(b.volume.perps + b.volume.spot) : '–'}</td>
                    <td className="right">{b ? usdShort(b.volume30d) : '–'}</td>
                    <td className="right">{b ? usdShort(b.windowVolume) : '–'}</td>
                    <td className="right" title={b ? `perps ${usd(b.fees.perps)} · spot ${usd(b.fees.spot)}` : undefined}>{b ? usd(b.fees.perps + b.fees.spot) : '–'}</td>
                    <td className="right">{b ? int(b.orders) : '–'}</td>
                    <td title={b?.signedFee ? `last signed ${bp(b.signedFee.perps)} / ${bp(b.signedFee.spot)} (${ago(b.signedFee.at)})` : undefined}>
                      {b ? <>Tier {b.tier.index} · {bp(b.tier.fee.perps)}{b.tier.fee.spot !== b.tier.fee.perps ? ` / ${bp(b.tier.fee.spot)}` : ''}</> : '–'}
                    </td>
                    <td>{b?.flags.length ? <span className="dv-warn">{b.flags.join(', ')}</span> : b?.pending ? <span className="dv-quiet">{b.pending} to check</span> : <span className="dv-quiet">–</span>}</td>
                    <td className="right">{b?.lastTradeAt ? ago(b.lastTradeAt) : '–'}</td>
                    <td className="right">{a ? int(a.visits) : '–'}</td>
                    <td className="right">{a ? duration(a.activeMs) : '–'}</td>
                    <td className="right">{a ? ago(a.lastSeen) : '–'}</td>
                    <td>{a?.countries.join(', ') || '–'}</td>
                    <td className="dv-quiet">{a?.features.map((f) => `${f.key} ${f.n}`).join(', ') || '–'}</td>
                    <td>{u.ticket ? <a className="st-link" href={`#/tickets/${u.ticket}`}>#{u.ticket}</a> : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!shown.length && !r.loading && <div className="dv-sheet__none"><Empty>{q ? 'No wallet matches the search.' : 'No wallet yet.'}</Empty></div>}
        </div>
      </Section>
      <div className="st-foot">
        Volume and fees come from the builder ledger: fills that paid ValueDesk's builder fee on orders the SoDEX explorer shows naming our builder at the fee owed; fee = counted notional × the order's fee. Visits and features exist only for visitors who allowed analytics and connected this wallet.
      </div>
    </Page>
  );
}
