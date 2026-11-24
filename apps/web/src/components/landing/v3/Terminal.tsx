/**
 * Version 3's hero (owner 2026-11-24): the trade page itself in 3D - the app's frame as a slab, its chart, order book,
 * ticket and positions as layers above it - switching between a bot and a copy at work on it.
 * Live: BTC's candles and book, straight from SoDEX (no server of ours), read only while it is on screen; the bot's cost
 * (useLiveDesk) and the top copy trader (the public boards). The bot, the copy and the settings are an example, said so.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, type Kline, type OrderBook } from '../../../api';
import { BrandMark } from '../../BrandMark';
import { CoinIcon } from '../../CoinIcon';
import { VenueLogo } from '../../VenueLogo';
import { liteDevice, reducedMotion, usdShort, useTopTraders, type LiveDesk } from '../shared';
import './terminal.css';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');
const SYM = 'BTC-USD';
const N = 64;
type Mode = 'bots' | 'copy';

function useMarket(on: boolean): { k: Kline[]; book: OrderBook | null } {
  const [k, setK] = useState<Kline[]>([]);
  const [book, setBook] = useState<OrderBook | null>(null);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    const slow = liteDevice() || reducedMotion();
    const read = () => {
      if (document.visibilityState !== 'visible') return;
      api.orderbook('perps', SYM, 20).then((b) => { if (alive) setBook(b.book); }, () => {});
    };
    const candles = () => {
      if (document.visibilityState !== 'visible') return;
      api.klines('perps', SYM, '5m', N).then((x) => { if (alive) setK([...x.klines].sort((a, b) => a.t - b.t).slice(-N)); }, () => {});
    };
    candles();
    read();
    const a = window.setInterval(read, slow ? 15_000 : 4_000);
    const b = window.setInterval(candles, 30_000);
    return () => { alive = false; window.clearInterval(a); window.clearInterval(b); };
  }, [on]);
  return { k, book };
}

const num = (v: number, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Candles and volume in a 640 x 300 drawing, the price axis beside them. */
function ChartLayer({ k, bid, ask, mode }: { k: Kline[]; bid: number | null; ask: number | null; mode: Mode }) {
  const g = useMemo(() => {
    if (k.length < 48) return null;
    const xs = k.map((c) => ({ o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v }));
    const lo = Math.min(...xs.map((c) => c.l));
    const hi = Math.max(...xs.map((c) => c.h));
    const pad = (hi - lo) * 0.12 || 1;
    const y = (p: number) => 14 + ((hi + pad - p) / (hi - lo + 2 * pad)) * 226;
    const vm = Math.max(...xs.map((c) => c.v)) || 1;
    const w = 640 / xs.length;
    let up = '', dn = '', vu = '', vd = '';
    xs.forEach((c, i) => {
      const x = i * w + w / 2;
      const top = y(Math.max(c.o, c.c));
      const h = Math.max(1, Math.abs(y(c.o) - y(c.c)));
      const d = `M${x.toFixed(1)} ${y(c.h).toFixed(1)}V${y(c.l).toFixed(1)}M${(x - w * 0.3).toFixed(1)} ${top.toFixed(1)}h${(w * 0.6).toFixed(1)}v${h.toFixed(1)}h${(-w * 0.6).toFixed(1)}z`;
      const v = `M${(x - w * 0.3).toFixed(1)} 298v${((-c.v / vm) * 38).toFixed(1)}h${(w * 0.6).toFixed(1)}V298z`;
      if (c.c >= c.o) { up += d; vu += v; } else { dn += d; vd += v; }
    });
    const step = (hi - lo + 2 * pad) / 5;
    return { up, dn, vu, vd, y, w, xs, axis: [0.5, 1.5, 2.5, 3.5, 4.5].map((q) => hi + pad - q * step) };
  }, [k]);
  if (!g) return <div className="tm-chart is-empty" />;
  const end = g.xs[g.xs.length - 1]!;
  const pct = (p: number) => `${g.y(p) / 3}%`;
  // The copy's example: the leader's entry where the window was lowest of its middle, yours right after it.
  const half = g.xs.slice(8, 42);
  const at = 8 + half.reduce((b, c, i) => (c.l < half[b]!.l ? i : b), 0);
  const left = (i: number) => `${((i * g.w + g.w / 2) / 640) * 92}%`;
  return (
    <div className="tm-chart">
      <svg viewBox="0 0 640 300" preserveAspectRatio="none">
        {g.axis.map((p) => <line key={p} className="tm-grid" x1="0" x2="640" y1={g.y(p)} y2={g.y(p)} />)}
        <path className="is-up v" d={g.vu} /><path className="is-dn v" d={g.vd} />
        <path className="is-up" d={g.up} /><path className="is-dn" d={g.dn} />
        <line className="tm-last" x1="0" x2="640" y1={g.y(end.c)} y2={g.y(end.c)} />
      </svg>
      {g.axis.map((p) => <span key={p} className="tm-ax" style={{ top: pct(p) }}>{num(p)}</span>)}
      <span className={cx('tm-lastp', end.c >= end.o && 'is-up')} style={{ top: pct(end.c) }}>{num(end.c)}</span>
      {mode === 'bots' ? (
        <>
          <span className="tm-quote is-ask" style={{ top: `calc(${pct(end.c)} - 26px)` }}><b>Sell</b>{ask ? num(ask) : ''}</span>
          <span className="tm-quote is-bid" style={{ top: `calc(${pct(end.c)} + 26px)` }}><b>Buy</b>{bid ? num(bid) : ''}</span>
        </>
      ) : (
        <>
          <span className="tm-mk is-lead" style={{ left: left(at), top: pct(g.xs[at]!.l) }}>Leader buys</span>
          <span className="tm-mk is-you" style={{ left: left(at + 1), top: pct(g.xs[at]!.l) }}>You buy</span>
        </>
      )}
    </div>
  );
}

