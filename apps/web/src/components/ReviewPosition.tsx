/**
 * Pre-trade review: the last screen between a filled-in ticket and a signed,
 * irreversible order.
 *
 * WHY THIS IS A COMPONENT AND NOT A CONFIRM STRING
 * ------------------------------------------------
 * The thing that makes a confirmation useful is not the question, it is the
 * numbers. "Place this order?" tells you nothing you did not already believe
 * when you clicked. What catches a mistake is seeing the notional you actually
 * committed, the margin it locks, where liquidation sits relative to your stop,
 * and what the exits are worth if they hit. A native `confirm()` can render one
 * unstyled string and cannot show any of that.
 *
 * EVERY NUMBER HERE IS DERIVED FROM VALUES THE TICKET ALREADY HAS.
 * Nothing is fetched, nothing is assumed. Where an input is missing (no last
 * price yet, a symbol with no published margin schedule) the row renders "-"
 * and states why, because a confident-looking invented number on the screen
 * where you commit real money is worse than a blank.
 */
import { useState } from 'react';
import type { Engine, Symbol } from '../api';
import { fmt, fmtPrice, fmtUsd, num, precisionOf, shortAddr, signClass } from '../format';
import {
  checkStopAgainstLiquidation,
  estimateLiquidationPrice,
  pnlAt,
  type MarginMode,
  type Side,
  type StopCheck,
} from '../risk';
import type { BuilderFeeQuote } from '../trading/builder';
import './ReviewPosition.css';

/**
 * Notional at or above which the review is shown on mainnet EVEN IF the user
 * has ticked "don't show this again".
 *
 * A suppression checkbox is a convenience for the trade size someone clicks
 * through twenty times in a session. It must not silently also cover the order
 * that is fifty times that size and was typed in a hurry - which is exactly
 * what an un-floored "never ask again" does, because the preference is stored
 * per-browser and never expires. One tick months ago would otherwise remove
 * every confirmation from every future order, including the one with an extra
 * digit in it.
 *
 * $10,000 is a floor, not a risk model. It is deliberately a round number a
 * user can hold in their head, and it sits roughly where a fat-fingered extra
 * digit stops being an irritating loss and starts being an account-ending one.
 * It is intentionally NOT configurable from the UI: a floor a user can raise to
 * infinity is not a floor.
 */
export const ALWAYS_REVIEW_NOTIONAL_USD = 10_000;

const SUPPRESS_KEY = 'opentrade.review.suppress';

/**
 * localStorage access is wrapped because it throws outright - not returns null -
 * in a Safari private window and under "block all cookies". A thrown storage
 * read must never be the reason an order ticket stops working, and failing
 * closed (treat as "not suppressed") means the worst case is one extra
 * confirmation rather than one skipped confirmation.
 */
export function isReviewSuppressed(): boolean {
  try {
    return localStorage.getItem(SUPPRESS_KEY) === '1';
  } catch {
    return false;
  }
}

export function setReviewSuppressed(v: boolean): void {
  try {
    if (v) localStorage.setItem(SUPPRESS_KEY, '1');
    else localStorage.removeItem(SUPPRESS_KEY);
  } catch {
    // A browser that refuses storage simply keeps showing the review.
  }
}

/**
 * Whether the ticket must be reviewed before it is signed.
 *
 * Two independent reasons, and the second one cannot be turned off:
 *  1. the user has not suppressed the review; or
 *  2. this is real money and the order is at or above the floor above.
 */
export function shouldReview(network: string | undefined, notional: number): boolean {
  if (!isReviewSuppressed()) return true;
  return network === 'mainnet' && notional >= ALWAYS_REVIEW_NOTIONAL_USD;
}

