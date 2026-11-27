/**
 * Sharing SoPoints and a squad (owner 2026-11-27: "share pop up for points + estimated point needs to exist and fully
 * styled. With options to hide ref code, show top % or points and show weekly + or total"; for the squad: "also share
 * needed"). The app's own share dialog and card (components/share: drawn on this device, nothing uploaded), with the
 * card's own switches: what leads (points or the top %), which period (the season's total or the last scored week),
 * this week's estimate, and the wallet's invite code.
 */
import { useMemo, useState } from 'react';
import { DlgSeg, DlgSwitch } from '../../../dialogParts';
import { ShareCard } from '../../../share/ShareCard';
import type { CardData, CardFact } from '../../../share/card';
import { inviteLink, useOwnCode } from '../../../../invites/invites';
import { localize } from '../../../../numStyle';
import { TIER_STYLE, tierKey } from '../../SoPointsMine';
import type { PointsArt } from '../../../share/pointsArt';
import type { EstBand } from '../../sopointsEstimate';
import { plusPct, pts, ptsEst, topText, type PointsView } from './shared';

type Lead = 'points' | 'top';
/** Total: the season so far; week: the last scored week; now: this week's estimate (owner 2026-11-27: "also a share
 * button for this weeks estimate"). */
export type Period = 'total' | 'week' | 'now';

const short = (n: number) => (n >= 1e6 ? `${localize(String(Number((n / 1e6).toFixed(2))))}M` : n >= 1e4 ? `${localize(String(Number((n / 1e3).toFixed(1))))}K` : pts(n));

/** A line of the share dialog's options: its label and its control. */
const Opt = ({ label, children }: { label: string; children: React.ReactNode }) => <div className="share-opt"><span>{label}</span>{children}</div>;

/** The wallet's SoPoints card. `week` is this week's estimate (total points, the squad's boost included) when there is
 * one; `start` the period the dialog opens on (the live card's share opens on this week). */
/** SoDEX's colours of a tier (SoPointsMine TIER_STYLE): its gradient stops, edge, chip and bar stops. */
function tierColours(tier: string) {
  const st = TIER_STYLE[tierKey(tier)]!;
  const cols = (css: string) => css.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\([^)]*\)/gi) ?? ['#52525B', '#27272A'];
  return { stops: cols(st.bg), border: st.border, chip: st.chip, bar: cols(st.bar) };
}

export function PointsShare({ v, week, weekLabel = 'so far', inputs = [], start = 'total', onClose }: { v: PointsView; week: Pick<EstBand, 'mid' | 'busy' | 'quiet'> | null; weekLabel?: string; inputs?: Array<{ k: string; v: string }>; start?: Period; onClose: () => void }) {
  const own = useOwnCode(v.c.address);
  const code = own.state === 'ok' ? own.code : null;
  const [lead, setLead] = useState<Lead>('points');
  const [period, setPeriod] = useState<Period>(start === 'now' && !week ? 'total' : start);
  const [showCode, setShowCode] = useState(true);
  const last = v.last;
  const sum = v.s.summary;
  const now = period === 'now' && !!week;
  const top = lead === 'top' && !now;
  const card: CardData = useMemo(() => {
    const total = v.total ?? 0;
    const lw = last?.split.week ?? null;
    const weekly = period === 'week' && lw;
    const rank = weekly ? lw.rank : sum?.rank ?? 0;
    const users = weekly ? lw.totalUser : sum?.totalUser ?? 0;
    const topTxt = topText(rank, users, weekly ? lw.rankPercentile : undefined);
    const lead1 = now
      ? { label: v.week ? `${v.week.weekName}, estimated` : 'This week, estimated', big: `≈ +${ptsEst(week!.mid)}`, sub: `${ptsEst(week!.busy)} – ${ptsEst(week!.quiet)}`, subRest: 'likely range' }
      : top && rank
        ? { label: weekly ? `${lw.weekName}, rank` : 'Rank on SoDEX', big: topTxt, sub: `#${pts(rank)}`, subRest: users ? `of ${pts(users)}` : '' }
        : weekly
          ? { label: `${lw.weekName}, SoPoints`, big: `+${pts(lw.points)}`, sub: pts(total), subRest: 'in all' }
          : { label: 'SoPoints', big: pts(total), sub: v.tier, subRest: rank ? `· #${pts(rank)}` : '' };
    const facts: CardFact[] = [
      { label: 'Tier', value: v.tier, kind: 'plain' as const },
      ...(now || top || weekly ? [{ label: 'SoPoints', value: pts(total), kind: 'stat' as const }] : [{ label: 'Rank', value: rank ? `#${pts(rank)}` : '—', kind: 'stat' as const }]),
      ...(lw && !weekly ? [{ label: lw.weekName, value: `+${pts(lw.points)}`, kind: 'stat' as const }] : []),
      ...(v.squad?.total ? [{ label: 'Squad boost', value: plusPct(v.squad.total), kind: 'plain' as const }] : []),
    ].slice(0, 4);
    let t = 0;
    const ys = period === 'total' ? v.scored.map((w) => (t += w.split.week.points)) : v.scored.map((w) => w.split.week.points);
    const link = showCode && code ? inviteLink(code) : `${location.origin}/points`;
    const when = v.week ? `Layer 1 · ${v.week.weekName}` : 'Layer 1 Season';
    // The image: the page's own card, drawn large (owner 2026-11-27: "look just like the actual card").
    let art: PointsArt;
    if (now) {
      const max = Math.max(1, week!.quiet * 1.12);
      art = {
        kind: 'estimate', when, title: `${v.week?.weekName ?? 'This week'}, ${weekLabel}`, big: `≈ ${ptsEst(week!.mid)}`,
        busy: ptsEst(week!.busy), mid: ptsEst(week!.mid), quiet: ptsEst(week!.quiet),
        at: { busy: week!.busy / max, mid: week!.mid / max, quiet: week!.quiet / max }, inputs: inputs.slice(0, 4),
      };
    } else {
      const col = tierColours(v.tier);
      const next = sum?.nextTier && sum.nextTierPoints ? { name: tierKey(sum.nextTier), at: pts(sum.nextTierPoints), pct: total / sum.nextTierPoints } : null;
      art = {
        kind: 'tier', when, tier: v.tier, ...col,
        label: lead1.label, big: lead1.big, unit: top && rank ? null : 'SOPOINTS',
        line: weekly ? `${pts(total)} SoPoints in all` : lw ? `Last week +${pts(lw.points)}` : null,
        next, rank: rank ? (top ? `#${pts(rank)} of ${pts(users)}` : `Rank ${pts(rank)} of all users`) : null,
      };
    }
    return {
      kind: 'points', label: now ? 'SoPoints estimate' : 'SoPoints', when: v.week ? `Layer 1 · ${v.week.weekName}` : 'Layer 1 Season',
      title: `${v.tier} tier`, pills: [], usd: null, pct: null,
      lead: { ...lead1, altLabel: lead1.label, altBig: lead1.big, altSub: lead1.sub, altSubRest: lead1.subRest },
      facts, foot: now ? 'Estimated by ValueDesk, not a SoDEX figure' : 'SoPoints on SoDEX', chart: ys.length > 1 ? { type: 'pnl', ys } : null, link,
      post: () => {
        const head = now ? `On track for about +${ptsEst(week!.mid)} SoPoints this week on SoDEX` : top && rank ? `${topTxt} on SoDEX's SoPoints` : weekly ? `+${pts(lw.points)} SoPoints in ${lw.weekName} on SoDEX` : `${pts(total)} SoPoints on SoDEX, ${v.tier}`;
        return `${head}.${showCode && code ? ` Trade with my code ${code}:` : ''}`;
      },
      second: null, wallet: null, art,
    };
  }, [v, last, sum, period, now, top, week, weekLabel, inputs, showCode, code]);
  const controls = (
    <>
      <Opt label="Show"><DlgSeg label="Show" value={top ? 'top' : 'points'} onChange={setLead} disabled={now} options={[{ value: 'points', label: 'Points' }, { value: 'top', label: 'Top %' }]} /></Opt>
      <Opt label="Period">
        <DlgSeg label="Period" value={period} onChange={setPeriod} options={[
          { value: 'total', label: 'Total' },
          ...(last ? [{ value: 'week' as const, label: 'Last week' }] : []),
          ...(week ? [{ value: 'now' as const, label: 'This week' }] : []),
        ]} />
      </Opt>
      <Opt label={code ? `Invite code ${code}` : 'Invite code'}><DlgSwitch on={showCode && !!code} onChange={setShowCode} label="Invite code" onWord="Shown" offWord="Hidden" disabled={!code} /></Opt>
    </>
  );
  return <ShareCard card={card} code={showCode ? code : null} onClose={onClose} controls={controls} />;
}

