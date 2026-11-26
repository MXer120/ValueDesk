/**
 * What the three Blind Box versions share: the reads (SoDEX's rules and opens through our server, a wallet's boxes off
 * the chain, Original's own sources), the arithmetic on them, and the parts drawn from them. Every figure is the rules',
 * the feed's, the chain's or plain arithmetic on those; SoDEX's page text only where Original already uses it.
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  LEVELS, LEVEL_LABEL, LOTTERY_FEED_SIZE, bpsToPct, fetchLotteryFeed, fetchLotteryMeta, isLevel, mergeLadder, readWalletBoxes, valuechainRpc,
  type FeedItem, type Level, type LotteryFeed, type LotteryMeta, type LotteryRules, type WalletBoxes,
} from '../../../../blindBox';
import { DASH, fmt } from '../../../../format';
import { SODEX_SITE } from '../../../../sodexProgrammes';
import { warmWalletModal } from '../../../../walletconnect';
import { openConnectDialog } from '../../../account/connect';
import { usePolled, type Read } from '../../../explore/cohorts/parts';
import { EmptyState, Segmented, Skeleton, StatusPill } from '../../../bots/kit/kit';
import { localize } from '../../../../numStyle';
import { CoinIcon } from '../../../CoinIcon';
import { BoxArt } from '../../BoxArt';
import { BENEFICIARY, DRAW_STEPS } from '../../BlindBoxPage';
import { LockedSection, fmtAgo, fmtTokens, fmtUsdTight } from '../../parts';
import { SAMPLE_ADDRESS, sampleBoxes } from './sample';

export { LEVELS, LEVEL_LABEL, BENEFICIARY, DRAW_STEPS };
/** $10K, $100K, $1M, $4M, $54.5K: a volume at a glance, in the app's number style. */
export const compact = (n: number): string => localize(n >= 1e6 ? `$${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${+(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`);
export const usd = fmtUsdTight;
export const count = (n: number) => fmt(n, 0);
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
export const levelName = (l: string) => (isLevel(l) ? LEVEL_LABEL[l] : l);

/* ------------------------------------------------------------------------------------------- reads ----- */

export interface WalletRead {
  state: 'connect' | 'loading' | 'error' | 'ok';
  boxes: WalletBoxes | null;
  error: string | null;
  retry: () => void;
  sample: boolean;
  /** As shown: short, or the sample's. */
  who: string | null;
}

export interface BoxData {
  meta: Read<LotteryMeta>;
  rules: LotteryRules | null;
  feed: Read<LotteryFeed>;
  /** The latest opens, newest first (the feed's own order is not by time). */
  opens: FeedItem[];
  wallet: WalletRead;
}

export function useBoxData(address: string | null, sample: boolean): BoxData {
  const meta = usePolled('lottery-meta', (signal) => fetchLotteryMeta(signal), 60_000);
  const feed = usePolled('lottery-feed', (signal) => fetchLotteryFeed(LOTTERY_FEED_SIZE, signal), 15_000);
  const box = meta.data?.contracts?.treasureBox;
  const chain = usePolled(
    !sample && address && box ? `boxes:${address.toLowerCase()}:${box}` : null,
    (signal) => readWalletBoxes(address as string, box as string, valuechainRpc(signal)),
    60_000,
  );
  const demo = useMemo(() => (sample ? sampleBoxes() : null), [sample]);
  const opens = useMemo(() => [...(feed.data?.items ?? [])].sort((a, b) => b.tsMs - a.tsMs), [feed.data]);
  const wallet: WalletRead = demo
    ? { state: 'ok', boxes: demo, error: null, retry: () => {}, sample: true, who: SAMPLE_ADDRESS }
    : !address ? { state: 'connect', boxes: null, error: null, retry: () => {}, sample: false, who: null }
    : chain.error && !chain.data ? { state: 'error', boxes: null, error: chain.error, retry: chain.retry, sample: false, who: short(address) }
    : chain.data ? { state: 'ok', boxes: chain.data, error: null, retry: chain.retry, sample: false, who: short(address) }
    : { state: 'loading', boxes: null, error: null, retry: chain.retry, sample: false, who: short(address) };
  return { meta, rules: meta.data?.rules ?? null, feed, opens, wallet };
}

/* -------------------------------------------------------------------------------------- arithmetic ----- */

