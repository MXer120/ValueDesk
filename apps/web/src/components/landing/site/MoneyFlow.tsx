/**
 * Where your money goes (owner 2026-11-23: "ensure the graphic is actually accurate"). The drawing separates the two
 * things that move, because they move differently:
 *
 *   FUNDS (solid, green): only between your wallet and your SoDEX account (you deposit and withdraw), and between your
 *   account and SoDEX's book (margin and results settle in your account). ValueDesk never holds them.
 *   ORDERS (dashed, white): signed and sent by the ValueDesk executor (bots, hosted copies; with your trading key) or by
 *   your browser (your own trades in the terminal, browser copies). No funds pass through either.
 *   FEES: charged by SoDEX on each fill (trading/builder.ts, docs/BUILDER-CODES.md): SoDEX's own fee, and ValueDesk's
 *   fee, which SoDEX takes only on orders that name it and never above the maximum you approved.
 *   BLOCKED: the trading key can move funds only between your own SoDEX accounts and your wallet, never to anyone else.
 *
 * A drawing: no amounts on it. Wide screens get the SVG, phones a stacked version of the same five parts.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { BrandMark } from '../../BrandMark';
import { VenueLogo } from '../../VenueLogo';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');

function useSeen<T extends Element>(): [React.RefObject<T>, boolean, boolean] {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(false);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') { setOn(true); setSeen(true); return; }
    const io = new IntersectionObserver(([e]) => { if (!e) return; setOn(e.isIntersecting); if (e.isIntersecting) setSeen(true); }, { rootMargin: '0px 0px -12% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, on, seen];
}

const curve = (x1: number, y1: number, x2: number, y2: number, vertical = false) =>
  vertical
    ? `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`
    : `M${x1} ${y1} C${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${x2} ${y2}`;

function Node({ x, y, w, h, t, s, s2, kind }: { x: number; y: number; w: number; h: number; t: string; s?: string; s2?: string; kind?: 'acct' | 'book' | 'sign' | 'fee' | 'no' }) {
  const cy = y + h / 2 - (s2 ? 16 : s ? 8 : -6);
  return (
    <g className={cx('mf-node', kind && `is-${kind}`)}>
      <rect x={x} y={y} width={w} height={h} rx={22} />
      <text x={x + w / 2} y={cy} className="mf-t">{t}</text>
      {s && <text x={x + w / 2} y={cy + 24} className="mf-s">{s}</text>}
      {s2 && <text x={x + w / 2} y={cy + 44} className="mf-s">{s2}</text>}
    </g>
  );
}

export function MoneyFlow() {
  const [ref, on, seen] = useSeen<HTMLDivElement>();
  const funds = [
    { d: curve(200, 98, 330, 98), i: 0 },
    { d: curve(330, 124, 200, 124), i: 1 },
    { d: curve(630, 98, 760, 98), i: 2 },
    { d: curve(760, 124, 630, 124), i: 3 },
  ];
  const orders = [
    { d: curve(410, 330, 820, 162, true), i: 0 },
    { d: curve(670, 330, 860, 162, true), i: 1 },
  ];
  return (
    <div ref={ref} className={cx('mf', seen && 'is-in')} data-off={on ? undefined : ''}>
      <svg className="mf-wide" viewBox="0 0 1000 470" role="img" aria-label="Funds move only between your wallet, your SoDEX account and SoDEX's order book. The ValueDesk executor and your browser send orders, never funds. SoDEX charges its fee and ValueDesk's fee on each fill. The trading key cannot send funds to anyone else.">
        <defs>
          <linearGradient id="mf-node" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#262628" /><stop offset="1" stopColor="#101011" /></linearGradient>
          <linearGradient id="mf-acct" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0f2a22" /><stop offset="1" stopColor="#0a1411" /></linearGradient>
        </defs>

        {/* funds: two-way between wallet and account, account and book */}
        {funds.map((f) => <path key={`b${f.i}`} className="mf-band" d={f.d} />)}
        {funds.map((f) => <path key={`f${f.i}`} className="mf-fund" d={f.d} pathLength={1} style={{ '--i': f.i } as CSSProperties} />)}
        <text x="265" y="76" className="mf-l">deposit · withdraw</text>
        <text x="695" y="76" className="mf-l">margin · results</text>

        {/* orders: no funds */}
        {orders.map((o) => <path key={`o${o.i}`} className="mf-order" d={o.d} pathLength={1} style={{ '--i': o.i } as CSSProperties} />)}
        <text x="540" y="304" className="mf-l is-order">orders only · no funds pass through</text>

        {/* fees, on each fill */}
        <path className="mf-fee" d={curve(930, 162, 900, 330, true)} pathLength={1} />
        <text x="955" y="252" className="mf-l is-end">per fill</text>

        {/* blocked: anyone else */}
        <path className="mf-block" d={curve(370, 180, 130, 330, true)} />
        <g className="mf-x" transform="translate(236 252)"><circle r="13" /><path d="M-5 -5 5 5M5 -5-5 5" /></g>

        <Node x={30} y={60} w={170} h={100} t="Your wallet" s="you deposit, withdraw" />
        <Node x={330} y={40} w={300} h={140} t="Your SoDEX account" s="spot and perps" s2="your funds stay here" kind="acct" />
        <Node x={760} y={60} w={210} h={102} t="SoDEX order book" s="orders fill here" kind="book" />
        <Node x={300} y={330} w={220} h={120} t="ValueDesk executor" s="bots, hosted copies" s2="signs with your trading key" kind="sign" />
        <Node x={560} y={330} w={220} h={120} t="Your browser" s="your own trades" s2="browser copies" kind="sign" />
        <Node x={810} y={330} w={170} h={120} t="Fees per fill" s="SoDEX's fee" s2="ValueDesk's, capped by you" kind="fee" />
        <Node x={30} y={330} w={200} h={120} t="Anyone else" s="the trading key cannot" s2="send funds here" kind="no" />
      </svg>

      <ol className="mf-stack" aria-label="Where your money goes">
        <li className="mf-c"><b>Your wallet</b><span>You deposit to SoDEX and withdraw from it.</span></li>
        <li className="mf-j is-fund">funds, both ways</li>
        <li className="mf-c is-acct"><b>Your SoDEX account</b><span>Spot and perps. Your funds stay here.</span></li>
        <li className="mf-j is-fund">margin and results settle here</li>
        <li className="mf-c is-book"><VenueLogo venue="sodex" size={18} /><b>SoDEX order book</b><span>Orders fill here.</span></li>
        <li className="mf-j is-order">orders only, from</li>
        <li className="mf-pair">
          <div className="mf-c is-sign"><BrandMark size={16} /><b>ValueDesk executor</b><span>Bots and hosted copies, signed with your trading key.</span></div>
          <div className="mf-c is-sign"><b>Your browser</b><span>Your own trades and browser copies.</span></div>
        </li>
        <li className="mf-c is-fee"><b>Fees per fill</b><span>SoDEX's fee, and ValueDesk's fee, never above the maximum you approved.</span></li>
        <li className="mf-c is-no"><b>Anyone else</b><span>The trading key cannot send funds to anyone else.</span></li>
      </ol>
    </div>
  );
}

/** The three facts under the drawing. */
export const MONEY_FACTS: Array<{ t: string; s: string }> = [
  { t: 'No deposit with ValueDesk', s: 'Funds go from your wallet to your own SoDEX account, and only there. ValueDesk never holds them.' },
  { t: 'The key trades, it cannot pay out', s: 'It places orders and can move funds only between your own SoDEX accounts and your wallet. It ends after the days you choose, at most 180.' },
  { t: 'Fees are taken per fill', s: "SoDEX charges its own fee and ValueDesk's on each filled order, ValueDesk's never above the maximum you approved. Revoke the approval on SoDEX any time." },
];
