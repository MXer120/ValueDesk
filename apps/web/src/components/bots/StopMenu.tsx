/**
 * One Stop button with its three ways in a menu that opens on hover and on a press (owner 2026-11-08), the app's own
 * pop-up behaviour (useHoverMenu, menu-popup / menu-row, as the bar's More):
 *
 *   Clean stop     closes what it holds at the best price first, a capped taker after a minute (recommended)
 *   Instant stop   closes what it holds now, with a capped taker
 *   Stop and keep  pulls its orders; what it holds stays in the account
 *
 * Holding nothing, all three just stop it. A bot already closing offers "Stop now" (it ends, what is left stays).
 * The same menu serves a tile (`compact`: the icon only) and Stop all (`onPick` and `held`: every running bot).
 */
import { useRef } from 'react';
import type { AlgoView } from '@copy-engine';
import { fmtUsd } from '../../format';
import { usePresence } from '../motion';
import { useHoverMenu } from '../useHoverMenu';
import type { BotsCtx, StopHow } from './BotsPage';
import { Icon, IconButton } from './kit/kit';

const WAYS: Array<{ how: StopHow; label: string; labelAll: string; line: string; lineAll: string; tag?: string }> = [
  { how: 'close', label: 'Clean stop', labelAll: 'Clean stop all', line: 'Closes at the best price, a capped taker after a minute', lineAll: 'Each closes at the best price, a capped taker after a minute', tag: 'Recommended' },
  { how: 'instant', label: 'Instant stop', labelAll: 'Instant stop all', line: 'Closes now with a capped taker', lineAll: 'Each closes now with a capped taker' },
  { how: 'keep', label: 'Stop and keep position', labelAll: 'Stop all and keep positions', line: 'Pulls its orders; the position stays in your account', lineAll: 'Pulls every order at once; positions stay in your account' },
];

export function StopMenu({ v, ctx, closing, compact, onPick, held: heldAll, label = 'Stop', disabled }: {
  v?: AlgoView;
  ctx: BotsCtx;
  closing?: boolean;
  /** The icon only (a tile's controls). */
  compact?: boolean;
  /** Stop all: what was picked, instead of stopping `v`. */
  onPick?: (how: StopHow) => void;
  /** Stop all: what every running bot holds together. */
  held?: number;
  label?: string;
  disabled?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const { open, close, press, hoverProps } = useHoverMenu(root);
  const pres = usePresence(open);
  const busy = disabled || (!!v && ctx.busy === v.algo.id);
  const held = heldAll ?? Math.abs(v?.bot?.inventoryUsd ?? 0);
  if (closing && v) {
    // Already closing: one press ends it where it is (its own question says what stays).
    return compact
      ? <IconButton icon="stop" label="Stop now" className="is-danger" disabled={busy} onClick={() => void ctx.stop(v, 'now')} />
      : <button type="button" className="tf-btn is-danger is-sm" disabled={busy} onClick={() => void ctx.stop(v, 'now')}><Icon name="stop" size={14} />Stop now</button>;
  }
  const go = (how: StopHow) => () => {
    close();
    if (onPick) onPick(how);
    else if (v) void ctx.stop(v, how);
  };
  const many = !!onPick;
  return (
    <div className={`bots-stopmenu${compact ? ' is-compact' : ''}`} ref={root} {...hoverProps}>
      <button type="button" className={`tf-btn is-danger is-sm bots-stopmenu__btn${compact ? ' is-icon' : ''}${open ? ' is-open' : ''}`} disabled={busy} aria-haspopup="menu" aria-expanded={open} aria-label={compact ? label : undefined} title={compact ? label : undefined} onClick={press}>
        <Icon name="stop" size={14} />{!compact && label}
        {!compact && <svg className="bots-stopmenu__chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </button>
      {pres.mounted && (
        <div className={`menu-popup navpop bots-stopmenu__menu${pres.closing ? ' is-closing' : ''}`} role="menu" aria-label={label} onAnimationEnd={(e) => { if (pres.closing && e.animationName === 'mo-pop-out') pres.done(); }}>
          {held > 0 && <div className="menu-group-label" aria-hidden="true">{many ? 'Together they hold' : 'Holding'} {fmtUsd(held, 2)}</div>}
          {WAYS.map((w) => (
            <button key={w.how} type="button" role="menuitem" className={`menu-row bots-stopmenu__row is-${w.how}`} onClick={go(w.how)}>
              <span className="menu-row__ic"><Icon name={w.how === 'instant' ? 'bolt' : w.how === 'keep' ? 'pause' : 'shield'} size={14} /></span>
              <span className="bots-stopmenu__t"><span className="menu-row__label">{many ? w.labelAll : w.label}{w.tag && held > 0 && <em>{w.tag}</em>}</span><small>{held > 0 ? (many ? w.lineAll : w.line) : many ? 'They hold nothing: this just stops them' : 'It holds nothing: this just stops it'}</small></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
