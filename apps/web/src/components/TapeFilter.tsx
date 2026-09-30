/**
 * Counterparty attribution and taker-side muting for the public trade tape.
 *
 * WHAT THE VENUE ACTUALLY PUBLISHES
 * ---------------------------------
 * The WebSocket `trade` channel carries two fields the REST snapshot does not:
 *
 *   { E, T, t, s, S, p, q, bi, si }   <- live push
 *   {    T, t, s, S, p, q         }   <- GET /api/md/{engine}/trades
 *
 * `bi` is the BUYER's account id and `si` is the SELLER's account id. Both are
 * plain integers. Verified live against both engines before this was written:
 *   perps  [{"t":11751668,"S":"SELL","p":"78367","q":"0.00936","bi":23342,"si":1002}]
 *   spot   [{"t":949144, "S":"BUY", "p":"80.173","q":"0.01",   "bi":1002, "si":2140}]
 * and the REST seed for the same markets returns no bi/si at all.
 *
 * WHY MAKER/TAKER IS DERIVED, NOT GUESSED
 * ---------------------------------------
 * `S` is the AGGRESSOR side, not the buyer's side - i.e. it names which side
 * crossed the spread to cause the print. That was established empirically:
 * 82 of 84 sampled prints traded exactly at the touch in the direction `S`
 * implies. So the role assignment is a definition, not a heuristic:
 *
 *   S = BUY   ->  bi crossed the spread (taker),  si was resting (maker)
 *   S = SELL  ->  si crossed the spread (taker),  bi was resting (maker)
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM
 * -------------------------------------
 * Nothing in the public feed designates any account as a market maker, a bot,
 * an official participant, or anything else. The venue does not publish that
 * and we must not imply it. An account id is an account id. Every label here
 * says "account", "counterparty" or "aggressor" for exactly that reason: a
 * user who believes they filtered out "the market makers" when they in fact
 * filtered one arbitrary account is being misled about what they are seeing.
 *
 * THE ORDER BOOK CANNOT BE FILTERED
 * ---------------------------------
 * l2Book levels are aggregated [price, size] pairs with no identity attached,
 * so muting an account has no effect there and none is attempted. The mute is
 * a tape-only view filter.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PrefsIcon } from './PrefsIcon';
import { useLatched } from './motion';
import type { PublicTrade } from '../api';
import { useStored } from '../hooks';
import './TapeFilter.css';

/**
 * Duplicated rather than imported from Market.tsx, and for the same reason
 * Market.tsx's own copy gives for not importing ITS from OrderEntry.tsx: this
 * file has no dependency on Market.tsx today (Market.tsx depends on this
 * file, not the other way round), and a shared popup-dismiss hook belongs in
 * hooks.ts, not borrowed sideways from whichever component happened to write
 * one first.
 */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement>, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref]);
}

/**
 * Accounts this app has been TOLD are market makers, not accounts the venue
 * has labelled as such - the feed carries no such field (see the file header
 * above) and this list makes no claim to the contrary. User-maintained,
 * currently by hand: 1002 and 2140 are the two account ids named when this
 * was added, the same ids already visible in the verified live samples at
 * the top of this file. Extend it the same way if more are identified -
 * there is deliberately no detection logic to keep in sync with here, only
 * a set to add to.
 */
export const KNOWN_MARKET_MAKER_IDS = new Set<number>([1002, 2140]);

/**
 * The canonical PublicTrade in api.ts models only the REST shape. The live
 * channel is a superset, so widen it locally rather than pretend REST rows
 * carry ids they do not - `bi`/`si` are optional precisely because a
 * REST-seeded row genuinely has neither.
 */
export interface TapeTrade extends PublicTrade {
  /** Buyer account id. Live WebSocket prints only. */
  bi?: number;
  /** Seller account id. Live WebSocket prints only. */
  si?: number;
}

/** True when this print carries both counterparty ids, i.e. it came over the WS. */
export const isAttributed = (t: TapeTrade): boolean =>
  typeof t.bi === 'number' && typeof t.si === 'number';

