/**
 * Making an index (owner 2026-11-28: "create your own with a big plus. You can select everything ... full functionality
 * of everything thats possible which users could create"): any of SoDEX's Wealth funds, two to twelve, each with its
 * weight in hundredths of a percent; the rules are the server's own (@sign/indexes/claim), checked as you type. Beside
 * it, the index as it would be: its allocation, its history from SoDEX's closes, what it costs at least, and whether
 * it can be bought on a schedule. Saved in this browser as a draft, or published for everyone with one free signature.
 * Editing a published index publishes it again under the same id.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, EmptyState, Field, IconButton, NumberField, Panel, Segmented, SearchField, SegmentedBar, Shell, ShellHeader, Skeleton, Slider, StatusPill, TextInput,
} from '../bots/kit/kit';
import { applyForBeta, useBetaAccessState } from '../../beta/access';
import { openConnectDialog } from '../account/connect';
import { fmtUsd } from '../../format';
import { openPath, pageScroller } from '../../nav';
import {
  INDEX_DESC_MAX, INDEX_LEG_MIN_BP, INDEX_LEGS_MAX, INDEX_NAME_MAX, indexProblem, indexProblemText, tidyDescription, tidyName,
} from '@sign/indexes/claim';
import { addLeg, cleanWeights, removeLeg, setWeight, annualised, basketHistory, changeOver, dropDraft, equalBp, kindOf, maxDrawdown, minimumFor, notRecurring, saveDraft, type VdIndex } from '../../trading/vdIndexes';
import { INDEX_PUBLISHING, publishIndex } from '../../trading/vdIndexApi';
import type { FundShelf } from '../../trading/wealth';
import { isUserRejection, type Eip1193Provider } from '../../wallet';
import { SHELVES, pctText, useFundViews, val } from '../sodex/wealth/data';
import { FundMark, PriceChart, Signed } from '../sodex/wealth/parts';
import { AllocRing, BuyMethods, IndexCover, fundNameOf, legColor, pct, thin, tone, useIndex, useLegCloses, useMinimums } from './indexParts';
import { PICTURE_ACCEPT, makePicture, pictureFromDataUrl, type Picture } from '../../trading/indexPicture';
import { useFundActions, useRecurringTargets } from './IndexBuy';
import { Crumbs, IndexConstituents } from './IndexPage';
import { IndexHoldings } from './IndexHoldings';
import { WEALTH_PATH } from './wealthRoute';
import type { WealthState } from './useWealth';

interface Leg { fundId: string; bp: number }
type ShelfPick = 'All' | FundShelf;
const SHELF_SHORT: Readonly<Record<FundShelf, string>> = { 'Stable Earn': 'Earn', 'Curated ETF': 'ETFs', Specialty: 'Specialty' };
const fromIx = (ix: VdIndex): Leg[] => ix.legs.map((l) => ({ fundId: l.fundId, bp: Math.round(l.weight * 10_000) }));
const withEqual = (legs: Leg[]): Leg[] => { const e = equalBp(legs.length); return legs.map((l, i) => ({ ...l, bp: e[i]! })); };


/** A broom: clean up the weights. */
const Broom = () => (
  <svg className="wp-broom" viewBox="0 0 20 20" aria-hidden="true"><path d="M13.5 2.5l-4 6.5M6.2 9.2l5.6 3.2M6.2 9.2c-1.4 2.4-3 4.4-3.7 6.8 2.4.1 5.2-.5 7-1.6.9-.6 1.6-1.4 2.3-2" /><path d="M5.2 13.4l1.6.9M7.6 12.2l1.5 1" /></svg>
);

