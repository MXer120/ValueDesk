/**
 * Blind Boxes, version "Path": the tier ladder is the page. Common → Uncommon → Rare → SuperRare, each with its art, how
 * it is had, the effective volume behind it on the merge route and its reward range; the merge size on every step; the
 * wallet's boxes standing on their tiers. Then a calculator (fills → boxes, by the rules), the reward ranges against the
 * latest opens, the wallet's shelf with what it can merge now, the draw and the opens.
 */
import { Fragment, useState } from 'react';
import { bpsToPct, mergeLadder, type LotteryRules } from '../../../../blindBox';
import { SODEX_SITE } from '../../../../sodexProgrammes';
import { ProgressBar, Skeleton, Slider, StatusPill } from '../../../bots/kit/kit';
import { BoxArt } from '../../BoxArt';
import { PFP_DROP } from '../../BlindBoxPage';
import { useNow } from '../../parts';
import { openConnectDialog } from '../../../account/connect';
import { warmWalletModal } from '../../../../walletconnect';
import {
  DrawRail, LEVELS, MergePlan, OpensList, ProgressLocked, RangeChart, ReadError, RewardTokens, boxesFor, compact, count, countsOf, feedStats, howGot, levelName, mergeAll,
  routeVolume, spanText, usd, useBoxData, type Counts, type WalletRead,
} from './shared';

export function BoxPath({ address, sample }: { address: string | null; sample: boolean }) {
  const d = useBoxData(address, sample);
  const now = useNow(30_000);
  const rules = d.rules;
  const st = feedStats(d.opens);
  return (
    <div className="tf bots-page rf-page sx sx-boxes">
      <div className="bots-col">
        <header className="sxb-head">
          <div>
            <h1>Blind Boxes</h1>
            <p>{rules ? <>Every <b className="sx-num">{usd(rules.volumePerBoxU)}</b> of effective volume wins a box. Merge them up the path; open them on SoDEX.</> : 'Trade to earn boxes, merge them, open them.'}</p>
          </div>
          <div className="sxb-head__acts">
            <a className="tf-btn is-secondary is-md" href={SODEX_SITE.blindBox} target="_blank" rel="noopener noreferrer">Open on SoDEX</a>
            <a className="tf-btn is-primary is-md" href="/trade">Trade</a>
          </div>
        </header>

        {d.meta.error && !d.meta.data ? <ReadError what="The programme's rules" error={d.meta.error} retry={d.meta.retry} />
          : !rules ? <Skeleton className="sxb-path__skel" />
          : <Ladder rules={rules} w={d.wallet} />}

        <div className="sxb-two">
          <section className="sx-sec sxb-panel" aria-label="What your volume wins">
            <div className="sxb-h3"><h3>What your volume wins</h3><StatusPill size="sm">By the rules</StatusPill></div>
            {rules ? <Calculator rules={rules} /> : <Skeleton className="sxb-calc__skel" />}
          </section>
          <section className="sx-sec sxb-panel" aria-label="Reward ranges">
            <div className="sxb-h3"><h3>Reward ranges</h3>{d.meta.data && <RewardTokens meta={d.meta.data} />}</div>
            {rules ? <RangeChart rules={rules} opens={d.opens} compactRows /> : <Skeleton className="sxb-calc__skel" />}
          </section>
        </div>

        <section className="sx-sec" aria-label="Your shelf">
          <div className="sx-sec__h"><div><h2>Your shelf</h2><p>{d.wallet.sample ? 'Sample data: a made-up wallet.' : 'Read off ValueChain from this browser. Opening and merging stay on SoDEX.'}</p></div>{d.wallet.who && <span className="sxb-who">{d.wallet.who}</span>}</div>
          <Shelf w={d.wallet} rules={rules} />
          <ProgressLocked />
        </section>

        <div className="sxb-two is-draw">
          <section className="sx-sec" aria-label="Weekly live draw">
            <div className="sx-sec__h"><div><h2>Weekly live draw</h2><p>Boxes still unopened at the snapshot count as tickets.</p></div></div>
            <DrawRail />
          </section>
          <section className="sx-sec rf-dark sxb-pfp is-slim" aria-label="PFP drop">
            <div>
              <h3>{PFP_DROP.title}</h3>
              <p>{PFP_DROP.line}</p>
              {st.n > 0 && <span className="sxb-pfp__stat"><b className="sx-num">{count(st.pfp)}</b> of the latest {count(st.n)} opens dropped one{spanText(st.from, now) ? `, ${spanText(st.from, now)}` : ''}</span>}
            </div>
            <img src="/sodex-art/cyber-cat.webp" alt="" loading="lazy" decoding="async" draggable={false} onError={(e) => { e.currentTarget.hidden = true; }} />
          </section>
        </div>

        <section className="sx-sec" aria-label="Live opens">
          <OpensList data={d} now={now} fold={10} head={<h2 className="sxb-opens__h2">Live opens</h2>} />
        </section>
      </div>
    </div>
  );
}

