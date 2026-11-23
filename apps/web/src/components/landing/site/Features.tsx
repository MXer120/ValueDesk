/**
 * The features section (owner 2026-11-23: V3's feature cards, the market picker swapped out; tabs, bento and sticky-scroll
 * variations were tried and dropped - "the original one, all the others look worse"). Six features, the whole product
 * rather than mostly bots, each with its own drawing: liquidations, copy, bots, who traded each candle, always on,
 * cross-venue. V3's card grid, two rows of three.
 * Facts as everywhere (shared.tsx): venues from gridModel, fees from FEES, counts live. Drawings carry no figures.
 */
import type { ReactNode } from 'react';
import { COPY_VENUES, GRID_VENUES } from '../../copy/gridModel';
import { VENUE_LABEL } from '../../../vsApi';
import { BookViz, Eyebrow, HeatViz, Reveal } from '../Home';
import { FollowViz as V3Follow, HeatField, HubViz, SleepViz } from '../v3/V3';
import { CandleViz } from './Pages';
import { Embed, IC } from './Site';
import './features.css';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');
const names = (vs: readonly string[]) => vs.map((v) => VENUE_LABEL[v as keyof typeof VENUE_LABEL]);
const list = (xs: string[], conj = 'and') => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${conj} ${xs[xs.length - 1]}`);

type Key = 'liq' | 'copy' | 'bots' | 'flow' | 'always' | 'cross';
interface Feat { k: Key; tag: string; t: string; s: string; ic: ReactNode }

const FEATS: Feat[] = [
  { k: 'liq', tag: 'Analytics · free', t: 'See the liquidations first', s: `Where positions on ${GRID_VENUES.length} venues get liquidated, over the chart, live and as history.`, ic: IC.heat },
  { k: 'copy', tag: 'Copy trading', t: 'Follow any trader', s: `Copy a ${list(names(COPY_VENUES), 'or')} wallet trade for trade, at your size and under your leverage cap.`, ic: IC.copy },
  { k: 'bots', tag: 'Bots', t: 'Market makers that never sleep', s: 'Quotes on both sides of the book, or a grid across a range, within the holding and loss limit you set.', ic: IC.bot },
  { k: 'flow', tag: 'Analytics · free', t: 'Who traded each candle', s: "Each candle's volume broken down by the wallets that traded it, right beside the chart.", ic: <svg viewBox="0 0 24 24"><path d="M6 20V9M12 20V4M18 20v-7" /></svg> },
  { k: 'always', tag: 'Always on', t: 'Runs with the laptop closed', s: "Bots and hosted copies run on ValueDesk's executor in Tokyo, around the clock, until your limits or you stop them.", ic: <svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></svg> },
  { k: 'cross', tag: 'Cross-venue', t: 'Five venues, one desk', s: `Traders and liquidations from ${list(names(GRID_VENUES))}; funding compared between SoDEX and Hyperliquid.`, ic: IC.cross },
];
/** The drawing for a feature. `big` picks the canvas field for large stages. Needs the `.v3` scope around it. */
function Vis({ k, big }: { k: Key; big?: boolean }) {
  switch (k) {
    case 'liq': return big ? <HeatField className="vd-fv-heat" /> : <div className="vd-fv-pad"><HeatViz /></div>;
    case 'copy': return <V3Follow />;
    case 'bots': return <div className="vd-fv-pad"><BookViz /></div>;
    case 'flow': return <div className="vd-fv-pad vd-fv-candles"><CandleViz /></div>;
    case 'always': return <SleepViz />;
    case 'cross': return <HubViz />;
  }
}

function Head({ title }: { title: ReactNode }) {
  return (
    <Reveal className="h-head">
      <Eyebrow>Features</Eyebrow>
      <h2 className="h-h2">{title}</h2>
    </Reveal>
  );
}

/* ------------------------------------------------------------------------------------------- A: cards ----- */

export function FeaturesCards() {
  return (
    <section className="vd-sec" id="features">
      <Head title={<>Everything on one desk.<br /><span>Each part does one job.</span></>} />
      <Embed scope="v3">
        <div className="v3-grid">
          {FEATS.map((f, i) => (
            <Reveal key={f.k} className="v3-feat" delay={(i % 3) * 80}>
              <div className="v3-viz">{<Vis k={f.k} />}</div>
              <p className="vd-ftag">{f.tag}</p>
              <h3>{f.t}</h3>
              <p>{f.s}</p>
            </Reveal>
          ))}
        </div>
      </Embed>
    </section>
  );
}
