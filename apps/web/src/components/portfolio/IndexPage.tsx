/**
 * One index's page (owner 2026-11-28: "pages for every custom index with historical performance as long as possible
 * into the history, + consitutents and allocation chart. Supported buy modes one-time, recuring").
 *
 *   history       the buy-and-hold basket from SoDEX's own daily closes of every leg, as far back as SoDEX has them
 *                 (price-history range=All: QQQ from 1999), starting on the first day every leg has one; a leg SoDEX
 *                 keeps no closes for (USDC Earn) is left out of the line and said so
 *   constituents  each fund with its weight, price, returns and how it trades now, each opening its fund page
 *   allocation    the weights as a ring and a list
 *   buy           once or on a schedule (IndexBuy.tsx), beside it
 *   yours         a draft or the wallet's published index: edit, publish or update, take down, delete
 */
import { useMemo, useState } from 'react';
import { Button, EmptyState, Panel, Segmented, Shell, ShellHeader, Skeleton, StatusPill } from '../bots/kit/kit';
import { openConnectDialog } from '../account/connect';
import { fmtUsd } from '../../format';
import { openPath } from '../../nav';
import {
  annualised, basketApy, basketHistory, changeOver, dropDraft, kindOf, maxDrawdown, minimumFor, rangeOf, saveDraft, type VdIndex,
} from '../../trading/vdIndexes';
import { INDEX_PUBLISHING, publishIndex, unpublishIndex } from '../../trading/vdIndexApi';
import { isUserRejection, type Eip1193Provider } from '../../wallet';
import { useNow } from '../sodex/parts';
import { pctText, useFundViews, val, type FundView } from '../sodex/wealth/data';
import { closedLine, resumingIn } from '../../trading/wealth';
import { ChannelPill, FundMark, PriceChart, Signed } from '../sodex/wealth/parts';
import { AllocRing, BuyMethods, IndexBy, IndexCover, IndexMarks, fundNameOf, legColor, pct, thin, tone, useIndex, useLegCloses, useMinimums, yieldOnlyIndex } from './indexParts';
import { IndexHoldings } from './IndexHoldings';
import { pictureFromDataUrl } from '../../trading/indexPicture';
import { useFundActions, useRecurringTargets } from './IndexBuy';
import { IndexTicket } from './IndexTicket';
import { Yours, useBuys } from './VdIndexes';
import { WEALTH_PATH } from './wealthRoute';
import type { WealthState } from './useWealth';

type Range = '1M' | '3M' | '1Y' | '5Y' | 'All';
const RANGES: ReadonlyArray<{ value: Range; label: string; days: number | null }> = [
  { value: '1M', label: '1M', days: 30 }, { value: '3M', label: '3M', days: 91 }, { value: '1Y', label: '1Y', days: 365 },
  { value: '5Y', label: '5Y', days: 1826 }, { value: 'All', label: 'All', days: null },
];
const dateLong = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function Crumbs({ items }: { items: ReadonlyArray<readonly [string, string | null]> }) {
  return (
    <nav className="wp-crumbs" aria-label="Breadcrumb">
      {items.map(([label, href], i) => (
        <span key={i}>
          {href ? <a href={href} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); openPath(href); } }}>{label}</a> : <b aria-current="page">{label}</b>}
        </span>
      ))}
    </nav>
  );
}

export function IndexPage({ id, w, address, provider, onDone, onOpenMarket }: {
  id: string; w: WealthState; address: string | null; provider: Eip1193Provider | null; onDone: () => void; onOpenMarket: (symbol: string, engine: 'spot') => void;
}) {
  const { ix, error } = useIndex(id);
  if (ix === undefined) {
    return (
      <div className="wp-page">
        <Crumbs items={[['Wealth', WEALTH_PATH.home], ['Indexes', WEALTH_PATH.indexes], ['Reading', null]]} />
        <Skeleton className="wp-bone wp-bone--hero" />
        <Skeleton className="wp-bone wp-bone--chart" />
      </div>
    );
  }
  if (!ix) {
    return (
      <div className="wp-page">
        <Crumbs items={[['Wealth', WEALTH_PATH.home], ['Indexes', WEALTH_PATH.indexes], ['Not found', null]]} />
        <EmptyState
          icon="search"
          tone={error ? 'error' : undefined}
          title={error ? 'This index did not load' : 'No index here'}
          description={error ?? 'It was taken down, or the link is not one of ours. Drafts live in the browser that made them.'}
          actions={<Button variant="secondary" onClick={() => openPath(WEALTH_PATH.indexes)}>All indexes</Button>}
        />
      </div>
    );
  }
  return <IndexView key={ix.id} ix={ix} w={w} address={address} provider={provider} onDone={onDone} onOpenMarket={onOpenMarket} />;
}