export type Counts = Record<Level, number>;
export const countsOf = (b: WalletBoxes | null): Counts | null =>
  b && b.exact ? { Common: b.byLevel.Common.length, Uncommon: b.byLevel.Uncommon.length, Rare: b.byLevel.Rare.length, SuperRare: b.byLevel.SuperRare.length } : null;

export interface MergeStep { from: Level; to: Level; consume: number; have: number; merges: number; missing: number }

/** Each merge the rules allow, with what this wallet's boxes of that tier make of it now (one step, no chain). */
export function mergeNow(c: Counts, rules: Pick<LotteryRules, 'mergeSize'>): MergeStep[] {
  return mergeLadder(rules).map((s) => {
    const have = c[s.from];
    const merges = Math.floor(have / s.consume);
    return { ...s, have, merges, missing: merges > 0 ? 0 : s.consume - have };
  });
}

/** Every merge done, lowest tier first, each result feeding the next: what the boxes become at most. */
export function mergeAll(c: Counts, rules: Pick<LotteryRules, 'mergeSize'>): Counts {
  const out = { ...c };
  for (const s of mergeLadder(rules)) {
    const m = Math.floor(out[s.from] / s.consume);
    out[s.from] -= m * s.consume;
    out[s.to] += m;
  }
  return out;
}

/**
 * The effective volume behind one box of each tier on the merge route: a Common is rules.volumePerBoxU, each tier above
 * is the merge size times the one below. Null for a tier the ladder does not reach.
 */
export function routeVolume(rules: LotteryRules): Record<Level, number | null> {
  const out: Record<Level, number | null> = { Common: rules.volumePerBoxU, Uncommon: null, Rare: null, SuperRare: null };
  for (const s of mergeLadder(rules)) { const v = out[s.from]; if (v !== null) out[s.to] = v * s.consume; }
  return out;
}

/** The boxes a week's fills earn: taker and maker fills weighted by the rules, whole boxes, the cap if there is one. */
export function boxesFor(taker: number, maker: number, rules: LotteryRules): { effective: number; boxes: number; toNext: number; capped: boolean } {
  const effective = taker * (bpsToPct(rules.takerWeightBps) / 100) + maker * (bpsToPct(rules.makerWeightBps) / 100);
  const raw = Math.floor(effective / rules.volumePerBoxU);
  const cap = typeof rules.maxTradeBoxesPerWallet === 'number' ? rules.maxTradeBoxesPerWallet : null;
  const boxes = cap !== null ? Math.min(cap, raw) : raw;
  return { effective, boxes, toNext: rules.volumePerBoxU - (effective % rules.volumePerBoxU), capped: cap !== null && raw > cap };
}

export interface FeedStats { n: number; paid: number; best: FeedItem | null; pfp: number; byLevel: Counts; from: number | null }

export function feedStats(opens: readonly FeedItem[]): FeedStats {
  const byLevel: Counts = { Common: 0, Uncommon: 0, Rare: 0, SuperRare: 0 };
  let paid = 0;
  let best: FeedItem | null = null;
  let pfp = 0;
  let from: number | null = null;
  for (const o of opens) {
    const v = Number(o.rewardUsd);
    if (Number.isFinite(v)) { paid += v; if (!best || v > Number(best.rewardUsd)) best = o; }
    if (o.pfp) pfp += 1;
    if (isLevel(o.level)) byLevel[o.level] += 1;
    if (Number.isFinite(o.tsMs)) from = from === null ? o.tsMs : Math.min(from, o.tsMs);
  }
  return { n: opens.length, paid, best, pfp, byLevel, from };
}

/** "the last 6 days": how far back the feed's opens reach. */
export function spanText(from: number | null, now: number): string {
  if (from === null) return '';
  const h = (now - from) / 3_600_000;
  return h < 1 ? 'the last hour' : h < 48 ? `the last ${Math.ceil(h)} hours` : `the last ${Math.ceil(h / 24)} days`;
}

/* ----------------------------------------------------------------------------------------- parts ----- */

export function TierDot({ level, children }: { level: string; children?: ReactNode }) {
  return <span className={`sxb-tier is-${level}`}><i aria-hidden="true" />{children ?? levelName(level)}</span>;
}

