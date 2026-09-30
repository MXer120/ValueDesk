/**
 * Weekly (and 24H / 30D / all-time) trader leaderboard.
 *
 * Everything on screen is upstream's own snapshot, forwarded by the backend
 * proxy without arithmetic: volume and PnL arrive as decimal strings and are
 * only ever formatted, never recomputed. `snapshot_ts` is shown deliberately -
 * the ranking is a periodic snapshot, not a live feed, and a trader comparing it
 * against their own fills needs to know how old it is.
 */
import { useState } from 'react';
import { useAsync, useStored } from '../hooks';
import { fmtDateTime, fmtUsd, shortAddr, signClass } from '../format';
import './Leaderboard.css';
import { LoadFailed, couldntLoad, logLoadFailure, useLoadFailedToast } from './LoadFailed';

/**
 * The four windows the API accepts. Sent verbatim - `window_type` is an enum
 * upstream and anything else is a 400.
 */
const WINDOWS = ['24H', '7D', '30D', 'ALL_TIME'] as const;
type WindowType = (typeof WINDOWS)[number];

const WINDOW_LABELS: Record<WindowType, string> = {
  '24H': '24H',
  '7D': '7D',
  '30D': '30D',
  ALL_TIME: 'All time',
};

type SortBy = 'pnl' | 'volume';
type SortOrder = 'asc' | 'desc';

/**
 * page_size is an ENUM of exactly these three values.
 *
 * Verified against the live API: 25, 100 and 500 each return HTTP 400. So the
 * picker offers no other option - an input that lets the user ask for something
 * the API refuses is just a way to produce an error.
 */
const PAGE_SIZES = [10, 20, 50] as const;

interface Item {
  wallet_address: string;
  account_id: number;
  /** Decimal strings, not numbers. */
  pnl_usd: string;
  volume_usd: string;
  rank: number;
}

interface Page {
  window_type: string;
  page: number;
  page_size: number;
  total: number;
  /** Millisecond epoch of the ranking snapshot. */
  snapshot_ts: number;
  items: Item[];
}

interface RankLookup {
  found: boolean;
  snapshot_ts: number;
  /** Absent when `found` is false - an unranked wallet, which is not an error. */
  item?: Item;
}