export function IndexBuilder({ editId, fromId, withFund, w, address, provider }: { editId: string | null; fromId: string | null; withFund: string | null; w: WealthState; address: string | null; provider: Eip1193Provider | null }) {
  const src = useIndex(editId ?? fromId ?? '');
  // Early access (owner 2026-11-28: "Make creating indexes access locked for early access whitelisted users"): the beta
  // list (beta/access.ts). Only what the page offers: an index is the user's own funds bought one by one, so there is no
  // server action to lock while publishing is off.
  const access = useBetaAccessState(address);
  if (access !== 'open') {
    return (
      <div className="wp-page">
        <Crumbs items={[['Wealth', WEALTH_PATH.home], ['Indexes', WEALTH_PATH.indexes], ['Create', null]]} />
        {access === 'checking' && address ? <Skeleton className="wp-bone wp-bone--chart" /> : (
          <EmptyState
            icon="star"
            title="Creating indexes is in early access"
            description={address ? 'It is open to wallets on the early-access list for now. Every index on the page can still be bought.' : 'Connect a wallet on the early-access list to create an index.'}
            actions={<>
              <StatusPill size="sm" tone="brand" icon="star">Early access</StatusPill>
              {!address ? <Button variant="primary" onClick={() => openConnectDialog()}>Connect wallet</Button> : <Button variant="primary" onClick={applyForBeta}>Get access</Button>}
              <Button variant="secondary" onClick={() => openPath(WEALTH_PATH.indexes)}>See the indexes</Button>
            </>}
          />
        )}
      </div>
    );
  }
  const base = editId || fromId ? src.ix : null;
  if ((editId || fromId) && base === undefined) {
    return <div className="wp-page"><Crumbs items={[['Wealth', WEALTH_PATH.home], ['Indexes', WEALTH_PATH.indexes], ['Reading', null]]} /><Skeleton className="wp-bone wp-bone--chart" /></div>;
  }
  const me = address?.toLowerCase() ?? null;
  const editable = !!base && editId !== null && (kindOf(base) === 'draft' || (kindOf(base) === 'published' && base.owner === me));
  if (editId && !editable) {
    return (
      <div className="wp-page">
        <Crumbs items={[['Wealth', WEALTH_PATH.home], ['Indexes', WEALTH_PATH.indexes], ['Edit', null]]} />
        <EmptyState
          icon="pen"
          title={base ? 'Only its maker can change this index' : 'No index here'}
          description={base ? (kindOf(base) === 'published' ? 'Connect the wallet that published it, or make a copy of your own.' : 'ValueDesk’s own indexes stay as they are; make a copy to change it.') : 'It was taken down, or it was a draft in another browser.'}
          actions={<>
            {base && kindOf(base) === 'published' && !address && <Button variant="primary" onClick={() => openConnectDialog()}>Connect wallet</Button>}
            {base && <Button variant="secondary" onClick={() => openPath(`${WEALTH_PATH.newIndex}?from=${encodeURIComponent(base.id)}`)}>Make a copy</Button>}
          </>}
        />
      </div>
    );
  }
  return <Builder key={`${editId ?? ''}|${fromId ?? ''}|${withFund ?? ''}|${base?.id ?? ''}`} base={base ?? null} editing={editable} withFund={withFund} w={w} address={address} provider={provider} />;
}