function IndexView({ ix, w, address, provider, onDone, onOpenMarket }: {
  ix: VdIndex; w: WealthState; address: string | null; provider: Eip1193Provider | null; onDone: () => void; onOpenMarket: (symbol: string, engine: 'spot') => void;
}) {
  const ids = useMemo(() => ix.legs.map((l) => l.fundId), [ix]);
  const { closes, error } = useLegCloses(ids, w.funds, 'All');
  const hist = useMemo(() => (closes ? basketHistory(ix, closes) : null), [closes, ix]);
  const [range, setRange] = useState<Range>('All');
  const shown = useMemo(() => (hist ? rangeOf(hist.series, RANGES.find((r) => r.value === range)!.days) : null), [hist, range]);
  const views = useFundViews(w);
  const now = useNow(15_000);
  const mins = useMinimums(w.funds, ids);
  const targets = useRecurringTargets(w.funds);
  const actions = useFundActions(w.funds);
  const buys = useBuys(address);
  const [focus, setFocus] = useState<string | null>(null);
  const me = address?.toLowerCase() ?? null;
  const kind = kindOf(ix);
  const ownPublished = kind === 'published' && !!me && ix.owner === me;
  const apy = yieldOnlyIndex(ix, w.funds) ? basketApy(ix, w.quotes) : null;
  const series = hist?.series ?? null;
  const total = series ? series[series.length - 1]!.v / series[0]!.v - 1 : null;
  const cagr = annualised(series);
  const y1 = changeOver(series, 365);
  const dd = maxDrawdown(series);
  const winChange = shown && shown.length > 1 ? shown[shown.length - 1]!.v - 1 : null;
  const min = minimumFor(ix, mins);
  const recurringOk = targets ? ix.legs.every((l) => targets.some((t) => t.fund.fundId === l.fundId)) : null;

  return (
    <div className="wp-page">
      <Crumbs items={[['Wealth', WEALTH_PATH.home], ['Indexes', WEALTH_PATH.indexes], [ix.name, null]]} />
      <header className="wp-hero">
        <div className="wp-hero__t">
          <div className="wp-hero__id">
            <IndexCover ix={ix} size={76} />
            <div className="wp-hero__idt">
              <div className="wp-hero__k"><IndexBy ix={ix} me={me} /><IndexMarks ix={ix} funds={w.funds} size={24} max={8} /></div>
              <h1>{ix.name}</h1>
            </div>
          </div>
          {ix.line && <p>{ix.line}</p>}
          <Owner ix={ix} own={kind === 'draft' || ownPublished} address={address} provider={provider} />
        </div>
        <dl className="wp-hero__figs">
          <div><dt>{series ? `Since ${dateLong(series[0]!.t)}` : 'Since the start'}</dt><dd className={tone(total)}>{series ? pct(total, 1) : closes ? '—' : <Skeleton className="wp-bone" />}</dd>{cagr !== null && <small>{`${pct(cagr, 1)} a year`}</small>}</div>
          <div><dt>1 year</dt><dd className={tone(y1)}>{closes ? pct(y1) : <Skeleton className="wp-bone" />}</dd></div>
          <div><dt>Deepest fall</dt><dd className={tone(dd)}>{closes ? pct(dd, 1) : <Skeleton className="wp-bone" />}</dd><small>From a high, closing prices</small></div>
          {apy !== null && <div><dt>Yield now</dt><dd className="pos">{`${apy.toFixed(2)}%`}</dd><small>7-day APY, by weight</small></div>}
        </dl>
      </header>

      <div className="wp-main">
        <div className="wp-main__l">
          <Shell className="wp-sec">
            <ShellHeader
              title="Performance"
              subtitle={hist ? `Bought and held from ${dateLong(hist.series[0]!.t)}, SoDEX’s daily closes. Not a forecast.` : 'SoDEX’s daily closes of every fund'}
              aside={<Segmented size="sm" label="Range" value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r.value, label: r.label }))} />}
            />
            <Panel className="wp-sec__p">
              {shown && shown.length > 1 ? (
                <>
                  <div className="wp-perf__chg">
                    <Signed v={winChange}><b>{pct(winChange)}</b></Signed>
                    <span>{`${dateLong(shown[0]!.t)} – ${dateLong(shown[shown.length - 1]!.t)}`}</span>
                  </div>
                  <PriceChart points={thin(shown.map((p) => ({ t: p.t, v: p.v * 100 })))} height={300} label={`${ix.name}, 100 at the start`} fmtY={(v, dp) => v.toFixed(dp ?? (v < 1000 ? 1 : 0))} />
                </>
              ) : error ? <EmptyState compact tone="error" icon="warning" title="The history did not load" description={error} />
                : !closes ? <Skeleton className="wp-bone wp-bone--chart" />
                : <EmptyState compact icon="chart" title="No history to draw" description="SoDEX keeps no daily closes for these funds yet." />}
              {hist && hist.leftOut.length > 0 && (
                <p className="wp-note">{`${hist.leftOut.map((fid) => fundNameOf(w.funds, fid)).join(', ')} (${Math.round((1 - hist.share) * 100)}% of the index): no daily price from SoDEX, so left out of the line. The rest is drawn at its own weights.`}</p>
              )}
            </Panel>
          </Shell>

          <IndexConstituents ix={ix} w={w} focus={focus} setFocus={setFocus} />

          <IndexHoldings ix={ix} funds={w.funds} />

          {address && buys.some((b) => b.id === ix.id) && (
            <Shell className="wp-sec">
              <ShellHeader title="Yours" subtitle="What you bought through this index" />
              <Panel className="wp-sec__p"><Yours w={w} buys={buys} all={[ix]} only={ix.id} onOpenMarket={onOpenMarket} /></Panel>
            </Shell>
          )}
        </div>

        <aside className="wp-main__r">
          <Shell className="wp-sec">
            <ShellHeader title="Buy" subtitle={min > 0 ? `Minimum buy ${fmtUsd(min, 0)}${recurringOk === false ? ', once only' : ''}` : 'Once or on a schedule'} />
            <Panel className="wp-sec__p wp-buy-p pf">
              <IndexTicket ix={ix} w={w} address={address} provider={provider} onDone={onDone} />
            </Panel>
          </Shell>
          <Shell className="wp-sec">
            <ShellHeader title="Buy methods" subtitle="What this index can be bought with" />
            <Panel className="wp-sec__p"><BuyMethods ix={ix} funds={w.funds} targets={targets} actions={actions} /></Panel>
          </Shell>
          <Shell className="wp-sec">
            <ShellHeader title="Allocation" subtitle="Weights when bought; they drift with prices" />
            <Panel className="wp-sec__p wp-alloc">
              <AllocRing ix={ix} focus={focus} onFocus={setFocus} />
              <ul className="wp-alloc__list">
                {ix.legs.map((l, i) => (
                  <li key={l.fundId} className={focus && focus !== l.fundId ? 'is-dim' : undefined} onPointerEnter={() => setFocus(l.fundId)} onPointerLeave={() => setFocus(null)}>
                    <i className="wp-dot" style={{ background: legColor(i) }} aria-hidden="true" />
                    <span>{fundNameOf(w.funds, l.fundId)}</span>
                    <b>{`${Math.round(l.weight * 10_000) / 100}%`}</b>
                  </li>
                ))}
              </ul>
            </Panel>
          </Shell>
        </aside>
      </div>
    </div>
  );
}

