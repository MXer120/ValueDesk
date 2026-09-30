/**
 * The wallet step a transfer out of the wallet shows the instant it starts,
 * before the balance, the chain and the permit nonce are read. Those reads are
 * what left the button saying "Confirming…".
 *
 * An ERC-20 deposit is two signatures: approve, then confirm, so (1/2). A chain
 * switch, once known, is an extra approve in front and the same first prompt
 * is recounted as (1/3). Native SOSO is one confirm, with no count. Engine
 * moves (Spot ↔ Futures) are not wallet prompts and must not use this.
 */
export interface OpeningStep {
  wallet: 'approve' | 'confirm';
  n: number;
  of: number;
}

export function openingWalletStep(native: boolean): OpeningStep {
  return native ? { wallet: 'confirm', n: 1, of: 1 } : { wallet: 'approve', n: 1, of: 2 };
}
