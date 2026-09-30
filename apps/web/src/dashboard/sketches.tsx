/**
 * Skeleton of the real panel. Logos are the app's own marks. Every number is
 * a bar: neutral for a label, green or red for a bullish or bearish figure.
 * Nothing here is a fake price.
 */
import { brandLogo, coinLogo } from '../logos';
import './sketches.css';

function Mark({ name, brand }: { name: string; brand?: string | null }) {
  const src = brand ?? coinLogo(name);
  if (!src) return <span className="sk-mark" />;
  return <img className="sk-mark" src={src} alt="" />;
}

const SOD = brandLogo('SODEX');
const HL = coinLogo('HYPE');

function Line() {
  return (
    <span className="sk sk-line">
      <svg viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 28 L16 24 L28 26 L44 14 L58 16 L74 8 L100 6" />
      </svg>
    </span>
  );
}

/** Asks above a spread rule, bids below. Depth is the bar; no prices. */
function Book() {
  const asks = [92, 74, 81, 56, 44];
  const bids = [88, 70, 63, 78, 40];
  return (
    <span className="sk sk-book">
      {asks.map((w, i) => <i key={`a${i}`} className="is-ask" style={{ width: `${w}%` }} />)}
      <i className="sk-spread" />
      {bids.map((w, i) => <i key={`b${i}`} className="is-bid" style={{ width: `${w}%` }} />)}
    </span>
  );
}

function Rows({ rows }: { rows: { name: string; brand?: string | null; tone: 'up' | 'dn' | 'mute'; w: number }[] }) {
  return (
    <span className="sk sk-rows">
      {rows.map((row) => (
        <span key={`${row.name}-${row.w}`} className="sk-row">
          <Mark name={row.name} brand={row.brand} />
          <i className="sk-bone" />
          <i className={`sk-bone is-${row.tone}`} style={{ width: `${row.w}%` }} />
        </span>
      ))}
    </span>
  );
}

function Heat({ names, cols }: { names: string[]; cols: number }) {
  return (
    <span className="sk sk-heat" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {names.map((name, i) => (
        <i key={`${name}-${i}`} className={i % 3 === 1 ? 'is-dn' : 'is-up'}>
          <Mark name={name} />
        </i>
      ))}
    </span>
  );
}

const COINS = [
  { name: 'BTC', tone: 'up' as const, w: 34 },
  { name: 'ETH', tone: 'dn' as const, w: 22 },
  { name: 'SOL', tone: 'up' as const, w: 28 },
];