/** The index's funds with their weights, returns and how each trades now: its page and the builder's review. */
export function IndexConstituents({ ix, w, focus, setFocus }: { ix: VdIndex; w: WealthState; focus: string | null; setFocus: (id: string | null) => void }) {
  const views = useFundViews(w);
  const now = useNow(15_000);
  const targets = useRecurringTargets(w.funds);
  return (
    <Shell className="wp-sec">
      <ShellHeader
        title="Constituents"
        subtitle={`${ix.legs.length} SoDEX Wealth funds, held as bought`}
        aside={<StatusPill size="sm" tone="neutral" icon="layers" title="Weights are fixed when bought and held as bought: nothing rebalances.">Fixed</StatusPill>}
      />
      <Panel className="wp-sec__p wp-legs">
        <div className="wp-legs__h" aria-hidden="true"><span>Fund</span><span>Weight</span><span>1 month</span><span>1 year</span><span>Now</span></div>
        {ix.legs.map((l, i) => {
          const v = views?.find((x) => x.id === l.fundId) ?? null;
          const q = w.quotes.get(l.fundId);
          const m1 = val(q?.roi1M), y = val(q?.roi1Y);
          return (
            <a
              key={l.fundId}
              className={`wp-leg${focus === l.fundId ? ' is-focus' : ''}`}
              href={WEALTH_PATH.fund(l.fundId)}
              onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); openPath(WEALTH_PATH.fund(l.fundId)); } }}
              onPointerEnter={() => setFocus(l.fundId)}
              onPointerLeave={() => setFocus(null)}
            >
              <span className="wp-leg__f">
                <i className="wp-dot" style={{ background: legColor(i) }} aria-hidden="true" />
                {v ? <FundMark v={v} size={30} /> : <Skeleton className="wp-bone wp-bone--mark" />}
                <span><b>{fundNameOf(w.funds, l.fundId)}</b><small>{v ? `${v.ticker} · ${v.shelf}${targets && targets.some((t) => t.fund.fundId === l.fundId) ? ' · Recurring' : ''}` : l.fundId}</small></span>
              </span>
              <span className="wp-leg__w"><b>{`${Math.round(l.weight * 10_000) / 100}%`}</b><i style={{ width: `${l.weight * 100}%`, background: legColor(i) }} aria-hidden="true" /></span>
              <span className="wp-leg__n"><Signed v={m1}>{pctText(m1)}</Signed></span>
              <span className="wp-leg__n"><Signed v={y}>{pctText(y)}</Signed></span>
              <span className="wp-leg__c">
                {v ? <NowPill v={v} now={now} /> : null}
              </span>
            </a>
          );
        })}
      </Panel>
    </Shell>
  );
}

