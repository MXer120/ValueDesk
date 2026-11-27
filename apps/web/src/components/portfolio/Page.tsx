/**
 * The Portfolio page: the wallet (wallet/Wallet.tsx; owner 2026-11-26: "promote portfolio page so its the new
 * original"). On localhost (import.meta.env.DEV) a switch at the foot also offers the page before it ("Previous") and
 * "View a wallet"; a build has neither: the dynamic import below is dropped with its branch.
 */
import { lazy, Suspense } from 'react';
import type { PortfolioContext } from '../Portfolio';
import type { PortfolioPageLinks } from './PortfolioPage';
import { PortfolioWallet } from './wallet/Wallet';

const DevVersions = import.meta.env.DEV ? lazy(() => import('./wallet/DevVersions')) : null;

export function PortfolioPage(props: { c: PortfolioContext } & PortfolioPageLinks) {
  if (!DevVersions) return <PortfolioWallet {...props} />;
  return <Suspense fallback={null}><DevVersions {...props} /></Suspense>;
}