/** One squad's card: its energy (the window's volume), its boost, its members, the next step. */
export function SquadShare({ v, which, name, onClose }: { v: PointsView; which: 'built' | 'joined'; name: string; onClose: () => void }) {
  const own = useOwnCode(v.c.address);
  const code = own.state === 'ok' ? own.code : null;
  const [showCode, setShowCode] = useState(true);
  const q = v.squad?.[which] ?? null;
  const windowWeeks = v.c.boost?.windowRounds ?? 4;
  const card: CardData = useMemo(() => {
    const energy = q?.volume ?? 0;
    const next = q?.next ?? null;
    const built = which === 'built' && v.squad ? v.squad.built : null;
    const facts: CardFact[] = [
      { label: 'Squad boost', value: q?.pct ? plusPct(q.pct) : '0%', kind: 'plain' },
      ...(built ? [{ label: 'Members', value: `${pts(built.members)} · ${pts(built.active)} active`, kind: 'stat' as const }] : []),
      { label: 'Next step', value: next ? `${plusPct(next.pct)} at ${short(next.threshold)}` : 'Top step', kind: 'stat' },
      { label: 'Counted over', value: `${windowWeeks} weeks`, kind: 'plain' },
    ];
    const link = showCode && code ? inviteLink(code) : `${location.origin}/points`;
    return {
      kind: 'squad', label: 'Squad', when: v.week ? `Layer 1 · ${v.week.weekName}` : 'Layer 1 Season', title: name, pills: [], usd: null, pct: null,
      lead: { label: 'Squad Energy', big: short(energy), sub: q?.pct ? plusPct(q.pct) : '0%', subRest: 'on every SoPoint', altLabel: 'Squad Energy', altBig: short(energy), altSub: '', altSubRest: '' },
      facts, foot: '$1 traded by the squad = 1 energy', chart: null, link,
      post: () => `Our SoDEX squad has ${short(energy)} Squad Energy${q?.pct ? `, ${plusPct(q.pct)} on every SoPoint` : ''}.${showCode && code ? ` Join with my code ${code}:` : ''}`,
      second: null, wallet: null,
    };
  }, [q, which, v.squad, v.week, windowWeeks, name, showCode, code]);
  const controls = (
    <Opt label={code ? `Invite code ${code}` : 'Invite code'}><DlgSwitch on={showCode && !!code} onChange={setShowCode} label="Invite code" onWord="Shown" offWord="Hidden" disabled={!code} /></Opt>
  );
  return <ShareCard card={card} code={showCode ? code : null} onClose={onClose} controls={controls} />;
}
