/**
 * A widget's card in the edit palette, the tab sidebar and a layout thumbnail:
 * a small drawing of the real panel - its tab bar, its columns, its chart or
 * its ticket - in the app's own colours (panel fill, the bullish and bearish
 * green and red). Logos are the app's own marks. Every figure is a bar, never a
 * number: nothing here is a fake price. Sizes are container units, so the same
 * drawing reads in a 200px card and a 30px layout cell.
 */
import type { ReactNode } from 'react';
import { brandLogo, coinLogo } from '../logos';
import './sketches.css';

type Tone = 'up' | 'dn' | 'mute' | 'dim' | 'accent';

function Mark({ name, brand }: { name: string; brand?: string | null }) {
  const src = brand ?? coinLogo(name);
  if (!src) return <span className="sk-mark" />;
  return <img className="sk-mark" src={src} alt="" />;
}

const SOD = brandLogo('SODEX');
const HL = coinLogo('HYPE');

/** A bar standing in for a word or a figure. */
const B = ({ w, t, grow }: { w?: number; t?: Tone; grow?: boolean }) => (
  <i className={`sk-b${t ? ` is-${t}` : ''}${grow ? ' is-grow' : ''}`} style={w ? { width: `${w}%` } : undefined} />
);

/** The panel's tab bar: the first tab on. */
const Tabs = ({ n, on = 0 }: { n: number; on?: number }) => (
  <span className="sk-tabs">
    {Array.from({ length: n }, (_, i) => <i key={i} className={i === on ? 'is-on' : ''} />)}
  </span>
);

/** A segmented switch (All / SoDEX / Hyperliquid, 24H / 7D / 30D). */
const Seg = ({ n, on = 0, right }: { n: number; on?: number; right?: boolean }) => (
  <span className={`sk-seg${right ? ' is-right' : ''}`}>
    {Array.from({ length: n }, (_, i) => <i key={i} className={i === on ? 'is-on' : ''} />)}
  </span>
);

const Row = ({ children, cls = '' }: { children: ReactNode; cls?: string }) => <span className={`sk-r ${cls}`}>{children}</span>;
const Head = ({ cols }: { cols: number[] }) => (
  <Row cls="sk-head">{cols.map((w, i) => <B key={i} w={w} t="dim" />)}</Row>
);

/** The drawing: `.sk` is the size container (its units are the card's), `.sk-in` the panel inside it. */
const Panel = ({ children, cls = '' }: { children: ReactNode; cls?: string }) => (
  <span className="sk"><span className={`sk-in ${cls}`}>{children}</span></span>
);

const COINS = ['BTC', 'ETH', 'SOL', 'HYPE', 'BNB'];

/** Candles: up-trending, the last one live. Shapes only; no axis figures. */
function Candles() {
  const c = [
    [30, 22, 34, 18, 1], [24, 28, 31, 20, 0], [27, 19, 29, 16, 1], [20, 23, 26, 17, 0],
    [22, 15, 24, 12, 1], [16, 18, 21, 13, 0], [18, 12, 20, 9, 1], [13, 9, 15, 6, 1],
    [10, 14, 17, 8, 0], [14, 10, 16, 7, 1], [11, 6, 12, 4, 1], [7, 9, 11, 5, 0], [9, 5, 10, 3, 1],
  ] as const;
  return (
    <svg className="sk-candles" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      {c.map(([o, cl, hi, lo, up], i) => {
        const x = 4 + i * 7.2;
        const top = Math.min(o, cl);
        return (
          <g key={i} className={up ? 'is-up' : 'is-dn'}>
            <line x1={x + 2} x2={x + 2} y1={lo} y2={hi} />
            <rect x={x} y={top} width={4} height={Math.max(1, Math.abs(o - cl))} />
          </g>
        );
      })}
      <line className="sk-last" x1="0" x2="100" y1="5" y2="5" />
    </svg>
  );
}