export interface ReviewOrder {
  side: Side;
  engine: Engine;
  /** Wire symbol; `sym` carries the display name and the precision/fee metadata. */
  symbol: string;
  sym?: Symbol;
  /** 'limit' | 'market' | 'stop', as chosen in the ticket. */
  orderType: string;
  /** True when this fills at market - a plain market order, or a stop executing as market. */
  marketExec: boolean;
  /**
   * Limit price for a limit order, last traded price for a market one. Zero
   * when neither is known yet, which the review reports rather than papers over.
   */
  entryPrice: number;
  quantity: number;
  notional: number;
  leverage: number;
  marginMode: MarginMode;
  /** Trigger price of a stop-type order, and whether it is the SL or TP leg. */
  triggerPrice?: number;
  triggerKind?: 'sl' | 'tp';
  triggerOn?: string;
  /** Attached exits, 0 when not set. */
  tpPrice: number;
  slPrice: number;
  reduceOnly: boolean;
  tif: string;
  network?: string;
  /** Address the backend's unlocked key signs as - the account this actually hits. */
  signingAddress?: string | null;
  /**
   * ValueDesk's builder fee on this order, when it will carry one (absent
   * otherwise - and always absent without a configured builder). SoDEX charges
   * it per fill on top of its own fee, so it is a row of its own.
   */
  builderFee?: BuilderFeeQuote;
}

interface Props {
  order: ReviewOrder;
  /**
   * Reports the "don't show again" checkbox. The caller persists it only after
   * the order is actually confirmed, so cancelling out of the review does not
   * quietly disable every future one.
   */
  onSuppressChange?: (v: boolean) => void;
}

/** Distance between two prices, rendered in quote terms and as a percentage of entry. */
function Distance({ from, to, sym }: { from: number; to: number; sym?: Symbol }) {
  if (!(from > 0) || !(to > 0)) return <span className="muted">-</span>;
  const abs = Math.abs(to - from);
  return (
    <>
      {fmt(abs, precisionOf(sym?.tickSize))} {sym?.quoteCoin ?? ''}
      <span className="muted"> ({fmt((abs / from) * 100, 2)}%)</span>
    </>
  );
}