function Builder({ base, editing, withFund, w, address, provider }: { base: VdIndex | null; editing: boolean; withFund: string | null; w: WealthState; address: string | null; provider: Eip1193Provider | null }) {
  const copyName = base && !editing ? `${base.name.replace(/^ValueDesk\s+/i, '')} (copy)`.slice(0, INDEX_NAME_MAX) : '';
  const [name, setName] = useState(editing ? base!.name : copyName);
  const [line, setLine] = useState(base ? base.line : '');
  // From a fund page's "Make an index with it": that fund first.
  const [legs, setLegs] = useState<Leg[]>(base ? fromIx(base) : withFund ? [{ fundId: withFund, bp: 10_000 }] : []);
  const [q, setQ] = useState('');
  const [shelf, setShelf] = useState<ShelfPick>('All');
  const [busy, setBusy] = useState<'save' | 'publish' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The picture: a new one made here, the published one kept by its hash, a draft's own, or none (the drawn default).
  const [picture, setPicture] = useState<Picture | null>(null);
  const [keep, setKeep] = useState<{ hash: string | null; dataUrl: string | null }>({ hash: editing ? base?.image ?? null : null, dataUrl: editing ? base?.picture ?? null : null });
  const [picError, setPicError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const actions = useFundActions(w.funds);
  const views = useFundViews(w);
  const targets = useRecurringTargets(w.funds);
  const kind = base ? kindOf(base) : 'draft';

  const ix: VdIndex = useMemo(() => ({
    id: base?.id ?? 'preview', name, line, legs: legs.map((l) => ({ fundId: l.fundId, weight: l.bp / 10_000 })),
    image: picture ? null : keep.hash, picture: picture?.dataUrl ?? keep.dataUrl,
  }), [base, name, line, legs, picture, keep]);
  const pick = async (f: File | undefined) => {
    setPicError(null);
    if (!f) return;
    const r = await makePicture(f);
    if (r.ok) setPicture(r.picture); else setPicError(r.error);
  };
  const dropPicture = () => { setPicture(null); setKeep({ hash: null, dataUrl: null }); setPicError(null); };
  const ids = useMemo(() => legs.map((l) => l.fundId), [legs]);
  const { closes } = useLegCloses(ids, w.funds, 'All');
  const mins = useMinimums(w.funds, ids);
  const sum = legs.reduce((s, l) => s + l.bp, 0);
  const hist = useMemo(() => (closes && sum === 10_000 ? basketHistory(ix, closes) : null), [closes, ix, sum]);
  const problemCode = indexProblem({ name: tidyName(name), description: tidyDescription(line), legs });
  const problem = problemCode ? indexProblemText(problemCode) : null;
  const blocked = targets && legs.length ? notRecurring(ix, targets) : [];
  const min = sum === 10_000 ? minimumFor(ix, mins) : 0;
  const series = hist?.series ?? null;

  useEffect(() => { setError(null); }, [name, line, legs]);

  // One weight moves the others; the total stays 100% (vdIndexes.ts setWeight / addLeg / removeLeg).
  const toggle = (fundId: string) => setLegs((cur) => (cur.some((l) => l.fundId === fundId) ? removeLeg(cur, fundId) : cur.length >= INDEX_LEGS_MAX ? cur : addLeg(cur, fundId, INDEX_LEG_MIN_BP)));
  const setBp = (fundId: string, bp: number) => setLegs((cur) => setWeight(cur, fundId, bp, INDEX_LEG_MIN_BP));
  // Errors show once Create was pressed, at the field: the page scrolls to the first and marks it.
  const [tried, setTried] = useState(false);
  // Details & Review (owner 2026-11-28): the index as it will be, all its funds and what they hold, before it is made.
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [focus, setFocus] = useState<string | null>(null);
  const toTop = () => { pageScroller()?.scrollTo({ top: 0 }); };
  const field: 'name' | 'line' | 'funds' | 'weights' | null = !problemCode ? null
    : problemCode.startsWith('name') ? 'name' : problemCode.startsWith('desc') ? 'line'
    : problemCode === 'legs-few' || problemCode === 'legs-many' || problemCode === 'leg-fund' || problemCode === 'leg-twice' ? 'funds' : 'weights';
  const refs = { name: useRef<HTMLDivElement>(null), line: useRef<HTMLDivElement>(null), funds: useRef<HTMLElement>(null), weights: useRef<HTMLElement>(null) };
  const show = (k: NonNullable<typeof field>) => (tried && field === k ? problem : null);
  const blocked2 = (): boolean => {
    if (!problem || !field) return false;
    setTried(true);
    const el = refs[field].current;
    // The page scroller only: scrollIntoView would also move the app's frame around it.
    const sc = pageScroller();
    if (el && sc) sc.scrollTo({ top: sc.scrollTop + el.getBoundingClientRect().top - sc.getBoundingClientRect().top - sc.clientHeight / 3, behavior: 'smooth' });
    el?.querySelector<HTMLElement>('input, textarea, button')?.focus({ preventScroll: true });
    return true;
  };

  const review = () => { if (blocked2()) return; setStep('review'); toTop(); };
  const save = () => {
    if (blocked2()) return;
    const kept = saveDraft({ id: kind === 'draft' && base ? base.id : '', name: tidyName(name), line: tidyDescription(line), legs: ix.legs, kind: 'draft', createdAt: base?.createdAt, publishedId: null, picture: picture?.dataUrl ?? keep.dataUrl });
    openPath(WEALTH_PATH.index(kept.id));
  };
  const publish = async () => {
    if (blocked2()) return;
    if (!address || !provider) { openConnectDialog(); return; }
    setBusy('publish');
    setError(null);
    try {
      const pic = picture ?? (keep.dataUrl ? await pictureFromDataUrl(keep.dataUrl) : keep.hash ? { hash: keep.hash } : null);
      const out = await publishIndex(provider, address, kind === 'published' && editing ? base!.id : '', { name: tidyName(name), line: tidyDescription(line), legs: ix.legs }, pic);
      if (editing && kind === 'draft' && base) dropDraft(base.id);
      openPath(WEALTH_PATH.index(out.id));
    } catch (e) {
      if (!isUserRejection(e)) setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const rows = (views ?? []).filter((v) => (shelf === 'All' || v.shelf === shelf) && (!q.trim() || `${v.name} ${v.ticker} ${v.id}`.toLowerCase().includes(q.trim().toLowerCase())));
  const title = editing ? `Edit ${base!.name}` : 'Create an index';
  if (step === 'review') {
    const last = series ? series[series.length - 1]!.v - 1 : null;
    return (
      <div className="wp-page wp-build">
        <Crumbs items={[['Wealth', WEALTH_PATH.home], ['Indexes', WEALTH_PATH.indexes], [editing ? 'Edit' : 'Create', null], ['Review', null]]} />
        <header className="wp-hero">
          <div className="wp-hero__t">
            <div className="wp-hero__id">
              <IndexCover ix={ix} size={76} />
              <div className="wp-hero__idt">
                <div className="wp-hero__k"><StatusPill size="sm" tone="neutral">Review</StatusPill></div>
                <h1>{tidyName(name)}</h1>
              </div>
            </div>
            {tidyDescription(line) && <p>{tidyDescription(line)}</p>}
          </div>
          <dl className="wp-hero__figs">
            <div><dt>{series ? `Since ${new Date(series[0]!.t).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}` : 'Since the start'}</dt><dd className={tone(last)}>{series ? pct(last, 1) : '—'}</dd></div>
            <div><dt>1 year</dt><dd className={tone(changeOver(series, 365))}>{pct(changeOver(series, 365))}</dd></div>
            <div><dt>Deepest fall</dt><dd className="neg">{pct(maxDrawdown(series), 1)}</dd></div>
            <div><dt>Minimum buy</dt><dd>{min > 0 ? fmtUsd(min, 0) : '—'}</dd></div>
          </dl>
        </header>
        <div className="wp-main">
          <div className="wp-main__l">
            <IndexConstituents ix={ix} w={w} focus={focus} setFocus={setFocus} />
            <IndexHoldings ix={ix} funds={w.funds} />
          </div>
          <aside className="wp-main__r">
            <Shell className="wp-sec">
              <ShellHeader title="Make it" subtitle={editing ? 'Save the changes, or go back' : 'Create it now; publishing comes later'} />
              <Panel className="wp-sec__p wp-review">
                <dl className="wp-kv wp-review__kv">
                  <div><dt>Minimum buy</dt><dd>{min > 0 ? fmtUsd(min, 0) : '—'}</dd></div>
                  <div><dt>Buy</dt><dd>{blocked.length ? 'Once' : 'Once or on a schedule'}</dd></div>
                </dl>
                <div className="wp-review__opt">
                  <span><b>Create</b><small>Yours, on its own page, to buy once or on a schedule.</small></span>
                  <Button variant="primary" size="md" disabled={!!busy} onClick={save}>{editing ? 'Save changes' : 'Create index'}</Button>
                </div>
                <div className={`wp-review__opt${INDEX_PUBLISHING ? '' : ' is-off'}`}>
                  <span><b>Publish{!INDEX_PUBLISHING && <StatusPill size="sm" tone="brand">Coming soon</StatusPill>}</b><small>Shown to everyone, with your wallet as its maker.</small></span>
                  <Button variant="secondary" size="md" loading={busy === 'publish'} disabled={!INDEX_PUBLISHING || !!busy} onClick={() => void publish()}>{kind === 'published' && editing ? 'Publish the change' : 'Publish'}</Button>
                </div>
                {error && <p className="wp-note is-bad" role="alert">{error}</p>}
                <Button variant="quiet" size="md" icon="arrowLeft" onClick={() => { setStep('edit'); toTop(); }}>Back to edit</Button>
              </Panel>
            </Shell>
            <Shell className="wp-sec">
              <ShellHeader title="Allocation" subtitle="Weights when bought; they drift with prices" />
              <Panel className="wp-sec__p wp-alloc">
                <AllocRing ix={ix} focus={focus} onFocus={setFocus} />
                <ul className="wp-alloc__list">
                  {legs.map((l, i) => <li key={l.fundId} className={focus && focus !== l.fundId ? 'is-dim' : undefined}><i className="wp-dot" style={{ background: legColor(i) }} aria-hidden="true" /><span>{fundNameOf(w.funds, l.fundId)}</span><b>{`${(l.bp / 100).toFixed(2)}%`}</b></li>)}
                </ul>
              </Panel>
            </Shell>
            <Shell className="wp-sec">
              <ShellHeader title="Buy methods" subtitle={blocked.length ? 'Once only: some funds have no recurring buys' : 'Once or on a schedule'} />
              <Panel className="wp-sec__p"><BuyMethods ix={ix} funds={w.funds} targets={targets} actions={actions} /></Panel>
            </Shell>
          </aside>
        </div>
      </div>
    );
  }
  return (
    <div className="wp-page wp-build">
      <Crumbs items={[['Wealth', WEALTH_PATH.home], ['Indexes', WEALTH_PATH.indexes], [editing ? 'Edit' : 'Create', null]]} />
      <header className="wp-hero wp-hero--build">
        <div className="wp-hero__t">
          <h1>{title}</h1>
          <p>Pick any SoDEX Wealth funds and their weights. Each is bought as the fund itself, at the weights you set, and held as bought: nothing rebalances.</p>
        </div>
      </header>
      <div className="wp-main">
        <div className="wp-main__l">
          <Shell className="wp-sec">
            <ShellHeader title="About this index" subtitle={kind === 'published' && editing ? 'Saving publishes the change' : 'Shown on its card and its page'} />
            <Panel className="wp-sec__p wp-form">
              <div className="wp-pic">
                <IndexCover ix={ix} size={84} />
                <div className="wp-pic__t">
                  <b>Picture</b>
                  <span>{picture || keep.hash || keep.dataUrl ? 'Your picture, cropped to a square.' : 'Drawn from its funds until you add one.'}</span>
                  <span className="wp-row-acts">
                    <Button size="sm" variant="secondary" icon="plus" onClick={() => fileRef.current?.click()}>{picture || keep.hash || keep.dataUrl ? 'Change' : 'Upload'}</Button>
                    {(picture || keep.hash || keep.dataUrl) && <Button size="sm" variant="quiet" icon="x" onClick={dropPicture}>Use the default</Button>}
                  </span>
                  <small>PNG, JPEG or WebP. Redrawn in your browser as a 256 px square; nothing else in the file is kept.</small>
                  {picError && <small className="wp-note is-bad" role="alert">{picError}</small>}
                </div>
                <input ref={fileRef} type="file" accept={PICTURE_ACCEPT} hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
              </div>
              <div ref={refs.name}><Field label="Name" htmlFor="wp-name" error={show('name')}>
                <TextInput id="wp-name" aria-invalid={show('name') ? true : undefined} value={name} maxLength={INDEX_NAME_MAX + 10} onChange={(e) => setName(e.target.value)} placeholder="Chips and cash" autoComplete="off" />
              </Field></div>
              <div ref={refs.line}><Field label="What it is" htmlFor="wp-line" error={show('line')} description={`${[...tidyDescription(line)].length} / ${INDEX_DESC_MAX}`}>
                <textarea id="wp-line" className="tf-input wp-textarea" rows={3} value={line} onChange={(e) => setLine(e.target.value)} placeholder="One or two lines on the idea behind it." />
              </Field></div>
            </Panel>
          </Shell>

          <Shell className={`wp-sec${show('funds') ? ' is-bad' : ''}`} ref={refs.funds}>
            <ShellHeader
              title="Funds"
              subtitle={`${legs.length} of at most ${INDEX_LEGS_MAX} picked`}
              aside={<Segmented size="sm" label="Shelf" value={shelf} onChange={setShelf} options={[{ value: 'All', label: 'All' }, ...SHELVES.map((s) => ({ value: s, label: SHELF_SHORT[s] }))]} />}
            />
            <Panel className="wp-sec__p">
              {show('funds') && <p className="wp-err" role="alert">{show('funds')}</p>}
              <SearchField value={q} onChange={setQ} placeholder="Search funds" label="Search funds" className="wp-search" />
              <div className="wp-pick">
                {!views ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="wp-bone wp-bone--row" />) : rows.map((v) => {
                  const on = legs.some((l) => l.fundId === v.id);
                  const y = val(v.quote?.roi1Y);
                  const rec = targets?.some((t) => t.fund.fundId === v.id);
                  return (
                    <button key={v.id} type="button" className={`wp-pick__row${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => toggle(v.id)} disabled={!on && legs.length >= INDEX_LEGS_MAX}>
                      <FundMark v={v} size={30} />
                      <span className="wp-pick__t"><b>{v.name}</b><small>{`${v.ticker} · ${v.shelf}${rec ? ' · Recurring' : ''}`}</small></span>
                      <span className="wp-pick__n">{y !== null ? <Signed v={y}>{pctText(y)}</Signed> : v.head.kind === 'apy' ? <span className="pos">{pctText(v.head.value, false)}</span> : '—'}<small>{y !== null ? '1 year' : v.head.short}</small></span>
                      <span className={`wp-pick__box${on ? ' is-on' : ''}`} aria-hidden="true">{on ? <svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" /></svg> : <svg viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9" /></svg>}</span>
                    </button>
                  );
                })}
              </div>
            </Panel>
          </Shell>

          <Shell className={`wp-sec${show('weights') ? ' is-bad' : ''}`} ref={refs.weights}>
            <ShellHeader
              title="Weights"
              subtitle="Moving one moves the others; always 100%"
              aside={<span className="wp-row-acts">
                <Button size="sm" variant="secondary" disabled={legs.length < 2} onClick={() => setLegs((c) => withEqual(c))}>Equal</Button>
                <Button size="sm" variant="secondary" disabled={legs.length < 2} onClick={() => setLegs((c) => cleanWeights(c, 0.03, INDEX_LEG_MIN_BP))} title="Round each weight to the cleanest step it allows"><Broom />Clean up</Button>
              </span>}
            />
            <Panel className="wp-sec__p">
              {legs.length ? (
                <>
                  <SegmentedBar size="md" max={Math.max(10_000, sum)} label="Weights" segments={legs.map((l, i) => ({ id: l.fundId, value: l.bp, label: fundNameOf(w.funds, l.fundId), color: legColor(i) }))} />
                  <ul className="wp-weights">
                    {legs.map((l, i) => {
                      const v = views?.find((x) => x.id === l.fundId);
                      return (
                        <li key={l.fundId}>
                          <i className="wp-dot" style={{ background: legColor(i) }} aria-hidden="true" />
                          {v && <FundMark v={v} size={26} />}
                          <span className="wp-weights__n">{fundNameOf(w.funds, l.fundId)}</span>
                          <Slider value={l.bp / 100} min={0} max={100} step={0.1} label={`Weight of ${fundNameOf(w.funds, l.fundId)}`} onChange={(v2) => setBp(l.fundId, v2 * 100)} className="wp-weights__s" />
                          <NumberField hideLabel label={`Weight of ${fundNameOf(w.funds, l.fundId)}, percent`} value={l.bp / 100} unit="%" onChange={(v2) => setBp(l.fundId, (v2 ?? 0) * 100)} className="wp-weights__f" />
                          <IconButton icon="x" label={`Remove ${fundNameOf(w.funds, l.fundId)}`} onClick={() => toggle(l.fundId)} />
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : <EmptyState compact icon="layers" title="No funds yet" description="Pick two or more funds above." />}
            </Panel>
          </Shell>
        </div>

        <aside className="wp-main__r">
          <Shell className="wp-sec">
            <ShellHeader title="Preview" subtitle={tidyName(name) || 'Your index'} />
            <Panel className="wp-sec__p wp-preview">
              {legs.length ? (
                <>
                  <div className="wp-alloc">
                    <AllocRing ix={ix} size={132} />
                    <ul className="wp-alloc__list">
                      {legs.map((l, i) => <li key={l.fundId}><i className="wp-dot" style={{ background: legColor(i) }} aria-hidden="true" /><span>{fundNameOf(w.funds, l.fundId)}</span><b>{`${(l.bp / 100).toFixed(2)}%`}</b></li>)}
                    </ul>
                  </div>
                  {series && series.length > 1 ? (
                    <>
                      <PriceChart points={thin(series.map((p) => ({ t: p.t, v: p.v * 100 })), 500)} height={170} label="Your index, 100 at the start" fmtY={(v, dp) => v.toFixed(dp ?? 0)} />
                      <dl className="wp-kv">
                        <div><dt>{`Since ${new Date(series[0]!.t).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`}</dt><dd className={tone(series[series.length - 1]!.v - 1)}>{pct(series[series.length - 1]!.v - 1, 1)}</dd></div>
                        <div><dt>A year, on average</dt><dd className={tone(annualised(series))}>{pct(annualised(series), 1)}</dd></div>
                        <div><dt>1 year</dt><dd className={tone(changeOver(series, 365))}>{pct(changeOver(series, 365))}</dd></div>
                        <div><dt>Deepest fall</dt><dd className="neg">{pct(maxDrawdown(series), 1)}</dd></div>
                      </dl>
                      {hist!.leftOut.length > 0 && <p className="wp-note">{`${hist!.leftOut.map((fid) => fundNameOf(w.funds, fid)).join(', ')}: no daily price from SoDEX, left out of the line.`}</p>}
                    </>
                  ) : sum !== 10_000 ? <p className="wp-note">The history shows once the weights add up to 100%.</p>
                    : !closes ? <Skeleton className="wp-bone wp-bone--chart" />
                    : <p className="wp-note">No daily prices from SoDEX for these funds.</p>}
                  <dl className="wp-kv">
                    <div><dt>Minimum buy</dt><dd>{min > 0 ? fmtUsd(min, 0) : '—'}</dd></div>
                  </dl>
                  <h3 className="wv-h3 wp-preview__h">Buy methods</h3>
                  <BuyMethods ix={ix} funds={w.funds} targets={targets} actions={actions} />
                </>
              ) : <EmptyState compact icon="chart" title="Nothing to preview" description="The allocation and its history show here as you pick funds." />}
            </Panel>
          </Shell>
          <div className="wp-build__acts">
            {tried && problem && <p className="wp-err" role="alert">{problem}</p>}
            {error && <p className="wp-note is-bad" role="alert">{error}</p>}
            <Button variant="primary" size="md" onClick={review}>Details &amp; Review</Button>
          </div>
        </aside>
      </div>
    </div>
  );
}
