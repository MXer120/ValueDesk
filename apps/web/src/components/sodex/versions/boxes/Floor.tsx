/**
 * Blind Boxes, version "Floor": what is being opened right now comes first. One open on the stage (the latest, or the
 * biggest of the latest), the ones before it beside it, and what the latest opens add up to (the feed's opens only: how
 * many, what they paid, the best, the PFP drops, each tier's share). Then every open as a card, the rules in four tiles
 * and the wallet's boxes.
 */
import { useState } from 'react';
import { LOTTERY_FEED_SIZE, bpsToPct, mergeLadder, type FeedItem, type LotteryRules } from '../../../../blindBox';
import { DASH } from '../../../../format';
import { SODEX_SITE } from '../../../../sodexProgrammes';
import { EmptyState, Segmented, SegmentedBar, Skeleton, StatusPill } from '../../../bots/kit/kit';
import { BoxArt } from '../../BoxArt';
import { PFP_DROP } from '../../BlindBoxPage';
import { fmtAgo, fmtTokens, useNow } from '../../parts';
import {
  BoxesCard, DrawRail, LEVELS, MergePlan, OpenFilterSeg, ProgressLocked, RangeChart, ReadError, RewardTokens, atLeast, count, feedStats, levelName, milestoneText, spanText, usd,
  useBoxData, type BoxData, type OpenFilter,
} from './shared';

const TIER_INK: Record<string, string> = { Common: '#b8ae94', Uncommon: '#4aa57d', Rare: '#4c86da', SuperRare: '#9866d6' };