/**
 * Local fetch helper.
 *
 * Deliberately inline for now: this component owns no part of api.ts, so it
 * calls the proxy directly and the orchestrator folds these two calls into the
 * typed client. Surfaces the backend's `error` field rather than a bare status
 * code, because that field is where the upstream reason actually lives.
 */
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Malformed response from ${path}`);
  }
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export function Leaderboard({
  address,
  // "Your rank" is correct on the Stats tab, where `address` is always the
  // connected wallet. Scan.tsx reuses this same component to show an
  // ARBITRARY wallet's standing and passes a different subject through here
  // so that case does not print "your" about someone else's wallet.
  subjectLabel = 'Your',
  onScan,
}: {
  address?: string | null;
  subjectLabel?: string;
  /** Every row already carries a real wallet address - the natural entry
   *  point into Scan, unlike the trade tape which only ever has an id.
   *  Optional so this table still renders standalone with no Scan page to
   *  send anything to. */
  onScan?: (address: string) => void;
}) {
  const [windowType, storeWindow] = useStored<WindowType>('ot.lb.window', '7D');
  const [sortBy, storeSortBy] = useStored<SortBy>('ot.lb.sortBy', 'volume');
  const [sortOrder, storeSortOrder] = useStored<SortOrder>('ot.lb.sortOrder', 'desc');
  const [pageSize, storePageSize] = useStored<number>('ot.lb.pageSize', 10);
  const [page, setPage] = useState(1);

  // Any control change invalidates the current page number: page 40 of a
  // volume ranking is not page 40 of a PnL ranking, and silently keeping the
  // offset shows a page of strangers with no explanation.
  const setWindow = (w: WindowType) => { storeWindow(w); setPage(1); };
  const setPageSize = (n: number) => { storePageSize(n); setPage(1); };
  const sortHeader = (col: SortBy) => {
    if (col === sortBy) storeSortOrder(sortOrder === 'desc' ? 'asc' : 'desc');
    else { storeSortBy(col); storeSortOrder('desc'); }
    setPage(1);
  };

  const query = new URLSearchParams({
    window_type: windowType,
    sort_by: sortBy,
    sort_order: sortOrder,
    page: String(page),
    page_size: String(pageSize),
  });
  const { data, error, loading, refresh } = useAsync<Page>(

    () => getJson<Page>(`/api/external/leaderboard?${query}`),
    [windowType, sortBy, sortOrder, pageSize, page],
  );
  useLoadFailedToast(error, 'Leaderboard', refresh);

  // The connected wallet's own standing. A separate endpoint because the wallet
  // is almost never on the page being viewed - there are ~128k ranked accounts.
  const { data: mine, error: mineError } = useAsync<RankLookup>(
    () =>
      getJson<RankLookup>(
        `/api/external/leaderboard/rank?window_type=${windowType}&sort_by=${sortBy}&wallet_address=${address}`,
      ).catch((e: unknown) => {
        logLoadFailure(`${subjectLabel} rank`, e);
        throw e;
      }),
    [address, windowType, sortBy],
    { enabled: !!address },
  );

  const items = data?.items ?? [];
  // The row badge means "this is you" - only true when `address` genuinely IS
  // the connected wallet (the default call site), never when Scan.tsx has
  // reused this component to show a subject that isn't. Tied to the same
  // `subjectLabel` override that already changes the wording above, so a
  // caller passing one gets the other for free rather than needing to keep
  // two props in sync.
  const me = subjectLabel === 'Your' ? address?.toLowerCase() : undefined;
  const lastPage = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const sortArrow = (col: SortBy) => (col === sortBy ? (sortOrder === 'desc' ? ' ↓' : ' ↑') : '');

  return (
    <section className="panel leaderboard">
      <div className="panelhead">
        <h2>Leaderboard</h2>
        {/* Freshness belongs next to the numbers, not buried in a tooltip. */}
        <span className="muted small">
          {data ? `Snapshot ${fmtDateTime(data.snapshot_ts)}` : loading ? 'Loading…' : ''}
        </span>
      </div>

      <div className="lb-controls">
        <div className="segmented">
          {WINDOWS.map((w) => (
            <button
              key={w}
              className={w === windowType ? 'active' : ''}
              onClick={() => setWindow(w)}
              aria-pressed={w === windowType}
            >
              {WINDOW_LABELS[w]}
            </button>
          ))}
        </div>
        <label className="inline lb-size">
          Rows
          <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>

      {address && (
        <p className="lb-you-line small">
          {!mine && mineError ? (
            <span className="muted">{couldntLoad(`${subjectLabel} rank`)}</span>
          ) : !mine ? (
            <span className="muted">Looking up {subjectLabel.toLowerCase()} rank…</span>
          ) : mine.found && mine.item ? (
            <>
              <span className="muted">{subjectLabel} rank</span>{' '}
              <strong>#{mine.item.rank}</strong>{' '}
              <span className="muted">of {data ? data.total.toLocaleString('en-US') : '—'}</span>{' '}
              <span className="muted">· volume</span> {fmtUsd(mine.item.volume_usd, 0)}{' '}
              <span className="muted">· PnL</span>{' '}
              <span className={signClass(mine.item.pnl_usd)}>{fmtUsd(mine.item.pnl_usd)}</span>
            </>
          ) : (
            // Upstream says found:false. That is a real answer - this wallet did
            // not trade in the window - and must not be shown as rank 0.
            <span className="muted">{subjectLabel} wallet is not ranked in this window.</span>
          )}
        </p>
      )}


      <div className="lb-scroll">
        <table className="datatable lb-table">
          <thead>
            <tr>
              <th className="right">#</th>
              <th>Wallet</th>
              <th className="right">Account</th>
              <th className="right sortable" onClick={() => sortHeader('volume')}>
                Volume{sortArrow('volume')}
              </th>
              <th className="right sortable" onClick={() => sortHeader('pnl')}>
                PnL{sortArrow('pnl')}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td className="tablenote muted" colSpan={5}>
                  {loading ? 'Loading…' : error ? <LoadFailed what="Leaderboard" onRetry={refresh} /> : 'No entries.'}
                </td>
              </tr>
            )}
            {items.map((it) => {
              const isMe = !!me && it.wallet_address.toLowerCase() === me;
              return (
                <tr key={`${it.wallet_address}-${it.rank}`} className={isMe ? 'lb-me' : ''}>
                  <td className="right">{it.rank}</td>
                  <td title={it.wallet_address}>
                    {onScan ? (
                      <button type="button" className="lb-scanlink" onClick={() => onScan(it.wallet_address)}>
                        <code>{shortAddr(it.wallet_address)}</code>
                      </button>
                    ) : (
                      <code>{shortAddr(it.wallet_address)}</code>
                    )}
                    {isMe && <span className="badge lb-badge">you</span>}
                  </td>
                  <td className="right">{it.account_id}</td>
                  <td className="right">{fmtUsd(it.volume_usd, 0)}</td>
                  <td className={`right ${signClass(it.pnl_usd)}`}>{fmtUsd(it.pnl_usd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="lb-pager">
        <button disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          Prev
        </button>
        <span className="muted small">
          Page {page.toLocaleString('en-US')} of {lastPage.toLocaleString('en-US')}
          {data ? ` · ${data.total.toLocaleString('en-US')} ranked accounts` : ''}
        </span>
        <button
          // Two independent stops: the computed last page, and a short page,
          // which is what actually happens if `total` and the page contents ever
          // disagree. Whichever fires first is right.
          disabled={loading || page >= lastPage || items.length < pageSize}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </div>
    </section>
  );
}