/** The account that crossed the spread, or undefined for an unattributed print. */
export function aggressorOf(t: TapeTrade): number | undefined {
  if (!isAttributed(t)) return undefined;
  return String(t.S).toUpperCase() === 'BUY' ? t.bi : t.si;
}

/** The account that was resting on the book, or undefined for an unattributed print. */
export function restingOf(t: TapeTrade): number | undefined {
  if (!isAttributed(t)) return undefined;
  return String(t.S).toUpperCase() === 'BUY' ? t.si : t.bi;
}

/**
 * Window used for the concentration stat. Deliberately smaller than the 100-print
 * buffer so the number reacts within a minute or two on a quiet market instead
 * of averaging over however long the buffer happens to span.
 */
export const CONCENTRATION_WINDOW = 50;

export interface Concentration {
  /** Distinct account ids seen on either side of the sampled prints. */
  distinct: number;
  /** How many prints actually carried ids - the honest denominator. */
  attributed: number;
  /** Prints in the window with no ids, which cannot contribute to `distinct`. */
  unattributed: number;
}

/**
 * Distinct counterparties across the most recent `window` prints.
 *
 * Counts BOTH sides: concentration is about who is present in this market at
 * all, not only who is lifting. Unattributed prints are excluded from the
 * count and reported separately - silently folding them in either direction
 * would make the ratio a fiction.
 */
export function concentrationOf(trades: TapeTrade[], window = CONCENTRATION_WINDOW): Concentration {
  const sample = trades.slice(0, window);
  const ids = new Set<number>();
  let attributed = 0;
  for (const t of sample) {
    if (!isAttributed(t)) continue;
    attributed++;
    ids.add(t.bi!);
    ids.add(t.si!);
  }
  return { distinct: ids.size, attributed, unattributed: sample.length - attributed };
}

// --- muted accounts ----------------------------------------------------------

const MUTE_KEY = 'opentrade.tape.mutedAccounts';

export interface MuteApi {
  muted: number[];
  isMuted: (id: number | undefined) => boolean;
  mute: (id: number) => void;
  unmute: (id: number) => void;
  clear: () => void;
}

