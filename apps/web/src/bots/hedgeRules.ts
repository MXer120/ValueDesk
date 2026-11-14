/** Whether a hedge's second wallet must take ValueDesk's code before its leg (owner 2026-11-14): SoDEX says it has no
 * inviter, and it has no SoDEX account yet (a new wallet). Unknown answers never hold a wallet. */
export const mustTakeCode = (ref: string, hasAccount: boolean | null): boolean => ref === 'none' && hasAccount === false;

/**
 * Whether a two-wallet hedge may run with real orders. Off (owner 2026-11-14 has not decided; the bot terms forbid
 * trading with accounts you control): pairs run as practice, a hedge against spot runs real. The executor refuses real
 * pairs too (EXECUTOR_HEDGE_PAIRS); both switch on together once the terms allow it.
 */
export const HEDGE_PAIRS_LIVE = false;
