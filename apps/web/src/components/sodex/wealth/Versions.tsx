/**
 * The Wealth page's new versions, loaded on localhost only (WealthPage.tsx imports this file lazily behind
 * import.meta.env.DEV, so a build carries none of it). Invest and Redeem open the Original's own sheet
 * (portfolio/WealthSheet.tsx) with its signatures and checks; Trade opens the spot order book.
 */
import { useState } from 'react';
import { WealthSheet, type WealthSheetTarget } from '../../portfolio/WealthSheet';
import type { Eip1193Provider } from '../../../wallet';
import { Shelves } from './Shelves';
import { Desk } from './Desk';
import { Mine } from './Mine';
import type { VersionProps } from './parts';
import '../../bots/kit/kit.css';
import '../../bots/botsPages.css';
import './wealth.css';

export type NewVersion = 'shelves' | 'desk' | 'mine';

export default function WealthVersion({ version, vp, provider, onDone, children }: {
  version: NewVersion;
  vp: Omit<VersionProps, 'ctx'> & { ctx: Omit<VersionProps['ctx'], 'onSheet'> };
  provider: Eip1193Provider | null;
  onDone: () => void;
  children?: React.ReactNode;
}) {
  const [target, setTarget] = useState<WealthSheetTarget | null>(null);
  const props: VersionProps = { ...vp, ctx: { ...vp.ctx, onSheet: setTarget } };
  return (
    <main className={`tf bots-page wv wv--${version}`} aria-label="Wealth">
      {version === 'shelves' ? <Shelves {...props} /> : version === 'desk' ? <Desk {...props} /> : <Mine {...props} />}
      <WealthSheet target={target} onClose={() => setTarget(null)} address={vp.ctx.address} provider={provider} onDone={onDone} />
      {children}
    </main>
  );
}