const ROWS = 8;
function BookLayer({ book }: { book: OrderBook | null }) {
  const cum = (xs: Array<[string, string]>) => { let s = 0; return xs.slice(0, ROWS).map(([p, q]) => ({ p: +p, q: +q, s: (s += +q) })); };
  const a = cum(book?.asks ?? []);
  const b = cum(book?.bids ?? []);
  const max = Math.max(a[a.length - 1]?.s ?? 0, b[b.length - 1]?.s ?? 0) || 1;
  const side = (xs: typeof a, cls: string) => (xs.length ? xs : Array.from({ length: ROWS }, (_, i) => ({ p: 0, q: 0, s: (i + 1) / ROWS })))
    .map((x, i) => <div key={i} className={`tm-ob__r ${cls}`} style={{ '--w': xs.length ? x.s / max : x.s } as CSSProperties}><span>{x.p ? num(x.p) : ''}</span><span>{x.p ? x.q.toFixed(3) : ''}</span></div>);
  return (
    <div className="tm-ob">
      <div className="tm-tabs"><b>Order Book</b><span>Trades</span></div>
      <div className="tm-ob__h"><span>Price</span><span>Size (BTC)</span></div>
      {side(a, 'ask').reverse()}
      <div className="tm-ob__m">{a[0] && b[0] ? num((a[0].p + b[0].p) / 2) : ''}</div>
      {side(b, 'bid')}
    </div>
  );
}

const Bar = ({ l, k }: { l: string; k: number }) => <div className="tm-f"><span>{l}</span><em>yours</em><i style={{ '--k': k } as CSSProperties} /></div>;

