/**
 * The hosts that only ever do something for a connected wallet, in one chunk (phone pass, 2026-11-18): the fill
 * toasts, the history walk's and the indexing notes, the referral offer and the invite. Without an address each
 * renders nothing and its effects return at once, so they were ~100 KB of code in every first render that did
 * nothing for a first-time visitor (most phone visitors). Each keeps its own error boundary, named as before.
 *
 * walletHostsLazy.tsx says when this loads: at once when the browser remembers a wallet, else after the page's
 * load event (a wallet connected later finds it in). All five render nothing until their own reads answer, so
 * mounting them a moment after the first commit changes nothing on screen.
 */
import { Guarded } from '../ErrorBoundary';
import { FillToasts } from '../FillToasts';
import { IndexPrompt } from '../IndexPrompt';
import { HistoryNote } from '../HistoryNote';
import { ReferralOfferHost } from '../../onboarding/ReferralOffer';
import { InviteHost } from '../../invites/InviteHost';
import type { Eip1193Provider } from '../../wallet';

export interface WalletHostsProps {
  address: string | null;
  provider: Eip1193Provider | null;
  /** The first-signup flow or the account-setup sheets are deciding or open (App.tsx onboarding). */
  hold: boolean;
}

export function WalletHosts({ address, provider, hold }: WalletHostsProps) {
  return (
    <>
      <Guarded name="Fill toasts">
        <FillToasts address={address} />
      </Guarded>
      <Guarded name="Account setup">
        <ReferralOfferHost address={address} provider={provider} hold={hold} />
      </Guarded>
      <Guarded name="Share">
        <InviteHost address={address} provider={provider} hold={hold} />
      </Guarded>
      <Guarded name="Indexing">
        <IndexPrompt address={address} />
      </Guarded>
      <Guarded name="History">
        <HistoryNote address={address} />
      </Guarded>
    </>
  );
}