export function BoxFloor({ address, sample }: { address: string | null; sample: boolean }) {
  const d = useBoxData(address, sample);
  const now = useNow(30_000);
  return (
    <div className="tf bots-page rf-page sx sx-boxes">
      <div className="bots-col">
        <Live d={d} now={now} />
        <Cards d={d} now={now} />
        <section className="sx-sec" aria-label="How it works">
          <div className="sx-sec__h"><div><h2>How boxes work</h2><p>SoDEX's rules, as the programme publishes them.</p></div><a className="tf-btn is-secondary is-md" href="/trade">Trade</a></div>
          {d.meta.error && !d.meta.data ? <ReadError what="The programme's rules" error={d.meta.error} retry={d.meta.retry} />
            : d.rules ? <Rules rules={d.rules} /> : <div className="sxb-rules">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="sxb-rules__skel" />)}</div>}
        </section>
        <section className="sx-sec" aria-label="Your boxes">
          <div className="sx-sec__h"><div><h2>Your boxes</h2><p>{d.wallet.sample ? 'Sample data: a made-up wallet.' : 'Read off ValueChain from this browser. Opening and merging stay on SoDEX.'}</p></div></div>
          <div className="sxb-mine">
            <BoxesCard w={d.wallet} />
            <div className="sxb-mine__r">
              {d.rules && d.wallet.state === 'ok' ? <MergePlan w={d.wallet} rules={d.rules} /> : <p className="sxb-note">What your boxes can merge into shows here once they are read.</p>}
              <ProgressLocked />
            </div>
          </div>
        </section>
        {d.rules && (
          <section className="sx-sec" aria-label="Reward ranges">
            <div className="sx-sec__h"><div><h2>Reward ranges</h2><p>Each tier's range, and where the latest opens landed in it.</p></div>{d.meta.data && <RewardTokens meta={d.meta.data} />}</div>
            <div className="sxb-panel"><RangeChart rules={d.rules} opens={d.opens} /></div>
          </section>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------------- the stage ----- */

type Pick = 'latest' | 'best';

function Live({ d, now }: { d: BoxData; now: number }) {
  const [pick, setPick] = useState<Pick>('latest');
  const st = feedStats(d.opens);
  const lead = pick === 'best' ? st.best : d.opens[0] ?? null;
  const rest = d.opens.filter((o) => o !== lead).slice(0, 5);
  return (
    <section className="rf-dark sxb-live" aria-label="Live opens">
      <span className="sxb-stage__ribs" aria-hidden="true" /><span className={`sxb-live__light is-${lead?.level ?? 'Common'}`} aria-hidden="true" />
      <div className="sxb-stage__k">
        <h1>Blind Boxes</h1>
        <StatusPill size="sm" tone="positive" dot pulse>Live opens</StatusPill>
        <div className="sxb-live__pick"><Segmented<Pick> label="Show" value={pick} onChange={setPick} options={[{ value: 'latest', label: 'Latest' }, { value: 'best', label: 'Biggest' }]} /></div>
      </div>
      {d.feed.error && !d.feed.data ? <div className="sxb-live__body"><ReadError what="The opens" error={d.feed.error} retry={d.feed.retry} /></div>
        : !d.feed.data ? <div className="sxb-live__body"><Skeleton className="sxb-live__skel" /></div>
        : !lead ? <div className="sxb-live__body"><EmptyState compact icon="clock" title="No opens yet" description="Opens show here as SoDEX reports them." /></div>
        : (
          <div className="sxb-live__body">
            <Lead item={lead} now={now} pick={pick} />
            <ol className="sxb-live__next" aria-label="Before it">
              {rest.map((o) => (
                <li key={`${o.tokenId}:${o.tsMs}`}>
                  <BoxArt level={o.level} size={34} />
                  <span><b>{o.rewardUsd ? usd(o.rewardUsd) : DASH}</b><small>{levelName(o.level)} · {o.wallet}</small></span>
                  <em>{Number.isFinite(o.tsMs) ? fmtAgo(o.tsMs, now) : DASH}</em>
                </li>
              ))}
            </ol>
          </div>
        )}
      <div className="sxb-live__stats">
        <dl>
          <div><dt>Opens</dt><dd className="sx-num">{d.feed.data ? count(st.n) : DASH}</dd><small>{spanText(st.from, now) || `the latest ${LOTTERY_FEED_SIZE}`}</small></div>
          <div><dt>Paid out</dt><dd className="sx-num">{d.feed.data ? usd(Math.round(st.paid * 100) / 100) : DASH}</dd><small>in USD at the open</small></div>
          <div><dt>Biggest</dt><dd className="sx-num">{st.best?.rewardUsd ? usd(st.best.rewardUsd) : DASH}</dd><small>{st.best ? `${levelName(st.best.level)} · #${st.best.tokenId}` : ''}</small></div>
          <div><dt>PFP drops</dt><dd className="sx-num">{d.feed.data ? count(st.pfp) : DASH}</dd><small>of these opens</small></div>
        </dl>
        {st.n > 0 && (
          <div className="sxb-live__mix">
            <SegmentedBar size="sm" max={st.n} label="Opens by tier" segments={LEVELS.map((l) => ({ id: l, value: st.byLevel[l], label: levelName(l), color: TIER_INK[l]! }))} />
            <ul>{LEVELS.map((l) => <li key={l} className={`is-${l}`}><i aria-hidden="true" />{levelName(l)}<b className="sx-num">{count(st.byLevel[l])}</b></li>)}</ul>
          </div>
        )}
      </div>
    </section>
  );
}

function Lead({ item, now, pick }: { item: FeedItem; now: number; pick: Pick }) {
  const amount = item.reward?.amount;
  const symbol = item.reward?.asset?.symbol;
  return (
    <div className={`sxb-lead is-${item.level}`} key={`${item.tokenId}:${pick}`}>
      <div className="sxb-lead__art"><BoxArt level={item.level} size={196} /></div>
      <div className="sxb-lead__t">
        <span className="sxb-lead__k">{pick === 'best' ? 'Biggest of the latest opens' : 'Latest open'} · {Number.isFinite(item.tsMs) ? fmtAgo(item.tsMs, now) : DASH}</span>
        <b className="sxb-lead__v sx-num">{item.rewardUsd ? usd(item.rewardUsd) : DASH}</b>
        <span className="sxb-lead__tok">{amount && symbol ? `${fmtTokens(amount)} ${symbol}` : DASH}</span>
        <span className="sxb-lead__who"><span className={`sxb-tier is-${item.level}`}><i aria-hidden="true" />{levelName(item.level)}</span><span>#{item.tokenId}</span><span>{item.wallet}</span>{item.pfp && <StatusPill size="sm" tone="brand">PFP</StatusPill>}</span>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------------- the cards ----- */

type Sort = 'latest' | 'biggest';

function Cards({ d, now }: { d: BoxData; now: number }) {
  const [filter, setFilter] = useState<OpenFilter>('all');
  const [sort, setSort] = useState<Sort>('latest');
  const [all, setAll] = useState(false);
  const rows = d.opens.filter((o) => atLeast(o.level, filter));
  const sorted = sort === 'biggest' ? [...rows].sort((a, b) => Number(b.rewardUsd ?? 0) - Number(a.rewardUsd ?? 0)) : rows;
  const shown = all ? sorted : sorted.slice(0, 8);
  return (
    <section className="sx-sec" aria-label="Every open">
      <div className="sx-sec__h">
        <div><h2>Every open</h2><p>The latest {LOTTERY_FEED_SIZE} as SoDEX reports them, every 15 seconds.</p></div>
        <div className="sxb-cards__ctl">
          <OpenFilterSeg value={filter} onChange={(f) => { setFilter(f); setAll(false); }} />
          <Segmented<Sort> label="Order" value={sort} onChange={setSort} options={[{ value: 'latest', label: 'Latest' }, { value: 'biggest', label: 'Biggest' }]} />
        </div>
      </div>
      {d.feed.error && !d.feed.data ? <ReadError what="The opens" error={d.feed.error} retry={d.feed.retry} />
        : !d.feed.data ? <div className="sxb-cards">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="sxb-cards__skel" />)}</div>
        : !rows.length ? <EmptyState compact icon="clock" title="Nothing here yet" description="No box of this tier among the latest opens." />
        : (
          <>
            <ul className="sxb-cards">
              {shown.map((o) => (
                <li key={`${o.tokenId}:${o.tsMs}`} className={`sxb-ocard is-${o.level}`}>
                  <div className="sxb-ocard__top"><span className={`sxb-tier is-${o.level}`}><i aria-hidden="true" />{levelName(o.level)}</span>{o.pfp && <StatusPill size="sm" tone="brand">PFP</StatusPill>}</div>
                  <div className="sxb-ocard__art"><BoxArt level={o.level} size={88} /></div>
                  <b className="sx-num">{o.rewardUsd ? usd(o.rewardUsd) : DASH}</b>
                  <small>{o.reward?.amount && o.reward.asset?.symbol ? `${fmtTokens(o.reward.amount)} ${o.reward.asset.symbol}` : DASH}</small>
                  <div className="sxb-ocard__foot"><span>{o.wallet}</span><span>{Number.isFinite(o.tsMs) ? fmtAgo(o.tsMs, now) : DASH}</span></div>
                </li>
              ))}
            </ul>
            {sorted.length > 8 && <div className="sxb-cards__more"><button type="button" className="rf-text" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${sorted.length}`}</button></div>}
          </>
        )}
    </section>
  );
}

/* ----------------------------------------------------------------------------------- the rules ----- */

function Rules({ rules }: { rules: LotteryRules }) {
  const ladder = mergeLadder(rules);
  return (
    <div className="sxb-rules">
      <article>
        <h3>Earn</h3>
        <div className="sxb-rules__big"><b className="sx-num">{usd(rules.volumePerBoxU)}</b><small>effective volume, 1 box</small></div>
        <ul><li><span>Taker fills count</span><b className="sx-num">{bpsToPct(rules.takerWeightBps)}%</b></li><li><span>Maker fills count</span><b className="sx-num">{bpsToPct(rules.makerWeightBps)}%</b></li></ul>
      </article>
      <article>
        <h3>Invite</h3>
        <ul>{rules.milestones.map((m) => <li key={`${m.thresholdU}:${m.beneficiary}`} className="is-stack"><BoxArt level={m.level} size={26} /><span>Friend trades <b className="sx-num">{usd(m.thresholdU)}</b><small>{milestoneText(m)}</small></span></li>)}</ul>
        {rules.newcomerMaxUAtBound != null && <p>The friend's own volume must be under {usd(rules.newcomerMaxUAtBound)} when they bind.</p>}
      </article>
      <article>
        <h3>Merge</h3>
        <ul>{ladder.map((s) => <li key={s.from}><span className="sxb-rules__merge"><BoxArt level={s.from} size={22} /><b className="sx-num">{s.consume}</b><i aria-hidden="true">→</i><BoxArt level={s.to} size={22} /><b className="sx-num">1</b></span><small>{levelName(s.to)}</small></li>)}</ul>
        <p>Only unopened boxes can merge. The lower-tier boxes used are burned.</p>
      </article>
      <article>
        <h3>Draw</h3>
        <DrawRail />
      </article>
      <article className="rf-dark sxb-rules__pfp">
        <div><h3>{PFP_DROP.title}</h3><p>{PFP_DROP.line}</p><a href={SODEX_SITE.blindBox} target="_blank" rel="noopener noreferrer">Open on SoDEX</a></div>
        <img src="/sodex-art/cyber-cat.webp" alt="" loading="lazy" decoding="async" draggable={false} onError={(e) => { e.currentTarget.hidden = true; }} />
      </article>
    </div>
  );
}
