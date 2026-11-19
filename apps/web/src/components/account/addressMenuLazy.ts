/**
 * The address menu (AddressMenu.tsx) and its figures (useAccountTotals.ts) for the navbar and the rail, without
 * them in every page's first render: they exist only for a page with a wallet (phone pass, 2026-11-18).
 *
 * Once an address is known its code is fetched after the page's load event (afterLoad.ts) - or at once on a press
 * or hover of the address - and the menu's reads start then (prefetchAccountTotals, as the navbar did on mount);
 * a hover or a press starts them again when stale. AddressMenu is a lazyPage: once in, it opens synchronously.
 */
import { prefetchAfterLoad } from '../../afterLoad';
import { lazyPage } from '../../lazyPage';

export const AddressMenu = lazyPage('address menu', () => import('./AddressMenu').then((m) => m.AddressMenu));

/** The menu's code, and its wallet figures read (useAccountTotals.ts prefetchAccountTotals). */
export function warmAddressMenu(address: string): void {
  void AddressMenu.preload().catch(() => {});
  void import('./useAccountTotals').then((m) => m.prefetchAccountTotals(address), () => {});
}

/** An address is on screen: its menu's code and figures after the load event. Returns a cancel (an effect's cleanup). */
export const warmAddressMenuAfterLoad = (address: string): (() => void) => prefetchAfterLoad(() => warmAddressMenu(address));
