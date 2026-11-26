/**
 * Blind Boxes (/blind-boxes): SoDEX's programme, view only, in the order of its own page. The boxes first
 * and large, the wallet's own, the PFP drop, how boxes are earned, invites, merging, the weekly draw, then
 * the opens as they happen. Tiers, bands, sizes and thresholds all come from `/meta`; what `/meta` does not
 * hold (burned boxes, the draw's clock, the PFP drop) is SoDEX's page text.
 *
 * Opening and merging stay on SoDEX's page. A wallet's boxes are read off the chain from this browser; what
 * only SoDEX's sign-in can read sits behind SODEX_SIGNIN_LIVE (BoxVault.tsx).
 */
import { Suspense, lazy, useState, type ReactNode } from 'react';
import { CoinIcon } from '../CoinIcon';
import { EmptyState } from '../EmptyState';
import { usePolled } from '../explore/cohorts/parts';
import {
  LEVELS, LEVEL_LABEL, LOTTERY_FEED_SIZE, bpsToPct, fetchLotteryFeed, fetchLotteryMeta, isLevel, mergeLadder,
  type FeedItem, type Level, type LotteryMeta, type LotteryRules,
} from '../../blindBox';
import { DASH } from '../../format';
import { SODEX_SIGNIN_LIVE, SODEX_SITE } from '../../sodexProgrammes';
import type { Eip1193Provider } from '../../wallet';
import { BoxArt } from './BoxArt';
import { OnChainBoxes, OpenOnSodex, ProgressPanel } from './BoxVault';
import { LockedSection, Pill, ProgrammeHero, ProgrammePage, ReadFailed, SegSwitch, SkelRows, SkelTiles, fmtAgo, fmtTokens, fmtUsdTight, useNow } from './parts';

const FEED_SIZE = LOTTERY_FEED_SIZE;

/*
 * Localhost only (owner 2026-11-26): the page's versions behind a switch (versions/boxes/BoxVersions.tsx), Original
 * among them. A build never loads that file: `import.meta.env.DEV` is false there, so the import is dropped and
 * production renders BlindBoxOriginal, today's page, unchanged.
 */
const BoxVersions = import.meta.env.DEV ? lazy(() => import('./versions/boxes/BoxVersions')) : null;

export function BlindBoxPage({ address, provider }: { address: string | null; provider: Eip1193Provider | null }) {
  if (BoxVersions) return <Suspense fallback={null}><BoxVersions address={address} provider={provider} Original={BlindBoxOriginal} /></Suspense>;
  return <BlindBoxOriginal address={address} provider={provider} />;
}

/** Today's page, as it was: the "Original" of the switch, and the only one a build has. */
export function BlindBoxOriginal({ address }: { address: string | null; provider: Eip1193Provider | null }) {
  const meta = usePolled('lottery-meta', (signal) => fetchLotteryMeta(signal), 60_000);
  const rules = meta.data?.rules ?? null;

  return (
    <ProgrammePage label="Blind Boxes">
      <ProgrammeHero
        big
        title="Trade to win Blind Boxes"
        line={rules ? <>Every <b>{fmtUsdTight(rules.volumePerBoxU)}</b> of effective volume wins 1 box.</> : 'Trade to earn boxes, merge them, open them.'}
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
          <Tiers rules={rules} meta={meta.data as LotteryMeta} />
          <Mine address={address} meta={meta.data as LotteryMeta} />
          <PfpDrop />
          <Section title="How boxes are earned"><Earned rules={rules} /></Section>
          <Section title="Invite friends, both get boxes" note={rules.newcomerMaxUAtBound != null ? `The friend's own volume must be under ${fmtUsdTight(rules.newcomerMaxUAtBound)} when they bind.` : undefined}>
            <InviteRules rules={rules} />
          </Section>
          <Section title="Merge to upgrade" note="Only unopened boxes can merge. The lower-tier boxes used are burned.">
            <MergeRules rules={rules} />
          </Section>
          <Section title="Weekly live draw" note="Boxes still unopened at the snapshot count as tickets.">
            <DrawRules />
          </Section>
        </>
      )}

      <Feed />
    </ProgrammePage>
  );
}