/** The terminal. `live`: the bots' costs. */
export function TerminalDesk({ live }: { live: LiveDesk }) {
  const box = useRef<HTMLDivElement>(null);
  const rig = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  const [mode, setMode] = useState<Mode>('bots');
  const [held, setHeld] = useState(false);
  const { k, book } = useMarket(on);
  const leader = useTopTraders(on)[0] ?? null;
  useEffect(() => {
    const b = box.current;
    const r = rig.current;
    if (!b || !r) return;
    const fit = () => {
      const s = Math.min(1, b.clientWidth / r.offsetWidth);
      b.style.setProperty('--s', s.toFixed(4));
      b.style.height = `${Math.round(r.offsetHeight * s)}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(b);
    const io = new IntersectionObserver(([e]) => setOn(!!e?.isIntersecting), { rootMargin: '120px' });
    io.observe(b);
    return () => { ro.disconnect(); io.disconnect(); };
  }, []);
  useEffect(() => {
    if (!on || held || reducedMotion()) return;
    const id = window.setInterval(() => setMode((m) => (m === 'bots' ? 'copy' : 'bots')), 6_500);
    return () => window.clearInterval(id);
  }, [on, held]);
  useEffect(() => {
    const b = box.current;
    if (!b || !on || reducedMotion() || liteDevice() || !matchMedia('(pointer: fine)').matches) return;
    let raf = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        b.style.setProperty('--mx', (e.clientX / window.innerWidth - 0.5).toFixed(3));
        b.style.setProperty('--my', (e.clientY / window.innerHeight - 0.5).toFixed(3));
      });
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => { window.removeEventListener('pointermove', move); cancelAnimationFrame(raf); };
  }, [on]);
  const bid = book?.bids[0] ? +book.bids[0][0] : null;
  const ask = book?.asks[0] ? +book.asks[0][0] : null;
  const last = k.length ? +k[k.length - 1]!.c : null;
  const first = k.length ? +k[0]!.o : null;
  const ch = last && first ? (last / first - 1) * 100 : null;
  const cost = live.rows.find((r) => r.m.base === 'BTC')?.bp ?? null;
  const layer = (cls: string, z: number, depth: number, i: number, child: ReactNode) => (
    <div className={cx('tm-l', cls)} style={{ '--z': z, '--k': depth } as CSSProperties}><div className="tm-l__in" style={{ '--i': i } as CSSProperties}>{child}</div></div>
  );
  return (
    <div className="tm" data-off={on ? undefined : ''}>
      <div className="tm-sw" role="group" aria-label="Show on the terminal">
        {(['bots', 'copy'] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} className={cx(mode === m && 'is-on')} onClick={() => { setHeld(true); setMode(m); }}>{m === 'bots' ? 'Bots' : 'Copy trading'}</button>)}
      </div>
      <div ref={box} className="tm-box" aria-hidden="true">
        <div ref={rig} className="tm-rig"><div className="tm-tilt">
          <div className="tm-slab">
            <div className="tm-rail"><BrandMark size={22} />{[0, 1, 2, 3, 4, 5].map((i) => <i key={i} className={cx(i === 0 && 'is-on')} />)}</div>
            <div className="tm-top"><span className="tm-seg"><b>Futures</b><span>Spot</span></span><b>Trade</b><span>Explore</span><span className={cx(mode === 'copy' && 'is-on')}>Copy</span><span>Portfolio</span><span>Scan</span><span className={cx(mode === 'bots' && 'is-on')}>Bots</span></div>
            <div className="tm-mkts">{['BTC', 'ETH', 'SOL', 'BNB'].map((c, i) => <span key={c} className={cx(i === 0 && 'is-on')}><CoinIcon coin={c} venue="SODEX" size={20} />{c}-USD</span>)}</div>
          </div>
          {layer('is-chart', 36, 0.5, 0, (
            <div className="tm-p">
              <div className="tm-mh">
                <CoinIcon coin="BTC" venue="SODEX" size={26} />
                <b>{last ? `$${num(last)}` : '—'}</b>
                <span><small>Last 5 h</small><em className={cx(ch !== null && (ch >= 0 ? 'is-up' : 'is-dn'))}>{ch === null ? '—' : `${ch >= 0 ? '+' : '−'}${Math.abs(ch).toFixed(2)}%`}</em></span>
                <span className="tm-tf"><small>1m</small><b>5m</b><small>15m</small><small>1H</small><small>4H</small></span>
              </div>
              <ChartLayer k={k} bid={bid} ask={ask} mode={mode} />
            </div>
          ))}
          {layer('is-book', 78, 0.8, 1, <div className="tm-p"><BookLayer book={book} /></div>)}
          {layer('is-pos', 56, 0.7, 2, (
            <div className="tm-p">
              <div className="tm-tabs"><b>Positions</b><span>Open Orders</span><span>Algos</span><span>Balances</span><span>Order History</span></div>
              <div key={mode} className="tm-row">
                {mode === 'bots' ? (
                  <><CoinIcon coin="BTC" venue="SODEX" size={22} /><div><b>Market maker</b><small>BTC-USD</small></div><div><b>Both sides</b><small>Quotes</small></div><div><b>Yours</b><small>Loss limit</small></div><div><b>Tokyo</b><small>Runs on</small></div><span className="tm-run"><i />Running</span></>
                ) : (
                  <>{leader ? <VenueLogo venue={leader.venue} size={22} /> : <i className="tm-sk" />}<div><b>{leader ? leader.label || `${leader.address.slice(0, 6)}…${leader.address.slice(-4)}` : 'Leader'}</b><small>Leader</small></div><div><b>Yours</b><small>Size</small></div><div><b>Yours</b><small>Leverage cap</small></div><div><b>Tokyo</b><small>Runs on</small></div><span className="tm-run"><i />Copying</span></>
                )}
              </div>
            </div>
          ))}
          {layer('is-ticket', 132, 1.3, 3, (
            <div className={cx('tm-p tm-tk', mode === 'copy' && 'is-copy')}>
              <div className="tm-tk__f">
                <div className="tm-tk__h"><b>New bot</b><span className="tm-chip">Market maker</span></div>
                <div className="tm-tk__big"><b className={cx(cost !== null && cost <= 0 && 'is-up')}>{cost === null ? '—' : `${cost <= 0 ? '+' : ''}$${num(Math.abs(cost) * 100)}`}</b><small>{cost !== null && cost <= 0 ? 'est. earned' : 'est. cost'} per $1M on BTC, VIP fee, 7 days</small></div>
                <div className="tm-seg3"><span>Steady</span><b>Balanced</b><span>Active</span></div>
                <Bar l="Order size" k={0.3} /><Bar l="Max holding" k={0.55} /><Bar l="Loss limit" k={0.4} />
                <div className="tm-btn">Start bot</div>
              </div>
              <div className="tm-tk__f is-c">
                <div className="tm-tk__h"><b>Copy a trader</b><span className="tm-chip">Hosted</span></div>
                <div className="tm-tk__big"><b className={cx(leader && leader.pnl >= 0 && 'is-up')}>{leader ? `${leader.pnl >= 0 ? '+' : '−'}${usdShort(Math.abs(leader.pnl))}` : '—'}</b><small>the top copy score's PnL, last 30 days</small></div>
                <div className="tm-seg3 is-2"><b>Copy</b><span>Counter</span></div>
                <Bar l="Your size" k={0.45} /><Bar l="Leverage cap" k={0.3} /><Bar l="Loss limit" k={0.5} />
                <div className="tm-btn">Start copying</div>
              </div>
            </div>
          ))}
          {layer('is-mark', 190, 1.8, 4, <div className="tm-mark"><BrandMark size={32} /></div>)}
        </div></div>
      </div>
      <p className="tm-note">Live BTC market on SoDEX. The bot and the copy shown are an example.</p>
    </div>
  );
}