function Treemap({ tiles }: { tiles: { name: string; c: string; r: string; t: 'up' | 'dn'; s?: 1 | 2 }[] }) {
  return (
    <span className="sk-tree">
      {tiles.map((x, i) => (
        <i key={`${x.name}-${i}`} className={`is-${x.t}${x.s === 2 ? ' is-deep' : ''}`} style={{ gridColumn: x.c, gridRow: x.r }}>
          <Mark name={x.name} />
        </i>
      ))}
    </span>
  );
}

const TREE = [
  { name: 'BTC', c: '1 / 4', r: '1 / 5', t: 'dn' as const, s: 2 as const },
  { name: 'ETH', c: '4 / 6', r: '1 / 3', t: 'dn' as const },
  { name: 'SOL', c: '6 / 7', r: '1 / 3', t: 'up' as const },
  { name: 'HYPE', c: '4 / 5', r: '3 / 5', t: 'up' as const, s: 2 as const },
  { name: 'BNB', c: '5 / 6', r: '3 / 4', t: 'dn' as const },
  { name: 'XRP', c: '5 / 6', r: '4 / 5', t: 'dn' as const },
  { name: 'DOGE', c: '6 / 7', r: '3 / 5', t: 'dn' as const, s: 2 as const },
];

/** A ticket: side switch, order type tabs, two fields, the size slider and the button. */
function Ticket({ quick }: { quick?: boolean }) {
  return (
    <Panel cls="sk-ticket">
      <span className="sk-side"><i className="is-long" /><i /></span>
      {!quick && <Tabs n={4} on={1} />}
      <span className="sk-field"><B w={30} t="dim" /><B w={22} /></span>
      {!quick && <span className="sk-field"><B w={34} t="dim" /><B w={18} /></span>}
      <span className="sk-slider"><i /><b /></span>
      <span className="sk-cta" />
    </Panel>
  );
}

/** Rows of a table with a coin first. */
function CoinRows({ n = 4, cells, tone }: { n?: number; cells: number[]; tone?: (i: number) => Tone | undefined }) {
  return (
    <>
      {COINS.slice(0, n).map((name, i) => (
        <Row key={name}>
          <Mark name={name} />
          {cells.map((w, j) => <B key={j} w={w} t={j === cells.length - 1 ? tone?.(i) : undefined} />)}
        </Row>
      ))}
    </>
  );
}

const upDn = (i: number): Tone => (i % 3 === 1 ? 'dn' : 'up');

