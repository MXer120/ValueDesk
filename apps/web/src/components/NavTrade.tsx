/**
 * "Trade" in the bar with its pop-up (owner 2026-11-06, after the owner's reference: two labelled columns of
 * icon, title and a line under it). Core: Futures, Spot, Wealth. Automated: Copy Trading, Bots.
 *
 * The word stays a link to the trade page; the mouse opens the pop-up by hovering (useHoverMenu.ts),
 * and the chevron beside the word is what a finger or the keyboard presses for it.
 *
 * Portalled to <body>: on a phone the nav strip scrolls and fades its edge with a mask, which would
 * cut the pop-up off. React still treats it as a child, so hovering it counts as hovering the word.
 */
import { useEffect, useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Engine } from '../api';
import { applyForBeta } from '../beta/access';
import { SOON_TABS, pathForSodexView, pathForTab, type SodexView, type Tab } from '../router';
import { usePresence } from './motion';
import { useHoverMenu } from './useHoverMenu';

const Icon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

function Row({ href, icon, title, line, current, soon, access, onOpen }: { href?: string; icon: ReactNode; title: string; line: string; current?: boolean; soon?: boolean; access?: () => void; onOpen?: () => void }) {
  const inner = (
    <>
      <span className="menu-row__ic">{icon}</span>
      <span className="navtrade__text">
        <b>{title}{access ? <span className="dv-devtag dv-devtag--beta">Get access</span> : soon && <span className="dv-devtag dv-devtag--soon">Coming soon</span>}</b>
        <small>{line}</small>
      </span>
    </>
  );
  if (access) return <button type="button" role="menuitem" className="menu-row navtrade__row is-access" title="In beta: apply for access on our Discord" onClick={access}>{inner}</button>;
  if (soon || !href) return <div role="menuitem" aria-disabled="true" className="menu-row navtrade__row is-soon">{inner}</div>;
  const go = (e: ReactMouseEvent) => {
    if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onOpen();
  };
  return <a role="menuitem" className={`menu-row navtrade__row${current ? ' is-current' : ''}`} href={href} aria-current={current ? 'page' : undefined} onClick={go}>{inner}</a>;
}

export function NavTrade({ tab, botsOpen = true, engine, onEngine, onNavigate, onOpenSodex, sodexOn = null, label }: {
  tab: Tab | null;
  /** The Bots page is open for this wallet (beta/access.ts); else its row asks for access. */
  botsOpen?: boolean;
  engine?: Engine;
  onEngine?: (e: Engine) => void;
  onNavigate: (tab: Tab) => void;
  onOpenSodex?: (view: SodexView) => void;
  sodexOn?: SodexView | null;
  label: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const { open, mode, close, press, hoverProps } = useHoverMenu(root, undefined, menu);
  const pres = usePresence(open);
  const onTrade = tab === 'trade';

  /* Under the word on a desktop, kept inside the window; on a phone CSS spans it under the bar. */
  useLayoutEffect(() => {
    const el = menu.current;
    if (!pres.mounted || !el) return;
    const place = () => {
      if (window.innerWidth <= 760) {
        el.style.removeProperty('left');
        return;
      }
      const from = root.current?.getBoundingClientRect().left ?? 8;
      el.style.left = `${Math.max(8, Math.min(from, window.innerWidth - el.offsetWidth - 8))}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [pres.mounted]);

  /* A press or the keyboard moves into the menu; a mouse passing over does not take the focus. */
  useEffect(() => {
    if (mode === 'pinned') menu.current?.querySelector<HTMLElement>('a.menu-row')?.focus();
  }, [mode]);

  const go = (then: () => void) => () => {
    close();
    then();
  };
  const trade = (e: Engine) => go(() => {
    onNavigate('trade');
    onEngine?.(e);
  });
  const botsSoon = SOON_TABS.has('bots');
  const botsLocked = !botsOpen;

  return (
    <div className="navtrade" ref={root} {...hoverProps}>
      <a
        href={pathForTab('trade')}
        className={`navlink${onTrade ? ' active' : ''}`}
        aria-current={onTrade ? 'page' : undefined}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          close();
          onNavigate('trade');
        }}
      >
        {label}
      </a>
      <button type="button" className={`navtrade__chev${open ? ' is-open' : ''}`} aria-label="Trade menu" aria-haspopup="menu" aria-expanded={open} onClick={press}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {pres.mounted && createPortal(
        <div
          ref={menu}
          className={`menu-popup navtrade__menu navpop${pres.closing ? ' is-closing' : ''}`}
          role="menu"
          aria-label="Trade"
          onAnimationEnd={(e) => { if (pres.closing && e.animationName === 'mo-pop-out') pres.done(); }}
        >
          <div className="navtrade__col" role="group" aria-label="Core">
            <div className="menu-group-label" aria-hidden="true">Core</div>
            <Row
              href={pathForTab('trade')}
              title="Futures"
              line="Perpetual contracts on SoDEX"
              current={onTrade && engine === 'perps'}
              onOpen={trade('perps')}
              icon={<Icon><rect x="2.5" y="3" width="15" height="14" rx="2.5" /><path d="M5.5 13.5 8.5 10l2.5 2 3.5-5" /></Icon>}
            />
            <Row
              href={`${pathForTab('trade')}?symbol=vBTC_vUSDC`}
              title="Spot"
              line="Buy and sell coins on SoDEX"
              current={onTrade && engine === 'spot'}
              onOpen={trade('spot')}
              icon={<Icon><circle cx="7.5" cy="7.5" r="4.5" /><circle cx="12.5" cy="12.5" r="4.5" /></Icon>}
            />
            <Row
              href={pathForSodexView('wealth')}
              title="Wealth"
              line="SoDEX's funds and vaults"
              current={sodexOn === 'wealth'}
              onOpen={onOpenSodex && go(() => onOpenSodex('wealth'))}
              access={botsLocked ? go(applyForBeta) : undefined}
              icon={<Icon><path d="M2.5 17h15M4 14l4-4 3 2.500L16.5 6" /><path d="M12.5 6h4v4" /></Icon>}
            />
          </div>
          <div className="navtrade__col" role="group" aria-label="Automated">
            <div className="menu-group-label" aria-hidden="true">Automated</div>
            <Row
              href={pathForTab('copy')}
              title="Copy Trading"
              line="Follow a trader's positions automatically"
              current={tab === 'copy'}
              onOpen={go(() => onNavigate('copy'))}
              icon={<Icon><rect x="7" y="7" width="10.5" height="10.5" rx="2.5" /><path d="M13 7V5a2.5 2.5 0 0 0-2.5-2.500H5A2.5 2.5 0 0 0 2.5 5v5.500A2.5 2.5 0 0 0 5 13h2" /></Icon>}
            />
            <Row
              href={botsSoon ? undefined : pathForTab('bots')}
              soon={botsSoon}
              access={botsLocked ? go(applyForBeta) : undefined}
              title="Bots"
              line="Automated volume and grid strategies"
              current={tab === 'bots'}
              onOpen={go(() => onNavigate('bots'))}
              icon={<Icon><rect x="3.5" y="6.5" width="13" height="10" rx="2.5" /><path d="M10 6.500V3.500M7.5 11v1M12.5 11v1M1.5 10.500v2.500M18.5 10.500v2.5" /></Icon>}
            />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
