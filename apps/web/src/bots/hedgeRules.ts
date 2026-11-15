/** Whether a hedge's second wallet must take ValueDesk's code before its leg (owner 2026-11-14): SoDEX says it has no
 * inviter, and it has no SoDEX account yet (a new wallet). Unknown answers never hold a wallet. */
export const mustTakeCode = (ref: string, hasAccount: boolean | null): boolean => ref === 'none' && hasAccount === false;

/**
 * Two-wallet hedges run with real orders (owner 2026-11-15: "yes if 1 of the wallets is on beta"): hedges are early
 * access, and a pair needs one of its two wallets on the beta list (the executor's hedgeAccess decides).
 */
export const HEDGE_PAIRS_LIVE = true;
