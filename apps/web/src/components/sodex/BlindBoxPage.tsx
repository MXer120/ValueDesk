/**
 * Blind Boxes (/blind-boxes): SoDEX's programme, in the order of its own page. How boxes are earned, the
 * four tiers with their live reward bands, merging, invites and the weekly draw, then the opens as they
 * happen. Tiers, bands, sizes and limits all come from `/meta`; the few facts `/meta` does not hold
 * (merged boxes are burned, the draw's clock) are quoted from SoDEX's page text.
 *
 * View only: opening and merging stay on SoDEX's page. A wallet's boxes are read off the chain from this
 * browser; what only SoDEX's sign-in can read sits behind SODEX_SIGNIN_LIVE (BoxVault.tsx).
 */
import { useState } from 'react';
import { Card } from '../portfolio/parts';
import { EmptyState } from '../EmptyState';
import { usePolled } from '../explore/cohorts/parts';
import {
  LEVELS, LEVEL_LABEL, bpsToPct, fetchLotteryFeed, fetchLotteryMeta, isLevel, mergeLadder,
  type FeedItem, type Level, type LotteryMeta, type LotteryRules,
} from '../../blindBox';
import { DASH, fmt, fmtUsd } from '../../format';
import { SODEX_SIGNIN_LIVE, SODEX_SITE } from '../../sodexProgrammes';
import type { Eip1193Provider } from '../../wallet';
import { BoxArt } from './BoxArt';
import { OnChainBoxes, OpenOnSodex, ProgressPanel } from './BoxVault';
import { LockedSection, Pill, ProgrammeHero, ProgrammePage, ReadFailed, SegSwitch, SkelRows, SkelTiles, fmtAgo, fmtTokens, useNow } from './parts';

const FEED_SIZE = 40;
const usd0 = (n: number): string => `$${fmt(n, 0)}`;

export function BlindBoxPage({ address }: { address: string | null; provider: Eip1193Provider | null }) {
  const meta = usePolled('lottery-meta', (signal) => fetchLotteryMeta(signal), 60_000);
  const rules = meta.data?.rules ?? null;

  return (
    <ProgrammePage label="Blind Boxes">
      <ProgrammeHero
        title="Blind Boxes"
        line={rules ? `Every ${usd0(rules.volumePerBoxU)} of effective volume earns a box.` : 'Trade to earn boxes, merge them, open them.'}
        aside={<><OpenOnSodex /><a className="pf-btn pf-btn--primary" href="/trade">Trade</a></>}
      />

      {meta.error && !meta.data ? (
        <ReadFailed what="The programme's rules" error={meta.error} onRetry={meta.retry} />
      ) : !rules ? (
        <>
          <SkelTiles />
          <SkelRows rows={2} height={120} />
        </>
      ) : (
        <>
          <Tiers rules={rules} />
          <Earned rules={rules} />
          <Mine address={address} meta={meta.data as LotteryMeta} />
          <div className="sdx-trio">
            <MergeRules rules={rules} />
            <InviteRules rules={rules} />
            <DrawRules />
          </div>
        </>
      )}

      <Feed />
    </ProgrammePage>
  );
}

function Tiers({ rules }: { rules: LotteryRules }) {
  return (
    <section className="sdx-tiers" aria-label="Tiers">
      {LEVELS.map((level) => {
        const band = rules.rewardBands.find((b) => b.level === level);
        const trade = rules.tradeBoxLevels.includes(level);
        return (
          <article key={level} className={`sdx-tier is-${level}`}>
            <header>
              <span className="sdx-tier__name"><i aria-hidden="true" />{LEVEL_LABEL[level]}</span>
              <Pill>{trade ? 'Trade / Invite' : 'Merge / Draw'}</Pill>
            </header>
            <BoxArt level={level} size={84} />
            <div className="sdx-tier__band">
              <span>Reward range</span>
              <b>{band ? `${fmtUsd(band.minUsd, 2)} – ${fmtUsd(band.maxUsd, 2)}` : DASH}</b>
            </div>
          </article>
        );
      })}
    </section>
  );
}

function Earned({ rules }: { rules: LotteryRules }) {
  return (
    <Card title="How boxes are earned">
      <div className="sdx-steps">
        <div className="sdx-step"><b>{usd0(rules.volumePerBoxU)}</b><span>effective volume, one box</span></div>
        <div className="sdx-step"><b>{fmt(bpsToPct(rules.takerWeightBps), 0)}%</b><span>of a taker fill counts</span></div>
        <div className="sdx-step"><b>{fmt(bpsToPct(rules.makerWeightBps), 0)}%</b><span>of a maker fill counts</span></div>
        <div className="sdx-step"><b>{rules.limits.maxBoxOpen ?? DASH}</b><span>boxes can be opened at once</span></div>
      </div>
    </Card>
  );
}