export function Sketch({ id }: { id: string }) {
  switch (id) {
    case 'chart':
    case 'ticker':
      return <Line />;
    case 'book':
      return <Book />;
    case 'liq':
      return (
        <span className="sk sk-liq">
          <svg viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 6 C 30 8, 64 26, 100 32" />
          </svg>
          <span className="sk-bars">
            {[28, 62, 36, 84, 44, 22, 58].map((h, i) => (
              <i key={i} className={i % 2 ? 'is-up' : 'is-dn'} style={{ height: `${h}%` }} />
            ))}
          </span>
        </span>
      );
    case 'stops':
      return (
        <span className="sk sk-stops">
          <svg viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">
            <path className="is-up" d="M0 28 C 36 26, 62 10, 100 6" />
            <path className="is-dn" d="M0 8 C 34 12, 66 28, 100 32" />
          </svg>
        </span>
      );
    case 'funding':
      return (
        <span className="sk sk-funding">
          <svg viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">
            <path className="is-up" d="M0 20 L20 12 L40 16 L60 8 L80 12 L100 6 L100 20 Z" />
            <path className="is-dn" d="M0 20 L18 28 L40 24 L62 32 L82 28 L100 34 L100 20 Z" />
          </svg>
        </span>
      );
    case 'cohort':
      return <Heat cols={3} names={['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE', 'XRP']} />;
    case 'heatmap':
      return <Heat cols={4} names={['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE', 'XRP', 'AVAX', 'LINK']} />;
    case 'exec':
    case 'quick':
      return (
        <span className={`sk sk-ticket${id === 'quick' ? ' is-quick' : ''}`}>
          <i className="is-long" />
          <i className="is-short" />
          <i className="sk-bone" />
          {id === 'exec' && <i className="sk-bone" />}
          <i className="sk-bone is-up" />
        </span>
      );
    case 'markets':
      return (
        <span className="sk sk-chips">
          {['BTC', 'ETH', 'SOL', 'HYPE'].map((name) => <Mark key={name} name={name} />)}
        </span>
      );
    case 'news':
      return (
        <span className="sk sk-rows">
          {[78, 62, 70].map((w) => (
            <span key={w} className="sk-row">
              <i className="sk-bone is-up" style={{ width: '8%' }} />
              <i className="sk-bone" style={{ width: `${w}%` }} />
            </span>
          ))}
        </span>
      );
    case 'transfers':
      return (
        <span className="sk sk-xfer">
          <Mark name="USDC" />
          <i className="sk-bone is-up" />
          <Mark name="S" brand={SOD} />
        </span>
      );
    case 'twap':
    case 'twaplive':
      return (
        <span className="sk sk-rows">
          {[{ name: 'BTC', w: id === 'twaplive' ? 62 : 28 }, { name: 'ETH', w: 40 }].map((row) => (
            <span key={row.name} className="sk-row">
              <Mark name={row.name} />
              <i className="sk-track"><i className="is-up" style={{ width: `${row.w}%` }} /></i>
            </span>
          ))}
        </span>
      );
    case 'venue':
      return (
        <span className="sk sk-rows">
          <span className="sk-row"><Mark name="S" brand={SOD} /><i className="sk-bone" /><i className="sk-dot is-up" /></span>
          <span className="sk-row"><Mark name="HYPE" brand={HL} /><i className="sk-bone" /><i className="sk-dot is-up" /></span>
        </span>
      );
    case 'leaderboard':
    case 'toptraders':
      return (
        <Rows rows={[
          { name: 'BTC', tone: 'up', w: 40 },
          { name: 'ETH', tone: 'up', w: 28 },
          { name: 'SOL', tone: 'dn', w: 18 },
        ]} />
      );
    case 'tracked':
      return (
        <Rows rows={[
          { name: 'S', brand: SOD, tone: 'up', w: 30 },
          { name: 'HYPE', brand: HL, tone: 'dn', w: 18 },
          { name: 'S', brand: SOD, tone: 'up', w: 24 },
        ]} />
      );
    case 'cohorts':
      return (
        <span className="sk sk-rows">
          {[70, 48, 32].map((w, i) => (
            <span key={w} className="sk-row">
              <i className="sk-bone" style={{ width: '28%' }} />
              <i className={`sk-bone is-${i === 2 ? 'dn' : 'up'}`} style={{ width: `${w}%` }} />
            </span>
          ))}
        </span>
      );
    case 'sizecalc':
      return (
        <span className="sk sk-calc">
          <i className="sk-bone" />
          <i className="sk-bone" />
          <i className="sk-bone" />
          <i className="sk-bone is-up" />
        </span>
      );
    case 'feetier':
      return (
        <span className="sk sk-rows">
          {[40, 55, 70].map((w, i) => (
            <span key={w} className="sk-row">
              <i className={`sk-bone ${i === 2 ? 'is-up' : ''}`} style={{ width: `${w}%` }} />
            </span>
          ))}
        </span>
      );
    case 'poschg':
    case 'positions':
    case 'orders':
    case 'fills':
    case 'tape':
    case 'history':
    case 'copy':
    case 'watch':
      return <Rows rows={COINS.map((c, i) => ({ ...c, w: c.w - i * 4, tone: id === 'orders' && i === 0 ? 'up' : c.tone }))} />;
    case 'account':
    case 'assets':
      return (
        <Rows rows={[
          { name: 'USDC', tone: 'mute', w: 46 },
          { name: 'BTC', tone: 'mute', w: 30 },
          { name: 'ETH', tone: 'mute', w: 22 },
        ]} />
      );
    default:
      return <Line />;
  }
}
