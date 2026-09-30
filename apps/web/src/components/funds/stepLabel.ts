/**
 * What a funds sheet's button says while it works - the only progress the
 * sheets show. While the wallet is asking: "Please approve in MetaMask (1/2)",
 * then "Please confirm in MetaMask (2/2)" - named after whatever wallet is
 * connected (an extension, or the phone wallet paired over WalletConnect), no
 * count for a single prompt; otherwise "Confirming…" while SoDEX and the chain
 * do their part.
 */
import type { FundsStep } from '../../trading/funds';

export interface WalletPlace {
  walletName: string;
}

/** Names that say how it is connected, not which wallet it is. */
const GENERIC = /^(walletconnect|browser wallet|injected|unknown)?$/i;

/** Where the user answers: the wallet by name, or "your wallet" when it has none worth showing. */
export const walletPlace = (w: WalletPlace): string => {
  const name = w.walletName.trim();
  return `in ${GENERIC.test(name) ? 'your wallet' : name}`;
};

export function stepLabel(step: FundsStep | null, wallet: WalletPlace): string {
  if (!step?.wallet) return 'Confirming…';
  const count = step.of > 1 ? ` (${step.n}/${step.of})` : '';
  return `Please ${step.wallet} ${walletPlace(wallet)}${count}`;
}