function Mine({ address, meta }: { address: string | null; meta: LotteryMeta }) {
  return (
    <>
      <OnChainBoxes address={address} box={meta.contracts?.treasureBox} />
      {SODEX_SIGNIN_LIVE ? <ProgressPanel address={address} /> : (
        <LockedSection
          title="Your progress"
          items={['Effective volume and the next box', 'Boxes waiting to be claimed', 'Draw tickets and history']}
          href={SODEX_SITE.blindBox}
          hrefLabel="Open on SoDEX"
        />
      )}
    </>
  );
}

function MergeRules({ rules }: { rules: LotteryRules }) {
  const ladder = mergeLadder(rules);
  return (
    <Card title="Merge">
      <ul className="sdx-merge">
        {ladder.map((s) => (
          <li key={s.from}>
            <span className="sdx-merge__from"><BoxArt level={s.from} size={28} /><b>{s.consume}</b> {LEVEL_LABEL[s.from]}</span>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8h9M9 4.500 12.500 8 9 11.500" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span className="sdx-merge__to"><BoxArt level={s.to} size={28} /><b>1</b> {LEVEL_LABEL[s.to]}</span>
          </li>
        ))}
      </ul>
      <p className="pf-note">Only unopened boxes can merge, and those used are burned.</p>
    </Card>
  );
}

const BENEFICIARY: Record<string, string> = { self: 'They get', inviter: 'You get' };

function InviteRules({ rules }: { rules: LotteryRules }) {
  return (
    <Card title="Invite">
      <ul className="sdx-invite">
        {rules.milestones.map((m) => (
          <li key={`${m.thresholdU}:${m.beneficiary}`}>
            <span>Friend trades {usd0(m.thresholdU)}</span>
            <b>
              {BENEFICIARY[m.beneficiary] ?? m.beneficiary} 1 {isLevel(m.level) ? LEVEL_LABEL[m.level] : m.level}
            </b>
          </li>
        ))}
      </ul>
      {rules.newcomerMaxUAtBound != null && (
        <p className="pf-note">The friend's own volume must be under {usd0(rules.newcomerMaxUAtBound)} when they bind.</p>
      )}
    </Card>
  );
}

function DrawRules() {
  return (
    <Card title="Weekly draw">
      <ul className="sdx-invite">
        <li><span>Snapshot</span><b>Tue 13:00 UTC+2</b></li>
        <li><span>Draw</span><b>Wed 13:00 UTC+2</b></li>
        <li><span>Tickets</span><b>Unopened boxes</b></li>
      </ul>
      <p className="pf-note">Keep boxes unopened through the snapshot for them to count.</p>
    </Card>
  );
}

type FeedFilter = 'all' | 'Uncommon' | 'Rare';
const FILTERS: ReadonlyArray<{ v: FeedFilter; label: string }> = [
  { v: 'all', label: 'All' },
  { v: 'Uncommon', label: 'Uncommon +' },
  { v: 'Rare', label: 'Rare +' },
];

const atLeast = (level: string, min: Level): boolean => isLevel(level) && LEVELS.indexOf(level) >= LEVELS.indexOf(min);

function Feed() {
  const feed = usePolled('lottery-feed', (signal) => fetchLotteryFeed(FEED_SIZE, signal), 15_000);
  const [filter, setFilter] = useState<FeedFilter>('all');
  const now = useNow(30_000);
  const all = feed.data?.items ?? [];
  const rows = filter === 'all' ? all : all.filter((i) => atLeast(i.level, filter));
  return (
    <Card title="Live opens" action={<SegSwitch value={filter} options={FILTERS} onChange={setFilter} label="Tier" />}>
      {feed.error && !feed.data ? (
        <ReadFailed what="The feed" error={feed.error} onRetry={feed.retry} />
      ) : !feed.data ? (
        <SkelRows rows={6} height={44} />
      ) : rows.length === 0 ? (
        <EmptyState icon="history" title="Nothing here yet" line="No box of this tier among the latest opens." compact />
      ) : (
        <ul className="sdx-feed">
          {rows.map((i) => <FeedRow key={`${i.tokenId}:${i.tsMs}`} item={i} now={now} />)}
        </ul>
      )}
    </Card>
  );
}

function FeedRow({ item, now }: { item: FeedItem; now: number }) {
  const amount = item.reward?.amount;
  const symbol = item.reward?.asset?.symbol;
  return (
    <li className="sdx-feed__row">
      <BoxArt level={item.level} size={30} />
      <div className="sdx-feed__who">
        <b>{item.wallet}</b>
        <small>{isLevel(item.level) ? LEVEL_LABEL[item.level] : item.level} · #{item.tokenId}</small>
      </div>
      {item.pfp && <Pill tone="info">PFP</Pill>}
      <div className="sdx-feed__prize">
        <b>{item.rewardUsd ? fmtUsd(item.rewardUsd, 2) : DASH}</b>
        <small>{amount && symbol ? `${fmtTokens(amount)} ${symbol}` : DASH}</small>
      </div>
      <span className="sdx-feed__ago">{Number.isFinite(item.tsMs) ? fmtAgo(item.tsMs, now) : DASH}</span>
    </li>
  );
}
