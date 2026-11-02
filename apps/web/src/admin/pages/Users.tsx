/**
 * Every wallet ValueDesk knows: those the builder ledger counted (volume, fees paid,
 * tier), those the copy executor knows (signed the site's or the copy terms, follow a
 * trader, run an algo, hold a key), those that connected while analytics was allowed
 * (visits, time, features), those with a feedback chat. A wallet only one source knows
 * shows "–" for the others.
 * The table is the leaderboard's (dv-sheet: its head, row height, number font, hover tint).
 */
import { useMemo, useState } from 'react';
import { ago, bp, duration, int, short, usd, usdShort } from '../format';
import { Empty, Figure, Figures, Note, Page, Search, Section, useAdmin } from '../ui';
import type { UserRow } from '../types';

type SortKey = 'joined' | 'fees' | 'volume' | 'volume30d' | 'window' | 'lastTrade' | 'copies' | 'visits' | 'time' | 'lastSeen';

/** The last sign of the wallet anywhere: a signature, a copy's or algo's action, a trade, a visit. */
const lastSeenOf = (u: UserRow): number | null => {
  const t = Math.max(u.activity?.lastSeen ?? 0, u.executor?.lastSignedAt ?? 0, u.executor?.lastActivityAt ?? 0, u.builder?.lastTradeAt ?? 0);
  return t > 0 ? t : null;
};

/** Where the wallet is from: what it declared when it signed, then the edge's country, then analytics'. */
const countriesOf = (u: UserRow): string[] =>
  [...new Set([u.executor?.country, u.executor?.viewerCountry, ...(u.activity?.countries ?? [])].filter((c): c is string => !!c))];

const value = (u: UserRow, k: SortKey): number => {
  const b = u.builder;
  const a = u.activity;
  const e = u.executor;
  switch (k) {
    case 'joined': return e?.firstAt ?? -1;
    case 'copies': return e ? (e.activeCopies + e.liveAlgos) * 1000 + e.copies + e.algos : -1;
    case 'fees': return b ? b.fees.perps + b.fees.spot : -1;
    case 'volume': return b ? b.volume.perps + b.volume.spot : -1;
    case 'volume30d': return b?.volume30d ?? -1;
    case 'window': return b?.windowVolume ?? -1;
    case 'lastTrade': return b?.lastTradeAt ?? -1;
    case 'visits': return a?.visits ?? -1;
    case 'time': return a?.activeMs ?? -1;
    case 'lastSeen': return lastSeenOf(u) ?? -1;
  }
};

