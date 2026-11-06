/**
 * The one window that asks before a trade is sent: an order, a close, a cancel, a move, an exit.
 *
 *   if (!(await askTrade({ kind: 'close', title: 'Close position at market', ... }))) return;
 *
 * Answers true at once when that kind was turned off (trading/confirmPrefs.ts: its "Don't ask again" tick, or the
 * switches in Settings > Trading), unless the caller forces the question.
 *
 * A module rather than a hook, because the callers are far apart (a chart line, a table row, a keyboard shortcut)
 * and only one question is ever open: it mounts itself on first use, and a new question answers an open one "no".
 * Nothing is remembered until the window is confirmed: ticking the box and going back changes nothing.
 *
 * Keys are taken on `window`, before the Modal's listener on `document`, so that Esc closes this window and not the
 * sheet under it. Enter confirms; a key still held from the press that opened the window does not, and neither does
 * Enter in the first moments: the ticket's Enter must not answer its own question.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { confirmOn, setConfirmOn, type ConfirmKind } from '../trading/confirmPrefs';
import { CoinIcon } from './CoinIcon';
import { Modal } from './Modal';
import './TradeConfirm.css';

export interface TradeFact {
  label: string;
  value: ReactNode;
  tone?: 'pos' | 'neg' | undefined;
}

export interface TradeAsk {
  kind: ConfirmKind;
  /** Names the question, so a later `withdrawTradeAsk` can take it back when its subject is gone. */
  id?: string;
  title: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** The confirm button: green for a buy, red for a sell and for what takes something away. */
  tone?: 'buy' | 'sell' | 'danger' | 'plain';
  /** The head of the summary: the market, and which way. */
  market?: string;
  coin?: string | null | undefined;
  side?: { word: string; tone: 'pos' | 'neg' | 'plain' } | undefined;
  facts?: TradeFact[];
  note?: ReactNode;
  /** In place of the summary: a review of its own (ReviewPosition). */
  body?: ReactNode;
  /** The button waits for this tick: the review itself found a hazard. */
  requireAck?: ReactNode;
  /** Asked even when this kind is turned off (a floor, or a single stray key). */
  force?: boolean;
  size?: 'sm' | 'md';
}

interface Open extends TradeAsk {
  answer: (ok: boolean) => void;
}

/** What the window is showing; kept after an answer, so that it closes with its words on it. */
let open: Open | null = null;
let answered = true;
const subs = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  for (const fn of subs) fn();
};

function settle(ok: boolean): void {
  if (!open || answered) return;
  answered = true;
  open.answer(ok);
  changed();
}

let mounted = false;
function mount(): void {
  if (mounted) return;
  mounted = true;
  const host = document.createElement('div');
  host.dataset.tradeConfirm = '';
  document.body.appendChild(host);
  createRoot(host).render(<TradeConfirmWindow />);
}

/** True when the trade may go. Never rejects. */
export function askTrade(ask: TradeAsk): Promise<boolean> {
  if (!ask.force && !confirmOn(ask.kind)) return Promise.resolve(true);
  mount();
  settle(false);
  return new Promise<boolean>((answer) => {
    open = { ...ask, answer };
    answered = false;
    changed();
  });
}

/** The question's subject is gone (the order filled while the window was open): it answers no. */
export function withdrawTradeAsk(id: string): void {
  if (open?.id === id) settle(false);
}

const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
};

/** How long after opening Enter starts to count. */
const ENTER_ARMS_AFTER_MS = 250;

function TradeConfirmWindow() {
  useSyncExternalStore(subscribe, () => version);
  const showing = !answered;
  const ask = open;
  const [ack, setAck] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const go = useRef<HTMLButtonElement>(null);
  const openedAt = useRef(0);

  useEffect(() => {
    if (!showing) return;
    setAck(false);
    setQuiet(false);
    openedAt.current = performance.now();
    // After the Modal's own focus (a child's effect runs first): Enter answers from here, Tab goes to the rest.
    go.current?.focus();
  }, [showing, ask]);

  useEffect(() => {
    if (!showing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        settle(false);
        return;
      }
      if (e.key !== 'Enter') return;
      const at = document.activeElement;
      const dialog = go.current?.closest('[role="dialog"]');
      // Cancel and the close button keep their own Enter.
      if (at instanceof HTMLButtonElement && at !== go.current && dialog?.contains(at)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || performance.now() - openedAt.current < ENTER_ARMS_AFTER_MS) return;
      if (go.current && !go.current.disabled) go.current.click();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [showing]);

  if (!ask) return null;
  const canSilence = !ask.force || confirmOn(ask.kind);
  return (
    <Modal
      open={showing}
      className={`fx vs-confirm tc${ask.body ? ' tc--review' : ''}`}
      size={ask.size ?? 'sm'}
      title={ask.title}
      onClose={() => settle(false)}
      footer={
        <div className="tc-foot">
          {ask.requireAck && (
            <label className="fx-check tc-ack">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>{ask.requireAck}</span>
            </label>
          )}
          <div className="tc-foot__row">
            {canSilence ? (
              <label className="fx-check tc-quiet" title="Turn it back on in Settings, Trading">
                <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
                <span>Don&apos;t ask again</span>
              </label>
            ) : <span />}
            <div className="tc-actions">
              <button type="button" className="fx-cta fx-cta--ghost" onClick={() => settle(false)}>
                {ask.cancelLabel ?? 'Cancel'}
              </button>
              <button
                ref={go}
                type="button"
                className={`fx-cta tc-go is-${ask.tone ?? 'plain'}`}
                disabled={!!ask.requireAck && !ack}
                onClick={() => {
                  if (answered) return;
                  if (quiet) setConfirmOn(ask.kind, false);
                  settle(true);
                }}
              >
                {ask.confirmLabel}
                <kbd aria-hidden="true">↵</kbd>
              </button>
            </div>
          </div>
        </div>
      }
    >
      {ask.body ?? <TradeSummary ask={ask} />}
    </Modal>
  );
}

/** The market and which way, then each figure in a row: nothing the app does not already know. */
export function TradeSummary({ ask }: { ask: Pick<TradeAsk, 'market' | 'coin' | 'side' | 'facts' | 'note'> }) {
  return (
    <div className="tc-sum">
      {ask.market && (
        <div className="tc-head">
          <CoinIcon coin={ask.coin ?? ask.market} size={28} />
          <b>{ask.market}</b>
          {ask.side && <span className={`tc-pill is-${ask.side.tone}`}>{ask.side.word}</span>}
        </div>
      )}
      {!!ask.facts?.length && (
        <dl className="tc-facts">
          {ask.facts.map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd className={f.tone}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {ask.note && <p className="tc-note">{ask.note}</p>}
    </div>
  );
}