/** Muted account ids, persisted across reloads. */
export function useMutedAccounts(): MuteApi {
  const [raw, setRaw] = useStored<number[]>(MUTE_KEY, []);
  // localStorage is user-writable and survives schema changes, so never trust
  // what comes back - a corrupted entry must degrade to "nothing muted", not
  // throw inside render and take the whole tape down.
  const muted = Array.isArray(raw) ? raw.filter((n) => typeof n === 'number' && Number.isFinite(n)) : [];

  const isMuted = useCallback(
    (id: number | undefined) => id !== undefined && muted.includes(id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [muted.join(',')],
  );
  const mute = useCallback(
    (id: number) => setRaw(muted.includes(id) ? muted : [...muted, id]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [muted.join(','), setRaw],
  );
  const unmute = useCallback(
    (id: number) => setRaw(muted.filter((m) => m !== id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [muted.join(','), setRaw],
  );
  const clear = useCallback(() => setRaw([]), [setRaw]);

  return { muted, isMuted, mute, unmute, clear };
}

// --- account aliases ----------------------------------------------------------

const ALIAS_KEY = 'ot.tape.accountAliases';

export interface AliasApi {
  /** Key -> alias, only entries the user has actually set. */
  aliases: Record<string, string>;
  aliasFor: (id: number | string | undefined) => string | undefined;
  /** Empty/whitespace name deletes the alias, matching a plain rename box
   *  that clears itself rather than needing a separate delete action. */
  setAlias: (id: number | string, name: string) => void;
}

/**
 * A usable name for an account id OR a wallet address, persisted the same way
 * MISSIONCONTROL's scan page keeps its own wallet aliases (`localStorage`,
 * `{ id: name }`, last write wins) - the exact request this ported for asked
 * for both: "give a usable string to an account id + address". One shared
 * store, not two - the trade tape only ever carries the numeric account id
 * (`bi`/`si`), the scan page only ever carries the `0x` address, and the two
 * key spaces cannot collide (one is all digits, the other always starts
 * `0x`), so a single map keyed by `String(id)` serves both without a second
 * mechanism to keep in sync.
 */
export function useAliases(): AliasApi {
  const [raw, setRaw] = useStored<Record<string, string>>(ALIAS_KEY, {});
  const aliases = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  const aliasFor = useCallback(
    (id: number | string | undefined) => (id === undefined ? undefined : aliases[String(id)]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(aliases)],
  );
  const setAlias = useCallback(
    (id: number | string, name: string) => {
      const trimmed = name.trim();
      const next = { ...aliases };
      if (trimmed) next[String(id)] = trimmed;
      else delete next[String(id)];
      setRaw(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(aliases), setRaw],
  );

  return { aliases, aliasFor, setAlias };
}

/**
 * Splits the buffer into what the user sees and what the mute removed.
 *
 * Only the AGGRESSOR is matched. Muting on the resting side instead would hide
 * prints the muted account did not initiate, which is a different question than
 * the one the control asks.
 *
 * Unattributed prints are never filtered - we cannot know who traded, so
 * dropping them would be inventing an attribution, and silently keeping them
 * without saying so would imply they passed the filter. They stay, marked.
 */
export function partitionByMute(
  trades: TapeTrade[],
  isMuted: (id: number | undefined) => boolean,
): { shown: TapeTrade[]; suppressed: number } {
  if (!trades.length) return { shown: trades, suppressed: 0 };
  const shown: TapeTrade[] = [];
  let suppressed = 0;
  for (const t of trades) {
    const agg = aggressorOf(t);
    if (agg !== undefined && isMuted(agg)) suppressed++;
    else shown.push(t);
  }
  return { shown, suppressed };
}

// --- UI ----------------------------------------------------------------------

const SearchGlyph = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true" focusable="false">
    <circle cx="4.6" cy="4.6" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.1" />
    <path d="M7.3 7.3 10 10" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
  </svg>
);

/**
 * The tape's Account column: the aggressor id (the same one the Time column's
 * hover mute button already acts on), shown as its alias when the user has
 * set one. Click the id/alias to rename it in place - a real `<input>`
 * swapped in for the cell's own content rather than a popover, which a
 * single short string does not need. The search glyph opens the Scan page
 * for this account id - see `onOpenScan` in Trades(). A trade print never
 * carries a wallet address, only this numeric id, so Scan resolves what it
 * can from the leaderboard and says plainly when it cannot.
 */
export function AccountCell({
  trade, aliasFor, onSetAlias, onSearch,
}: {
  trade: TapeTrade;
  aliasFor: (id: number | undefined) => string | undefined;
  onSetAlias: (id: number, name: string) => void;
  onSearch: (id: number) => void;
}) {
  const agg = aggressorOf(trade);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (agg === undefined) {
    return (
      <td
        className="tape-cp tape-cp-none"
        title="No account id. This print came from the REST snapshot, which does not publish one, so it cannot be attributed."
      >
        —
      </td>
    );
  }

  if (editing) {
    return (
      <td className="tape-cp">
        <form
          onSubmit={(e) => { e.preventDefault(); onSetAlias(agg, draft); setEditing(false); }}
        >
          <input
            className="tape-acct-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setEditing(false)}
            placeholder={String(agg)}
            aria-label={`Alias for account ${agg}`}
          />
        </form>
      </td>
    );
  }

  const alias = aliasFor(agg);
  const aggressorBuys = String(trade.S).toUpperCase() === 'BUY';
  return (
    <td className="tape-cp">
      <button
        className={`tape-id tape-id-agg ${aggressorBuys ? 'pos' : 'neg'}`}
        onClick={() => { setDraft(alias ?? ''); setEditing(true); }}
        title={alias ? `Account ${agg}, aliased "${alias}". Click to rename.` : `Account ${agg}. Click to give it an alias.`}
      >
        {alias ?? agg}
      </button>
      <button
        className="tape-acct-search"
        onClick={() => onSearch(agg)}
        title={`Look up account ${agg} on the Scan page`}
        aria-label="View wallet details"
      >
        <SearchGlyph />
      </button>
    </td>
  );
}

/**
 * Header bar: mute entry, muted chips, and the two honesty counters.
 *
 * Both rows always render, even at zero, for two reasons. The suppressed count
 * is the only thing standing between "I muted a very active account" and "the
 * tape looks broken" - a panel that can legitimately empty itself must always
 * say why. And a constant bar height keeps the Trades scroll compensation
 * measuring only the row insertions it is meant to measure.
 */
export function TapeControls({
  mutes, suppressed, buffered, concentration, onHeight,
}: {
  mutes: MuteApi;
  suppressed: number;
  /** Total prints held in the buffer, filtered or not. */
  buffered: number;
  concentration: Concentration;
  /** Reports the bar's rendered height so the caller can offset the sticky table header. */
  onHeight?: (px: number) => void;
}) {
  const [draft, setDraft] = useState('');
  const barRef = useRef<HTMLDivElement>(null);
  const onHeightRef = useRef(onHeight);
  onHeightRef.current = onHeight;
  const lastH = useRef(-1);

  // The tape scrolls inside an ancestor, so this bar is sticky. The table's
  // own sticky header then has to sit directly below it rather than at top:0,
  // and the bar's height is font/zoom dependent - so measure it instead of
  // hard-coding an offset that would be wrong on someone else's machine.
  //
  // Report only real changes, and never report 0: the panel measures zero
  // while its tab is hidden, and publishing that would un-offset the column
  // header so it reappears underneath the bar on the way back.
  const sync = useCallback(() => {
    const el = barRef.current;
    if (!el) return;
    const h = el.getBoundingClientRect().height;
    if (h > 0 && Math.abs(h - lastH.current) > 0.5) {
      lastH.current = h;
      onHeightRef.current?.(h);
    }
  }, []);

  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sync]);

  // Belt and braces. A ResizeObserver on the bar alone was observed going
  // stale across a layout change that resized it (measured 65px, actual 58px),
  // which leaves the column header floating below a gap. Re-measuring after
  // every commit is one getBoundingClientRect on a component that re-renders
  // per print, and the change guard above stops it looping.
  useLayoutEffect(sync);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const id = Number(draft.trim());
    // Account ids are non-negative integers; anything else is a typo, and
    // muting a typo would silently do nothing while looking like it worked.
    if (!draft.trim() || !Number.isInteger(id) || id < 0) return;
    mutes.mute(id);
    setDraft('');
  };

  const { distinct, attributed, unattributed } = concentration;

  return (
    <div className="tape-bar" ref={barRef}>
      <div className="tape-bar-row">
        {/* An explicit submit button, not just Enter: the control is easier to
            find, and implicit single-input form submission is exactly the kind
            of thing that silently stops working in some input modes. */}
        <form className="tape-muteform" onSubmit={submit}>
          <input
            className="tape-muteinput"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Mute account id"
            inputMode="numeric"
            aria-label="Mute an account id on the tape"
            title="Hides prints where this account crossed the spread. It does not affect the order book, which publishes no identity."
          />
          <button
            className="tape-mutego"
            type="submit"
            disabled={!draft.trim()}
            title="Mute this account id"
          >
            Mute
          </button>
        </form>
        <div className="tape-chips">
          {mutes.muted.length === 0 && <span className="tape-hint">No accounts muted</span>}
          {mutes.muted.map((id) => (
            <button
              key={id}
              className="tape-chip"
              onClick={() => mutes.unmute(id)}
              title={`Unmute account ${id}`}
            >
              {id}
              <span className="tape-chip-x">×</span>
            </button>
          ))}
        </div>
        {mutes.muted.length > 0 && (
          <button className="tape-clear" onClick={mutes.clear} title="Unmute every account">
            clear
          </button>
        )}
      </div>

      <div className="tape-bar-row tape-stats">
        <span
          className={suppressed > 0 ? 'tape-stat warnish' : 'tape-stat'}
          title="Prints in the buffer whose aggressor is muted. They are hidden, not missing."
        >
          {suppressed} print{suppressed === 1 ? '' : 's'} hidden
          <span className="tape-stat-of"> of {buffered}</span>
        </span>
        <span
          className="tape-stat"
          title={`Distinct account ids on either side of the last ${attributed} attributed print(s). Both aggressor and resting side are counted.`}
        >
          {attributed > 0 ? `${distinct} counterpart${distinct === 1 ? 'y' : 'ies'} in last ${attributed}` : 'no attributed prints yet'}
        </span>
        {unattributed > 0 && (
          <span
            className="tape-stat tape-stat--note dim"
            title="REST-seeded prints publish no account ids, so they show “—”, are never attributed, and are never filtered."
          >
            {unattributed} unattributed (REST seed carries no ids)
          </span>
        )}
      </div>
    </div>
  );
}

const GearIcon = () => <PrefsIcon size={14} />;

/**
 * The tape's own settings: size unit, data source, and the known-market-maker
 * filter. Controlled from Trades() rather than owning its state, the same
 * split TapeControls above has with `mutes`: this component only ever renders
 * what it is given and reports what was clicked.
 */
export function TapeSettings({
  unit, onUnit, baseLabel, hideMakers, onHideMakers, dataSource, onDataSource,
}: {
  unit: 'quote' | 'base';
  onUnit: (u: 'quote' | 'base') => void;
  /** The base coin's own symbol, e.g. "BTC" - falls back to a generic label
   *  when the market metadata has not loaded yet. */
  baseLabel: string;
  hideMakers: boolean;
  onHideMakers: (v: boolean) => void;
  dataSource: 'ws' | 'rest';
  onDataSource: (s: 'ws' | 'rest') => void;
}) {
  const [open, setOpen] = useState(false);
  const menuFx = useLatched(open);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));

  return (
    <div className="menu tape-settingswrap" ref={ref}>
      <button
        type="button"
        className="tape-settingsbtn"
        aria-label="Trade tape settings"
        title="Trade tape settings"
        onClick={() => setOpen((o) => !o)}
      >
        <GearIcon />
      </button>
      {menuFx.value && (
        <div className={`menu-popup tape-settingsmenu${menuFx.closing ? ' is-closing' : ''}`} onAnimationEnd={menuFx.onExit}>
          <div className="tape-settings-cols">
            <div className="menu-group">
              <div className="menu-group-label">Display</div>
              <div className="menu-grid">
                <button type="button" className={unit === 'quote' ? 'active' : ''} onClick={() => onUnit('quote')}>USD</button>
                <button type="button" className={unit === 'base' ? 'active' : ''} onClick={() => onUnit('base')}>{baseLabel}</button>
              </div>
            </div>
            <div className="menu-group">
              {/* Live is the WebSocket push. Historical polls the REST snapshot
                  every few seconds and those prints carry no account ids. */}
              <div className="menu-group-label">Feed</div>
              <div className="menu-grid">
                <button
                  type="button"
                  className={dataSource === 'ws' ? 'active' : ''}
                  title="Live push — every print, with account ids"
                  onClick={() => onDataSource('ws')}
                >
                  Live
                </button>
                <button
                  type="button"
                  className={dataSource === 'rest' ? 'active' : ''}
                  title="Older prints from the snapshot, refreshed every few seconds. They have no account ids, so the Account column, aliases, and Hide likely market makers stop applying."
                  onClick={() => onDataSource('rest')}
                >
                  Historical
                </button>
              </div>
            </div>
          </div>
          <div className="menu-group">
            <label className="tape-settings-check">
              <input type="checkbox" checked={hideMakers} onChange={(e) => onHideMakers(e.target.checked)} />
              Hide likely market makers
            </label>
          </div>
          {/* No market/limit filter here, on purpose - the feed carries no
              order-type field on a print (t, T, s, S, p, q, bi, si only; see
              PublicTrade/TapeTrade), live or REST, so there is nothing to
              filter on. Add it back only once the venue actually publishes
              one - a disabled row explaining the gap was tried and removed;
              it read as clutter, not as disclosure. */}
        </div>
      )}
    </div>
  );
}
