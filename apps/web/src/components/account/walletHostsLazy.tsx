/**
 * Where App.tsx mounts the wallet-only hosts (WalletHosts.tsx), without them in the entry chunk.
 *
 * Their code is asked for the moment this module runs when the browser remembers a wallet (`ot.address`, which
 * App's useStored reads too): it downloads beside the landing page's own chunks. Without one it comes after the
 * page's load event (afterLoad.ts), or as soon as an address appears. It mounts once in - every host renders
 * nothing until its own reads answer, so a moment after the first commit draws exactly what the first commit
 * would have.
 */
import { useEffect, useState } from 'react';
import { prefetchAfterLoad } from '../../afterLoad';
import { lazyPage } from '../../lazyPage';
import type { WalletHostsProps } from './WalletHosts';

const Hosts = lazyPage<WalletHostsProps>('wallet hosts', () => import('./WalletHosts').then((m) => m.WalletHosts));

/** The browser remembers a wallet (hooks.ts useStored keeps `ot.address` as JSON). */
function rememberedWallet(): boolean {
  try {
    const raw = localStorage.getItem('ot.address');
    return !!raw && raw !== 'null';
  } catch {
    return false;
  }
}

if (typeof window !== 'undefined' && rememberedWallet()) void Hosts.preload().catch(() => {});

export function WalletHostsSlot(props: WalletHostsProps) {
  const [ready, setReady] = useState(Hosts.ready);
  const { address } = props;
  useEffect(() => {
    if (ready) return;
    let live = true;
    const go = () => { if (live) setReady(true); };
    // With an address now: at once. Without one: after the load event (a later wallet finds it in).
    if (address) Hosts.preload().then(go, () => {});
    const cancel = address ? () => {} : prefetchAfterLoad(() => Hosts.preload().then(go));
    return () => {
      live = false;
      cancel();
    };
  }, [ready, address]);
  return ready ? <Hosts {...props} /> : null;
}