export function ReviewPosition({ order, onSuppressChange }: Props) {
  const [suppress, setSuppress] = useState(false);
  const {
    side, engine, symbol, sym, orderType, marketExec, entryPrice, quantity, notional,
    leverage, marginMode, triggerPrice, triggerKind, triggerOn, tpPrice, slPrice,
    reduceOnly, tif, network, signingAddress, builderFee,
  } = order;

  const isPerps = engine === 'perps';
  const long = side === 'buy';
  const priceKnown = entryPrice > 0;
  const market = sym?.displayName ?? symbol;
  const tick = sym?.tickSize;

  // Margin and liquidation describe OPENING exposure. A reduce-only order can
  // only ever close, so quoting an entry margin and a fresh-position liquidation
  // price for it would describe a position that will never exist.
  const opensExposure = isPerps && !reduceOnly;
  const lev = num(leverage);
  const margin = opensExposure && notional > 0 && lev > 0 ? notional / lev : null;

  const liq = opensExposure
    ? estimateLiquidationPrice({ entryPrice, quantity, side, leverage: lev, sym, marginMode })
    : null;

  // The stop is checked against the side actually being placed - unlike the
  // ticket, which has no side until a button is pressed and must infer one.
  const stopLevel = slPrice > 0 ? slPrice : triggerKind === 'sl' ? num(triggerPrice) : 0;
  const stopCheck: StopCheck | null =
    opensExposure && stopLevel > 0 && priceKnown
      ? checkStopAgainstLiquidation(stopLevel, { entryPrice, quantity, side, leverage: lev, sym, marginMode })
      : null;

  // Fees. A market fill is unambiguously taker; a post-only order is
  // unambiguously maker; a plain resting limit is genuinely either, so it is
  // shown as a range rather than picking the flattering end.
  const makerFee = num(sym?.makerFee);
  const takerFee = num(sym?.takerFee);
  const feeKnown = Boolean(sym) && notional > 0;
  const pct = (r: number) => `${fmt(r * 100, 4)}%`;

  const tpPnl = tpPrice > 0 && priceKnown ? pnlAt(entryPrice, tpPrice, quantity, side) : null;
  const slPnl = slPrice > 0 && priceKnown ? pnlAt(entryPrice, slPrice, quantity, side) : null;

  /**
   * How the order fills, in one phrase. Built rather than concatenated because
   * "limit · limit @ 80,060" - what a naive `type + price` join produced - reads
   * as two different facts and is really one.
   */
  const execLine =
    orderType === 'stop'
      ? `stop · executes as ${marketExec ? 'market' : `limit @ ${fmtPrice(entryPrice, tick)}`}`
      : marketExec
        ? `market · fills at the book, ${priceKnown ? `last ${fmtPrice(entryPrice, tick)}` : 'price unknown'}`
        : `limit @ ${fmtPrice(entryPrice, tick)}`;

  const toggle = (v: boolean) => {
    setSuppress(v);
    onSuppressChange?.(v);
  };

  // Above the floor the checkbox cannot do what it says for THIS order, so the
  // review says so instead of accepting a tick that silently does nothing.
  const flooredNow = network === 'mainnet' && notional >= ALWAYS_REVIEW_NOTIONAL_USD;

  return (
    <div className="review">
      <div className="review-head">
        <span className={`review-side ${long ? 'pos' : 'neg'}`}>{long ? 'BUY / LONG' : 'SELL / SHORT'}</span>
        <span className="review-market">{market}</span>
        {network === 'mainnet' && <span className="badge danger">MAINNET</span>}
      </div>
      <p className="review-sub muted small">
        {execLine}
        {` · ${tif.toUpperCase()}`}
        {reduceOnly ? ' · reduce-only' : ''}
        {isPerps && opensExposure ? ` · ${marginMode} ${lev > 0 ? `${fmt(lev, 0)}x` : ''}` : ''}
      </p>

      <div className="fx-review">
        <div>
          <span>Size</span>
          <b className={quantity > 0 ? undefined : 'muted'}>
            {quantity > 0 ? `${fmt(quantity, sym ? precisionOf(sym.stepSize) : undefined)} ${sym?.baseCoin ?? ''}` : '-'}
          </b>
        </div>
        <div>
          <span>{marketExec ? 'Entry (last price)' : 'Entry (limit)'}</span>
          <b className={priceKnown ? undefined : 'muted'}>{priceKnown ? fmtPrice(entryPrice, tick) : '-'}</b>
        </div>
        {triggerPrice !== undefined && triggerPrice > 0 && (
          <div>
            <span>Trigger ({triggerKind === 'tp' ? 'take profit' : 'stop loss'}{triggerOn ? `, on ${triggerOn}` : ''})</span>
            <b>{fmtPrice(triggerPrice, tick)}</b>
          </div>
        )}
        <div>
          <span>Order value</span>
          <b className={notional > 0 ? undefined : 'muted'}>{notional > 0 ? fmtUsd(notional) : '-'}</b>
        </div>
        {opensExposure && (
          <div>
            <span>Margin required</span>
            <b className={margin !== null ? undefined : 'muted'}>{margin !== null ? fmtUsd(margin) : '-'}</b>
          </div>
        )}
        {opensExposure && (
          <div>
            {/* "est." is not decoration. The exchange liquidates against the
                whole account - other positions, funding, its own mark price -
                which a client cannot reproduce. See risk.ts. */}
            <span>Est. liquidation</span>
            {liq?.price ? (
              <b>
                {fmtPrice(liq.price, tick)}
                <span className="muted"> ({fmt((liq.distancePct ?? 0) * 100, 2)}% away)</span>
              </b>
            ) : (
              <b className="muted">-</b>
            )}
          </div>
        )}
        <div>
          <span>Est. entry fee</span>
          {!feeKnown ? (
            <b className="muted">-</b>
          ) : marketExec ? (
            <b>
              {fmtUsd(notional * takerFee)} <span className="muted">taker {pct(takerFee)}</span>
            </b>
          ) : (
            <b>
              {fmtUsd(notional * makerFee)}–{fmtUsd(notional * takerFee)}{' '}
              <span className="muted">maker {pct(makerFee)} / taker {pct(takerFee)}</span>
            </b>
          )}
        </div>
        {builderFee && (
          <div>
            {/* Charged by SoDEX on each fill, maker or taker, on top of the fee above; paid to ValueDesk. */}
            <span>Est. ValueDesk fee</span>
            {!builderFee.charged ? (
              <b className="muted">none on spot buys</b>
            ) : notional > 0 ? (
              <b>
                {fmtUsd(notional * builderFee.fraction)} <span className="muted">builder {pct(builderFee.fraction)}</span>
              </b>
            ) : (
              <b className="muted">-</b>
            )}
          </div>
        )}
        {signingAddress && (
          <div>
            <span>Signs as</span>
            <b><code>{shortAddr(signingAddress)}</code></b>
          </div>
        )}
      </div>

      {opensExposure && !liq?.price && (
        <p className="muted small review-note">
          No liquidation estimate:{' '}
          {!sym?.marginTiers?.length
            ? 'this symbol publishes no maintenance-margin schedule, and a made-up rate would produce a confident-looking fictional price.'
            : !priceKnown
              ? 'no entry price yet.'
              : 'the entry price, size and leverage above do not describe a liquidatable position.'}
        </p>
      )}

      {(tpPrice > 0 || slPrice > 0) && (
        <div className="review-exits">
          <h3>Exits</h3>
          <div className="fx-review">
            {tpPrice > 0 && (
              <div>
                <span>Take profit</span>
                <b>
                  {fmtPrice(tpPrice, tick)}
                  <span className="muted"> · <Distance from={entryPrice} to={tpPrice} sym={sym} /></span>
                  {' '}
                  <span className={tpPnl === null ? 'muted' : signClass(tpPnl)}>
                    {tpPnl === null ? '-' : fmtUsd(tpPnl)}
                  </span>
                </b>
              </div>
            )}
            {slPrice > 0 && (
              <div>
                <span>Stop loss</span>
                <b>
                  {fmtPrice(slPrice, tick)}
                  <span className="muted"> · <Distance from={entryPrice} to={slPrice} sym={sym} /></span>
                  {' '}
                  <span className={slPnl === null ? 'muted' : signClass(slPnl)}>
                    {slPnl === null ? '-' : fmtUsd(slPnl)}
                  </span>
                </b>
              </div>
            )}
          </div>
          <p className="muted small review-note">
            PnL is price movement only — entry and exit fees, funding and slippage are not included.
            {!priceKnown && ' No entry price is known yet, so no PnL can be computed.'}
          </p>
        </div>
      )}

      {stopCheck?.message && (
        <p
          className={`status ${stopCheck.severity === 'error' ? 'err' : 'warn'} ${
            stopCheck.verdict === 'beyond-liquidation' || stopCheck.verdict === 'at-liquidation' ? 'review-hazard' : ''
          }`}
        >
          <strong>{stopCheck.verdict === 'beyond-liquidation' || stopCheck.verdict === 'at-liquidation' ? 'This stop cannot protect the position. ' : ''}</strong>
          {stopCheck.message}
          {stopCheck.liquidationPrice !== null && (
            <span className="muted">
              {' '}(est. liquidation {fmtPrice(stopCheck.liquidationPrice, tick)} for a {long ? 'long' : 'short'})
            </span>
          )}
        </p>
      )}

      {!priceKnown && (
        <p className="status warn">
          {/* Left blank rather than guessed: without an entry price the value,
              margin and liquidation are all undefined, not zero. */}
          No entry price yet{marketExec ? ' (no last trade)' : ''}. Value, margin and liquidation unavailable.
        </p>
      )}

      <label className="fx-check review-suppress">
        <input type="checkbox" checked={suppress} onChange={(e) => toggle(e.target.checked)} />
        Don&apos;t show this review again
      </label>
      <p className="muted small review-note">
        {flooredNow
          ? `This order is at or above ${fmtUsd(ALWAYS_REVIEW_NOTIONAL_USD, 0)} on mainnet, so it will keep showing this review either way.`
          : `Mainnet orders of ${fmtUsd(ALWAYS_REVIEW_NOTIONAL_USD, 0)} or more always show it regardless.`}
      </p>
    </div>
  );
}