export function Sketch({ id }: { id: string }) {
  switch (id) {
    case 'chart':
      return (
        <Panel cls="sk-chart">
          <Row cls="sk-tools"><B w={8} t="mute" /><B w={8} t="dim" /><B w={8} t="dim" /><B w={8} t="dim" /><span className="sk-sp" /><B w={12} t="dim" /></Row>
          <span className="sk-plot"><Candles /><span className="sk-axis"><B t="dim" /><B t="dim" /><B t="accent" /><B t="dim" /></span></span>
        </Panel>
      );
    case 'book':
      return (
        <Panel cls="sk-book">
          <Tabs n={2} />
          {[64, 40, 78, 30, 52].map((d, i) => (
            <Row key={`a${i}`} cls="sk-depth is-ask"><B w={24} t="dn" /><span className="sk-sp" /><B w={18} /><i className="sk-bar" style={{ width: `${d}%` }} /></Row>
          ))}
          <Row cls="sk-mid"><B w={34} t="up" /><span className="sk-sp" /><B w={14} t="dim" /></Row>
          {[36, 70, 48, 86, 58].map((d, i) => (
            <Row key={`b${i}`} cls="sk-depth is-bid"><B w={24} t="up" /><span className="sk-sp" /><B w={18} /><i className="sk-bar" style={{ width: `${d}%` }} /></Row>
          ))}
        </Panel>
      );
    case 'exec':
      return <Ticket />;
    case 'quick':
      return <Ticket quick />;
    case 'tape':
      return (
        <Panel>
          <Head cols={[22, 18, 14]} />
          {[1, 0, 0, 1, 0, 1, 1].map((up, i) => (
            <Row key={i} cls="sk-cols3"><B w={26} t={up ? 'up' : 'dn'} /><B w={16 + (i % 3) * 6} /><B w={14} t="dim" /></Row>
          ))}
        </Panel>
      );
    case 'markets':
      return (
        <Panel cls="sk-strip">
          {COINS.slice(0, 4).map((name) => <span key={name} className="sk-chip"><Mark name={name} /><B grow /></span>)}
        </Panel>
      );
    case 'ticker':
      return (
        <Panel cls="sk-ticker">
          <Row><Mark name="BTC" /><B w={22} /><span className="sk-big" /></Row>
          <span className="sk-stats">
            {[0, 1, 2, 3].map((i) => <span key={i}><B w={70} t="dim" /><B w={i === 1 ? 50 : 80} t={i === 1 ? 'dn' : undefined} /></span>)}
          </span>
        </Panel>
      );
    case 'watch':
      return (
        <Panel>
          <Head cols={[26, 16, 12]} />
          {COINS.slice(0, 4).map((name, i) => (
            <Row key={name}><Mark name={name} /><B w={24} /><span className="sk-sp" /><B w={18} /><i className={`sk-pill is-${upDn(i)}`} /></Row>
          ))}
        </Panel>
      );

    case 'positions':
      return (
        <Panel>
          <Tabs n={6} />
          <Head cols={[14, 10, 12, 12, 10]} />
          <CoinRows n={3} cells={[12, 14, 12, 10]} tone={upDn} />
        </Panel>
      );
    case 'account':
      return (
        <Panel cls="sk-kv">
          <Row cls="sk-title"><B w={30} /><span className="sk-sp" /><B w={18} t="dim" /></Row>
          {[44, 30, 36].map((w, i) => <Row key={i}><B w={30} t="dim" /><span className="sk-sp" /><B w={w} /></Row>)}
          <span className="sk-meter"><i style={{ width: '38%' }} /></span>
        </Panel>
      );
    case 'assets':
      return (
        <Panel>
          <Head cols={[20, 14, 14]} />
          {['USDC', 'BTC', 'ETH', 'SOL'].map((name, i) => (
            <Row key={name}><Mark name={name} /><B w={18} /><span className="sk-sp" /><B w={[30, 20, 16, 12][i]} /></Row>
          ))}
        </Panel>
      );
    case 'orders':
      return (
        <Panel>
          <Head cols={[14, 10, 14, 12]} />
          {COINS.slice(0, 4).map((name, i) => (
            <Row key={name}><Mark name={name} /><i className={`sk-tag is-${i % 2 ? 'dn' : 'up'}`} /><B w={18} /><B w={14} /><span className="sk-sp" /><i className="sk-x" /></Row>
          ))}
        </Panel>
      );
    case 'fills':
      return (
        <Panel>
          <Head cols={[14, 10, 14, 10]} />
          <CoinRows n={4} cells={[10, 18, 12]} tone={() => 'dim'} />
        </Panel>
      );
    case 'history':
      return (
        <Panel>
          <Seg n={4} />
          <Head cols={[14, 12, 14, 10]} />
          <CoinRows n={3} cells={[16, 14, 12]} tone={upDn} />
        </Panel>
      );
    case 'transfers':
      return (
        <Panel>
          <Head cols={[16, 22, 12]} />
          {[1, 0, 1, 1].map((inn, i) => (
            <Row key={i}><i className={`sk-arrow is-${inn ? 'in' : 'out'}`} /><B w={26} /><span className="sk-sp" /><B w={16} t={inn ? 'up' : 'dn'} /><B w={12} t="dim" /></Row>
          ))}
        </Panel>
      );
    case 'twap':
    case 'twaplive':
      return (
        <Panel>
          <Seg n={3} on={id === 'twaplive' ? 1 : 0} />
          {[{ n: 'BTC', w: 62 }, { n: 'ETH', w: 34 }, { n: 'SOL', w: id === 'twaplive' ? 80 : 100 }].map((r, i) => (
            <Row key={r.n}>
              {id === 'twaplive' && <i className="sk-live" />}
              <Mark name={r.n} /><B w={14} t="dim" />
              <span className="sk-track"><i className={i === 2 && id !== 'twaplive' ? 'is-done' : ''} style={{ width: `${r.w}%` }} /></span>
            </Row>
          ))}
        </Panel>
      );
    case 'copy':
      return (
        <Panel cls="sk-cards">
          {[0, 1].map((i) => (
            <span key={i} className="sk-card">
              <Row><i className={`sk-avatar is-${i}`} /><B w={40} /><span className="sk-sp" /><B w={22} t={i ? 'dn' : 'up'} /></Row>
              <span className="sk-meter"><i style={{ width: i ? '36%' : '64%' }} /></span>
            </span>
          ))}
        </Panel>
      );

    case 'heatmap':
      return <Panel cls="sk-full"><Treemap tiles={TREE} /></Panel>;
    case 'cohort':
      return (
        <Panel cls="sk-full">
          <Row cls="sk-title"><B w={24} /><span className="sk-sp" /><span className="sk-lean"><i style={{ width: '49%' }} /></span></Row>
          <Treemap tiles={TREE.map((x, i) => ({ ...x, t: i % 2 ? 'up' : 'dn' }))} />
        </Panel>
      );
    case 'funding':
      return (
        <Panel>
          <Row cls="sk-head"><B w={18} t="dim" /><span className="sk-sp" /><Mark name="S" brand={SOD} /><Mark name="HYPE" brand={HL} /><B w={14} t="dim" /></Row>
          {COINS.slice(0, 4).map((name, i) => (
            <Row key={name}><Mark name={name} /><B w={16} /><span className="sk-sp" /><B w={12} /><B w={12} /><B w={14} t={upDn(i)} /></Row>
          ))}
        </Panel>
      );
    case 'indicator':
      return (
        <Panel cls="sk-chart">
          <Seg n={5} />
          <span className="sk-cols">
            {[46, 58, 52, 64, 40, 70, 62, 54, 76].map((h, i) => <i key={i} className={i === 8 ? 'is-accent' : ''} style={{ height: `${h}%` }} />)}
          </span>
        </Panel>
      );
    case 'etfflows':
      return (
        <Panel cls="sk-chart">
          <Seg n={4} />
          <span className="sk-flows">
            {[30, -18, 44, 22, -36, 52, -12, 28, 40, -24, 34].map((v, i) => (
              <span key={i}><i className={v > 0 ? 'is-up' : 'is-dn'} style={{ height: `${Math.abs(v) * 0.9}%`, [v > 0 ? 'bottom' : 'top']: '50%' }} /></span>
            ))}
          </span>
        </Panel>
      );
    case 'liqmap':
      return (
        <Panel cls="sk-chart">
          <Row cls="sk-tools"><B w={10} t="mute" /><B w={10} t="dim" /><B w={10} t="dim" /><span className="sk-sp" /><B w={16} t="dim" /></Row>
          <svg className="sk-liqcurve" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
            <path className="is-dn" d="M0 6 H8 V10 H16 V15 H22 V19 H30 V25 H36 V30 H42 V35 H48 V40 H0 Z" />
            <path className="is-up" d="M52 40 V36 H58 V31 H63 V27 H70 V20 H76 V15 H84 V9 H92 V4 H100 V40 Z" />
            <line x1="50" x2="50" y1="0" y2="40" />
          </svg>
        </Panel>
      );

    case 'poschg':
      return (
        <Panel>
          <Seg n={3} right />
          {[1, 0, 1, 0].map((up, i) => (
            <Row key={i}><Mark name={i % 2 ? 'HYPE' : 'S'} brand={i % 2 ? HL : SOD} /><B w={14} /><B w={10} t={up ? 'up' : 'dn'} /><span className="sk-sp" /><B w={18} /><B w={12} t="dim" /></Row>
          ))}
        </Panel>
      );
    case 'news':
      return (
        <Panel>
          <Tabs n={4} />
          {[78, 64, 72].map((w, i) => (
            <span key={i} className="sk-item"><i className="sk-src" /><span><B w={w} /><B w={w - 30} t="dim" /></span><B w={10} t="dim" /></span>
          ))}
        </Panel>
      );
    case 'livefeed':
    case 'fedlive':
      return (
        <Panel cls={id === 'fedlive' ? 'sk-video is-fed' : 'sk-video'}>
          <span className="sk-screen"><i className="sk-play" /><i className="sk-onair" /></span>
          {id === 'fedlive' ? <><B w={86} t="dim" /><B w={70} t="dim" /></> : <Row><B w={52} /><span className="sk-sp" /><B w={14} t="dim" /></Row>}
        </Panel>
      );
    case 'fedwatch':
      return (
        <Panel>
          <Head cols={[30, 14]} />
          {[72, 24, 4].map((w, i) => (
            <Row key={i}><B w={22} t="dim" /><span className="sk-track is-wide"><i className={i === 0 ? '' : 'is-mute'} style={{ width: `${w}%` }} /></span></Row>
          ))}
        </Panel>
      );
    case 'cohorts':
      return (
        <Panel>
          <Head cols={[22, 30, 14]} />
          {[58, 44, 66, 38].map((l, i) => (
            <Row key={i}><B w={22} /><span className="sk-split"><i style={{ width: `${l}%` }} /></span><B w={14} t={upDn(i)} /></Row>
          ))}
        </Panel>
      );
    case 'toptraders':
    case 'leaderboard':
      return (
        <Panel>
          {id === 'leaderboard' ? <Seg n={4} /> : <Row cls="sk-head"><Mark name="S" brand={SOD} /><Mark name="HYPE" brand={HL} /><span className="sk-sp" /><Seg n={3} /></Row>}
          {[0, 1, 2, 3].map((i) => (
            <Row key={i}><i className="sk-rank" /><i className={`sk-avatar is-${i % 3}`} /><B w={30} /><span className="sk-sp" /><B w={22 - i * 3} t="up" /></Row>
          ))}
        </Panel>
      );
    case 'sizecalc':
      return (
        <Panel cls="sk-form">
          {[0, 1, 2].map((i) => <span key={i} className="sk-field"><B w={34} t="dim" /><B w={16} /></span>)}
          <Row cls="sk-out"><B w={30} t="up" /><span className="sk-sp" /><B w={22} /></Row>
        </Panel>
      );
    case 'feetier':
      return (
        <Panel>
          <Row cls="sk-title"><B w={26} /><span className="sk-sp" /><B w={16} t="dim" /></Row>
          <span className="sk-ladder">
            {[22, 38, 54, 70, 86].map((h, i) => <i key={i} className={i === 1 ? 'is-on' : ''} style={{ height: `${h}%` }} />)}
          </span>
        </Panel>
      );
    case 'venue':
      return (
        <Panel>
          {[{ b: SOD, n: 'S' }, { b: HL, n: 'HYPE' }].map((v) => (
            <Row key={v.n} cls="sk-tall"><Mark name={v.n} brand={v.b} /><B w={28} /><span className="sk-sp" /><B w={14} t="dim" /><i className="sk-dot" /></Row>
          ))}
          <Row><B w={40} t="dim" /></Row>
        </Panel>
      );
    default:
      return (
        <Panel>
          <Head cols={[20, 16, 14]} />
          <CoinRows n={3} cells={[18, 14, 12]} />
        </Panel>
      );
  }
}
