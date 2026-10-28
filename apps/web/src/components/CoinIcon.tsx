/**
 * A coin or chain icon from our own public/logos/ copy (see logos.ts). Never a
 * letter (owner, 2026-10-28: "no letter badges, logos everywhere"): a listing
 * newer than the icon set, or a file that fails to load, shows the mark of the
 * venue it trades on (`venue`, SoDEX's by default - brandLogo in logos.ts).
 * Size is set inline so every call site keeps its own layout class (mkt-coin,
 * mkinfo-coin, fx-av...).
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { chainLogo, coinLogo, venueMark } from '../logos';
import './CoinIcon.css';

export function CoinIcon({ coin, chain, venue, size = 20, className = '', title }: {
  /** Any SoDEX spelling: vBTC, BTC-USD, vBTC_vUSDC, BTC/USDC... */
  coin?: string | null;
  /** A SoDEX chain key instead of a coin: BASE_ETH, VALUECHAIN... */
  chain?: string | null;
  /** The venue the coin trades on (SODEX, HYPERLIQUID, LIGHTER...): its mark is the fallback. */
  venue?: string | null;
  size?: number;
  className?: string;
  title?: string;
}) {
  const own = chain != null ? chainLogo(chain) : coinLogo(coin);
  const mark = venueMark(venue);
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const style: CSSProperties = { width: size, height: size };
  const src = [own, mark].find((s): s is string => !!s && !broken.has(s));

  if (src) {
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
        onError={() => setBroken((b) => new Set(b).add(src))}
      />
    );
  }
  // Both files failed to load (offline, a broken deploy): an empty disc keeps the layout.
  return <span className={`coin-ic coin-ic--blank ${className}`} style={style} title={title} aria-hidden="true" />;
}

/** Icon + label, for table cells and lists: `<CoinLabel coin="vBTC">BTC</CoinLabel>`. */
export function CoinLabel({ coin, chain, venue, size = 16, children }: { coin?: string | null; chain?: string | null; venue?: string | null; size?: number; children: ReactNode }) {
  return (
    <span className="coin-lbl">
      <CoinIcon coin={coin} chain={chain} venue={venue} size={size} />
      <span className="coin-lbl__t">{children}</span>
    </span>
  );
}
