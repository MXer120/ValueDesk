/**
 * The order ticket's warning when an order would use margin that copy trading and bots have set aside (owner
 * 2026-11-26: "for normal trading for all types of orders, margin needs to be managed with copies and bots too ... if
 * it would take into a bot or copy allocation there's a warning, BUT no hard stop, if users wants to he can still
 * press").
 *
 * The futures account as the Bots page's margin panel counts it (Allocation.tsx marginOf): what your own positions
 * hold, what each copy and each real bot sets aside, and what is free after all of it. An order that needs more than
 * what is free takes the rest out of what copies and bots set aside: this says how much, and that they may then not
 * have the margin for their next orders. The order button is untouched - the order can still be sent.
 *
 * Loaded with its own chunk (OrderEntry.tsx renders it only for a perps order that opens a position), so the trade
 * page's first load carries none of the bots code.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { getLiveCopy, readiness, subscribeLiveCopy } from '../../copy/live';
import { useBots } from '../../bots/useBots';
import { fmtUsd } from '../../format';
import { intoReserve } from '../../bots/reserve';
import { useAccountTotals } from '../account/useAccountTotals';
import { marginCopies, marginOf, usePositionsMargin } from './Allocation';

export interface ReserveWarningProps {
  address: string;
  /** The margin this order needs, in USD (order value over leverage, as the ticket shows it). */
  need: number;
}


export function ReserveNote({ into, reserved, copies, bots }: { into: number; reserved: number; copies: number; bots: number }) {
  const who = copies > 0 && bots > 0 ? 'your bots and copies' : bots > 0 ? (bots === 1 ? 'your bot' : 'your bots') : copies === 1 ? 'your copy' : 'your copies';
  return (
    <div className="oe-reserve" role="status">
      <svg className="oe-reserve__ic" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <path d="M8 1.8 15 14H1z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M8 6.2v3.6M8 11.7v.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <div className="oe-reserve__t">
        {/* Each line one text, so the page's translation reads it whole. */}
        <b>{`Takes ${fmtUsd(into)} from ${who}`}</b>
        <span title={`${fmtUsd(reserved)} is set aside for ${who}. With this order they may not have the margin for their next orders until some frees up.`}>{`Of the ${fmtUsd(reserved)} they set aside. You can still send it.`}</span>
      </div>
    </div>
  );
}

export default function ReserveWarning({ address, need }: ReserveWarningProps) {
  const live = useSyncExternalStore(subscribeLiveCopy, getLiveCopy, getLiveCopy);
  const signedIn = readiness(live, 'hosted').connected;
  const { bots } = useBots(address, signedIn);
  const totals = useAccountTotals(address);
  const pm = usePositionsMargin(address);
  const copies = useMemo(() => marginCopies(live), [live]);
  const a = useMemo(() => marginOf(bots, copies, totals.perpsUsd, pm), [bots, copies, totals.perpsUsd, pm]);
  const reserved = a.copyUsd + a.botUsd;
  const into = intoReserve(need, a.free, reserved);
  if (into < 0.01) return null;
  return <ReserveNote into={into} reserved={reserved} copies={a.copies.length} bots={a.bots.length} />;
}
