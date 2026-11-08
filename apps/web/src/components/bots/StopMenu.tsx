/**
 * One Stop button with its three ways in a menu that opens on hover and on a press (owner 2026-11-08), the app's own
 * pop-up behaviour (useHoverMenu, menu-popup / menu-row, as the bar's More):
 *
 *   Clean stop     closes what it holds at the best price first, a capped taker after a minute (recommended)
 *   Instant stop   closes what it holds now, with a capped taker
 *   Stop and keep  pulls its orders; what it holds stays in the account
 *
 * Holding nothing, all three just stop it. A bot already closing offers "Stop now" (it ends, what is left stays).
 */
import { useRef } from 'react';
import type { AlgoView } from '@copy-engine';
import { fmtUsd } from '../../format';
import { usePresence } from '../motion';
import { useHoverMenu } from '../useHoverMenu';
import type { BotsCtx } from './BotsPage';
import { Icon } from './kit/kit';

const WAYS = [
  { how: 'close' as const, label: 'Clean stop', line: 'Closes at the best price, a capped taker after a minute', tag: 'Recommended' },
  { how: 'instant' as const, label: 'Instant stop', line: 'Closes now with a capped taker' },
  { how: 'keep' as const, label: 'Stop and keep position', line: 'Pulls its orders; the position stays in your account' },
];

export function StopMenu({ v, ctx, closing }: { v: AlgoView; ctx: BotsCtx; closing: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const { open, close, press, hoverProps } = useHoverMenu(root);
  const pres = usePresence(open);
  const busy = ctx.busy === v.algo.id;
  const held = Math.abs(v.bot?.inventoryUsd ?? 0);
  if (closing) {
    return <button type="button" className="tf-btn is-danger is-sm" disabled={busy} onClick={() => void ctx.stop(v)}><Icon name="stop" size={14} />Stop now</button>;
  }
  const go = (how: 'close' | 'instant' | 'keep') => () => {
    close();
    void ctx.stop(v, how);
  };
  return (
    <div className="bots-stopmenu" ref={root} {...hoverProps}>
      <button type="button" className={`tf-btn is-danger is-sm bots-stopmenu__btn${open ? ' is-open' : ''}`} disabled={busy} aria-haspopup="menu" aria-expanded={open} onClick={press}>
        <Icon name="stop" size={14} />Stop
        <svg className="bots-stopmenu__chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {pres.mounted && (
        <div className={`menu-popup navpop bots-stopmenu__menu${pres.closing ? ' is-closing' : ''}`} role="menu" aria-label="Stop" onAnimationEnd={(e) => { if (pres.closing && e.animationName === 'mo-pop-out') pres.done(); }}>
          {held > 0 && <div className="menu-group-label" aria-hidden="true">Holding {fmtUsd(held, 2)}</div>}
          {WAYS.map((w) => (
            <button key={w.how} type="button" role="menuitem" className={`menu-row bots-stopmenu__row is-${w.how}`} onClick={go(w.how)}>
              <span className="menu-row__ic"><Icon name={w.how === 'instant' ? 'bolt' : w.how === 'keep' ? 'pause' : 'shield'} size={14} /></span>
              <span className="bots-stopmenu__t"><span className="menu-row__label">{w.label}{w.tag && held > 0 && <em>{w.tag}</em>}</span><small>{held > 0 ? w.line : 'It holds nothing: this just stops it'}</small></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
