/**
 * Tells the fee terms when the connected account had a fill, so the server
 * looks at that wallet's volume soon and the next tier arrives without a
 * reload (trading/terms.ts `hintTerms`: debounced, at most one request a
 * minute; docs/BUILDER-TIERS.md section 7).
 *
 * It rides the `accountTrade` stream the app already holds for its fill
 * notifications - no extra connection, no polling. It renders nothing, and in a
 * build whose fee cannot be lowered by signed terms (no builder, or no pinned
 * terms key) it does not subscribe at all.
 *
 * A fill only ever makes the app ASK. What the answer may do is decided where
 * it is verified (terms.ts): nothing in this stream can lower a fee.
 */
import { useEffect } from 'react';
import { useChannel } from '../../hooks';
import { hintTerms, termsPossible } from '../../trading/terms';

interface Fill {
  T?: number;
  t?: number;
  time?: number;
}

function useFillHint(engine: 'perps' | 'spot', address: string | null): void {
  useChannel(engine, address ? { channel: 'accountTrade', user: address } : null, (data, pushType) => {
    if (pushType === 'snapshot' || !address) return; // history on subscribe, not news
    const list: Fill[] = Array.isArray(data) ? data : data ? [data] : [];
    // A fill stamped more than a minute ago is history replayed, not a fill that just happened.
    const fresh = list.some((f) => {
      const at = Number(f?.T ?? f?.t ?? f?.time);
      return !(at > 0) || Date.now() - (at < 1e12 ? at * 1000 : at) <= 60_000;
    });
    if (fresh) hintTerms(address);
  });
}

export function BuilderTermsFollower({ address }: { address: string | null }) {
  const who = termsPossible() ? address : null;
  useFillHint('perps', who);
  useFillHint('spot', who);
  // Once per connected wallet and visit, fill or not: a wallet that traded only through the
  // executor (hosted or self-hosted) is counted the first time its owner opens the site
  // (owner 2026-11-01: only 2 wallets were in the ledger). A wallet without our builder approved writes nothing.
  useEffect(() => {
    if (who) hintTerms(who);
  }, [who]);
  return null;
}
