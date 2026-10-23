/**
 * What an empty panel says, as a title and one line under it (EmptyState.tsx):
 * "No open positions" over "Your open positions show here once you open one."
 * The account tables pass their short sentence ("No open positions."); this
 * turns the ones we know into the two-line form and picks the icon, and keeps
 * any other sentence as a title on its own.
 */
export type EmptyIcon = 'positions' | 'orders' | 'history' | 'wallet' | 'coins' | 'funding' | 'transfers' | 'search' | 'news' | 'chart';

export interface EmptyCopy {
  icon: EmptyIcon;
  title: string;
  line?: string;
  /** No wallet is connected: the state offers Connect. */
  wallet?: boolean;
}

const KNOWN: Record<string, EmptyCopy> = {
  'No open positions.': { icon: 'positions', title: 'No open positions', line: 'Your open perpetual positions show here once you open one.' },
  'No open orders.': { icon: 'orders', title: 'No open orders', line: 'Limit, stop and algo orders you place wait here until they fill.' },
  'No orders yet.': { icon: 'history', title: 'No orders yet', line: 'Every order you place, filled or cancelled, is listed here.' },
  'No orders on record.': { icon: 'history', title: 'No orders on record', line: 'This account has not placed an order on this venue yet.' },
  'No fills yet.': { icon: 'history', title: 'No fills yet', line: 'Your trades show here as soon as an order fills.' },
  'No fills on record.': { icon: 'history', title: 'No fills on record', line: 'This account has no trades on this venue yet.' },
  'No funding payments yet.': { icon: 'funding', title: 'No funding payments yet', line: 'Funding paid and received on open positions shows here.' },
  'No funding payments in the last 30 days.': { icon: 'funding', title: 'No funding payments', line: 'Nothing paid or received in the last 30 days.' },
  'No closed positions yet.': { icon: 'positions', title: 'No closed positions yet', line: 'Positions you close show here with their result.' },
  'No closing fills in the loaded history.': { icon: 'positions', title: 'No closed positions', line: 'None in the history loaded so far.' },
  'No balances.': { icon: 'coins', title: 'No balances', line: 'Deposit to fund this account.' },
  'Nothing held.': { icon: 'coins', title: 'Nothing held', line: 'Deposit to fund this account.' },
  'Nothing above 1 USDC.': { icon: 'coins', title: 'Nothing above 1 USDC', line: 'Smaller balances are hidden.' },
  'No deposits, withdrawals or transfers yet.': { icon: 'transfers', title: 'No transfers yet', line: 'Deposits, withdrawals and transfers show here.' },
  'Nothing in this view yet.': { icon: 'search', title: 'Nothing in this view', line: 'Change the filters to see more.' },
  'Nothing in this view.': { icon: 'search', title: 'Nothing in this view', line: 'Change the filters to see more.' },
};

export function emptyCopy(text: string): EmptyCopy {
  const known = KNOWN[text.trim()];
  if (known) return known;
  const wallet = /^Connect a wallet to see (.+)\.$/.exec(text.trim());
  if (wallet) return { icon: 'wallet', title: 'No wallet connected', line: text.trim(), wallet: true };
  return { icon: 'search', title: text.trim().replace(/\.$/, '') };
}