function Section({ title, note, action, children }: { title: string; note?: string | undefined; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="sdx-block">
      <header className="sdx-block__head">
        <h2>{title}</h2>
        {action}
      </header>
      {children}
      {note && <p className="sdx-block__note">{note}</p>}
    </section>
  );
}

/* --- the boxes: the page's centre --------------------------------------------------------------- */

function Tiers({ rules, meta }: { rules: LotteryRules; meta: LotteryMeta }) {
  const tokens = (meta.rewardTokens ?? []).map((t) => t.asset?.symbol).filter((s): s is string => !!s);
  return (
    <>
      <section className="sdx-tiers" aria-label="Tiers">
        {LEVELS.map((level) => {
          const band = rules.rewardBands.find((b) => b.level === level);
          const trade = rules.tradeBoxLevels.includes(level);
          return (
            <article key={level} className={`sdx-tier is-${level}`}>
              <header>
                <span className="sdx-tier__name"><i aria-hidden="true" />{LEVEL_LABEL[level]}</span>
                <span className="sdx-tier__from">{trade ? 'Trade / Invite' : 'Merge / Draw'}</span>
              </header>
              <div className="sdx-tier__stage"><BoxArt level={level} size={168} /></div>
              <div className="sdx-tier__band">
                <span>Reward range</span>
                <b>{band ? `${fmtUsdTight(band.minUsd)} – ${fmtUsdTight(band.maxUsd)}` : DASH}</b>
              </div>
            </article>
          );
        })}
      </section>
      {tokens.length > 0 && (
        <p className="sdx-rewards">
          Rewards pay out in
          {tokens.map((t) => <span key={t} className="sdx-rewards__t"><CoinIcon coin={t} size={16} />{t}</span>)}
        </p>
      )}
    </>
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

/** SoDEX's page text for the PFP drop (shared with the localhost versions). */
export const PFP_DROP = {
  title: 'Exclusive drop: Cybereator PFP',
  line: 'Every box has an extra chance to drop a PFP NFT. The earlier you open, the better your odds.',
} as const;

function PfpDrop() {
  return (
    <section className="sdx-pfp">
      <div className="sdx-pfp__text">
        <h2>{PFP_DROP.title}</h2>
        <p>{PFP_DROP.line}</p>
      </div>
      <img className="sdx-pfp__cat" src="/sodex-art/cyber-cat.webp" alt="" loading="lazy" decoding="async" draggable={false} onError={(e) => { e.currentTarget.hidden = true; }} />
    </section>
  );
}

/* --- how they are earned ------------------------------------------------------------------------ */

/** SoDEX's own worked example, kept only while the live rules still make it come out at one box. */
function Earned({ rules }: { rules: LotteryRules }) {
  const taker = bpsToPct(rules.takerWeightBps);
  const maker = bpsToPct(rules.makerWeightBps);
  const example = 8000 * (taker / 100) + 10000 * (maker / 100) === rules.volumePerBoxU;
  return (
    <div className="sdx-earned">
      <div className="sdx-earned__part">
        <b>{taker}%</b>
        <span>of a taker fill counts</span>
        {example && <small>{fmtUsdTight(8000)} taker fill counts as {fmtUsdTight(8000 * (taker / 100))}</small>}
      </div>
      <i aria-hidden="true">+</i>
      <div className="sdx-earned__part">
        <b>{maker}%</b>
        <span>of a maker fill counts</span>
        {example && <small>{fmtUsdTight(10000)} maker fill counts as {fmtUsdTight(10000 * (maker / 100))}</small>}
      </div>
      <i aria-hidden="true">=</i>
      <div className="sdx-earned__result">
        <BoxArt level="Common" size={72} />
        <div>
          <b>{fmtUsdTight(rules.volumePerBoxU)}</b>
          <span>effective volume, 1 box</span>
        </div>
      </div>
    </div>
  );
}

export const BENEFICIARY: Record<string, string> = { self: 'Friend gets', inviter: 'You get' };

function InviteRules({ rules }: { rules: LotteryRules }) {
  return (
    <ol className="sdx-steps3">
      {rules.milestones.map((m) => (
        <li key={`${m.thresholdU}:${m.beneficiary}`}>
          <span className={`sdx-ring is-${m.level}`}><BoxArt level={m.level} size={64} /></span>
          <b>Friend trades {fmtUsdTight(m.thresholdU)}</b>
          <small>{BENEFICIARY[m.beneficiary] ?? m.beneficiary} 1 {isLevel(m.level) ? LEVEL_LABEL[m.level] : m.level}</small>
        </li>
      ))}
    </ol>
  );
}

function MergeRules({ rules }: { rules: LotteryRules }) {
  return (
    <div className="sdx-merges">
      {mergeLadder(rules).map((s) => (
        <article key={s.from} className={`sdx-mergecard is-${s.to}`}>
          <div className="sdx-mergecard__from">
            <div className={`sdx-pile is-${s.consume}`} aria-hidden="true">
              {Array.from({ length: s.consume }, (_, i) => <BoxArt key={i} level={s.from} size={44} />)}
            </div>
            <span><b>{s.consume}</b> {LEVEL_LABEL[s.from]}</span>
          </div>
          <svg className="sdx-mergecard__arrow" viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path d="M3 8h9M9 4.500 12.500 8 9 11.500" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <div className="sdx-mergecard__to">
            <BoxArt level={s.to} size={72} />
            <span><b>1</b> {LEVEL_LABEL[s.to]}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

export const DRAW_STEPS: ReadonlyArray<{ when: string; what: string; line: string }> = [
  { when: 'Every Tuesday, 13:00 UTC+2', what: 'Snapshot', line: "Counts this week's tickets and publishes the prize pool." },
  { when: 'Every Wednesday, 13:00 UTC+2', what: 'Live draw', line: 'Prizes are boxes of all four tiers.' },
  { when: 'After the draw', what: 'Results', line: 'Winners and the random seed are published; prizes go to winning wallets.' },
];

function DrawRules() {
  return (
    <ol className="sdx-timeline">
      {DRAW_STEPS.map((s, i) => (
        <li key={s.what}>
          <span className="sdx-timeline__n">{i + 1}</span>
          <small>{s.when}</small>
          <b>{s.what}</b>
          <p>{s.line}</p>
        </li>
      ))}
    </ol>
  );
}

/* --- the opens ---------------------------------------------------------------------------------- */

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
    <Section title="Live opens" action={<SegSwitch value={filter} options={FILTERS} onChange={setFilter} label="Tier" />}>
      {feed.error && !feed.data ? (
        <ReadFailed what="The feed" error={feed.error} onRetry={feed.retry} />
      ) : !feed.data ? (
        <SkelRows rows={6} height={44} />
      ) : rows.length === 0 ? (
        <EmptyState icon="history" title="Nothing here yet" line="No box of this tier among the latest opens." compact />
      ) : (
        <ul className="sdx-opens">
          {rows.map((i) => <FeedRow key={`${i.tokenId}:${i.tsMs}`} item={i} now={now} />)}
        </ul>
      )}
    </Section>
  );
}

function FeedRow({ item, now }: { item: FeedItem; now: number }) {
  const amount = item.reward?.amount;
  const symbol = item.reward?.asset?.symbol;
  return (
    <li className="sdx-feed__row">
      <BoxArt level={item.level} size={38} />
      <div className="sdx-feed__who">
        <b>{item.wallet}</b>
        <small>{isLevel(item.level) ? LEVEL_LABEL[item.level] : item.level} · #{item.tokenId}</small>
      </div>
      {item.pfp && <Pill tone="info">PFP</Pill>}
      <div className="sdx-feed__prize">
        <b>{item.rewardUsd ? fmtUsdTight(item.rewardUsd) : DASH}</b>
        <small>{amount && symbol ? `${fmtTokens(amount)} ${symbol}` : DASH}</small>
      </div>
      <span className="sdx-feed__ago">{Number.isFinite(item.tsMs) ? fmtAgo(item.tsMs, now) : DASH}</span>
    </li>
  );
}
