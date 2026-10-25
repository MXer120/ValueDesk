/**
 * Money moving in and out - deposits, withdrawals, transfers - is announced on the
 * wallet button in the rail's bottom-left corner (SideBar.tsx SideWallet), which
 * widens to say it ("Deposit of 250 USDC completed"), not in the navbar's
 * notification lane with everything else (owner, 2026-10-25). The bell's list
 * keeps them too (transferLog.ts pushNotice).
 *
 * Senders: transferLog.ts finishTransfer, WithdrawModal.tsx, DepositModal.tsx.
 */
import { useEffect, useState } from 'react';

export type MoneyKind = 'deposit' | 'withdraw' | 'transfer';
export interface MoneyNotice {
  kind: MoneyKind;
  /** done: arrived / completed; sent: submitted, the chain still has it; failed. */
  status: 'done' | 'sent' | 'failed';
  text: string;
}

const EVENT = 'vs:money';
/** How long the button stays open. */
export const MONEY_SHOW_MS = 6_500;

export function announceMoney(n: MoneyNotice): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<MoneyNotice>(EVENT, { detail: n }));
}

/** The notice to show now, or null; each one shows for MONEY_SHOW_MS. */
export function useMoneyNotice(): MoneyNotice | null {
  const [cur, setCur] = useState<MoneyNotice | null>(null);
  useEffect(() => {
    let timer = 0;
    const on = (e: Event) => {
      setCur((e as CustomEvent<MoneyNotice>).detail);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setCur(null), MONEY_SHOW_MS);
    };
    window.addEventListener(EVENT, on);
    return () => { window.removeEventListener(EVENT, on); window.clearTimeout(timer); };
  }, []);
  return cur;
}