/** How a tier is had, from the rules: trading or invites for the trade tiers, merging and the draw for the rest. */
export const howGot = (level: Level, rules: LotteryRules): string => {
  const trade = rules.tradeBoxLevels.includes(level);
  const invite = rules.milestones.some((m) => m.level === level);
  return trade ? (invite ? 'Trade · Invite' : 'Trade') : invite ? 'Invite · Merge' : 'Merge · Draw';
};

export type OpenFilter = 'all' | 'Uncommon' | 'Rare';
const FILTERS: ReadonlyArray<{ value: OpenFilter; label: string }> = [{ value: 'all', label: 'All' }, { value: 'Uncommon', label: 'Uncommon +' }, { value: 'Rare', label: 'Rare +' }];
export const atLeast = (level: string, min: OpenFilter): boolean => min === 'all' || (isLevel(level) && LEVELS.indexOf(level) >= LEVELS.indexOf(min));

export function OpenFilterSeg({ value, onChange }: { value: OpenFilter; onChange: (v: OpenFilter) => void }) {
  return <Segmented<OpenFilter> label="Tier" value={value} onChange={onChange} options={FILTERS.map((f) => ({ ...f }))} />;
}

export function OpenRow({ item, now }: { item: FeedItem; now: number }) {
  const amount = item.reward?.amount;
  const symbol = item.reward?.asset?.symbol;
  return (
    <li className="sxb-open">
      <span className={`sxb-open__art is-${item.level}`}><BoxArt level={item.level} size={38} /></span>
      <span className="sxb-open__t">
        <span className="sxb-open__w"><b>{item.wallet}</b>{item.pfp && <StatusPill size="sm" tone="brand" title="This open also dropped a PFP">PFP</StatusPill>}</span>
        <small>{levelName(item.level)} · #{item.tokenId}</small>
      </span>
      <span className="sxb-open__p"><b>{item.rewardUsd ? usd(item.rewardUsd) : DASH}</b><small>{amount && symbol ? `${fmtTokens(amount)} ${symbol}` : DASH}</small></span>
      <span className="sxb-open__ago">{Number.isFinite(item.tsMs) ? fmtAgo(item.tsMs, now) : DASH}</span>
    </li>
  );
}

/** The opens as a list with the tier filter; folds after `fold` rows. */
export function OpensList({ data, now, fold = 8, head }: { data: BoxData; now: number; fold?: number; head?: ReactNode }) {
  const [filter, setFilter] = useState<OpenFilter>('all');
  const [all, setAll] = useState(false);
  const rows = data.opens.filter((o) => atLeast(o.level, filter));
  const shown = all ? rows : rows.slice(0, fold);
  return (
    <section className="sxb-opens" aria-label="Live opens">
      <div className="sxb-opens__h">{head ?? <h3>Live opens</h3>}<OpenFilterSeg value={filter} onChange={(f) => { setFilter(f); setAll(false); }} /></div>
      {data.feed.error && !data.feed.data ? <ReadError what="The opens" error={data.feed.error} retry={data.feed.retry} />
        : !data.feed.data ? <div className="sxb-skel">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="sxb-skel__row" />)}</div>
        : !rows.length ? <EmptyState compact icon="clock" title="Nothing here yet" description="No box of this tier among the latest opens." />
        : (
          <>
            <ul className="sxb-list">{shown.map((o) => <OpenRow key={`${o.tokenId}:${o.tsMs}`} item={o} now={now} />)}</ul>
            {rows.length > fold && <button type="button" className="rf-text sxb-more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</button>}
          </>
        )}
    </section>
  );
}

export function ReadError({ what, error, retry }: { what: string; error: string | null; retry: () => void }) {
  return <EmptyState compact icon="warning" tone="error" title={`${what} could not be read`} description={error ?? undefined} actions={<button type="button" className="rf-cta" onClick={retry}>Try again</button>} />;
}

/**
 * Every tier's reward range on one log axis ($1 … $10K), with where the latest opens of each tier landed. The ranges are
 * /meta's; the dots are the feed's opens, nothing else.
 */
