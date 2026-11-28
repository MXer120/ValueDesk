/**
 * The Wealth page's own pages beyond the overview (wealthRoute.ts): a fund, every index, one index, the builder. Loaded
 * with their own chunk the first time one opens, so the overview does not carry them.
 */
import type { Eip1193Provider } from '../../wallet';
import { FundPage } from './FundPage';
import { IndexBrowse } from './IndexBrowse';
import { IndexBuilder } from './IndexBuilder';
import { IndexPage } from './IndexPage';
import type { WealthRoute } from './wealthRoute';
import type { WealthState } from './useWealth';

export function WealthSub({ route, w, address, provider, onDone, onOpenMarket }: {
  route: Exclude<WealthRoute, { kind: 'home' }>; w: WealthState; address: string | null; provider: Eip1193Provider | null; onDone: () => void;
  onOpenMarket: (symbol: string, engine: 'spot') => void;
}) {
  const q = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
  switch (route.kind) {
    case 'fund': return <FundPage id={route.id} w={w} onOpenMarket={onOpenMarket} />;
    case 'indexes': return <IndexBrowse w={w} address={address} provider={provider} onDone={onDone} />;
    case 'new': return <IndexBuilder editId={null} fromId={q.get('from')} withFund={q.get('with')} w={w} address={address} provider={provider} />;
    case 'edit': return <IndexBuilder editId={route.id} fromId={null} withFund={null} w={w} address={address} provider={provider} />;
    case 'index': return <IndexPage id={route.id} w={w} address={address} provider={provider} onDone={onDone} onOpenMarket={onOpenMarket} />;
  }
}
