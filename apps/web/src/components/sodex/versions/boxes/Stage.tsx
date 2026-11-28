/**
 * Blind Boxes, version "Stage": the Referrals page's look. The four boxes on a lit shelf with the one rule that matters
 * (every rules.volumePerBoxU of effective volume wins a box); "How it works" swaps the shelf for the four ways of the
 * programme (trade, invite, merge, draw). Under it the wallet's boxes as a card with what they can merge into now, every
 * tier's reward range with where the latest opens landed, and the opens themselves.
 */
import { useId, useMemo, useState, type ReactNode } from 'react';
import type { Eip1193Provider } from '../../../../wallet';
import { BoxHistory, MergeMath, PfpLinks, ProgressCard, Vault, type VaultDemo } from '../../vault/Vault';
import { sampleDraw, sampleVault } from './sample';
import { DrawTab } from '../../vault/Draw';
import { bpsToPct, mergeLadder, type LotteryRules } from '../../../../blindBox';
import { Skeleton } from '../../../bots/kit/kit';
import { BoxArt } from '../../BoxArt';
import { PFP_DROP } from '../../BlindBoxPage';
import {
  DrawRail, LEVELS, RangeChart, ReadError, RewardTokens, levelName, milestoneText, usd, useBoxData,
} from './shared';

export function BoxStage({ address, provider, sample }: { address: string | null; provider: Eip1193Provider | null; sample: boolean }) {
  const d = useBoxData(address, sample);
  const rules = d.rules;
  const demo = useMemo<VaultDemo | null>(() => (sample ? sampleVault() : null), [sample]);
  return (
    <div className="tf bots-page rf-page sx sx-boxes">
      <div className="bots-col">
        {d.meta.error && !d.meta.data ? <ReadError what="The programme's rules" error={d.meta.error} retry={d.meta.retry} />
          : <Stage rules={rules} hero={<ProgressCard address={address} provider={provider} rules={rules} demo={demo} />} />}
        <div id="vault" className="sxb-vault"><Vault address={address} provider={provider} meta={d.meta.data} demo={demo} /></div>
        <MergeMath rules={rules} />
        <DrawTab address={address} provider={provider} demo={sample ? sampleDraw() : null} />
        <div className="sxb-desk is-two">
          <BoxHistory address={address} provider={provider} demo={demo} />
          <section className="sxb-desk__inside" aria-label="What is inside">
            <div className="sxb-h3"><h3>What is inside</h3>{d.meta.data && <RewardTokens meta={d.meta.data} />}</div>
            {rules ? <RangeChart rules={rules} opens={d.opens} /> : <div className="sxb-skel">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="sxb-skel__row is-tall" />)}</div>}
          </section>
        </div>
        <Extras />
      </div>
    </div>
  );
}