export function RangeChart({ rules, opens, compactRows }: { rules: LotteryRules; opens: readonly FeedItem[]; compactRows?: boolean }) {
  const bands = LEVELS.map((l) => ({ level: l, b: rules.rewardBands.find((x) => x.level === l) })).filter((x) => x.b);
  const lo = Math.min(...bands.map((x) => Number(x.b!.minUsd)).filter((v) => v > 0), 1);
  const hi = Math.max(...bands.map((x) => Number(x.b!.maxUsd)), 10);
  const a = Math.floor(Math.log10(lo));
  const z = Math.ceil(Math.log10(hi));
  const x = (v: number) => ((Math.log10(Math.max(10 ** a, Math.min(10 ** z, v))) - a) / Math.max(1, z - a)) * 100;
  const ticks = Array.from({ length: z - a + 1 }, (_, i) => 10 ** (a + i));
  const [on, setOn] = useState<FeedItem | null>(null);
  return (
    <div className={`sxb-range${compactRows ? ' is-compact' : ''}`} role="group" aria-label={bands.map((r) => `${levelName(r.level)} ${usd(r.b!.minUsd)} to ${usd(r.b!.maxUsd)}`).join('; ')}>
      <div className="sxb-range__rows">
        {bands.map(({ level, b }) => {
          const mine = opens.filter((o) => o.level === level && Number(o.rewardUsd) > 0);
          return (
            <div key={level} className={`sxb-range__row is-${level}`}>
              <span className="sxb-range__k"><BoxArt level={level} size={compactRows ? 28 : 34} /><span><b>{levelName(level)}</b><small>{howGot(level, rules)}</small></span></span>
              <span className="sxb-range__track">
                {ticks.map((t) => <i key={t} className="sxb-range__grid" style={{ left: `${x(t)}%` }} />)}
                <span className="sxb-range__bar" style={{ left: `${x(Number(b!.minUsd))}%`, width: `${Math.max(1.2, x(Number(b!.maxUsd)) - x(Number(b!.minUsd)))}%` }} />
                {mine.map((o) => (
                  /* A point, not a control: a span, so the phone's 44 px rule for buttons does not stretch it. */
                  <span key={`${o.tokenId}:${o.tsMs}`} role="img" tabIndex={0} className={`sxb-range__dot${on === o ? ' is-on' : ''}`} style={{ left: `${x(Number(o.rewardUsd))}%` }}
                    aria-label={`${levelName(level)} #${o.tokenId}: ${usd(o.rewardUsd!)}`} onPointerEnter={() => setOn(o)} onPointerDown={() => setOn(o)} onFocus={() => setOn(o)} onPointerLeave={(e) => { if (e.pointerType !== 'touch') setOn(null); }} onBlur={() => setOn(null)} />
                ))}
              </span>
              <span className="sxb-range__v"><b>{usd(b!.minUsd)} – {usd(b!.maxUsd)}</b></span>
            </div>
          );
        })}
      </div>
      <div className="sxb-range__axis" aria-hidden="true"><span className="sxb-range__k" /><span className="sxb-range__track">{ticks.map((t) => <i key={t} style={{ left: `${x(t)}%` }}>{compact(t)}</i>)}</span><span className="sxb-range__v" /></div>
      <p className="sxb-range__say" aria-live="polite">
        {on ? <><TierDot level={on.level} /><span>#{on.tokenId} · {on.wallet}</span><b>{usd(on.rewardUsd!)}</b></>
          : <><i className="sxb-range__key is-bar" />Reward range<i className="sxb-range__key is-dot" />An open from the latest {count(opens.length)}</>}
      </p>
    </div>
  );
}

/** The wallet's boxes as a card, the Referrals page's black card: the count, each tier, the wallet. */
export function BoxesCard({ w, className }: { w: WalletRead; className?: string }) {
  const c = countsOf(w.boxes);
  return (
    <section className={`rf-dark sxb-card${className ? ` ${className}` : ''}`} aria-label="Your boxes">
      <span className="sxb-card__sheen" aria-hidden="true" />
      <div className="sxb-card__top"><em>Your boxes</em>{w.sample ? <StatusPill size="sm" tone="warning">Sample</StatusPill> : <span>ValueChain</span>}</div>
      {w.state === 'connect' ? (
        <div className="sxb-card__empty">
          <p>Connect a wallet to see the boxes it holds.</p>
          <button type="button" className="rf-cta" onPointerEnter={warmWalletModal} onFocus={warmWalletModal} onClick={() => void openConnectDialog()}>Connect wallet</button>
        </div>
      ) : w.state === 'error' ? (
        <div className="sxb-card__empty"><p>Your boxes could not be read.</p><button type="button" className="rf-cta" onClick={w.retry}>Try again</button></div>
      ) : (
        <>
          <div className="sxb-card__n">{w.state === 'loading' ? <Skeleton className="sxb-card__skel" /> : <b className="sx-num">{count(w.boxes!.count)}</b>}<span>unopened</span></div>
          <ul className="sxb-card__tiers">
            {LEVELS.map((l) => (
              <li key={l} className={c && c[l] > 0 ? 'is-on' : undefined}><BoxArt level={l} size={30} /><b className="sx-num">{c ? count(c[l]) : DASH}</b><small>{levelName(l)}</small></li>
            ))}
          </ul>
        </>
      )}
      <div className="sxb-card__foot"><span>{w.who ?? '0x•••• ••••'}</span><a href={SODEX_SITE.blindBox} target="_blank" rel="noopener noreferrer">Open on SoDEX</a></div>
    </section>
  );
}

