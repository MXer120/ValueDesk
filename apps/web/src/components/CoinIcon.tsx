/**
 * A coin or chain icon from our own public/logos/ copy (see logos.ts), with the
 * old letter avatar as the fallback - for a listing newer than the icon set, or
 * a file that fails to load. Size is set inline so every call site keeps its
 * own layout class (mkt-coin, mkinfo-coin, fx-av...).
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { chainLogo, coinColor, coinInitial, coinLogo } from '../logos';
import './CoinIcon.css';

export function CoinIcon({ coin, chain, size = 20, className = '', title }: {
  /** Any SoDEX spelling: vBTC, BTC-USD, vBTC_vUSDC, BTC/USDC... */
  coin?: string | null;
  /** A SoDEX chain key instead of a coin: BASE_ETH, VALUECHAIN... */
  chain?: string | null;
  size?: number;
  className?: string;
  title?: string;
}) {
  const name = (chain ?? coin ?? '').trim();
  const src = chain != null ? chainLogo(chain) : coinLogo(coin);
  const [broken, setBroken] = useState<string | null>(null);
  const style: CSSProperties = { width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.5)) };

  if (src && broken !== src) {
    return (
      <img
        className={`coin-ic ${className}`}
        src={src}
        alt=""
        title={title}
        width={size}
        height={size}
        style={style}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setBroken(src)}
      />
    );
  }
  return (
    <span
      className={`coin-ic coin-ic--letter ${className}`}
      style={{ ...style, background: coinColor(name || '?') }}
      data-letter={coinInitial(name)}
      title={title}
      aria-hidden="true"
    />
  );
}

/** Icon + label, for table cells and lists: `<CoinLabel coin="vBTC">BTC</CoinLabel>`. */
export function CoinLabel({ coin, chain, size = 16, children }: { coin?: string | null; chain?: string | null; size?: number; children: ReactNode }) {
  return (
    <span className="coin-lbl">
      <CoinIcon coin={coin} chain={chain} size={size} />
      <span className="coin-lbl__t">{children}</span>
    </span>
  );
}
