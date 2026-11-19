/**
 * A saved address's picture: the platform's logo (or the coin's) with the CHAIN
 * as the small badge - always the chain. Never a letter (owner, 2026-10-28): a
 * contact the user made for a bare address (no platform, no coin) gets its
 * wallet identicon, drawn from the address; a coin whose file cannot load shows
 * SoDEX's mark, a platform's the identicon. An EVM address nobody said the chain
 * of gets a neutral "any EVM chain" link mark rather than a guessed network.
 */
import { useMemo, useState } from 'react';
import { chainLogo, coinLogo, venueMark } from '../../../logos';
import { Identicon } from '../../Identicon';
import { COIN_LOGOS } from '../../../logoManifest';
import type { Contact } from '../contacts';
import { CATALOG, CHAIN_LOGOS, PLATFORM_LOGOS } from './catalogData';
import { resolveLook, type CatalogChain, type Look } from './detect';

const BASE = (() => {
  const b = import.meta.env?.BASE_URL;
  return typeof b === 'string' && b ? (b.endsWith('/') ? b : `${b}/`) : '/';
})();
const own = (rel: string | undefined) => (rel ? `${BASE}addrbook/${rel}` : null);

/** Every coin the app has a logo for - the coins a name can mention. */
export const KNOWN_COINS: ReadonlySet<string> = new Set(Object.keys(COIN_LOGOS).filter((k) => /^[A-Z0-9]{2,10}$/.test(k)));

export const platformById = (id: string | null | undefined) => (id ? CATALOG.platforms.find((p) => p.id === id) ?? null : null);
export const chainById = (id: string | null | undefined) => (id ? CATALOG.chains.find((c) => c.id === id) ?? null : null);
export const platformLogo = (id: string | null | undefined): string | null => (id ? own(PLATFORM_LOGOS[id]) : null);

/** The address book's logo for a connected wallet, matched on its name ("Rabby Wallet", "MetaMask"): ./walletLogo.ts. */
export { walletLogoForName } from './walletLogo';
/** SoDEX's own chain icon where SoDEX routes there (the rest of the app uses it too), else ours. */
export const catalogChainLogo = (c: CatalogChain | null): string | null => (c ? (c.sodexKey && chainLogo(c.sodexKey)) || own(CHAIN_LOGOS[c.id]) : null);

export function useContactLook(c: Pick<Contact, 'name' | 'kind' | 'look'>) {
  return useMemo(() => resolveLook(c, CATALOG, KNOWN_COINS), [c.name, c.kind, c.look]); // eslint-disable-line react-hooks/exhaustive-deps
}

function Img({ src, alt, className, fallback }: { src: string | null; alt: string; className: string; fallback: JSX.Element }) {
  const [bad, setBad] = useState<string | null>(null);
  return src && bad !== src ? <img className={className} src={src} alt={alt} onError={() => setBad(src)} /> : fallback;
}

export function ContactAvatar({ name, address, kind, look, size = 30 }: { name: string; address: string; kind: Contact['kind']; look: Look; size?: number }) {
  const platform = platformById(look.platform);
  const chain = chainById(look.chain);
  const main = platform ? platformLogo(platform.id) : look.coin ? coinLogo(look.coin) : null;
  const badge = chain ? catalogChainLogo(chain) : null;
  const badgeSize = Math.round(size * 0.46);
  const face = <Identicon seed={address || name} size={size} className="ab-av__main ab-av__face" title={platform || look.coin ? undefined : name} />;
  return (
    <span className="ab-av" style={{ width: size, height: size }} aria-hidden="true">
      <Img
        src={main}
        alt=""
        className="ab-av__main"
        fallback={!platform && look.coin ? <Img src={venueMark(null)} alt="" className="ab-av__main" fallback={face} /> : face}
      />
      {(chain || kind === 'evm') && (
        <span className="ab-av__badge" style={{ width: badgeSize, height: badgeSize }} title={chain?.name ?? 'Any EVM chain'}>
          {chain ? (
            <Img src={badge} alt="" className="ab-av__badgeimg" fallback={<Identicon seed={chain.id} size={badgeSize} className="ab-av__badgeimg" />} />
          ) : (
            <AnyEvm />
          )}
        </span>
      )}
    </span>
  );
}

/** "Any EVM chain": a neutral link mark (no network's logo is guessed, no letters). */
const AnyEvm = () => (
  <svg className="ab-av__anyevm" viewBox="0 0 16 16" width="70%" height="70%" aria-hidden="true">
    <path d="M6.5 9.5l3-3M5.2 7.3L4 8.5a2.5 2.5 0 003.5 3.5l1.2-1.2M10.8 8.7L12 7.5A2.5 2.5 0 008.5 4L7.3 5.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
