/**
 * The wallet menu's money icons (AddressMenu): Deposit is a tray with the arrow coming in, Withdraw the same tray with
 * the arrow leaving, Transfer two arrows passing each other. One set, so a page's own money keys draw exactly what the
 * pop-up draws (owner 2026-11-26: "reuse the icons we got in the actual pop ups").
 */
const glyph = (d: string) => function MoneyGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
};

/** Into the account: the arrow comes down into a tray. */
export const DepositIcon = glyph('M8 2.5v8M5 7.5l3 3 3-3M2.5 10v2.2c0 .7.6 1.3 1.3 1.3h8.4c.7 0 1.3-.6 1.3-1.3V10');
/** Out of the account: the same tray, the arrow leaving it. */
export const WithdrawIcon = glyph('M8 10.5V2.5M5 5.5l3-3 3 3M2.5 10v2.2c0 .7.6 1.3 1.3 1.3h8.4c.7 0 1.3-.6 1.3-1.3V10');
/** Between accounts: one arrow up, one down. */
export const TransferIcon = glyph('M5 2.5v11M2.5 5 5 2.5 7.5 5M11 13.5v-11M8.5 11 11 13.5 13.5 11');
