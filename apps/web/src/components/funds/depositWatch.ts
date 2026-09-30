/**
 * Watches for the deposit the user is about to make, while the Deposit sheet
 * shows an address: a baseline of the account's deposits when it opens, then a
 * look every 6 s at SoDEX's own deposit history (the same `account_flow` read
 * the Account History tab uses). The first deposit that was not there before
 * drives the sheet: detected -> processing -> deposited (or failed).
 *
 * Read-only; nothing is ever sent from here.
 */
import { useEffect, useRef, useState } from 'react';
import { fetchAccountFlows, type LedgerRow } from '../../accountData';

export type DepositStage = 'detected' | 'processing' | 'done' | 'failed' | 'review' | 'refunding';
export interface DepositWatch {
  stage: DepositStage;
  row: LedgerRow;
}

const POLL_MS = 6_000;
/** "Deposit detected" is shown this long before it reads as processing. */
const DETECTED_MS = 3_500;

export function useDepositWatch(owner: string | null, active: boolean): DepositWatch | null {
  const [seen, setSeen] = useState<{ row: LedgerRow; firstAt: number } | null>(null);
  const [, tick] = useState(0);
  const baseline = useRef<Set<string> | null>(null);

  useEffect(() => {
    baseline.current = null;
    setSeen(null);
    if (!owner || !active) return;
    let stop = false;
    let timer: number | undefined;
    const look = async () => {
      try {
        const { rows } = await fetchAccountFlows(owner, 0, 20);
        if (stop) return;
        const deposits = rows.filter((r) => r.kind === 'deposit');
        if (baseline.current === null) {
          baseline.current = new Set(deposits.map((r) => r.id));
        } else {
          const fresh = deposits.find((r) => !baseline.current!.has(r.id));
          if (fresh) setSeen((p) => (p && p.row.id === fresh.id ? { ...p, row: fresh } : { row: fresh, firstAt: Date.now() }));
        }
      } catch {
        /* the next look tries again */
      }
      if (!stop) timer = window.setTimeout(look, POLL_MS);
    };
    void look();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [owner, active]);

  // Re-render once the "detected" moment has passed.
  useEffect(() => {
    if (!seen || seen.row.state !== 'pending') return;
    const left = seen.firstAt + DETECTED_MS - Date.now();
    if (left <= 0) return;
    const t = window.setTimeout(() => tick((n) => n + 1), left);
    return () => window.clearTimeout(t);
  }, [seen]);

  if (!seen) return null;
  const { row } = seen;
  // account_flow is SoDEX's own deposit ledger: Depositing, then Reporting,
  // then Success — or Failed, Refunding, Refunded, Suspicious. The first
  // moment is the only step we add ("detected"); everything after follows
  // the row's status, which this poll refreshes.
  const raw = row.rawStatus ?? '';
  const early = row.state === 'pending' && (raw === '' || raw === 'Depositing' || raw === 'Pending' || raw === 'Processing');
  const stage: DepositStage =
    row.state === 'completed' ? 'done'
      : row.state === 'failed' || row.state === 'refunded' ? 'failed'
        : row.state === 'review' ? 'review'
          : raw === 'Refunding' ? 'refunding'
            : early && Date.now() - seen.firstAt < DETECTED_MS ? 'detected' : 'processing';
  return { stage, row };
}