/**
 * How a fund trades now, short enough for a table cell: a paused fund as a clock and the time left (the full words and
 * the reopening time on hover), a coming-soon fund as such, anything else as the fund's own channel pill.
 */
function NowPill({ v, now }: { v: FundView; now: number }) {
  if (v.fund.comingSoon) return <StatusPill tone="brand" size="sm" title={v.fund.comingSoon}>Coming soon</StatusPill>;
  const a = v.action;
  if (a?.kind === 'closed') {
    const left = a.nextAt ? resumingIn(a.nextAt, now)?.replace(/^Resuming in /, '') : null;
    return <StatusPill tone="warning" size="sm" icon="clock" title={closedLine(a.nextAt, now)}>{left ? `Paused · ${left}` : 'Paused'}</StatusPill>;
  }
  return <ChannelPill v={v} now={now} />;
}

/** A draft's or the wallet's own published index: what its maker can do with it. Anyone can make a copy. */
function Owner({ ix, own, address, provider }: { ix: VdIndex; own: boolean; address: string | null; provider: Eip1193Provider | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const kind = kindOf(ix);
  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what);
    setNote(null);
    try { await f(); } catch (e) { if (!isUserRejection(e)) setNote({ text: (e as Error).message, bad: true }); } finally { setBusy(null); }
  };
  const needWallet = (): boolean => {
    if (address && provider) return true;
    openConnectDialog();
    return false;
  };
  const publish = () => run('publish', async () => {
    if (!needWallet()) return;
    const picture = kind === 'draft' && ix.picture ? await pictureFromDataUrl(ix.picture) : kind === 'published' && ix.image ? { hash: ix.image } : null;
    const out = await publishIndex(provider!, address!, kind === 'published' ? ix.id : ix.publishedId ?? '', ix, picture);
    if (kind === 'draft') dropDraft(ix.id);
    openPath(WEALTH_PATH.index(out.id));
  });
  const takeDown = () => run('down', async () => {
    if (!needWallet()) return;
    await unpublishIndex(provider!, address!, ix);
    const copy = saveDraft({ ...ix, id: '', kind: 'draft', publishedId: null, image: null, picture: null });
    openPath(WEALTH_PATH.index(copy.id));
  });
  const remove = () => { dropDraft(ix.id); openPath(WEALTH_PATH.indexes); };
  const copyLink = () => {
    void navigator.clipboard?.writeText(`${window.location.origin}${WEALTH_PATH.index(ix.id)}`).then(() => setNote({ text: 'Link copied.' }), () => setNote({ text: 'Could not copy the link.', bad: true }));
  };
  return (
    <div className="wp-hero__acts">
      {own && <Button size="sm" variant="secondary" icon="pen" onClick={() => openPath(WEALTH_PATH.edit(ix.id))}>Edit</Button>}
      {INDEX_PUBLISHING && kind === 'draft' && <Button size="sm" variant="primary" icon="share" loading={busy === 'publish'} disabled={!!busy} onClick={() => void publish()}>Publish</Button>}
      {kind === 'published' && own && <Button size="sm" variant="secondary" loading={busy === 'down'} disabled={!!busy} onClick={() => void takeDown()}>Take down</Button>}
      {kind === 'draft' && <Button size="sm" variant="quiet" icon="trash" disabled={!!busy} onClick={remove}>{INDEX_PUBLISHING ? 'Delete draft' : 'Delete'}</Button>}
      {kind !== 'draft' && <Button size="sm" variant="quiet" icon="share" onClick={copyLink}>Copy link</Button>}
      <Button size="sm" variant="quiet" icon="layers" onClick={() => openPath(`${WEALTH_PATH.newIndex}?from=${encodeURIComponent(ix.id)}`)}>Make a copy</Button>
      {note && <p className={`wp-hero__note${note.bad ? ' is-bad' : ''}`} role={note.bad ? 'alert' : 'status'}>{note.text}</p>}
      {INDEX_PUBLISHING && kind === 'draft' && !note && <p className="wp-hero__note">Only this browser has this draft. Publishing shows it to everyone, with your wallet as its maker: one free signature, never a transaction.</p>}
    </div>
  );
}
