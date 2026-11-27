/**
 * Sharing SoPoints and a squad (owner 2026-11-27: "share pop up for points + estimated point needs to exist and fully
 * styled. With options to hide ref code, show top % or points and show weekly + or total"; for the squad: "also share
 * needed"). The app's own share dialog and card (components/share: drawn on this device, nothing uploaded), with the
 * card's own switches: what leads (points or the top %), which period (the season's total or the last scored week),
 * this week's estimate, and the wallet's invite code.
 */
import { useMemo, useState } from 'react';
import { DlgRow, DlgSeg, DlgSwitch } from '../../../dialogParts';
import { ShareCard } from '../../../share/ShareCard';
import type { CardData, CardFact } from '../../../share/card';
import { inviteLink, useOwnCode } from '../../../../invites/invites';
import { localize } from '../../../../numStyle';
import type { EstBand } from '../../sopointsEstimate';
import { money, plusPct, pts, ptsEst, topText, type PointsView } from './shared';

type Lead = 'points' | 'top';
type Period = 'total' | 'week';

const short = (n: number) => (n >= 1e6 ? `${localize(String(Number((n / 1e6).toFixed(2))))}M` : n >= 1e4 ? `${localize(String(Number((n / 1e3).toFixed(1))))}K` : pts(n));

/** The wallet's SoPoints card: `week` is this week's estimate (total points, the squad's boost included) when there is one. */
export function PointsShare({ v, week, onClose }: { v: PointsView; week: Pick<EstBand, 'mid' | 'busy' | 'quiet'> | null; onClose: () => void }) {
  const own = useOwnCode(v.c.address);
  const code = own.state === 'ok' ? own.code : null;
  const [lead, setLead] = useState<Lead>('points');
  const [period, setPeriod] = useState<Period>('total');
  const [est, setEst] = useState(!!week);
  const [showCode, setShowCode] = useState(!!code);
  const last = v.last;
  const sum = v.s.summary;
  const card: CardData = useMemo(() => {
    const total = v.total ?? 0;
    const lw = last?.split.week ?? null;
    const weekly = period === 'week' && lw;
    const rank = weekly ? lw.rank : sum?.rank ?? 0;
    const users = weekly ? lw.totalUser : sum?.totalUser ?? 0;
    const top = topText(rank, users, weekly ? lw.rankPercentile : undefined);
    const big = lead === 'top' && rank ? top : weekly ? `+${pts(lw.points)}` : pts(total);
    const label = lead === 'top' && rank ? (weekly ? `${lw.weekName}, rank` : 'Rank on SoDEX') : weekly ? `${lw.weekName}, SoPoints` : 'SoPoints';
    const sub = lead === 'top' && rank ? `#${pts(rank)}` : weekly ? pts(total) : v.tier;
    const subRest = lead === 'top' && rank ? (users ? `of ${pts(users)}` : '') : weekly ? 'in all' : rank ? `· #${pts(rank)}` : '';
    const facts: CardFact[] = [
      { label: 'Tier', value: v.tier, kind: 'plain' as const },
      lead === 'top' || weekly ? { label: 'SoPoints', value: pts(total), kind: 'stat' as const } : { label: 'Rank', value: rank ? `#${pts(rank)}` : '—', kind: 'stat' as const },
      ...(lw && !weekly ? [{ label: lw.weekName, value: `+${pts(lw.points)}`, kind: 'stat' as const }] : []),
      ...(est && week ? [{ label: 'This week, est.', value: `≈ +${ptsEst(week.mid)}`, kind: 'stat' as const }] : []),
      ...(v.squad?.total ? [{ label: 'Squad boost', value: plusPct(v.squad.total), kind: 'plain' as const }] : []),
    ].slice(0, 4);
    let t = 0;
    const ys = period === 'week' ? v.scored.map((w) => w.split.week.points) : v.scored.map((w) => (t += w.split.week.points));
    const link = showCode && code ? inviteLink(code) : `${location.origin}/points`;
    return {
      kind: 'points', label: 'SoPoints', when: v.week ? `Layer 1 · ${v.week.weekName}` : 'Layer 1 Season',
      title: `${v.tier} tier`, pills: [], usd: null, pct: null,
      lead: { label, big, sub, subRest, altLabel: label, altBig: big, altSub: sub, altSubRest: subRest },
      facts, foot: 'SoPoints on SoDEX', chart: ys.length > 1 ? { type: 'pnl', ys } : null, link,
      post: () => {
        const head = lead === 'top' && rank ? `${top} on SoDEX's SoPoints` : weekly ? `+${pts(lw.points)} SoPoints in ${lw.weekName} on SoDEX` : `${pts(total)} SoPoints on SoDEX, ${v.tier}`;
        const e = est && week ? `, about +${ptsEst(week.mid)} more this week` : '';
        return `${head}${e}.${showCode && code ? ` Trade with my code ${code}:` : ''}`;
      },
      second: null, wallet: null,
    };
  }, [v, last, sum, lead, period, est, week, showCode, code]);
  const controls = (
    <div className="dlg-card">
      <DlgRow title="Lead with" line={lead === 'top' ? 'Your place among everyone SoDEX ranks' : 'Your SoPoints'}>
        <DlgSeg label="Lead with" value={lead} onChange={setLead} options={[{ value: 'points', label: 'Points' }, { value: 'top', label: 'Top %' }]} />
      </DlgRow>
      <DlgRow title="Period" line={period === 'week' ? (last ? `${last.split.week.weekName}, the last scored week` : 'No scored week yet') : 'The whole season so far'}>
        <DlgSeg label="Period" value={period} onChange={setPeriod} options={[{ value: 'total', label: 'Total' }, { value: 'week', label: 'Weekly' }]} />
      </DlgRow>
      <DlgRow title="This week’s estimate" line={week ? `≈ +${ptsEst(week.mid)}, ValueDesk’s estimate` : 'No estimate yet'} off={!est || !week}>
        <DlgSwitch on={est && !!week} onChange={setEst} label="This week’s estimate" onWord="Shown" offWord="Hidden" disabled={!week} />
      </DlgRow>
      <DlgRow title="Invite code" line={code ? `${code}: people who join with it trade in your squad` : 'You have no SoDEX invite code yet'} off={!showCode || !code}>
        <DlgSwitch on={showCode && !!code} onChange={setShowCode} label="Invite code" onWord="Shown" offWord="Hidden" disabled={!code} />
      </DlgRow>
    </div>
  );
  return <ShareCard card={card} code={showCode ? code : null} onClose={onClose} controls={controls} />;
}

/** One squad's card: its energy (the window's volume), its boost, its members, the next step. */
export function SquadShare({ v, which, name, onClose }: { v: PointsView; which: 'built' | 'joined'; name: string; onClose: () => void }) {
  const own = useOwnCode(v.c.address);
  const code = own.state === 'ok' ? own.code : null;
  const [showCode, setShowCode] = useState(!!code);
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
    <div className="dlg-card">
      <DlgRow title="Invite code" line={code ? `${code}: people who join with it trade in your squad` : 'You have no SoDEX invite code yet'} off={!showCode || !code}>
        <DlgSwitch on={showCode && !!code} onChange={setShowCode} label="Invite code" onWord="Shown" offWord="Hidden" disabled={!code} />
      </DlgRow>
      <DlgRow title="Energy" line={`${money(q?.volume ?? 0)} traded by the squad over the last ${windowWeeks} weeks`}>{null}</DlgRow>
    </div>
  );
  return <ShareCard card={card} code={showCode ? code : null} onClose={onClose} controls={controls} />;
}
