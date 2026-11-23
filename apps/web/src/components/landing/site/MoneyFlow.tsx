/**
 * Where your money goes (owner 2026-11-23: accurate, but "doesn't look good and too complicated"). Three parts only:
 *
 *   your wallet  <== funds ==>  YOUR SODEX ACCOUNT  <-- orders only --  ValueDesk
 *
 * FUNDS move only between your wallet and your SoDEX account (you deposit and withdraw); trades fill there.
 * ValueDesk's executor places orders for your bots and hosted copies with your trading key and never holds funds.
 * FEES (the one line under it): SoDEX takes its fee and ValueDesk's on each fill, ValueDesk's never above the maximum
 * you approved (trading/builder.ts). The key cannot send funds to anyone else (MONEY_FACTS).
 */
import { useEffect, useRef, useState } from 'react';
import { BrandMark } from '../../BrandMark';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');

function useOn<T extends Element>(): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') { setOn(true); return; }
    const io = new IntersectionObserver(([e]) => { if (e) setOn(e.isIntersecting); }, { rootMargin: '0px 0px -10% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, on];
}

const WalletIc = <svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="3.2" /><path d="M3 9.5h14.5a3.5 3.5 0 0 1 3.5 3.5" /><circle cx="16.5" cy="13.5" r="1.2" /></svg>;
const ShieldIc = <svg viewBox="0 0 24 24"><path d="M12 3 5 6v5.5c0 4.4 3 7.9 7 9.5 4-1.6 7-5.1 7-9.5V6Z" /><path d="m9 12 2.2 2.2L15.5 10" /></svg>;

export function MoneyFlow() {
  const [ref, on] = useOn<HTMLDivElement>();
  return (
    <div ref={ref} className={cx('mf2', on && 'is-on')} role="img" aria-label="Funds move only between your wallet and your SoDEX account. ValueDesk sends orders to your account, never funds. Fees are taken per fill.">
      <div className="mf2-node">
        <span className="mf2-ic">{WalletIc}</span>
        <b>Your wallet</b>
        <span>You deposit and withdraw</span>
      </div>

      <div className="mf2-link is-fund" aria-hidden="true">
        <em>funds</em>
        <div className="mf2-rail"><i /><i /><i /><i className="is-back" /><i className="is-back" /></div>
      </div>

      <div className="mf2-core">
        <div className="mf2-glow" aria-hidden="true" />
        <span className="mf2-ic is-core">{ShieldIc}</span>
        <b>Your SoDEX account</b>
        <span>Your funds stay here. Every trade fills here.</span>
      </div>

      <div className="mf2-link is-order" aria-hidden="true">
        <em>orders only</em>
        <div className="mf2-rail"><i /><i /><i /></div>
      </div>

      <div className="mf2-node">
        <span className="mf2-ic is-brand"><BrandMark size={20} /></span>
        <b>ValueDesk</b>
        <span>Runs your bots and copies. Never holds funds.</span>
      </div>
    </div>
  );
}

/** The three facts under the drawing, one line each. */
export const MONEY_FACTS: Array<{ t: string; s: string }> = [
  { t: 'No deposit with ValueDesk', s: 'Your money goes from your wallet to your own SoDEX account, and stays there.' },
  { t: 'The key trades, it cannot pay out', s: 'It moves funds only between your own SoDEX accounts and your wallet. Never to anyone else.' },
  { t: 'Fees per fill, capped by you', s: "SoDEX takes its fee and ValueDesk's on each fill; ValueDesk's never above what you approved." },
];
