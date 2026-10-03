/**
 * The ValueDesk mark: two candles standing on a desk. The same rectangles as
 * public/favicon.svg (the tab icon), drawn inline so the navbar needs no extra
 * request. Decorative: the wordmark next to it carries the name.
 */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="6" fill="#1b1a14" />
      <rect x="9" y="8" width="4" height="12" rx="1" fill="#00b481" />
      <rect x="10.5" y="5" width="1" height="3" fill="#00b481" />
      <rect x="10.5" y="20" width="1" height="3" fill="#00b481" />
      <rect x="19" y="12" width="4" height="8" rx="1" fill="#ef4a3c" />
      <rect x="20.5" y="9" width="1" height="3" fill="#ef4a3c" />
      <rect x="20.5" y="20" width="1" height="3" fill="#ef4a3c" />
      <rect x="6" y="23" width="20" height="2" rx="1" fill="#e6e6e6" />
      <rect x="8" y="25" width="2" height="3" fill="#e6e6e6" />
      <rect x="22" y="25" width="2" height="3" fill="#e6e6e6" />
    </svg>
  );
}