function Stage({ rules, hero }: { rules: LotteryRules | null; hero: ReactNode }) {
  const [how, setHow] = useState(false);
  const [toggled, setToggled] = useState(false);
  const id = useId();
  const taker = rules ? bpsToPct(rules.takerWeightBps) : null;
  const maker = rules ? bpsToPct(rules.makerWeightBps) : null;
  return (
    <section className={`rf-dark sxb-stage${how ? ' is-how' : ''}${toggled ? ' is-toggled' : ''}`} aria-label="Blind Boxes">
      <span className="sxb-stage__ribs" aria-hidden="true" /><span className="sxb-stage__light" aria-hidden="true" />
      <div className="sxb-stage__k">
        <h1>Blind Boxes</h1>
        <button type="button" className="rf-howbtn" aria-expanded={how} aria-controls={id} disabled={!rules} onClick={() => { setHow(!how); setToggled(true); }}>
          {how ? 'Close' : 'How it works'}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.600" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={how ? 'm4.500 4.500 7 7m0-7-7 7' : 'm4 6 4 4 4-4'} /></svg>
        </button>
      </div>
      <div className="sxb-stage__body">
        <div className="sxb-stage__front" aria-hidden={how} {...(how ? { inert: '' } : {})}>
          <div className="sxb-stage__t">
            {rules ? (
              <>
                <h2>Trade <span className="sx-num">{usd(rules.volumePerBoxU)}</span>.<br />Win a box.</h2>
                <p>Every taker fill counts {taker}%, every maker fill {maker}%. Merge boxes to climb a tier, open them right here.</p>
              </>
            ) : (
              <><Skeleton className="sxb-stage__skel is-h" /><Skeleton className="sxb-stage__skel" /></>
            )}
            <div className="sxb-stage__acts">
              <a className="rf-cta" href="/trade">Trade</a>
              <a className="rf-howbtn" href="#vault">Open your boxes</a>
            </div>
          </div>
          <div className="sxb-stage__side"><Shelf />{hero}</div>
        </div>
        <div className="sxb-stage__how" id={id} aria-hidden={!how} {...(how ? {} : { inert: '' })}>{rules && <HowSteps rules={rules} />}</div>
      </div>
      <div className="rf-pays sxb-pays">
        <div className="rf-pays__g is-you">
          <h3>Trading</h3>
          <ul>
            <li><b>{rules ? usd(rules.volumePerBoxU) : '—'}</b><span>Effective volume, 1 box</span></li>
            <li><b>{taker ?? '—'}%</b><span>Of a taker fill counts</span></li>
            <li><b>{maker ?? '—'}%</b><span>Of a maker fill counts</span></li>
          </ul>
        </div>
        <div className="rf-pays__g">
          <h3>Invites</h3>
          <ul>
            {(rules?.milestones ?? []).map((m) => <li key={`${m.thresholdU}:${m.beneficiary}`}><b>{usd(m.thresholdU)}</b><span>{milestoneText(m)}</span></li>)}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** SoDEX's four boxes on lit steps, each tier a step up. Still for reduced motion. */
function Shelf() {
  return (
    <div className="sxb-shelf" aria-hidden="true">
      {LEVELS.map((l, i) => (
        <span key={l} className={`sxb-shelf__col is-${l} is-${i}`}>
          <span className="sxb-shelf__box"><BoxArt level={l} size={160} /></span>
          <span className="sxb-shelf__step" />
        </span>
      ))}
      {[[8, 22, 1], [88, 12, 1.2], [14, 70, 0.8], [93, 64, 0.7]].map(([x, y, s]) => (
        <svg key={x} className="sxb-shelf__sp" style={{ left: `${x}%`, top: `${y}%`, width: 18 * s!, height: 18 * s! }} viewBox="-9 -9 18 18"><path d="M0-9 2.300-2.300 9 0 2.300 2.300 0 9-2.300 2.300-9 0-2.300-2.300z" fill="#f4f4f2" /></svg>
      ))}
    </div>
  );
}

/** The four ways of the programme, each with its numbers from the rules. */
function HowSteps({ rules }: { rules: LotteryRules }) {
  const ladder = mergeLadder(rules);
  return (
    <ol className="sxb-how">
      <li>
        <h3><i>1</i>Trade</h3>
        <p>Taker fills count {bpsToPct(rules.takerWeightBps)}%, maker fills {bpsToPct(rules.makerWeightBps)}%.</p>
        <div className="sxb-how__art"><BoxArt level="Common" size={64} /><b className="sx-num">{usd(rules.volumePerBoxU)}</b><small>effective volume, 1 box</small></div>
      </li>
      <li>
        <h3><i>2</i>Invite</h3>
        <p>Your friend's trading wins boxes for both of you.</p>
        <ul className="sxb-how__rows">
          {rules.milestones.map((m) => <li key={`${m.thresholdU}:${m.beneficiary}`}><BoxArt level={m.level} size={26} /><span>Friend trades <b className="sx-num">{usd(m.thresholdU)}</b></span><small>{milestoneText(m)}</small></li>)}
        </ul>
      </li>
      <li>
        <h3><i>3</i>Merge</h3>
        <p>Only unopened boxes merge; the ones used are burned.</p>
        <ul className="sxb-how__rows">
          {ladder.map((s) => <li key={s.from}><BoxArt level={s.from} size={26} /><span><b className="sx-num">{s.consume}</b> {levelName(s.from)}</span><small>→ 1 {levelName(s.to)}</small></li>)}
        </ul>
      </li>
      <li>
        <h3><i>4</i>Draw</h3>
        <p>Boxes still unopened at the snapshot count as tickets.</p>
        <DrawRail />
      </li>
    </ol>
  );
}

function Extras() {
  return (
    <div className="sxb-extras">
      <section className="rf-dark sxb-pfp" aria-label="PFP drop">
        <div>
          <h3>{PFP_DROP.title}</h3>
          <p>{PFP_DROP.line}</p>
          <PfpLinks />
        </div>
        <img src="/sodex-art/cyber-cat.webp" alt="" loading="lazy" decoding="async" draggable={false} onError={(e) => { e.currentTarget.hidden = true; }} />
      </section>
      <section className="sxb-drawcard" aria-label="Weekly live draw">
        <h3>Weekly live draw</h3>
        <DrawRail />
      </section>
    </div>
  );
}
