/** Whether a hedge's second wallet must take ValueDesk's code before its leg (owner 2026-11-14): SoDEX says it has no
 * inviter, and it has no SoDEX account yet (a new wallet). Unknown answers never hold a wallet. */
export const mustTakeCode = (ref: string, hasAccount: boolean | null): boolean => ref === 'none' && hasAccount === false;