/** The ladder: four tiers, the merge size between them, the wallet's boxes on each. */
function Ladder({ rules, w }: { rules: LotteryRules; w: WalletRead }) {
  const vol = routeVolume(rules);
  const steps = mergeLadder(rules);
  const c = countsOf(w.boxes);
  return (
    <section className="sxb-path" aria-label="The tiers">
      <ol>
        {LEVELS.map((l, i) => {
          const band = rules.rewardBands.find((b) => b.level === l);
          const step = steps.find((s) => s.to === LEVELS[i + 1]);
          return (
            <Fragment key={l}>
              <li className={`sxb-node is-${l}`}>
                <div className="sxb-node__art"><BoxArt level={l} size={120} />{c && c[l] > 0 && <span className="sxb-node__have" title={`You hold ${c[l]}`}>{count(c[l])}</span>}</div>
                <span className="sxb-node__name"><i aria-hidden="true" />{levelName(l)}</span>
                <small className="sxb-node__how">{howGot(l, rules)}</small>
                <dl>
                  <div><dt>Reward</dt><dd>{band ? `${usd(band.minUsd)} – ${usd(band.maxUsd)}` : '—'}</dd></div>
                  <div><dt>Volume behind it</dt><dd>{vol[l] !== null ? compact(vol[l]!) : '—'}</dd></div>
                </dl>
              </li>
              {step && (
                <li className="sxb-link" aria-label={`${step.consume} ${levelName(step.from)} merge into 1 ${levelName(step.to)}`}>
                  <span className="sxb-link__rail" aria-hidden="true" />
                  <span className="sxb-link__chip"><b className="sx-num">{step.consume}</b><small>merge</small></span>
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
      <p className="sxb-path__note">
        Volume behind a tier counts the merge route from Common: one Common is {usd(rules.volumePerBoxU)} of effective volume, each tier above is its merge size times the one below. Only unopened boxes merge; the lower tier is burned.
      </p>
    </section>
  );
}

/* ---------------------------------------------------------------------------------- the calculator ----- */

const STEPS = 1000;
/** A log slider from $1K to $10M, two significant figures, 0 at the left end. */
const of = (t: number): number => {
  if (t <= 0) return 0;
  const v = 10 ** (3 + (4 * t) / STEPS);
  const mag = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.round(v / mag) * mag;
};
const tOf = (usdv: number): number => (usdv <= 0 ? 0 : Math.round(((Math.log10(usdv) - 3) / 4) * STEPS));

function Calculator({ rules }: { rules: LotteryRules }) {
  const [tt, setTt] = useState(() => tOf(50_000));
  const [tm, setTm] = useState(() => tOf(20_000));
  const taker = of(tt);
  const maker = of(tm);
  const r = boxesFor(taker, maker, rules);
  const commons: Counts = { Common: r.boxes, Uncommon: 0, Rare: 0, SuperRare: 0 };
  const up = mergeAll(commons, rules);
  const upText = LEVELS.filter((l) => up[l] > 0).reverse().map((l) => `${count(up[l])} ${levelName(l)}`).join(' · ');
  const tp = bpsToPct(rules.takerWeightBps);
  const mp = bpsToPct(rules.makerWeightBps);
  return (
    <div className="sxb-calc">
      <div className="sxb-calc__in">
        <label className="sxb-calc__row"><span>Taker fills <small>count {tp}%</small></span><output className="sx-num">{compact(taker)}</output></label>
        <div className="sxb-calc__sl"><Slider value={tt} min={0} max={STEPS} onChange={setTt} label={`Taker fills: ${compact(taker)}`} minLabel="$0" maxLabel="$10M" /></div>
        <label className="sxb-calc__row"><span>Maker fills <small>count {mp}%</small></span><output className="sx-num">{compact(maker)}</output></label>
        <div className="sxb-calc__sl"><Slider value={tm} min={0} max={STEPS} onChange={setTm} label={`Maker fills: ${compact(maker)}`} minLabel="$0" maxLabel="$10M" /></div>
      </div>
      <div className="sxb-calc__out">
        <div className="sxb-calc__big"><BoxArt level="Common" size={56} /><div><b className="sx-num">{count(r.boxes)}</b><span>{r.boxes === 1 ? 'box' : 'boxes'}</span></div></div>
        <dl className="rf-kv">
          <div><dt>Effective volume</dt><dd>{compact(r.effective)}</dd></div>
          <div><dt>To the next box</dt><dd>{usd(Math.round(r.toNext))}</dd></div>
          <div title="The rules do not say which tier a trade box is; SoDEX's own example is a Common"><dt>Merged up, all Common</dt><dd>{r.boxes > 0 ? upText : '—'}</dd></div>
        </dl>
        <ProgressBar value={rules.volumePerBoxU - r.toNext} max={rules.volumePerBoxU} size="sm" label="Toward the next box" valueText={`${usd(Math.round(rules.volumePerBoxU - r.toNext))} of ${usd(rules.volumePerBoxU)}`} />
        {r.capped && <p className="sxb-note">Capped at {count(rules.maxTradeBoxesPerWallet as number)} trade boxes a wallet.</p>}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------------------- the shelf ----- */

function Shelf({ w, rules }: { w: WalletRead; rules: LotteryRules | null }) {
  if (w.state !== 'ok') {
    return (
      <div className="sxb-shelf2 is-empty">
        {LEVELS.map((l) => <div key={l} className={`sxb-slot is-${l}`}><BoxArt level={l} size={56} /><b>{w.state === 'loading' ? <Skeleton className="sxb-slot__skel" /> : '—'}</b><small>{levelName(l)}</small></div>)}
        <ShelfState w={w} />
      </div>
    );
  }
  const c = countsOf(w.boxes);
  const steps = rules ? mergeLadder(rules) : [];
  return (
    <>
      <div className="sxb-shelf2">
        {LEVELS.map((l) => {
          const step = steps.find((s) => s.from === l);
          const have = c ? c[l] : null;
          return (
            <div key={l} className={`sxb-slot is-${l}${have ? ' is-on' : ''}`}>
              <BoxArt level={l} size={56} />
              <b className="sx-num">{have === null ? '—' : count(have)}</b>
              <small>{levelName(l)}</small>
              {step && have !== null && (
                <div className="sxb-slot__merge">
                  <ProgressBar value={Math.min(have, step.consume)} max={step.consume} size="sm" tone={have >= step.consume ? 'positive' : 'neutral'} label={`${levelName(l)} toward a merge`} valueText={`${Math.min(have, step.consume)} of ${step.consume}`} />
                  <span>{have >= step.consume ? <span className="pos">{count(Math.floor(have / step.consume))} merge{Math.floor(have / step.consume) === 1 ? '' : 's'} ready</span> : `${count(step.consume - have)} more to merge`}</span>
                </div>
              )}
              {!step && <div className="sxb-slot__merge"><span className="sx-faint">Top tier</span></div>}
            </div>
          );
        })}
      </div>
      {rules && <MergePlan w={w} rules={rules} />}
    </>
  );
}

function ShelfState({ w }: { w: WalletRead }) {
  if (w.state === 'connect') return <p className="sxb-shelf2__say">Connect a wallet to put its boxes on the shelf. <ConnectLink /></p>;
  if (w.state === 'error') return <p className="sxb-shelf2__say">Your boxes could not be read. <button type="button" className="rf-text is-link" onClick={w.retry}>Try again</button></p>;
  return <p className="sxb-shelf2__say">Reading your boxes off ValueChain…</p>;
}

function ConnectLink() {
  return <button type="button" className="rf-text is-link" onPointerEnter={warmWalletModal} onClick={() => void openConnectDialog()}>Connect wallet</button>;
}