function csv(rows: UserRow[]): void {
  const head = ['wallet', 'internal', 'first_signed', 'site_terms', 'copy_terms', 'copies', 'active_copies', 'algos', 'live_algos', 'keys', 'account', 'volume_usd', 'volume_30d_usd', 'tier_window_usd', 'fees_paid_usd', 'orders', 'tier', 'fee_perps_bp', 'fee_spot_bp', 'flags', 'last_trade', 'visits', 'active_min', 'last_seen', 'countries', 'ticket'];
  const out = [head];
  for (const u of rows) {
    const b = u.builder;
    const a = u.activity;
    const e = u.executor;
    const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : '');
    out.push([
      u.address, u.internal ? 'yes' : '', iso(e?.firstAt), iso(e?.siteTermsAt), iso(e?.copyTermsAt), String(e?.copies ?? ''), String(e?.activeCopies ?? ''), String(e?.algos ?? ''), String(e?.liveAlgos ?? ''), String(e?.keys ?? ''),
      String(b?.accountId ?? ''), b ? String((b.volume.perps + b.volume.spot) / 1e6) : '', b ? String(b.volume30d / 1e6) : '', b ? String(b.windowVolume / 1e6) : '',
      b ? String((b.fees.perps + b.fees.spot) / 1e6) : '', String(b?.orders ?? ''), b ? String(b.tier.index) : '', b ? String(b.tier.fee.perps / 10) : '', b ? String(b.tier.fee.spot / 10) : '',
      b?.flags.join(' ') ?? '', b?.lastTradeAt ? new Date(b.lastTradeAt).toISOString() : '', String(a?.visits ?? ''), a ? String(Math.round(a.activeMs / 60_000)) : '',
      iso(lastSeenOf(u)), countriesOf(u).join(' '), String(u.ticket ?? ''),
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
  const r = useAdmin<{ users: UserRow[]; builderId: number | null; executorRead?: boolean }>('users');
  const [sort, setSort] = useState<SortKey>('lastSeen');
  const [q, setQ] = useState('');
  const users = r.data?.users ?? [];
  const shown = useMemo(
    () => users.filter((u) => !q || u.address.includes(q.toLowerCase()) || String(u.builder?.accountId ?? '').includes(q)).sort((a, b) => value(b, sort) - value(a, sort)),
    [users, sort, q],
  );
  const signed = users.filter((u) => u.executor?.siteTermsAt || u.executor?.copyTermsAt).length;
  const copying = users.filter((u) => u.executor && (u.executor.activeCopies > 0 || u.executor.liveAlgos > 0)).length;
  const traded = users.filter((u) => u.builder && u.builder.volume.perps + u.builder.volume.spot > 0).length;
  const fees = users.reduce((s, u) => s + (u.builder ? u.builder.fees.perps + u.builder.fees.spot : 0), 0);
  const volume = users.reduce((s, u) => s + (u.builder ? u.builder.volume.perps + u.builder.volume.spot : 0), 0);
  const th = (k: SortKey, label: string) => (
    <th className="right"><button type="button" className={`dv-sort${sort === k ? ' is-on' : ''}`} onClick={() => setSort(k)} aria-sort={sort === k ? 'descending' : 'none'}>{label}{sort === k ? ' ↓' : ''}</button></th>
  );
  return (
    <Page
      title={`${int(users.length)} wallet${users.length === 1 ? '' : 's'}`}
      line="Every wallet ValueDesk knows: who signed the terms or copies on the executor, what the builder ledger counted on SoDEX, what analytics saw (only visitors who allowed it), who wrote feedback."
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
      {r.data?.executorRead === false && <Section><Note kind="warn">The copy executor (server 2) did not answer: wallets only it knows (terms signers, followers, algo owners) are missing until it does.</Note></Section>}
      <Section>
        <Figures>
          <Figure label="Wallets known" value={int(users.length)} sub={`${int(users.filter((u) => u.internal).length)} internal`} />
          <Figure label="Signed the terms" value={int(signed)} sub={`${int(copying)} copying or running an algo`} />
          <Figure label="Traded through ValueDesk" value={int(traded)} sub={`counted on builder ${r.data?.builderId ?? '–'}`} />
          <Figure label="Volume, all wallets" value={usdShort(volume)} />
          <Figure label="Fees counted per wallet" value={usd(fees)} sub="ledger only - all income: Volume &amp; fees" />
        </Figures>
      </Section>
      <Section flush>
        <div className="dv-sheet">
          <table className="dv-table">
            <thead>
              <tr>
                <th>Wallet</th>
                {th('joined', 'Joined')}
                <th>Terms</th>
                {th('copies', 'Copies · algos')}
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
                const e = u.executor;
                const seen = lastSeenOf(u);
                return (
                  <tr key={u.address}>
                    <td className="dv-mono" title={u.address}>{short(u.address)}{u.internal && <span className="dv-internal">Internal</span>}</td>
                    <td className="right">{e?.firstAt ? ago(e.firstAt) : '–'}</td>
                    <td>
                      {e?.siteTermsAt || e?.copyTermsAt ? (
                        <>
                          {e.siteTermsAt ? <span className="dv-tag is-on" title={`site terms ${new Date(e.siteTermsAt).toLocaleString()}`}>Site</span> : null}
                          {e.copyTermsAt ? <span className="dv-tag is-on" title={`copy terms ${new Date(e.copyTermsAt).toLocaleString()}`}>Copy</span> : null}
                        </>
                      ) : <span className="dv-quiet">–</span>}
                    </td>
                    <td className="right" title={e ? `${e.activeCopies} of ${e.copies} copies active · ${e.liveAlgos} of ${e.algos} algos running · ${e.keys} key${e.keys === 1 ? '' : 's'}` : undefined}>
                      {e && (e.copies || e.algos) ? `${e.activeCopies}/${e.copies} · ${e.liveAlgos}/${e.algos}` : '–'}
                    </td>
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
                    <td className="right">{seen ? ago(seen) : '–'}</td>
                    <td>{countriesOf(u).join(', ') || '–'}</td>
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
        Joined, terms and copies come from the copy executor: the first signature a wallet gave there, the site's and the copy terms it accepted, its copies and algos (active or running / all). Last seen is the latest of a signature, a copy's or algo's action, a trade and a visit; From is the country declared at signing, then the edge's, then analytics'. Volume and fees come from the builder ledger: fills that paid ValueDesk's builder fee on orders the SoDEX explorer shows naming our builder at the fee owed; fee = counted notional × the order's fee. Visits and features exist only for visitors who allowed analytics and connected this wallet.
      </div>
    </Page>
  );
}