/** What the wallet's boxes can merge into, by the rules: each step now, and everything merged up. */
export function MergePlan({ w, rules }: { w: WalletRead; rules: LotteryRules }) {
  const c = countsOf(w.boxes);
  if (w.state !== 'ok') return null;
  if (!c) return <p className="sxb-note">The tiers could not be read just now, so only the count is shown.</p>;
  if (w.boxes!.count === 0) return <p className="sxb-note">No boxes yet: every {usd(rules.volumePerBoxU)} of effective volume wins one.</p>;
  const steps = mergeNow(c, rules);
  const up = mergeAll(c, rules);
  const changed = LEVELS.some((l) => up[l] !== c[l]);
  return (
    <dl className="rf-kv sxb-merge">
      {steps.map((s) => (
        <div key={s.from}>
          <dt><span className="sxb-merge__step"><BoxArt level={s.from} size={20} />{s.consume}<i aria-hidden="true">→</i><BoxArt level={s.to} size={20} />1</span></dt>
          <dd>{s.merges > 0 ? <span className="pos">{count(s.merges)} {levelName(s.to)} now</span> : <span className="sx-muted">{count(s.missing)} {levelName(s.from)} short</span>}</dd>
        </div>
      ))}
      <div className="sxb-merge__all"><dt>All merged up</dt><dd>{changed ? LEVELS.filter((l) => up[l] > 0).reverse().map((l) => `${count(up[l])} ${levelName(l)}`).join(' · ') : 'Nothing to merge yet'}</dd></div>
    </dl>
  );
}

/** The wallet's progress, history and draw tickets: SoDEX's sign-in only, which stays off here (SODEX_SIGNIN_LIVE). */
export function ProgressLocked() {
  return (
    <div className="sxb-locked">
      <LockedSection title="Your progress" items={['Effective volume and the next box', 'Boxes waiting to be claimed', 'Draw tickets and history']} href={SODEX_SITE.blindBox} hrefLabel="Open on SoDEX" />
    </div>
  );
}

/** The draw, SoDEX's page text (Original's DRAW_STEPS), on a rail. */
export function DrawRail() {
  return (
    <ol className="sxb-draw">
      {DRAW_STEPS.map((s, i) => (
        <li key={s.what}><span className="sxb-draw__n">{i + 1}</span><small>{s.when}</small><b>{s.what}</b><p>{s.line}</p></li>
      ))}
    </ol>
  );
}

/** An invite milestone, as Original words it. */
export const milestoneText = (m: LotteryRules['milestones'][number]) => `${BENEFICIARY[m.beneficiary] ?? m.beneficiary} 1 ${levelName(m.level)}`;

/** "Rewards pay out in vANT · vsoUSDC", with the price /meta quotes for each. */
export function RewardTokens({ meta }: { meta: LotteryMeta }) {
  const tokens = (meta.rewardTokens ?? []).filter((t) => t.asset?.symbol);
  if (!tokens.length) return null;
  return (
    <span className="sxb-tokens">
      {tokens.map((t) => (
        <span key={t.asset!.symbol} title={t.priceUsd ? `${t.asset!.symbol} at ${usd(t.priceUsd)}, SoDEX's price` : undefined}>
          <CoinIcon coin={t.asset!.symbol} size={16} />
          {t.asset!.symbol}{t.priceUsd && Number(t.priceUsd) !== 1 ? <small>{usd(t.priceUsd)}</small> : null}
        </span>
      ))}
    </span>
  );
}
