/**
 * ============================================================================
 *  THE PORTFOLIO PAGE. Sidebar of account facts, main column of performance.
 * ============================================================================
 *
 * WHY A TWO-COLUMN PAGE AND NOT A DRAGGABLE DASHBOARD
 * ---------------------------------------------------
 * This page used to be a second react-grid-layout dashboard. It was moved to a
 * fixed two-column shape because the two halves have genuinely different jobs
 * and a draggable grid cannot express that:
 *
 *   - The LEFT COLUMN is identity and standing facts - who this account is,
 *     what it can do, what it is worth, what it has done. It is a REFERENCE
 *     rail: short rows, one number each, always in the same place. Its width is
 *     fixed (310px) precisely so those numbers land in the same pixel column on
 *     every load and can be read without re-scanning.
 *   - The RIGHT COLUMN is analysis - a chart with a period selector, stat
 *     cards, and the tables. It wants every pixel it can get and it changes
 *     shape as you interact with it.
 *
 * A grid that lets the reader drag the rail into the middle is a grid that lets
 * them break the only property the rail has. So the layout here is CSS, in
 * Portfolio.css, and the knob is one custom property (--pf-rail) rather than a
 * layout array.
 *
 * WHERE EVERY NUMBER ON THIS PAGE COMES FROM
 * ------------------------------------------
 * This app signs real mainnet orders, so nothing here is invented. Four
 * payloads feed the whole page, and each was inspected live against the running
 * backend before a single column was written:
 *
 *  1. The perps account state (SoDEX gateway, read from this browser) ->
 *     `state`, whose keys are terse:
 *       user aid uid av mm mmr am ami amw im cm oim ocm B P O TO S
 *     The gateway documents none of them. Their meaning here is not guessed -
 *     it is pinned by arithmetic identities that this account's own numbers
 *     satisfy exactly, and those identities are RE-CHECKED AT RUNTIME (see
 *     `deriveChecks`) so that a future gateway change shows up as a warning on
 *     screen instead of as quietly mislabelled money:
 *
 *       av - (am + cm + im + oim + ocm + haircut) = 0
 *         haircut = sum(wb×px) − sum(wm). ami is not in the sum: it repeats am.
 *       mmr - mm / av                   = 0      residual measured:  2.8e-17
 *       av - (sum of B[].wb x B[].px + sum of P[].ur) = 0
 *                                                residual measured:  2.8e-12
 *
 *     Read together, those force one interpretation and no other:
 *       av  = ACCOUNT VALUE - total equity, wallet balance plus unrealised PnL
 *       am  = AVAILABLE MARGIN - the free part of that equity
 *       cm  = margin currently held by CROSS positions
 *       im  = margin currently held by ISOLATED positions
 *       oim/ocm = margin held by resting orders (isolated / cross)
 *       mm  = maintenance margin required
 *       mmr = mm / av, the maintenance-margin ratio
 *       amw = withdrawable
 *     Note this makes `av` the LARGER figure and `am` the spendable one. The
 *     third identity is the load-bearing one: equity = cash + unrealised PnL is
 *     only true if `av` is equity and `P[].ur` is unrealised PnL, and it holds
 *     to twelve significant figures across 52 live positions.
 *
 *  2. The perps positions (gateway) -> the verbose position rows. Verified
 *     keys: id symbol marginMode positionSide size initialMargin avgEntryPrice
 *     cumOpenCost cumTradingFee cumClosedSize avgClosePrice maxSize realizedPnL
 *     leverage active isTakenOver takeOverPrice createdAt updatedAt.
 *     There is no mark price, no unrealised PnL and no liquidation price in it.
 *
 *  3. The perps mark prices (gateway) -> { symbol, markPrice, indexPrice, ... }.
 *     This is the ONLY source of a mark price on this page. Positions are
 *     valued by joining it in; a position the feed does not carry gets no
 *     notional and no ROE, and the panel says how many were skipped rather than
 *     quietly summing an incomplete book.
 *
 *  4. api.statsAllTime -> the venue's own perps PnL headline (including a
 *     real daily cumulative-PnL series) plus a walk, from this browser, of
 *     this account's whole fill and funding history. It is expensive - see
 *     `useAllTime`, which paces it and says what it costs.
 *
 * Unrealised PnL is therefore never derived here: it is `P[].ur`, the venue's
 * own per-position figure, joined onto the verbose row by position id. The
 * derived alternative ((mark - entry) x size) was computed during verification
 * and lands within ~1% of it - the gap is that the two payloads are two
 * snapshots - which is exactly why the venue's number is preferred.
 *
 * WHAT IS DELIBERATELY BLANK, AND WHY THAT IS THE FEATURE
 * ------------------------------------------------------
 * A conventional perp-DEX portfolio rail carries a fixed set of rows, and this
 * one carries the same set so it can be read by muscle memory. Several of those
 * rows have NO honest source behind this venue's API. They are rendered as an
 * em-dash with the reason in the tooltip, never as a zero and never as a
 * plausible-looking estimate:
 *
 *   Win rate     - needs a closed-trade log. The venue publishes none: positions
 *                  carry realizedPnL only while they are OPEN, and there is no
 *                  round-trip history to count wins from.
 *   Net P&L      - would be realised minus fees minus funding, but no per-period
 *                  fee or funding total exists, AND it is not documented whether
 *                  the venue's cumulative PnL is already net of them. Two
 *                  unknowns; subtracting anyway would produce a confident number
 *                  that is wrong twice.
 *   Sub-accounts - the account model is one account id per wallet (`aid`). There
 *                  is no sub-account concept to select between, so no selector
 *                  is rendered. An empty dropdown is worse than none.
 *   Claim        - no claim/reward endpoint exists in the backend. A button that
 *                  cannot do anything is not a placeholder, it is a bug report
 *                  waiting to happen, so it is not rendered.
 *
 * The rows that ARE derived here rather than published are annotated
 * `derived` / `est.` in the source. Those chips are no longer DRAWN - see
 * SHOW_PROVENANCE_TAGS - so the page no longer distinguishes a figure we
 * computed from one the venue published. That is a deliberate trade of
 * disclosure for a quieter panel, not an oversight: the annotation is still on
 * every row, and turning it back on is a one-line change.
 *
 * A venue liquidation price is also deliberately absent. The state payload
 * carries a per-position `lp` which is very likely one: it is always on the
 * losing side of entry (0 of 30 non-zero samples were on the wrong side), it is
 * exactly 0 for longs that cannot be liquidated by price alone, and it is
 * distinct from `takeOverPrice`, which is 0 on every position observed. That is
 * strong circumstantial evidence and not documentation, and a mislabelled
 * liquidation price is precisely the number a trader would bet size on - so the
 * column here is risk.ts's own estimate, labelled "est.".
 *
 * WHAT THIS PAGE NO LONGER DRAWS FOR ITSELF
 * -----------------------------------------
 * The row-level account views - open positions, balances, fills, orders,
 * funding - are NOT rendered here any more. They are the shared account band,
 * components/AccountTabs.tsx, which is the same element the trade page carries
 * along its bottom edge. This page used to draw its own differently-styled
 * copies of all six, which meant "your open orders" looked like two different
 * features depending on which page you were reading and gave the account API
 * two places to break.
 *
 * What is left here is what only this page has: the account's identity, the
 * decoded equity and margin figures, the venue's one historical series, and the
 * two analyses built on top of them (margin usage, net exposure). The
 * venue's own per-position unrealised PnL still reaches the screen - summed, on
 * the Account value card and in Overview - and the per-market breakdown of
 * exposure is in Net positions exposure. Nothing that had a source lost one.
 *
 * This page is read-only on purpose: closing a position takes a real market
 * order whose SIDE must be right, and that path already exists, tested, on the
 * trade page. A second copy of it is a second chance to get a short flattened
 * as a long. (The shared band's Positions tab does carry a Close action, and
 * that is the SAME tested path rather than a second copy of it - which is
 * exactly the argument for sharing the element instead of re-implementing it.)
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { PrefsIcon } from './PrefsIcon';
import { useLatched } from './motion';
import type { PanelDefinition } from '../dashboard/types';
import { Leaderboard } from './Leaderboard';
import { FeeTier } from './FeeTier';
import { Private, useAddressMask, useMask, usePrivacy, type PrivacyKey } from '../privacy';
import {
  fetchChainNative, fetchChainTokens, fetchCoinPrices, priceTokens,
  type ChainNative, type ChainToken,
} from '../scanChain';
import { api, type Engine, type Symbol as MarketSymbol } from '../api';
import { bumpAccountResource, useAccountResource } from '../accountFeeds';
import { useAsync, useChannel, useStored, useSymbols } from '../hooks';
import {
  WINDOWS as VENUE_WINDOWS,
  fetchAccountId,
  fetchChart,
  type ChartPoint,
  type MarketType,
  type Window as VenueWindow,
} from '../performance';
import { DASH, fmt, fmtBalance, fmtUsd, num, pick, shortAddr, signClass } from '../format';
import { fmtRate, type VenueFeeRate } from '../fees';
import { estimateLiquidationPrice, type LiquidationEstimate } from '../risk';
import { AccountTabs } from './AccountTabs';
import { ReadFailed } from './AccountHistory';
import { CoinIcon, CoinLabel } from './CoinIcon';
import { useAccountTotals } from './account/useAccountTotals';
import { Chevron, ConnectedWalletLogo, CopyIcon, SodexMark } from './funds/ui';
import { marginUsage } from '../accountData';
import { readGateway } from '../trading/gateway';
import { walletRank } from '../exchange/sodexData';
import { pollEvery } from '../exchange/visibility';
import { logLoadFailure } from './LoadFailed';
import { Modal } from './Modal';
import { Collapse } from './motion';
import { requestDeposit, requestTransfer, requestWithdraw } from './account/actions';
import './Portfolio.css';
import {
  Card, EquityCurve, Group, Row, Stat, fmtCompactUsd, fmtDay, type CurveWindow,
} from './portfolio/parts';
import { fmtFixed } from '../numStyle';

/* The design system and the curve live in ./portfolio/parts (so that using a
   Card does not load this page); they are still exported from here. */
export { Card, EquityCurve, Group, Row, Stat, Tag, fmtCompactUsd, fmtDay } from './portfolio/parts';
export type { CurveWindow } from './portfolio/parts';

// =============================================================================
//  1. THE MODEL - every derived number on this page is built here, once.
// =============================================================================

/**
 * Whether a position is long or short.
 *
 * Reimplemented rather than imported because Account.tsx does not export it,
 * and extended in one way that matters: that copy resolves `positionSide`
 * through `num()`, which only recognises the numeric enum {LONG:2, SHORT:3}.
 * The live REST payload spells it as a STRING - every observed position reports
 * `positionSide: "BOTH"`, and the funding log reports `"SHORT"` - so the string
 * spellings are handled explicitly here before falling back to the sign of
 * `size` (which is signed: a short reports a negative size).
 *
 * Returns null rather than guessing. A mislabelled direction turns a short into
 * a long everywhere on this page, including in the net-exposure figure.
 */
export function positionDirection(p: unknown): 'long' | 'short' | null {
  const raw = pick<string | number>(p, 'positionSide', 'ps');
  const side = typeof raw === 'string' ? raw.toUpperCase() : raw;
  if (side === 'LONG' || side === 2) return 'long';
  if (side === 'SHORT' || side === 3) return 'short';

  // 'BOTH' (one-way mode) carries no direction; the sign of size does.
  const amt = num(pick(p, 'size', 'sz', 'positionAmt', 'pa', 'q'));
  if (amt > 0) return 'long';
  if (amt < 0) return 'short';
  return null;
}

/** The terse perps account summary, decoded. Every field is a raw string from the gateway. */
interface AccountSummary {
  /** av - total equity. */
  accountValue: number;
  /** am - free cross margin. */
  availableMargin: number;
  /** ami - free isolated margin. */
  isolatedAvailable: number;
  /** amw - withdrawable. */
  withdrawable: number;
  /** mm - maintenance margin required. */
  maintenanceMargin: number;
  /** mmr - the venue's own mm/av. */
  maintenanceRatio: number;
  /** cm - margin held by cross positions. */
  crossMargin: number;
  /** im - margin held by isolated positions. */
  isolatedMargin: number;
  /** oim + ocm - margin held by resting orders. */
  orderMargin: number;
  /** Sum of B[].wb x B[].px - the cash side of equity, before unrealised PnL. */
  walletValue: number;
  /** walletValue − sum(B[].wm). Collateral SoDEX does not count as margin. */
  haircut: number;
  /** True when the wallet has a SoDEX account at all (aid != 0). */
  exists: boolean;
}

interface PositionRow {
  id: number;
  symbol: string;
  sym: MarketSymbol | undefined;
  dir: 'long' | 'short' | null;
  /** Signed, as the venue reports it. */
  size: number;
  entry: number;
  /** Joined from the mark-price feed; null when that feed does not carry this market. */
  mark: number | null;
  /** The venue's own P[].ur. null when the state payload had no row for this position. */
  unrealized: number | null;
  realized: number;
  fees: number;
  /** initialMargin, verbatim. */
  margin: number;
  leverage: number;
  marginMode: string;
  /** |size| x mark. null without a mark. */
  notional: number | null;
  /** |size| x entry - what was committed, always available. */
  entryNotional: number;
  /** unrealised / initialMargin. The conventional return-on-margin. */
  roe: number | null;
  liq: LiquidationEstimate;
  takenOver: boolean;
}

interface Exposure {
  long: number;
  short: number;
  gross: number;
  net: number;
  /** gross / accountValue. */
  grossLeverage: number | null;
  /** Positions excluded from the sums because the mark feed did not carry them. */
  unpriced: number;
  byMarket: Array<{ symbol: string; dir: 'long' | 'short' | null; notional: number; share: number }>;
}

/**
 * Resting-order notional.
 *
 * Separate from Exposure because it is a different KIND of number: exposure is
 * risk you already carry, this is risk you have queued. `excluded` counts the
 * orders that could be valued at neither their own limit price nor a mark, so
 * the total is never quietly short by an unknown amount.
 */
interface OpenOrdersSummary {
  count: number;
  notional: number;
  excluded: number;
}

/**
 * The runtime re-check of the three identities the field decoding rests on.
 *
 * This is not decoration. Every label on the equity and margin panels is an
 * inference from these identities, so if the gateway ever changes what a key
 * means, the identities break first - and the page says so above the numbers
 * instead of continuing to print confident nonsense.
 */
interface Checks {
  /** av − (am + cm + im + oim + ocm + haircut). ami is not included. */
  marginResidual: number;
  /** av - (walletValue + sum of unrealised). */
  equityResidual: number;
  /** mmr - mm/av. */
  ratioResidual: number;
  /** Absolute residual we accept as floating-point noise, scaled to the account. */
  tolerance: number;
  ok: boolean;
  /** False when some position had no `ur`, which makes equityResidual meaningless. */
  equityCheckable: boolean;
}

interface PortfolioModel {
  loading: boolean;
  /** Fatal read error, if any. Panels render it instead of a table of zeros. */
  error: string | null;
  account: AccountSummary | null;
  positions: PositionRow[];
  exposure: Exposure | null;
  orders: OpenOrdersSummary | null;
  checks: Checks | null;
  /** Sum of the venue's own per-position `ur`. null when any position lacked one. */
  unrealized: number | null;
  /** Verbose balance rows straight from /api/acct/<engine>/balances - no decoding. */
  perpsBalances: Array<Record<string, unknown>>;
  spotBalances: Array<Record<string, unknown>>;
  balancesError: string | null;
  /** Re-read the account state and positions now (a failed read's Retry). */
  refresh: () => void;
}

export function deriveAccount(payload: any): AccountSummary | null {
  const s = payload?.state;
  if (!s) return null;
  // wb x px, not wb: `px` is the coin's price in the account's quote unit (1 for
  // vUSDC). Verified against /api/acct/perps/balances, which spells the same two
  // fields `total` and `price` and returns byte-identical values.
  const balances = Array.isArray(s.B) ? s.B : [];
  let walletValue = 0;
  let marginValue = 0;
  let haircutKnown = true;
  for (const b of balances) {
    const px = num(pick(b, 'px', 'price')) || 1;
    walletValue += num(pick(b, 'wb', 'total')) * px;
    const wm = pick(b, 'wm');
    if (wm === undefined || wm === null || wm === '') haircutKnown = false;
    else marginValue += num(wm);
  }
  return {
    accountValue: num(s.av),
    availableMargin: num(s.am),
    isolatedAvailable: num(s.ami),
    withdrawable: num(s.amw),
    maintenanceMargin: num(s.mm),
    maintenanceRatio: num(s.mmr),
    crossMargin: num(s.cm),
    isolatedMargin: num(s.im),
    orderMargin: num(s.oim) + num(s.ocm),
    walletValue,
    haircut: haircutKnown ? walletValue - marginValue : 0,
    exists: payload?.exists === true,
  };
}

export function derivePositions(
  rows: any[],
  statePayload: any,
  marks: Map<string, number>,
  byName: Map<string, MarketSymbol>,
): PositionRow[] {
  // The state payload's P[] carries the one field the verbose rows do not:
  // `ur`, unrealised PnL. Joined on position id, never on symbol - one symbol
  // can hold more than one position id under hedge mode.
  const unrealizedById = new Map<number, number>();
  for (const p of statePayload?.state?.P ?? []) {
    const id = num(pick(p, 'i', 'id'));
    const ur = pick(p, 'ur');
    if (id && ur !== undefined) unrealizedById.set(id, num(ur));
  }

  return rows
    .filter((p) => num(pick(p, 'size')) !== 0)
    .map((p): PositionRow => {
      const symbol = pick<string>(p, 'symbol') ?? '-';
      const sym = byName.get(symbol);
      const size = num(pick(p, 'size'));
      const entry = num(pick(p, 'avgEntryPrice'));
      const dir = positionDirection(p);
      const mark = marks.get(symbol) ?? null;
      const id = num(pick(p, 'id'));
      const unrealized = unrealizedById.has(id) ? unrealizedById.get(id)! : null;
      const margin = num(pick(p, 'initialMargin'));
      const leverage = num(pick(p, 'leverage'));

      return {
        id,
        symbol,
        sym,
        dir,
        size,
        entry,
        mark,
        unrealized,
        realized: num(pick(p, 'realizedPnL')),
        fees: num(pick(p, 'cumTradingFee')),
        margin,
        leverage,
        marginMode: String(pick(p, 'marginMode') ?? '-'),
        notional: mark === null ? null : Math.abs(size) * mark,
        entryNotional: Math.abs(size) * entry,
        roe: unrealized !== null && margin > 0 ? unrealized / margin : null,
        // Deliberately isolated: extraCollateral is left at 0 even for CROSS
        // positions. Under cross margin the whole free balance backs every
        // position at once, so attributing it to each one in turn would push
        // every estimate far away from entry and understate the risk of all of
        // them simultaneously. Zero gives the CONSERVATIVE (nearer) level - the
        // panel says so, and erring toward "closer than it really is" is the
        // only safe direction for this particular number.
        liq: estimateLiquidationPrice({
          entryPrice: entry,
          quantity: Math.abs(size),
          side: dir === 'short' ? 'sell' : 'buy',
          leverage,
          sym,
          marginMode: String(pick(p, 'marginMode') ?? '').toUpperCase() === 'ISOLATED' ? 'isolated' : 'cross',
          extraCollateral: 0,
          // Isolated: its own margin as SoDEX holds it (added / removed included) - SoDEX's own liquidation price.
          isolatedMargin: String(pick(p, 'marginMode') ?? '').toUpperCase() === 'ISOLATED' && margin > 0 ? margin : undefined,
        }),
        takenOver: pick<boolean>(p, 'isTakenOver') === true,
      };
    })
    // Biggest risk first: a portfolio page is read top-down and the position
    // that can hurt most should not be below the fold.
    .sort((a, b) => (b.notional ?? b.entryNotional) - (a.notional ?? a.entryNotional));
}

export function deriveExposure(rows: PositionRow[], account: AccountSummary | null): Exposure | null {
  if (rows.length === 0) return null;
  let long = 0;
  let short = 0;
  let unpriced = 0;
  const byMarket: Exposure['byMarket'] = [];

  for (const r of rows) {
    if (r.notional === null || r.dir === null) {
      unpriced++;
      continue;
    }
    if (r.dir === 'long') long += r.notional;
    else short += r.notional;
    byMarket.push({ symbol: r.symbol, dir: r.dir, notional: r.notional, share: 0 });
  }

  const gross = long + short;
  for (const m of byMarket) m.share = gross > 0 ? m.notional / gross : 0;
  byMarket.sort((a, b) => b.notional - a.notional);

  return {
    long,
    short,
    gross,
    net: long - short,
    grossLeverage: account && account.accountValue > 0 ? gross / account.accountValue : null,
    unpriced,
    byMarket,
  };
}

/**
 * Notional still resting on the book.
 *
 * Valued at the order's OWN price, because that is the price it will fill at -
 * a mark price would answer a different question. A market order carries no
 * price, so it falls back to the mark; if neither exists the order is counted in
 * `excluded` rather than valued at zero, which would understate the total
 * silently.
 */
export function deriveOrders(rows: any[], marks: Map<string, number>): OpenOrdersSummary {
  let notional = 0;
  let excluded = 0;
  for (const o of rows) {
    const symbol = pick<string>(o, 'symbol', 's') ?? '';
    const qty = num(pick(o, 'quantity', 'q', 'origQty'));
    const filled = num(pick(o, 'filledQuantity', 'z', 'executedQty'));
    const remaining = Math.max(0, Math.abs(qty) - Math.abs(filled));
    const px = num(pick(o, 'price', 'p')) || marks.get(symbol) || 0;
    if (remaining === 0) continue;
    if (px <= 0) {
      excluded++;
      continue;
    }
    notional += remaining * px;
  }
  return { count: rows.length, notional, excluded };
}

export function deriveChecks(account: AccountSummary | null, rows: PositionRow[]): Checks | null {
  if (!account) return null;
  const av = account.accountValue;
  // Scaled to the account: an absolute epsilon would be far too tight on a
  // seven-figure balance and far too loose on a ten-dollar one. 1e-6 relative
  // is ~six orders of magnitude above the residuals actually observed.
  const tolerance = Math.max(1e-6, Math.abs(av) * 1e-6);

  const marginResidual =
    av - (account.availableMargin + account.crossMargin + account.isolatedMargin + account.orderMargin + account.haircut);

  const equityCheckable = rows.length === 0 || rows.every((r) => r.unrealized !== null);
  const unrealizedTotal = rows.reduce((s, r) => s + (r.unrealized ?? 0), 0);
  const equityResidual = av - (account.walletValue + unrealizedTotal);

  const ratioResidual = av > 0 ? account.maintenanceRatio - account.maintenanceMargin / av : 0;

  return {
    marginResidual,
    equityResidual,
    ratioResidual,
    tolerance,
    equityCheckable,
    ok:
      Math.abs(marginResidual) <= tolerance
      && Math.abs(ratioResidual) <= 1e-6
      && (!equityCheckable || Math.abs(equityResidual) <= tolerance),
  };
}

/**
 * Every live read this page makes, in one place.
 *
 * Polling intervals are deliberately unequal: the account state moves on every
 * fill, the mark feed moves constantly but only changes valuations, and balance
 * rows barely move at all. The account WebSocket also pushes a refresh, so the
 * polls are a floor rather than the mechanism.
 *
 * The expensive history walk is NOT here - see `useAllTime`.
 */
function usePortfolioModel(
  address: string | null,
  refreshToken: number,
  perpsByName: Map<string, MarketSymbol>,
): PortfolioModel {
  // state/positions/open are shared with Account.tsx, Chart.tsx and
  // OrderEntry.tsx via accountFeeds.ts - the same (resource, engine, address)
  // key, so a Trade tab and a Portfolio tab open on the same address (two
  // windows, or two browser tabs) ride one poll instead of two.
  const stateKey = address ? `state:perps:${address}` : null;
  const posKey = address ? `pos:${address}` : null;
  const ordersKey = address ? `orders:perps:${address}` : null;

  /*
   * Stream-driven refresh. The account channels push on every order, fill and
   * balance change - an active account several a second - and
   * bumpAccountResource collapses a burst into one re-read per shared feed.
   *
   * The marks and the two balance lists are NOT refetched on the stream any
   * more. They used to be, through a 3s-coalesced `tick`: on a market maker's
   * account that re-read both balance lists and the marks every 3s against the
   * backend's shared weight budget, and the queue it built timed out the spot
   * state read the Balances tab needs (measured). None of them moves with a
   * fill in a way their own polls do not catch.
   */
  const sub = address ? { user: address } : null;
  const onStream = useCallback(() => {
    bumpAccountResource(stateKey);
    bumpAccountResource(posKey);
    bumpAccountResource(ordersKey);
  }, [stateKey, posKey, ordersKey]);
  useChannel('perps', sub ? { channel: 'accountUpdate', ...sub } : null, onStream);
  useChannel('perps', sub ? { channel: 'accountTrade', ...sub } : null, onStream);
  useChannel('perps', sub ? { channel: 'accountOrderUpdate', ...sub } : null, onStream);

  const enabled = !!address;
  const deps = [address, refreshToken];

  const state = useAccountResource(stateKey, () => api.state('perps', address!), 10_000);
  const positions = useAccountResource(posKey, () => api.positions(address!), 10_000);
  const marks = useAsync(() => api.markPrices(), [], { pollMs: 15_000 });
  const open = useAccountResource(ordersKey, () => api.openOrders('perps', address!), 10_000);
  const perpsBal = useAsync(() => api.balances('perps', address!), deps, { enabled, pollMs: 30_000 });
  const spotBal = useAsync(() => api.balances('spot', address!), deps, { enabled, pollMs: 30_000 });
  useEffect(() => {
    state.refresh();
    positions.refresh();
    open.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const markMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const row of marks.data?.markPrices ?? []) {
      const s = pick<string>(row, 'symbol', 's');
      const p = num(pick(row, 'markPrice', 'p'));
      if (s && p > 0) m.set(s, p);
    }
    return m;
  }, [marks.data]);

  return useMemo(() => {
    const account = deriveAccount(state.data);
    const rows = derivePositions(positions.data?.positions ?? [], state.data, markMap, perpsByName);
    // null, not 0, in the two cases where 0 would be a LIE rather than a total:
    // when there is no account to read at all (no wallet connected, or the read
    // has not landed), and when some position is missing its `ur` so the sum
    // would be partial. `[].every()` is true, so without the `account` guard a
    // disconnected page printed a confident "$0.00" tagged as the venue's own
    // figure - which is exactly the class of number this file exists to prevent.
    const unrealized = account && rows.every((r) => r.unrealized !== null)
      ? rows.reduce((s, r) => s + (r.unrealized ?? 0), 0)
      : null;
    return {
      loading: state.loading || positions.loading,
      error: state.error ?? positions.error,
      account,
      positions: rows,
      exposure: deriveExposure(rows, account),
      orders: open.data ? deriveOrders(open.data.orders ?? [], markMap) : null,
      checks: deriveChecks(account, rows),
      unrealized,
      perpsBalances: perpsBal.data?.balances ?? [],
      spotBalances: spotBal.data?.balances ?? [],
      balancesError: perpsBal.error ?? spotBal.error,
      refresh: () => { state.refresh(); positions.refresh(); },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.data, state.loading, state.error, positions.data, positions.loading, positions.error,
    markMap, perpsByName, open.data, perpsBal.data, perpsBal.error, spotBal.data, spotBal.error,
  ]);
}

// =============================================================================
//  2. THE HISTORY WALK - real, expensive, and never automatic.
// =============================================================================

/** One coin's total from the server-side walk. `coin: null` = the venue did not label it. */
interface CoinTotal {
  coin: string | null;
  amount: string;
  count: number;
}

interface WalkTradeStats {
  count: number;
  fees: CoinTotal[];
  volume: CoinTotal[];
}

interface SyncProgress {
  kind: string;
  status: 'never' | 'running' | 'done' | 'error';
  complete: boolean;
  truncated: string | null;
  error: string | null;
  oldest: number | null;
}

/** The subset of api.statsAllTime this page reads (server/src/statsCore.ts owns the full shape). */
interface AllTimeResponse {
  trades: { spot: WalkTradeStats; perps: WalkTradeStats };
  funding: { count: number; totals: CoinTotal[] };
  headline: {
    available: boolean;
    reason: string | null;
    asOf: number | null;
    cumulativePnl: string | null;
    cumulativeQuoteVolume: string | null;
    /** Cumulative (not per-day) perps PnL, one point per UTC day. */
    curve: Array<{ t: number; pnl: string }>;
  };
  sync: { running: boolean; scopes: Record<string, SyncProgress> };
}

interface AllTime {
  started: boolean;
  loading: boolean;
  error: string | null;
  data: AllTimeResponse | null;
  start: () => void;
}

/**
 * The account's own history, behind one click.
 *
 * api.statsAllTime walks this account's entire fill and funding history from
 * this browser (exchange/allTime.ts). On an active account that is tens of
 * thousands of rows and several minutes, and - this is the part that matters -
 * it spends the same per-IP upstream budget that the live trading views need.
 * So the walk is paced as the lowest-priority traffic there is (a page every
 * few seconds, never while the fill panels need the history drip).
 * This was not theoretical: auto-loading it drove `weightSpent` to 1151/1200 and
 * left the equity and positions panels stuck on "Loading…" while the walk ran.
 *
 * A portfolio page must not be able to starve the order book by being opened.
 * So the walk starts when the reader asks for it, the cost is stated first, and
 * every figure that depends on it renders an em-dash until then.
 *
 * Polling only while a walk is in flight is the same rule: a finished walk is
 * cached in this browser and re-polling it would burn budget for no new data.
 */
function useAllTime(address: string | null): AllTime {
  const [started, setStarted] = useState(false);
  const [data, setData] = useState<AllTimeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A different wallet is a different history. Reset rather than showing the
  // previous account's totals under the new address.
  useEffect(() => {
    setStarted(false);
    setData(null);
    setError(null);
  }, [address]);

  const load = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      const body: AllTimeResponse = await api.statsAllTime(address);
      if (alive.current) {
        setData(body);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [address]);

  const start = useCallback(() => {
    if (!address) return;
    setStarted(true);
    void load();
  }, [address, load]);

  /*
   * Start automatically.
   *
   * This used to sit behind a "Load account history" button because the walk is
   * expensive - it pages the gateway and caches into SQLite. But the button made
   * the page look broken to anyone who did not know to press it: every all-time
   * figure read as empty until they did, and nothing said why. The cost is the
   * server's, it is cached, and the progress is already reported - so it should
   * just run. `started` still gates the poller, so the behaviour after kick-off
   * is unchanged.
   */
  useEffect(() => {
    if (!address || started) return;
    start();
  }, [address, started, start]);

  const running = data?.sync.running ?? false;
  useEffect(() => {
    if (!started || !running) return;
    const id = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(id);
  }, [started, running, load]);

  return { started, loading, error, data, start };
}

/**
 * A rolling 14-day traded notional, measured from the fill log - or nothing.
 *
 * The fee ladder is keyed on a rolling 14-DAY window and the venue publishes no
 * such figure, so this is the only honest route to one: walk back through the
 * recent fill page and sum price x quantity inside the window.
 *
 * The whole value of this is the COVERAGE CHECK. One page of fills is a fixed
 * number of rows, not a fixed span of time. If the oldest fill returned is still
 * newer than the window start, the page ran out before the window did and the
 * sum is a FLOOR, not the total - and a floor read as a 14-day volume will
 * mis-tier the reader's fee estimate upwards. So `complete` is reported
 * alongside the number and the UI renders ">= x" and says why.
 *
 * Behind a button for the same reason the walk is: it is an extra upstream read
 * that most visits do not need.
 */
const FILL_PAGE = 500;
const WINDOW_DAYS = 14;

interface VolumeWindow {
  usd: number;
  /** True when the fill page reached back past the window start. */
  complete: boolean;
  /** Oldest fill timestamp the page returned, for the "only reaches back to" note. */
  oldest: number | null;
  fills: number;
}

function useVolume14d(address: string | null): {
  started: boolean; loading: boolean; error: string | null; value: VolumeWindow | null; start: () => void;
} {
  const [started, setStarted] = useState(false);
  const [value, setValue] = useState<VolumeWindow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setStarted(false);
    setValue(null);
    setError(null);
  }, [address]);

  const start = useCallback(() => {
    if (!address) return;
    setStarted(true);
    setLoading(true);
    setError(null);
    const since = Date.now() - WINDOW_DAYS * 86_400_000;
    api
      .userTrades('perps', address, FILL_PAGE)
      .then(({ trades }) => {
        let usd = 0;
        let fills = 0;
        let oldest: number | null = null;
        for (const t of trades ?? []) {
          const at = num(pick(t, 'time', 'T', 'createdAt', 'updatedAt'));
          if (at > 0) oldest = oldest === null ? at : Math.min(oldest, at);
          if (at < since) continue;
          // A fill carries price and quantity and no quote-side field, so this
          // multiplication IS the notional - the same derivation the server's
          // walk uses, stated in Stats' provenance note.
          const px = num(pick(t, 'price', 'p'));
          const qty = num(pick(t, 'quantity', 'q', 'origQty'));
          if (px <= 0 || qty <= 0) continue;
          usd += px * qty;
          fills++;
        }
        setValue({ usd, complete: oldest !== null && oldest <= since, oldest, fills });
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [address]);

  return { started, loading, error, value, start };
}

// =============================================================================
//  3. PERIOD MATHS - everything derived from the venue's daily PnL series.
// =============================================================================

export type Period = '24H' | '7D' | '14D' | '30D' | '90D' | 'ALL';
const PERIODS: Period[] = ['7D', '30D', '90D', 'ALL'];
const PERIOD_DAYS: Record<Period, number | null> = { '24H': 1, '7D': 7, '14D': 14, '30D': 30, '90D': 90, ALL: null };

/* ---------------------------------------------------------------------------
 * The venue's own equity / PnL series.
 *
 * `wallet/portfolio/chart` is fetched STRAIGHT from the browser - it is CORS
 * open and needs no credentials. That keeps each user on their own IP against
 * SoDEX's per-IP rate limit rather than funnelling every user through one
 * server, and no proxy of ours sees the traffic.
 *
 * One response carries account value AND the PnL split by venue:
 *   { ts_ms, account_value_usd, pnl_usd, spot_pnl_usd, perps_pnl_usd, ... }
 * so every series below is a field selection, not another round trip. The only
 * thing `market_type` changes is which balance `account_value_usd` reflects,
 * which is why it is sent for the equity series and left at `all` otherwise.
 * ------------------------------------------------------------------------- */

/**
 * What a PnL chart plots. Equity is deliberately NOT here - it belongs to the
 * Account value card, which is the card about account value.
 */
export type SeriesMode = 'pnl-total' | 'pnl-perps' | 'pnl-spot';

/** Said in both menus, because it is the same limitation in both. */
const AIRDROP_NOTE =
  'Only claim eligibility is published; the endpoints that return a claimed amount need an ' +
  'authenticated session. Turning this on cannot add a number we do not have, so the series is ' +
  'unchanged and says so.';

const SERIES: ReadonlyArray<readonly [SeriesMode, string, string]> = [
  ['pnl-total', 'Total', 'Spot + perps'],
  ['pnl-perps', 'Futures', 'Futures only'],
  ['pnl-spot', 'Spot', 'Spot only'],
];

/** Period -> the venue window that covers it. There is no ALL; 1Y is the max. */
const VENUE_WINDOW_FOR: Record<Period, VenueWindow> = {
  '24H': '24H', '7D': '7D', '14D': '30D', '30D': '30D', '90D': '90D', ALL: '1Y',
};

export function pnlAt(m: SeriesMode, p: ChartPoint): number {
  if (m === 'pnl-perps') return p.perpsPnl;
  if (m === 'pnl-spot') return p.spotPnl;
  return p.pnl;
}

export interface VenueSeries {
  /** The full 1Y spine, cumulative from account inception. */
  points: ChartPoint[] | null;
  /** The network the series was read on (the 24-hour read needs the same one). */
  network: string;
  error: string | null;
  progress: { done: number; total: number } | null;
  accountId: number | null;
}

/**
 * The venue's series, fetched ONCE at its longest window.
 *
 * Two reasons it is fetched at 1Y and sliced locally rather than refetched per
 * period. First, `pnl_usd` is CUMULATIVE FROM ACCOUNT INCEPTION - a 30D response
 * opens at whatever the running total was 30 days ago, not at zero - so to show
 * "PnL earned inside this period" you need the value from BEFORE the period
 * starts, which a 30D response does not contain. Second, market_type only
 * changes `account_value_usd`; every *_pnl_usd field is present regardless, so
 * switching between total/perps/spot costs no request at all.
 *
 * Verified against the live endpoint: perps_pnl_usd + spot_pnl_usd = pnl_usd,
 * and the last perps value equals `perps/pnl/overview`.cumulative_pnl exactly.
 */
function useVenueSeries(address: string | null): VenueSeries {
  const [accountId, setAccountId] = useState<number | null>(null);
  const [network, setNetwork] = useState('mainnet');
  const [points, setPoints] = useState<ChartPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    // The shell reads /api/health too; a read that overlaps it is shared (api.health).
    void api.health()
      .then((h) => { if (alive.current && h?.network) setNetwork(String(h.network)); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!address) { setAccountId(null); setPoints(null); return; }
    let off = false;
    void fetchAccountId(address, network).then((id) => { if (!off && alive.current) setAccountId(id); });
    return () => { off = true; };
  }, [address, network]);

  useEffect(() => {
    if (!accountId) { setPoints(null); return; }
    let off = false;
    setError(null);
    setProgress({ done: 0, total: 1 });
    void fetchChart(accountId, '1Y', 'all', network)
      .then((r) => { if (!off && alive.current) setPoints(r.points); })
      .catch((e) => { if (!off && alive.current) setError((e as Error).message); })
      .finally(() => { if (!off && alive.current) setProgress(null); });
    return () => { off = true; };
  }, [accountId, network]);

  return { points, network, error, progress, accountId };
}

/**
 * Slice the cumulative spine to a period and rebase it to zero.
 *
 * The baseline is the last point STRICTLY BEFORE the period, not the first point
 * inside it. That distinction is the whole point: using the first inside point
 * would silently discard that day's own move and make every period start flat.
 * When the period covers the whole series there is nothing before it, so the
 * baseline is 0 - which is correct, because the venue's cumulative series starts
 * at zero.
 */
/**
 * Max drawdown: the biggest fall from a peak to a low that comes AFTER it.
 *
 * Two things it is NOT:
 *
 *  - the lowest point. A series that climbs to +0.23 and then falls to -0.25 has
 *    a low of -0.25 but a fall of -0.48, because that is how far it dropped.
 *  - the highest point minus the lowest point. The low has to come after the
 *    peak in time, so each point is measured against the highest value seen
 *    SO FAR, not against the highest in the window.
 *
 * Both ends are real points of the selected window. The level the window opened
 * from is deliberately not a candidate peak: the figure always names two points
 * you can put a finger on in the chart.
 *
 * Signed negative, and 0 when the series never falls.
 */
export function maxDrawdown(values: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (v - peak < worst) worst = v - peak;
  }
  return worst;
}

export function sliceCurve(
  spine: ChartPoint[],
  period: Period,
  value: (p: ChartPoint) => number,
): CurveWindow | null {
  const days = PERIOD_DAYS[period];
  const cutoff = days === null ? -Infinity : Date.now() - days * 86_400_000;
  const inside = spine.filter((p) => p.ts >= cutoff);
  if (inside.length < 2) return null;

  const before = spine.filter((p) => p.ts < cutoff);
  const baseline = before.length ? value(before[before.length - 1]!) : 0;

  const pts = inside.map((p) => ({ t: p.ts, v: value(p) - baseline }));
  const last = pts[pts.length - 1]!.v;
  // Rebased, so the curve opens at (first - baseline) and zero is the period's
  // own starting level. `baseline` is reported unrebased for the stat strip,
  // which describes the level the period started FROM.
  return { points: pts, baseline, change: last, maxDrawdown: maxDrawdown(pts.map((q) => q.v)) };
}

/* ---- the settings popup, same convention every trade-page panel uses ------ */

/** Copied, not imported - each panel on the trade page carries its own. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref]);
}

const PfGearIcon = () => <PrefsIcon size={14} />;

/**
 * Series picker. Opens on click OR on right-click of the card header, matching
 * how the trade page's own panels behave.
 */
function SeriesMenu({ mode, onMode, airdrops, onAirdrops, airdropNote }: {
  mode?: SeriesMode;
  onMode?: (m: SeriesMode) => void;
  airdrops: boolean;
  onAirdrops: (v: boolean) => void;
  airdropNote: string;
}) {
  const [open, setOpen] = useState(false);
  const menuFx = useLatched(open);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));

  useEffect(() => {
    const onCtx = (e: Event) => {
      const t = (e as MouseEvent).target;
      if (!(t instanceof Element)) return;
      // Only the card this menu belongs to, and never inside the popup itself.
      if (t.closest('.menu-popup')) return;
      const card = ref.current?.closest('.pf-card');
      if (!card || !card.contains(t)) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener('contextmenu', onCtx);
    return () => window.removeEventListener('contextmenu', onCtx);
  }, []);

  return (
    <div className="menu perf-settingswrap" ref={ref}>
      <button
        type="button" className="perf-settingsbtn" aria-label="Chart settings"
        title="Chart settings (or right-click the card)" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <PfGearIcon />
      </button>
      {menuFx.value && (
        <div className={`menu-popup perf-settingsmenu${menuFx.closing ? ' is-closing' : ''}`} onAnimationEnd={menuFx.onExit}>
          {mode && onMode && (
            <div className="menu-group">
              <div className="menu-group-label">Series</div>
              <div className="menu-grid">
                {SERIES.map(([id, label, hint]) => (
                  <button
                    key={id} type="button" title={hint}
                    className={mode === id ? 'active' : ''}
                    onClick={() => onMode(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="menu-group">
            <div className="menu-group-label">Airdrops</div>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={airdrops}
              className={`menu-row${airdrops ? '' : ' is-off'}`}
              onClick={() => onAirdrops(!airdrops)}
              title="Include claimed airdrops in the series"
            >
              <span className="menu-row__label">Include airdrops</span>
              <span className="menu-box" aria-hidden="true">
                {airdrops && (
                  <svg width="10" height="8" viewBox="0 0 10 8" aria-hidden="true" focusable="false">
                    <path d="M1 4.3 3.7 7 9 1.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
            </button>
            <p className="pf-note perf-settingsnote">{airdropNote}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export function windowCurve(curve: Array<{ t: number; pnl: string }>, period: Period): CurveWindow {
  const days = PERIOD_DAYS[period];
  const since = days === null ? -Infinity : Date.now() - days * 86_400_000;

  let baseline = 0;
  const points: Array<{ t: number; v: number }> = [];
  for (const p of curve) {
    const v = num(p.pnl);
    // The last point before the window is the level the window opened at.
    // Without it a 7-day view of a two-year-old account would report its whole
    // lifetime PnL as this week's.
    if (p.t < since) {
      baseline = v;
      continue;
    }
    points.push({ t: p.t, v });
  }

  if (points.length === 0) return { points, baseline, change: null, maxDrawdown: null };

  return {
    points,
    baseline,
    change: points[points.length - 1]!.v - baseline,
    /*
     * Nothing renders this any more - the Performance card's series is the one
     * the page shows a drawdown from, because this endpoint carries a much
     * shorter history (see PerformanceGroup). It stays because `CurveWindow` is
     * shared with `sliceCurve`, and it uses the SAME `maxDrawdown` so that if a
     * row is ever pointed back at it the definition cannot have drifted.
     *
     * A single point cannot describe a fall, so it reports none rather than 0 -
     * "no drawdown" and "not enough data to have one" are different answers.
     */
    maxDrawdown: points.length >= 2 ? maxDrawdown(points.map((q) => q.v)) : null,
  };
}

/** The one total from a per-coin bucket list, or null if it is not a single total. */
export function soleTotal(totals: CoinTotal[]): { amount: number; coin: string | null } | null {
  const nonZero = totals.filter((t) => num(t.amount) !== 0);
  if (nonZero.length === 0) return totals.length > 0 ? { amount: 0, coin: totals[0]!.coin } : null;
  // Two coins cannot be added: a spot buy is charged in the base coin and a sell
  // in vUSDC, so a single "$ fees" figure across them would be arithmetic on
  // unrelated units. The caller renders an em-dash instead.
  if (nonZero.length > 1) return null;
  return { amount: num(nonZero[0]!.amount), coin: nonZero[0]!.coin };
}

// =============================================================================
//  4. SMALL PRESENTATION PIECES
// =============================================================================
/** USD with an explicit + on gains. fmtUsd only signs negatives. */
export const fmtSigned = (v: number | null | undefined, dp = 2): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${v > 0 ? '+' : ''}${fmtUsd(v, dp)}`;
};

export const fmtRatioPct = (v: number | null | undefined, dp = 2): string =>
  v === null || v === undefined || !Number.isFinite(v) ? DASH : `${fmtFixed(v * 100, dp)}%`;

/**
 * A walked total WITH its coin, always.
 *
 * Fees and funding are charged per coin - a spot buy in the base coin, a sell in
 * vUSDC - so a bare "18,422.4412" in a column of dollar figures reads as
 * dollars, which it is not. The coin travels with the number all the way to the
 * screen; if the venue did not label it, that is said out loud rather than
 * assumed to be the quote coin.
 */
function fmtCoinAmount(amount: number, coin: string | null): ReactNode {
  const abs = Math.abs(amount);
  const dp = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  return (
    <>
      {fmt(amount, dp)}{' '}
      {coin
        ? <span className="pf-unit">{coin}</span>
        : <span className="pf-unit" title="The venue did not report which coin this amount is in.">?</span>}
    </>
  );
}

/**
 * DAILY PnL AS A CALENDAR. The venue's series is cumulative, so a day's PnL is
 * that day's point minus the one before. One month at a time (arrows step
 * through the months the series covers), each day tinted by the size of its
 * move - green up, red down, the strongest day of the month at full strength -
 * with the day's figure and the month's total above.
 */
export function CrossFadeCal({ points, mode }: { points: ChartPoint[]; mode: SeriesMode }) {
  const mask = useMask('pnl');
  const days = useMemo(() => {
    const out = new Map<string, number>();
    for (let i = 1; i < points.length; i++) {
      const p = points[i]!;
      const d = new Date(p.ts);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      out.set(key, (out.get(key) ?? 0) + (pnlAt(mode, p) - pnlAt(mode, points[i - 1]!)));
    }
    return out;
  }, [points, mode]);
  const last = points.length ? new Date(points[points.length - 1]!.ts) : new Date();
  const first = points.length ? new Date(points[0]!.ts) : new Date();
  const [month, setMonth] = useState(() => ({ y: last.getFullYear(), m: last.getMonth() }));
  const monthStart = new Date(month.y, month.m, 1);
  const daysIn = new Date(month.y, month.m + 1, 0).getDate();
  const lead = (monthStart.getDay() + 6) % 7; // Monday first
  const cells: Array<{ day: number; v: number | null } | null> = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  let total = 0;
  let peak = 0;
  for (let d = 1; d <= daysIn; d++) {
    const v = days.get(`${month.y}-${month.m}-${d}`) ?? null;
    if (v !== null) { total += v; peak = Math.max(peak, Math.abs(v)); }
    cells.push({ day: d, v });
  }
  const canBack = monthStart > new Date(first.getFullYear(), first.getMonth(), 1);
  const canFwd = monthStart < new Date(last.getFullYear(), last.getMonth(), 1);
  const step = (n: number) => setMonth((c) => {
    const d = new Date(c.y, c.m + n, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const label = monthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const traded = cells.filter((c): c is { day: number; v: number } => !!c && c.v !== null && Math.abs(c.v) >= 0.005);
  const wins = traded.filter((c) => c.v > 0).length;
  const best = traded.length ? Math.max(...traded.map((c) => c.v)) : null;
  const worst = traded.length ? Math.min(...traded.map((c) => c.v)) : null;
  const now = new Date();
  const isThisMonth = now.getFullYear() === month.y && now.getMonth() === month.m;
  const stat = (k: string, v: ReactNode, cls = '') => (
    <div className="pfc-stat"><span>{k}</span><b className={cls}>{v}</b></div>
  );
  return (
    <div className="pfc">
      <div className="pfc-head">
        <div className="pfc-nav">
          <button type="button" onClick={() => step(-1)} disabled={!canBack} aria-label="Previous month"><Chevron /></button>
          <span>{label}</span>
          <button type="button" onClick={() => step(1)} disabled={!canFwd} aria-label="Next month"><Chevron /></button>
        </div>
        <div className="pfc-stats">
          {stat('Month', mask(fmtSigned(total)), signClass(total))}
          {stat('Winning days', mask(traded.length ? `${wins} of ${traded.length}` : DASH))}
          {stat('Best day', mask(best === null ? DASH : fmtSigned(best)), best === null ? '' : signClass(best))}
          {stat('Worst day', mask(worst === null ? DASH : fmtSigned(worst)), worst === null ? '' : signClass(worst))}
        </div>
      </div>
      <div className="pfc-dow">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <span key={d}>{d}</span>)}</div>
      <div className="pfc-grid">
        {cells.map((c, i) => {
          if (!c) return <span key={`e${i}`} className="pfc-day is-blank" />;
          const moved = c.v !== null && Math.abs(c.v) >= 0.005;
          const strength = !moved || peak === 0 ? 0 : Math.max(0.14, Math.abs(c.v!) / peak);
          const tone = !moved ? '' : c.v! > 0 ? 'is-up' : 'is-down';
          const today = isThisMonth && now.getDate() === c.day;
          return (
            <span
              key={c.day}
              className={`pfc-day ${tone}${today ? ' is-today' : ''}`}
              style={{ ['--s' as string]: strength.toFixed(3) }}
              title={c.v === null ? undefined : `${label.split(' ')[0]} ${c.day}: ${fmtSigned(c.v)}`}
            >
              <span className="pfc-day__n">{c.day}</span>
              {moved && <span className="pfc-day__v">{mask(fmtCompactSigned(c.v!))}</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** "+$1.2K" / "-$38" - a calendar cell has room for three or four characters. */
export function fmtCompactSigned(v: number): string {
  const a = Math.abs(v);
  const sign = v > 0 ? '+' : v < 0 ? '\u2212' : '';
  // Each step at the figure that would round up into the next ($999.6 is $1.0K, not $1000).
  const body = a >= 999_950 ? `${fmtFixed(a / 1e6, 1)}M` : a >= 999.5 ? `${fmtFixed(a / 1e3, 1)}K` : a >= 99.995 ? fmtFixed(a, 0) : fmtFixed(a, 2);
  return `${sign}$${body}`;
}

/**
 * The period selector, in one place because three headers carry it and they
 * must not drift apart. Selection is amber text on a filled control - the
 * label never changes weight, so the group cannot re-flow under the cursor.
 */
export function PeriodSeg({ period, onPeriod, label }: {
  period: Period; onPeriod: (p: Period) => void; label: string;
}) {
  return (
    <div className="pf-seg" role="tablist" aria-label={label}>
      {PERIODS.map((p) => (
        <button
          key={p}
          type="button"
          role="tab"
          aria-selected={p === period}
          className={`pf-ctl ${p === period ? 'is-on' : ''}`}
          onClick={() => onPeriod(p)}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

/**
 * A meter, animated by TRANSFORM.
 *
 * Never width. A width transition re-runs layout on every frame of every tick of
 * the mark feed, and on this page there can be fifty of these on screen at once;
 * a transform is composited and costs nothing. `--pf-v` is the 0..1 fraction.
 */
export function Meter({ value, tone, label }: { value: number; tone: string; label?: string }) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div className="pf-meter" role="img" aria-label={label ?? `${fmtFixed(v * 100, 1)}%`}>
      <span className={`pf-meter__fill pf-meter__fill--${tone}`} style={{ transform: `scaleX(${v})` }} />
    </div>
  );
}

/**
 * Rendered wherever a block has nothing real to show. Never a zero.
 *
 * `what` is not decoration. Without a wallet this page shows six of these at
 * once, and six identical "Connect a wallet." lines read as a page that failed
 * rather than as a page waiting - so each one names the thing it would be
 * showing instead. The empty state then teaches the layout.
 */
function Empty({ address, loading, error, what, failed = 'This account', onRetry, children }: {
  address: string | null; loading?: boolean; error?: string | null; what?: string;
  /** The noun for the failure line: "<failed> couldn't load." */
  failed?: string; onRetry?: () => void; children?: ReactNode;
}) {
  if (!address) return <p className="pf-empty">Connect a wallet to see {what ?? 'this account'}.</p>;
  if (error) return <ReadFailed what={failed} error={error} onRetry={onRetry} />;
  if (loading) return <p className="pf-empty"><span className="pf-spin" aria-hidden="true" />Loading…</p>;
  return <>{children ?? <p className="pf-empty">Nothing to show.</p>}</>;
}

/**
 * The runtime identity report.
 *
 * Silent when everything checks out - a green tick on every load is noise that
 * trains people to stop reading. Loud, and above the numbers, when it does not.
 */
function IdentityNote({ checks }: { checks: Checks | null }) {
  if (!checks || checks.ok) return null;
  return (
    <div className="pf-warn">
      <strong>These labels may be wrong for this account.</strong>
      <p>
        The gateway names these fields <code>av</code>, <code>am</code>, <code>cm</code>,{' '}
        <code>im</code>, <code>mm</code> and <code>mmr</code>. <code>ami</code> repeats available
        margin, so it is not added again. The identities below normally hold exactly; one does not
        right now, so treat the labels as unconfirmed.
      </p>
      <ul>
        {Math.abs(checks.marginResidual) > checks.tolerance && (
          <li>av − (am + cm + im + oim + ocm + haircut) = {fmt(checks.marginResidual, 8)}, expected 0</li>
        )}
        {Math.abs(checks.ratioResidual) > 1e-6 && (
          <li>mmr − mm ÷ av = {fmt(checks.ratioResidual, 10)}, expected 0</li>
        )}
        {checks.equityCheckable && Math.abs(checks.equityResidual) > checks.tolerance && (
          <li>av − (wallet balance + unrealised PnL) = {fmt(checks.equityResidual, 8)}, expected 0</li>
        )}
      </ul>
    </div>
  );
}

/**
 * Colour flash on a changed headline number.
 *
 * Two phases, and the order matters. The class is applied with `transition:
 * none` so the colour lands INSTANTLY - that is the flash - then removed one
 * beat later, which starts the 500ms ease back to neutral. Holding the class for
 * the full 500ms and then dropping it would give a hard on/off blink at twice
 * the duration: a strobe, not a flash.
 */
export function useFlash(value: number | null): 'up' | 'down' | null {
  const prev = useRef<number | null>(null);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);

  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (value === null || before === null || before === value) return;
    setFlash(value > before ? 'up' : 'down');
    const id = window.setTimeout(() => setFlash(null), 50);
    return () => window.clearTimeout(id);
  }, [value]);

  return flash;
}

// =============================================================================
//  5. THE LEFT RAIL
// =============================================================================

/**
 * Account identity.
 *
 * No sub-account selector: the account model is one numeric `aid` per wallet and
 * there is nothing to switch between. A disabled dropdown with one entry would
 * imply a feature that does not exist.
 */
export function AccountChip({ address, unlocked, exists }: {
  address: string | null; unlocked: boolean; exists: boolean | null;
}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    if (!address) return;
    // Clipboard access is permission-gated and absent on insecure origins, so a
    // failure is expected rather than exceptional - the label just does not
    // change, and the address stays selectable in the DOM.
    void navigator.clipboard?.writeText(address).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }, [address]);

  const maskAddr = useAddressMask();
  const addrHidden = usePrivacy().isHidden('address');

  return (
    <div className="pf-account">
      <div className="pf-account__id">
        {/* shortAddr renders "-" for a missing address, which on an identity
            chip reads as a broken value rather than as "nobody is connected".

            The TITLE is masked too. A tooltip carrying the full address on a
            chip that is showing `0x***…***` hands the whole thing back on
            hover, which is the one place a mask most needs to hold. */}
        <span
          className={`pf-account__addr ${address ? '' : 'pf-dim'}`}
          title={address ? (addrHidden ? undefined : address) : undefined}
        >
          {address ? maskAddr(address) : 'Not connected'}
        </span>
        <div className="pf-account__meta">
          {address ? (
            <>
              <span className={`pf-chip ${unlocked ? 'pf-chip--ok' : ''}`}>
                {unlocked ? 'trading enabled' : 'read-only'}
              </span>
              {exists === false && (
                <span className="pf-chip pf-chip--warn" title="Deposit once to create a SoDEX account for this wallet.">
                  no account yet
                </span>
              )}
            </>
          ) : (
            <span className="pf-chip">no wallet</span>
          )}
        </div>
        {address && (
          <button
            type="button"
            className="pf-icon"
            onClick={copy}
            title={copied ? 'Copied' : 'Copy the full address'}
            aria-label="Copy account address"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        )}
      </div>
    </div>
  );
}

/** The copy button's "done" state, drawn at CopyIcon's size and stroke. */
const CheckIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * Account actions.
 *
 * Only actions that EXIST are rendered, and only when this page has been given a
 * way to reach them. Transfer and deposit live on the money page (which owns the
 * signing path and the coin/route selection); this rail links to them rather
 * than growing a second, differently-tested copy of a funds-moving form.
 *
 * There is no Claim button because there is no claim endpoint - not in api.ts,
 * not in server/src/routes. A greyed-out button implying otherwise would be a
 * promise the app cannot keep.
 */
export function Actions({ onGoToMoney, onGoToWallet }: {
  onGoToMoney?: () => void; onGoToWallet?: () => void;
}) {
  if (!onGoToMoney && !onGoToWallet) return null;
  return (
    <div className="pf-actions">
      {onGoToMoney && (
        <button type="button" className="pf-btn pf-btn--primary" onClick={onGoToMoney}>Transfer</button>
      )}
      {onGoToWallet && (
        <button type="button" className="pf-btn" onClick={onGoToWallet}>Wallet</button>
      )}
    </div>
  );
}

/**
 * The 14-day traded notional, as a rail row rather than a headline.
 *
 * Honest in three different states and it says which one it is in: not
 * measured, measured and complete, or measured but the fill page ran out
 * before the 14-day window did - in which case the number is a floor and is
 * rendered with a "≥" and the reason underneath it.
 */
function VolumeGroup({ vol, address }: { vol: ReturnType<typeof useVolume14d>; address: string | null }) {
  const v = vol.value;
  return (
    <Group title="Traded volume">
      <Row
        label={<>Rolling <span className="pf-unit">14d</span></>}
        value={
          vol.error ? DASH
            : vol.loading ? <span className="pf-dim">measuring…</span>
            : v ? (
              <span title={`${fmtUsd(v.usd)} across ${v.fills} perps fill${v.fills === 1 ? '' : 's'}`}>
                {v.complete ? '' : <span className="pf-approx" title="a floor, not the total">≥ </span>}
                {fmtCompactUsd(v.usd)}
              </span>
            ) : DASH
        }
        cls={v ? undefined : 'pf-dim'}
        tag={v ? 'derived' : undefined}
        tagHint="Summed here as price × quantity over this wallet's own perps fills."
      />
      {!address ? (
        <p className="pf-note">No wallet, no fills to measure.</p>
      ) : !vol.started ? (
        <button type="button" className="pf-btn pf-btn--ghost" onClick={vol.start}>Measure from fills</button>
      ) : vol.error ? (
        <ReadFailed what="Traded volume" error={vol.error} onRetry={vol.start} />
      ) : v && !v.complete ? (
        <p className="pf-note pf-note--warn">
          {/* The page cap is reached inside the window, so the figure is a floor:
              there were more fills than this page can see. */}
          Floor — {FILL_PAGE} fills reach only to {fmtDay(v.oldest)}.
        </p>
      ) : v ? (
        <p className="pf-note">Futures fills only. Spot notional is charged in other coins and is not added in.</p>
      ) : null}
    </Group>
  );
}

function FeesGroup({ engine, fee, error, onRetry }: {
  engine: Engine; fee: VenueFeeRate | null; error: string | null; onRetry?: () => void;
}) {
  return (
    <Group title={<>Fee rate <span className="pf-unit">{engine}</span></>}>
      <Row
        label="Taker"
        privacy="fees"
        value={fee ? fmtRate(num(fee.takerFeeRate)) : DASH}
        cls={fee ? undefined : 'pf-dim'}
        tag={fee ? 'venue' : undefined}
        tagHint="The venue's own fee-rate for this account, from GET /api/acct/:engine/fee-rate."
      />
      <Row
        label="Maker"
        privacy="fees"
        value={fee ? fmtRate(num(fee.makerFeeRate)) : DASH}
        cls={fee ? undefined : 'pf-dim'}
        tag={fee ? 'venue' : undefined}
        tagHint="The venue's own fee-rate for this account, from GET /api/acct/:engine/fee-rate."
      />
      {error
        ? <ReadFailed what="Fee rate" error={error} onRetry={onRetry} />
        : fee
          ? <p className="pf-note">Fee tier {fee.feeTier} · staking tier {fee.stakingTier}</p>
          : null}
    </Group>
  );
}

/* ---------------------------------------------------------------------------
 * WHERE THE MONEY ACTUALLY IS.
 *
 * "Total equity" is one number covering three different places, and which place
 * matters: spot and futures are the venue's ledger, on-chain is a wallet the
 * venue cannot see and cannot touch. Reading a single figure and assuming it is
 * all withdrawable, or all margin, is the mistake this breakdown removes.
 *
 * It is COLLAPSED by default. Three sub-rows under the headline is three lines
 * of the rail spent on a decomposition most visits do not need; the twisty says
 * it is there.
 * ------------------------------------------------------------------------ */

export interface OnChain {
  tokens: ChainToken[] | null;
  native: ChainNative | null;
  /** Summed from the tokens the venue could price. */
  total: number;
  priced: number;
  unpriced: number;
  loading: boolean;
  error: string | null;
}

const EMPTY_CHAIN: OnChain = {
  tokens: null, native: null, total: 0, priced: 0, unpriced: 0, loading: false, error: null,
};

/**
 * What this address holds on ValueChain, priced by the venue.
 *
 * THE EXPLORER CANNOT PRICE ANYTHING - every token it returns has
 * `exchange_rate: null`. So the amounts come from the chain and the prices come
 * from the venue's own `<coin>_vUSDC` spot markets. Tokens with no such market
 * are counted separately and left out of the total rather than valued at zero:
 * a total that silently omits holdings is worse than one that says how much it
 * could not see.
 */
/**
 * Coin -> USD, from the venue's own `<coin>_vUSDC` spot markets.
 *
 * Shared by the on-chain read and the spot valuation below, so the same coin
 * cannot be worth two different things in two rows of the same card.
 */
export function useCoinPrices(): Map<string, number> {
  const [prices, setPrices] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    let off = false;
    void Promise.all([api.symbols('spot'), api.tickers('spot')])
      .then(async ([sy, tk]) => {
        if (off) return;
        setPrices(await fetchCoinPrices(sy.symbols, tk.tickers));
      })
      .catch(() => {});
    return () => { off = true; };
  }, []);
  return prices;
}

export function useOnChain(address: string | null): OnChain {
  const [state, setState] = useState<OnChain>(EMPTY_CHAIN);

  useEffect(() => {
    if (!address) { setState(EMPTY_CHAIN); return; }
    let off = false;
    setState({ ...EMPTY_CHAIN, loading: true });

    void (async () => {
      try {
        const [tokensRes, nativeRes, symbolsRes, tickersRes] = await Promise.allSettled([
          fetchChainTokens(address),
          fetchChainNative(address),
          api.symbols('spot'),
          api.tickers('spot'),
        ]);
        if (off) return;

        const rawTokens = tokensRes.status === 'fulfilled' ? tokensRes.value : null;
        const native = nativeRes.status === 'fulfilled' ? nativeRes.value : null;

        if (!rawTokens && !native) {
          setState({ ...EMPTY_CHAIN, error: 'The ValueChain explorer did not answer.' });
          return;
        }

        const prices = symbolsRes.status === 'fulfilled' && tickersRes.status === 'fulfilled'
          ? await fetchCoinPrices(symbolsRes.value.symbols, tickersRes.value.tickers)
          : new Map<string, number>();
        if (off) return;

        const tokens = rawTokens ? priceTokens(rawTokens, prices) : null;
        const priced = (tokens ?? []).filter((t) => t.usd !== null).length;
        setState({
          tokens,
          native,
          total: (tokens ?? []).reduce((sum, t) => sum + (t.usd ?? 0), 0),
          priced,
          unpriced: (tokens ?? []).length - priced,
          loading: false,
          error: null,
        });
      } catch (e) {
        if (!off) setState({ ...EMPTY_CHAIN, error: (e as Error).message });
      }
    })();

    return () => { off = true; };
  }, [address]);

  return state;
}

/**
 * Spot equity, priced.
 *
 * THE SPOT BALANCES ENDPOINT CARRIES NO PRICE. `/api/acct/spot/balances` returns
 * `{id, coin, total, locked}` and nothing else - unlike the perps account state,
 * whose `B[]` entries do carry `px`. This function was written against the perps
 * shape, so `num(pick(b,'px','price')) || 1` fell through to 1 for every row and
 * the "Spot" line was the SUM OF TOKEN COUNTS presented as dollars: half a
 * Bitcoin and half a DOGE both counted as $0.50.
 *
 * Prices come from the venue's own `<coin>_vUSDC` spot markets instead. A coin
 * with no market cannot be valued, so it is counted separately and reported
 * rather than silently valued at zero.
 */
export function spotValue(
  rows: Array<Record<string, unknown>>,
  prices: Map<string, number>,
): { usd: number | null; unpriced: number } {
  if (!rows.length) return { usd: null, unpriced: 0 };
  let usd = 0;
  let unpriced = 0;
  let priced = 0;
  for (const b of rows) {
    const amount = num(pick(b, 'total', 'wb'));
    if (!amount) continue;
    const coin = String(pick(b, 'coin', 'a') ?? '');
    const px = prices.get(coin);
    if (px === undefined) { unpriced += 1; continue; }
    usd += amount * px;
    priced += 1;
  }
  return { usd: priced > 0 ? usd : null, unpriced };
}

export function OverviewGroup({ m, all, chain, venue, prices, address = null }: {
  m: PortfolioModel; all: AllTime; chain: OnChain; venue: VenueSeries;
  prices: Map<string, number>;
  /** The wallet whose EVM holdings count - the address menu's own read. */
  address?: string | null;
}) {
  /*
   * EVM = exactly what the wallet (address) menu shows: ValueChain plus the
   * other EVM chains it reads, priced the same way - one source, so the two
   * totals can never disagree. Falls back to the ValueChain-only explorer read
   * for a page with no wallet read (e.g. Scan).
   */
  const eq = useEquityParts(m, venue, prices, address);
  const evmUsd = eq.evm ?? (chain.tokens ? chain.total : null);
  const evmRows = eq.evmRows;
  void chain;
  const a = m.account;
  const h = all.data?.headline;
  const exp = m.exposure;
  /* Open by default: the split between spot, futures and the chain is the point
     of the row, not an optional detail behind a control. */
  const [open, setOpen] = useState(true);

  const spot = eq.spot;
  const futures = eq.perps;
  const grand = spot === null && futures === null && eq.vaults === null && evmUsd === null
    ? null
    : (spot ?? 0) + (futures ?? 0) + (eq.vaults ?? 0) + (evmUsd ?? 0);
  const maskEquity = useMask('equity');
  const equityHidden = usePrivacy().isHidden('equity');

  /*
   * THE ADDRESS MENU'S ACCOUNT BOX: label over the 20px figure, the head a
   * toggle with the menu's chevron, and the breakdown under a hairline as the
   * menu's holdings list - the SoDEX mark on what the venue holds, the
   * ValueChain mark on what the wallet holds. The "Overview" heading this used
   * to carry is gone: the box's own label names it, and the card is "Account".
   */
  return (
    <>
      <div className={`pf-hero${open ? ' is-open' : ''}`}>
        <button
          type="button"
          className="pf-hero__main"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={equityHidden ? undefined : 'Spot and futures equity on the venue, plus what this wallet holds on-chain.'}
        >
          <span className="pf-hero__k">Total equity <Chevron /></span>
          <span className="pf-hero__v">{maskEquity(grand === null ? DASH : fmtUsd(grand))}</span>
        </button>
      {open && (
        <div className="pf-hero__list">
          <Row
            label={<><CoinIcon coin="USDC" size={16} />Spot</>}
            sub
            value={spot === null ? DASH : fmtUsd(spot)}
            cls={spot === null ? 'pf-dim' : undefined}
            hint="Every spot coin's balance at the venue's own price for it."
          />
          <Row
            label={<><CoinIcon coin="USDC" size={16} />Futures</>}
            sub
            value={futures === null ? DASH : fmtUsd(futures)}
            cls={futures === null ? 'pf-dim' : undefined}
            hint="av — perps equity: wallet balance plus unrealised PnL on open positions."
          />
          {(eq.vaults ?? 0) > 0.01 && (
            <Row
              label={<><SodexMark size={16} />Vaults & Wealth</>}
              sub
              value={fmtUsd(eq.vaults)}
              hint="Wealth vaults and SLP. MAG7 or sMAG7 deposited into the SLP leaves the spot balance, so it is counted here. Share tokens still sitting in Spot stay in Spot; the coin-by-coin split is in Details."
            />
          )}
          <Row
            label={<><CoinIcon chain="VALUECHAIN" size={16} />EVM</>}
            sub
            value={evmUsd === null ? (eq.evmLoading ? '…' : DASH) : fmtUsd(evmUsd)}
            cls={evmUsd === null ? 'pf-dim' : undefined}
            hint="Your wallet on ValueChain and the other EVM chains - the same figure as the wallet menu."
          />
          {evmRows.length > 0 && (
            <ul className="pf-evm">
              {evmRows.map((h) => (
                <li key={`${h.chain}:${h.symbol}`}>
                  <span className="pf-evm__ic">
                    <CoinIcon coin={h.symbol} size={16} />
                    <CoinIcon chain={h.chain} size={10} className="pf-evm__chain" />
                  </span>
                  <span className="pf-evm__t">{h.symbol}<small>{h.chainLabel}</small></span>
                  <span className="pf-evm__v">{h.usd === null ? DASH : fmtUsd(h.usd)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      </div>
      <div className="pf-kvlist">
      {/*
        "Net equity" is spelled out rather than assumed, because the phrase means
        different things on different venues. Here it is stated as exactly one
        thing - equity with unrealised PnL taken back out - which is the wallet
        balance, and which the runtime identity check above already verifies.
      */}
      <Row
        label="Net equity"
        privacy="equity"
        value={a ? fmtUsd(a.walletValue) : DASH}
        hint="Account value minus unrealised PnL — the settled cash side of the account. Equal to the sum of balance × price, which is one of the three identities re-checked on every refresh."
        tag={a ? 'derived' : undefined}
      />
      <Row
        label="All-time volume"
        value={h?.cumulativeQuoteVolume ? fmtCompactUsd(num(h.cumulativeQuoteVolume)) : DASH}
        cls={h?.cumulativeQuoteVolume ? undefined : 'pf-dim'}
        hint={
          h?.cumulativeQuoteVolume
            ? `${fmtUsd(num(h.cumulativeQuoteVolume))} — the venue's own cumulative quote volume, perps only.`
            : all.started
              ? 'The venue reported no cumulative volume for this account.'
              : 'Not loaded — this comes from the account history, which is not read automatically.'
        }
        tag={h?.cumulativeQuoteVolume ? 'venue' : undefined}
      />
      <Row
        label="All-time PnL"
        value={h?.cumulativePnl ? fmtSigned(num(h.cumulativePnl)) : DASH}
        cls={h?.cumulativePnl ? signClass(h.cumulativePnl) : 'pf-dim'}
        hint={
          h?.cumulativePnl
            ? `The venue's own cumulative realised PnL, perps only. Daily snapshot dated ${fmtDay(h.asOf)} — it does not include today.`
            : all.started
              ? 'The venue reported no cumulative PnL for this account.'
              : 'Not loaded — this comes from the account history, which is not read automatically.'
        }
        tag={h?.cumulativePnl ? 'venue' : undefined}
      />
      <Row
        label="Unrealized PnL"
        value={m.unrealized === null ? DASH : fmtSigned(m.unrealized)}
        cls={m.unrealized === null ? 'pf-dim' : signClass(m.unrealized)}
        hint={
          m.unrealized === null
            ? 'Not shown: the account-state payload did not carry an unrealised figure for every open position, and a partial sum would be a wrong number.'
            : "Sum of the venue's own per-position unrealised PnL. Not derived from a mark price."
        }
        tag={m.unrealized === null ? undefined : 'venue'}
      />
      <Row
        label="Open position size"
        value={exp ? fmtCompactUsd(exp.gross) : DASH}
        cls={exp ? undefined : 'pf-dim'}
        hint={
          exp
            ? `${fmtUsd(exp.gross)} — long plus short notional at the mark price.${exp.unpriced > 0 ? ` ${exp.unpriced} position(s) excluded: the mark feed did not carry that market.` : ''}`
            : 'No open positions.'
        }
        tag={exp ? 'derived' : undefined}
      />
      <Row
        label="Open orders size"
        value={m.orders ? fmtCompactUsd(m.orders.notional) : DASH}
        cls={m.orders ? undefined : 'pf-dim'}
        hint={
          m.orders
            ? `${fmtUsd(m.orders.notional)} across ${m.orders.count} resting order(s), valued at each order's own price.${m.orders.excluded > 0 ? ` ${m.orders.excluded} had neither a price nor a mark and are excluded.` : ''}`
            : 'Open orders have not been read yet.'
        }
        tag={m.orders ? 'derived' : undefined}
      />
      </div>
    </>
  );
}

/**
 * The period card.
 *
 * Four of its seven rows are blank for most periods, and that is the honest
 * answer rather than a gap to be filled. The venue publishes exactly one
 * historical series - cumulative perps PnL, one point per UTC day - so anything
 * that can be read off that series is real (realised P&L, max drawdown) and
 * anything that cannot is an em-dash with the reason in its tooltip.
 */
function PerformanceGroup({
  period, onPeriod, all, win, mode,
}: {
  period: Period;
  onPeriod: (p: Period) => void;
  all: AllTime;
  win: CurveWindow | null;
  /** The page's series mode. The rows below read the SAME curve the chart card
   *  plots, so the labelling has to follow it rather than claim perps. */
  mode: SeriesMode;
}) {
  const d = all.data;
  const seriesName = SERIES.find(([id]) => id === mode)?.[1] ?? 'Total';
  const isAll = period === 'ALL';

  // Fees and funding come from the server-side walk, which produces ALL-TIME
  // totals only. Showing an all-time total in a row labelled "7D" would be the
  // worst kind of wrong number, so they are blank outside the all-time period.
  const fees = isAll && d ? soleTotal(d.trades.perps.fees) : null;
  const funding = isAll && d ? soleTotal(d.funding.totals) : null;
  const volume = isAll && d?.headline.cumulativeQuoteVolume ? num(d.headline.cumulativeQuoteVolume) : null;

  const notLoaded = 'Not loaded — this comes from the account history, which is not read automatically.';
  const periodOnly = `No per-period source exists: the venue publishes one historical series (daily cumulative PnL) and the fill walk produces all-time totals only. Switch to ALL to see the lifetime figure.`;

  return (
    <Group
      title="Performance"
      action={<PeriodSeg period={period} onPeriod={onPeriod} label="Performance period" />}
    >
      <Row
        label="Volume"
        value={volume === null ? DASH : fmtCompactUsd(volume)}
        cls={volume === null ? 'pf-dim' : undefined}
        hint={volume !== null ? `${fmtUsd(volume)} — the venue's cumulative quote volume, perps only.` : !all.started ? notLoaded : periodOnly}
        tag={volume === null ? undefined : 'venue'}
      />
      <Row
        label="Realized P&L"
        value={win?.change === undefined || win?.change === null ? DASH : fmtSigned(win.change)}
        cls={win?.change === null || win?.change === undefined ? 'pf-dim' : signClass(win.change)}
        hint={
          win?.change !== null && win?.change !== undefined
            ? `Cumulative PnL at the end of the period minus the level it started from (${fmtUsd(win.baseline)}). ${seriesName}, off the venue's own daily series, so it lags today's trading.`
            : !all.started ? notLoaded : 'The venue published no daily PnL points inside this period.'
        }
        tag={win?.change === null || win?.change === undefined ? undefined : 'derived'}
      />
      {/*
        Net P&L would be realised minus fees minus funding. Two things block it:
        no per-period fee or funding total exists, and it is undocumented whether
        the venue's cumulative PnL is already net of them. Subtracting anyway
        would be wrong twice and look right once.
      */}
      <Row
        label="Net P&L"
        value={DASH}
        cls="pf-dim"
        hint="Not shown. It would be realised P&L net of fees and funding, but there is no per-period fee or funding total, and it is not documented whether the venue's cumulative PnL already deducts them. A figure here would be a guess about someone's money."
      />
      <Row
        label="Fees"
        value={fees ? fmtCoinAmount(fees.amount, fees.coin) : DASH}
        cls={fees ? undefined : 'pf-dim'}
        hint={
          fees
            ? `Walked from this account's own perps fill history${fees.coin ? `, charged in ${fees.coin}` : ''}.`
            : !all.started ? notLoaded
            : isAll ? 'Charged in more than one coin, so there is no single total — see the all-time breakdown on the Stats page.'
            : periodOnly
        }
        tag={fees ? 'derived' : undefined}
      />
      <Row
        label="Funding"
        value={funding ? fmtCoinAmount(funding.amount, funding.coin) : DASH}
        cls={funding ? signClass(funding.amount) : 'pf-dim'}
        hint={
          funding
            ? `Summed with the venue's own sign, unmodified${funding.coin ? `, settled in ${funding.coin}` : ''}.`
            : !all.started ? notLoaded
            : isAll ? 'Settled in more than one coin, so there is no single total.'
            : periodOnly
        }
        tag={funding ? 'derived' : undefined}
      />
      <Row
        label="Max drawdown"
        value={win?.maxDrawdown === null || win?.maxDrawdown === undefined ? DASH : fmtUsd(win.maxDrawdown)}
        cls={win?.maxDrawdown ? 'pf-neg-text' : 'pf-dim'}
        hint={
          win?.maxDrawdown !== null && win?.maxDrawdown !== undefined
            ? `The biggest fall from a peak to a low that comes after it, inside this period - not the lowest point. ${seriesName}: the same series, period and function the Performance card uses, so the two always agree. Daily snapshots, so an intraday trough between two of them is not in it.`
            : 'The venue published fewer than two daily points inside this period - not enough to describe a fall.'
        }
        tag={win?.maxDrawdown === null || win?.maxDrawdown === undefined ? undefined : 'derived'}
      />
      {/*
        Win rate needs a closed-trade log. Positions carry realizedPnL only while
        they are open, and no round-trip history endpoint exists, so there is
        nothing to count wins out of. Winning DAYS could be counted off the daily
        curve, but that is a different statistic wearing this one's label.
      */}
      <Row
        label="Win rate"
        value={DASH}
        cls="pf-dim"
        hint="Not shown. It needs a closed-trade log and the venue publishes none — a position carries realizedPnL only while it is open, and there is no round-trip history to count wins from. The daily PnL series would give winning days, which is a different statistic."
      />
    </Group>
  );
}

// =============================================================================
//  6. THE MAIN COLUMN
// =============================================================================

/**
 * Row 1, left card: what the account is worth right now.
 *
 * There is no chart in it, and that is the honest answer rather than a gap.
 * The venue publishes no historical equity series; rebuilding one from the
 * cumulative-PnL curve would have to assume no deposits, no withdrawals and no
 * change in unrealised PnL, and all three are false on any account that has
 * been used. So the body says so in place of a line nobody could trust, and
 * the three live measures of account health sit in the strip beneath it.
 */
function ValueCard({ m, address, equity, historyNote, liveEquity }: {
  m: PortfolioModel;
  address: string | null;
  /** Fetched once by the page and shared - see the note on `useVenueSeries`. */
  equity: VenueSeries;
  /** The venue's history is unusable: no line, this sentence, live equity only. */
  historyNote?: string | null;
  liveEquity?: number | null;
}) {
  const a = m.account;
  const exp = m.exposure;
  const flash = useFlash(a ? a.accountValue : null);
  const maskEquity = useMask('equity');
  const maskFunds = useMask('funds');
  const fundsHidden = usePrivacy().isHidden('funds');

  /* Account value over time. The venue does publish this - `wallet/portfolio/
   * chart` with market_type=all - so the card no longer has to say the history
   * does not exist. Total equity above is the LIVE figure from account state;
   * the curve is the venue's daily snapshot, so the last point can sit slightly
   * behind it. That is a real difference, not a bug, and the caption says so. */
  const [equityPeriod, setEquityPeriod] = useStored<Period>('ot.pf.equityperiod', '30D');
  const [airdrops, setAirdrops] = useStored<boolean>('ot.pf.equity.airdrops', false);
  const equityCurve = equity.points
    ? sliceCurve(equity.points, equityPeriod, (q) => q.accountValue)
    : null;
  /**
   * The venue's own account total - the basis the curve is on.
   *
   * Spot AND perps AND VAULT. The vault part is easy to miss and matters: an
   * account with $4.9M here can read `av: 0.0000057` on the perps engine and
   * hold nothing but dust in spot, because the money is in a vault that neither
   * engine endpoint reports. Any figure built by adding up the engines alone
   * will say that account is empty.
   */
  const venueTotal = historyNote
    ? (typeof liveEquity === 'number' && Number.isFinite(liveEquity) ? liveEquity : null)
    : equity.points?.[equity.points.length - 1]?.accountValue ?? null;

  // Our bands, not the venue's. The venue's own boundary is mmr = 1, where
  // equity has fallen to the maintenance requirement; everything below that is
  // this terminal's editorial and the tooltip says so.
  const ratio = a?.maintenanceRatio ?? null;
  const band = ratio === null ? '' : ratio >= 0.7 ? 'neg' : ratio >= 0.4 ? 'warn' : 'pos';
  const hasRatio = !!a && a.accountValue > 0;

  return (
    <Card
      title="Account value"
      className="pf-card--chart"
      action={
        <div className="pf-cardactions">
          <PeriodSeg period={equityPeriod} onPeriod={setEquityPeriod} label="Equity period" />
          <SeriesMenu airdrops={airdrops} onAirdrops={setAirdrops} airdropNote={AIRDROP_NOTE} />
        </div>
      }
    >
      <div className="pf-readout">
        {/*
          The curve is spot + perps, so the headline is too. `a.accountValue` is
          the PERPS account alone - showing that above an all-venue curve was the
          mismatch that made this card read as wrong ($0.10 over a line ending at
          $0.41). The perps figure is still here, named.
        */}
        <span className="pf-readout__label">Total equity</span>
        <span className={`pf-readout__value ${flash ? `pf-flash--${flash}` : ''}`}>
          {maskEquity(venueTotal !== null ? fmtUsd(venueTotal) : a ? fmtUsd(a.accountValue) : DASH)}
        </span>
        {/* The breakdown is three more balances, so it answers to `funds` rather
            than to `equity` - hiding the headline and leaving "Perps $1,240.18"
            underneath it would have masked nothing. */}
        <span className="pf-readout__sub">
          {a
            ? maskFunds(`Futures ${fmtUsd(a.accountValue)} · Free ${fmtUsd(a.availableMargin)} · Withdrawable ${fmtUsd(a.withdrawable)}`)
            : 'Connect a wallet to read this account.'}
        </span>
      </div>

      {!address ? <div className="pf-chart pf-chart--empty"><p>Connect a wallet to plot account value.</p></div>
        : historyNote ? <div className="pf-chart pf-chart--empty"><p>{historyNote}</p></div>
        : equity.progress ? <div className="pf-chart pf-chart--empty"><p><span className="pf-spin" aria-hidden="true" />{equity.progress.done}/{equity.progress.total}</p></div>
        : equity.error ? <div className="pf-chart pf-chart--empty"><ReadFailed what="Account value history" error={equity.error} /></div>
        : !equity.accountId ? <div className="pf-chart pf-chart--empty"><p>No SoDEX account for this wallet.</p></div>
        : equityCurve ? (
          <>
            <EquityCurve win={equityCurve} tone="equity" />
          </>
        )
        : <div className="pf-chart pf-chart--empty"><p>Fewer than two daily points in {equityPeriod}.</p></div>}

      <div className="pf-statstrip">
        <Stat
          label="Margin ratio"
          privacy="funds"
          value={hasRatio ? fmtRatioPct(ratio) : DASH}
          cls={hasRatio ? band : 'pf-dim'}
          tag={a ? 'venue' : undefined}
          tagHint="mmr, published directly by the venue."
          hint={
            hasRatio
              ? `Reaches 100% when equity has fallen to the maintenance requirement. Buffer ${fmtUsd(a!.accountValue - a!.maintenanceMargin)}. The amber and red thresholds at 40% and 70% are ours, not the venue's.`
              : a ? 'No account value to measure against.' : 'Connect a wallet to see margin health.'
          }
        >
          {/* A METER IS THE NUMBER, DRAWN. Leaving the bar filled to 62% while
              the figure beside it reads *** hands back what the mask covered,
              to the nearest few percent. */}
          {hasRatio && !fundsHidden ? (
            <Meter
              value={ratio ?? 0}
              tone={band || 'pos'}
              label={`Maintenance margin is ${fmtRatioPct(ratio)} of account value`}
            />
          ) : hasRatio ? null : (
            <p className="pf-note">{a ? 'No account value to measure against.' : 'Connect a wallet.'}</p>
          )}
        </Stat>

        <Stat
          label="Unrealized PnL"
          privacy="pnl"
          value={m.unrealized === null ? DASH : fmtSigned(m.unrealized)}
          cls={m.unrealized === null ? 'pf-dim' : signClass(m.unrealized)}
          tag={m.unrealized === null ? undefined : 'venue'}
          tagHint="Sum of the venue's own per-position figure."
        >
        </Stat>

        <Stat
          label="Account leverage"
          privacy="funds"
          value={exp?.grossLeverage != null ? `${fmt(exp.grossLeverage, 2)}×` : DASH}
          cls={exp?.grossLeverage != null ? undefined : 'pf-dim'}
          tag={exp?.grossLeverage != null ? 'derived' : undefined}
          tagHint="Gross notional ÷ account value."
        >
        </Stat>
      </div>
    </Card>
  );
}

/**
 * Row 1, right card: the one real historical series this venue publishes.
 *
 * Cumulative realised perps PnL, one point per UTC day, windowed to the header's
 * period. Every state it can be in - no wallet, walk not started, walk failed,
 * no series, too few points - draws its own sentence rather than an empty box,
 * because the not-started state is what most visits see and it has to read as a
 * deliberate answer.
 */
function PerformanceChartCard({
  all, period, onPeriod, win, address, venue, mode, onMode, historyNote,
}: {
  all: AllTime;
  period: Period;
  onPeriod: (p: Period) => void;
  win: CurveWindow | null;
  address: string | null;
  /** Fetched once by the page and shared - see the note on `useVenueSeries`. */
  venue: VenueSeries;
  /** Owned by the page, because the rail's group reads the same series. */
  mode: SeriesMode;
  onMode: (m: SeriesMode) => void;
  /** The venue's history is unusable: no line and no PnL figures, this sentence instead. */
  historyNote?: string | null;
}) {
  /* The series picker. `walk` keeps this card exactly as it was - our own
   * fill-derived curve - and every other option swaps in the venue's published
   * series without changing anything else about the card. */
  const [airdrops, setAirdrops] = useStored<boolean>('ot.pf.pnl.airdrops', false);
  /** Chart or calendar of daily PnL - remembered. */
  const [view, setView] = useStored<'chart' | 'calendar'>('vs.pf.pnl.view', 'chart');
  const venueCurve = venue.points && !historyNote
    ? sliceCurve(venue.points, period, (q) => pnlAt(mode, q))
    : null;

  // `win` (this page's own fill-derived walk) is kept in the signature so the
  // caller is unchanged, but the card now plots the venue's published series -
  // that is what the series menu selects between.
  void win;
  const change = venueCurve?.change ?? null;
  const dd = venueCurve?.maxDrawdown ?? null;
  const lifetimeVolume = all.data?.headline.cumulativeQuoteVolume ?? null;

  return (
    <Card
      title="Performance"
      className="pf-card--chart"
      action={
        <div className="pf-cardactions">
          <div className="pf-seg" role="tablist" aria-label="Chart or calendar">
            <button type="button" role="tab" aria-selected={view === 'chart'} className={`pf-ctl ${view === 'chart' ? 'is-on' : ''}`} onClick={() => setView('chart')} title="Chart">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 12.5 6 8l3 2.5 5-6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <button type="button" role="tab" aria-selected={view === 'calendar'} className={`pf-ctl ${view === 'calendar' ? 'is-on' : ''}`} onClick={() => setView('calendar')} title="Calendar">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M2 6.5h12M5.5 1.8v2.4M10.5 1.8v2.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
            </button>
          </div>
          {view === 'chart' && <PeriodSeg period={period} onPeriod={onPeriod} label="Chart period" />}
          <SeriesMenu
            mode={mode} onMode={onMode}
            airdrops={airdrops} onAirdrops={setAirdrops} airdropNote={AIRDROP_NOTE}
          />
        </div>
      }
    >
      <div className="pf-readout">
        <span className="pf-readout__label">{SERIES.find(([id]) => id === mode)?.[1]} P&amp;L · {period}</span>
        <span className={`pf-readout__value ${change === null ? '' : signClass(change)}`}>
          {change === null ? DASH : fmtSigned(change)}
        </span>

      </div>

      {!address ? <div className="pf-chart pf-chart--empty"><p>Connect a wallet to plot this account's PnL.</p></div>
        : historyNote ? <div className="pf-chart pf-chart--empty"><p>{historyNote}</p></div>
        : venue.progress ? <div className="pf-chart pf-chart--empty"><p><span className="pf-spin" aria-hidden="true" />{venue.progress.done}/{venue.progress.total}</p></div>
        : venue.error ? <div className="pf-chart pf-chart--empty"><ReadFailed what="PnL history" error={venue.error} /></div>
        : !venue.accountId ? <div className="pf-chart pf-chart--empty"><p>No SoDEX account for this wallet.</p></div>
        : view === 'calendar' ? <CrossFadeCal points={venue.points ?? []} mode={mode} />
        : venueCurve ? <EquityCurve win={venueCurve} />
        : <div className="pf-chart pf-chart--empty"><p>Fewer than two daily points in {period}.</p></div>}

      <div className="pf-statstrip">
        {/*
          Deliberately NOT a second copy of the headline above. It is the level
          the headline is measured FROM - the last cumulative point before the
          window opened - which is the one number that makes the period figure
          checkable and which is otherwise invisible.
        */}
        <Stat
          label={`Opening level · ${period}`}
          privacy="pnl"
          value={venueCurve ? fmtUsd(venueCurve.baseline) : DASH}
          cls={change === null ? 'pf-dim' : undefined}
          tag={change === null ? undefined : 'derived'}
          tagHint="The last cumulative-PnL point before the period opened. The headline above is the end of the period minus this."
        >
        </Stat>
        <Stat
          label={`Max drawdown · ${period}`}
          privacy="pnl"
          value={dd === null ? DASH : fmtUsd(dd)}
          cls={dd === null ? 'pf-dim' : 'pf-neg-text'}
          tag={dd === null ? undefined : 'derived'}
          tagHint="Deepest peak-to-trough fall of the cumulative realised-PnL curve inside this period."
        >
        </Stat>
        <Stat
          label="All-time volume"
          privacy="funds"
          value={lifetimeVolume ? fmtCompactUsd(num(lifetimeVolume)) : DASH}
          cls={lifetimeVolume ? undefined : 'pf-dim'}
          tag={lifetimeVolume ? 'venue' : undefined}
          tagHint="The venue's own cumulative quote volume, perps only."
        >
        </Stat>
      </div>
    </Card>
  );
}

/**
 * Walk completeness, inline.
 *
 * Anything short of "the walk reached the beginning of this account's history"
 * means every walked total on this page is a floor rather than a total, and the
 * reader has to know that while they are reading the number, not after.
 */
function Coverage({ scopes }: { scopes: Record<string, SyncProgress> }) {
  const partial = Object.values(scopes).filter((s) => !s.complete || s.error || s.truncated);
  if (partial.length === 0) return null;
  const running = partial.some((s) => s.status === 'running');
  return (
    <span className="pf-note--warn">
      {running
        ? 'Still walking this account\'s history — the walked totals are a partial sum.'
        : 'The history walk did not reach the beginning of this account — walked totals are a floor.'}
    </span>
  );
}


/**
 * Margin usage: how much of the perps account value is committed.
 *
 *   margin usage = (av - am) / av
 *
 * av is the account value and am the available margin, both straight from the
 * perps state. av − am − haircut is the margin held by positions and resting
 * orders. ami is not subtracted again.
 *
 * This card used to be "Capital efficiency": the same breakdown of account
 * value, with "margin in use" as one row among five. The ratio is the headline
 * now, because it is the number that says how close the account is to being
 * unable to open anything else.
 *
 * The stacked bar is drawn as four full-width layers scaled from the left and
 * painted largest-first, rather than as four flex children. That is not a
 * flourish: flex children have to animate their WIDTH, which relayouts on every
 * mark tick, whereas a scaled layer is composited. The cumulative fractions make
 * each layer end exactly where the next begins.
 */
function MarginUsagePanel({ m, address }: { m: PortfolioModel; address: string | null }) {
  const a = m.account;
  const u = a
    ? marginUsage({
        av: a.accountValue,
        am: a.availableMargin,
        cm: a.crossMargin,
        im: a.isolatedMargin,
        oim: a.orderMargin,
        haircut: a.haircut,
      })
    : null;
  if (!a || !u) {
    return (
      <Card title="Margin usage">
        <Empty
          address={address} loading={m.loading} error={m.error}
          what="how much margin is in use" failed="Margin usage" onRetry={m.refresh}
        />
      </Card>
    );
  }

  const av = a.accountValue;
  const f = (v: number) => (av > 0 ? Math.max(0, Math.min(1, v / av)) : 0);

  // Cumulative, so each layer is drawn from 0 to its own boundary.
  const c1 = f(a.crossMargin);
  const c2 = c1 + f(a.isolatedMargin);
  const c3 = c2 + f(a.orderMargin);
  const freeMargin = a.availableMargin;
  const c4 = c3 + f(freeMargin);
  const layers: Array<[string, number, string, number]> = [
    ['free', c4, 'Available', freeMargin],
    ['orders', c3, 'Resting orders', a.orderMargin],
    ['iso', c2, 'Isolated positions', a.isolatedMargin],
    ['cross', c1, 'Cross positions', a.crossMargin],
  ];
  // Over 100% is possible (losses past the margin make `am` negative) and is
  // printed as it is; only the meter stops at full.
  const tone = u.ratio === null ? 'pos' : u.ratio >= 0.8 ? 'neg' : u.ratio >= 0.5 ? 'warn' : 'pos';

  return (
    <Card title="Margin usage">
      <IdentityNote checks={m.checks} />
      <Row
        label="Margin usage"
        value={u.ratio === null ? DASH : fmtRatioPct(u.ratio, 1)}
        cls={u.ratio === null ? 'pf-dim' : undefined}
        hint="(account value − available margin) / account value: the share of the perps account committed to positions and resting orders."
        tag="derived"
      />
      {u.ratio !== null && <Meter value={u.ratio} tone={tone} label={`Margin usage ${fmtRatioPct(u.ratio, 1)}`} />}
      <Row
        label="Margin in use"
        value={`${fmtUsd(u.inUse)} of ${fmtUsd(av)}`}
        hint="av − am − haircut: margin held by positions and by resting orders. ami repeats am and is not subtracted again."
        tag="derived"
      />
      {av > 0 ? (
        <div className="pf-well pf-well--legend">
          <div className="pf-stack-bar" role="img" aria-label="Account value by what each part is committed to">
            {layers.map(([t, cum]) => (
              <span
                key={t}
                className={`pf-stack-bar__seg pf-stack-bar__seg--${t}`}
                style={{ transform: `scaleX(${cum})` }}
              />
            ))}
          </div>
          <ul className="pf-legend">
            {layers
              .slice()
              .reverse()
              .map(([t, , label, value]) => (
                <li key={t}>
                  <i className={`pf-swatch pf-swatch--${t}`} />
                  <span>{label}</span>
                  <b>{fmtUsd(value)}</b>
                  <span className="pf-dim">{fmtRatioPct(value / av, 1)}</span>
                </li>
              ))}
          </ul>
        </div>
      ) : (
        <p className="pf-note">No account value to break down.</p>
      )}
      <Row label="Maintenance margin" value={fmtUsd(a.maintenanceMargin)} hint="mm — the equity the venue requires this book to keep." tag="venue" />
      <Row label="Withdrawable" value={fmtUsd(a.withdrawable)} hint="amw — the venue's own withdrawable figure." tag="venue" />
    </Card>
  );
}

function ExposurePanel({ m, perpsByName, address }: {
  m: PortfolioModel; perpsByName: Map<string, MarketSymbol>; address: string | null;
}) {
  const e = m.exposure;
  if (!e) {
    return (
      <Card title="Net positions exposure">
        <Empty address={address} loading={m.loading} error={m.error} what="long and short exposure" failed="Positions" onRetry={m.refresh}>
          <p className="pf-empty">No open positions to weigh.</p>
        </Empty>
      </Card>
    );
  }

  const skew = e.gross > 0 ? e.long / e.gross : 0;

  return (
    <Card title="Net positions exposure">
      <div className="pf-exposure__figures">
        <div>
          <span className="pf-stat__sub">Net</span>
          <span className={`pf-stat__value ${e.net > 0 ? 'pos' : e.net < 0 ? 'neg' : ''}`}>
            {fmtSigned(e.net, 0)}
          </span>
        </div>
        <div>
          <span className="pf-stat__sub">Gross</span>
          <span className="pf-stat__value">{fmtUsd(e.gross, 0)}</span>
        </div>
      </div>

      <div className="pf-well pf-well--exposure">
      <div className="pf-split" role="img" aria-label={`${fmtRatioPct(skew)} of gross exposure is long`}>
        <span className="pf-split__fill" style={{ transform: `scaleX(${skew})` }} />
      </div>
      <div className="pf-split__labels">
        <span className="pos">Long {fmtUsd(e.long, 0)}</span>
        <span className="neg">Short {fmtUsd(e.short, 0)}</span>
      </div>

      <ul className="pf-alloc">
        {e.byMarket.map((mk) => (
          <li key={mk.symbol}>
            <span className="pf-alloc__name"><CoinLabel coin={perpsByName.get(mk.symbol)?.baseCoin ?? mk.symbol}>{perpsByName.get(mk.symbol)?.displayName ?? mk.symbol}</CoinLabel></span>
            <span className="pf-alloc__track">
              <span
                className={`pf-alloc__fill ${mk.dir === 'long' ? 'pos' : 'neg'}`}
                style={{ transform: `scaleX(${Math.max(0.01, mk.share)})` }}
              />
            </span>
            <span className="pf-alloc__value">{fmtUsd(mk.notional, 0)}</span>
            <span className="pf-alloc__share pf-dim">{fmtRatioPct(mk.share, 1)}</span>
          </li>
        ))}
      </ul>
      </div>

      {e.unpriced > 0 && (
        <p className="pf-note pf-note--warn">
          {/* No mark price for that market, so there is no honest way to value
              it - the sums above are a floor, not the whole book. */}
          {e.unpriced} position{e.unpriced === 1 ? '' : 's'} unpriced — totals are a floor.
        </p>
      )}
    </Card>
  );
}


// =============================================================================
//  7. THE PAGE
// =============================================================================

/**
 * Props are the `ctx` object App.tsx already builds for its account panels, plus
 * two OPTIONAL navigation callbacks in the same shape StatusBar already uses
 * (`onGoToWallet` / `onGoToMoney`). They are optional so this page cannot render
 * a button that goes nowhere: with no callback, no action button appears.
 *
 * `byName` is accepted and ignored - it holds only the CURRENTLY SELECTED
 * engine's symbols, and this page needs both.
 */
export interface PortfolioProps {
  engine: Engine;
  address: string | null;
  unlocked: boolean;
  byName: Map<string, MarketSymbol>;
  refreshToken: number;
  onChanged: () => void;
  /** Wire to the money page's transfer form. Omitted -> no Transfer button. */
  onGoToMoney?: () => void;
  /** Wire to the wallet page. Omitted -> no Wallet button. */
  onGoToWallet?: () => void;
}

/**
 * Everything the page's panels read, computed once.
 *
 * This used to be the top of `Portfolio`, with the layout hard-coded in the JSX
 * underneath it. The panels are independent now - each one is placed and sized
 * by the user - so the shared state has to outlive any particular arrangement
 * of them. Every fetch here is page-level on purpose: the venue spine feeds
 * three panels, and letting each fetch its own is what had the same 1Y chart
 * pulled twice before.
 */
export interface PortfolioContext {
  engine: Engine;
  address: string | null;
  unlocked: boolean;
  /** Someone else's account (Scan): every table shows, nothing acts - no close, modify, cancel or transfer. */
  readOnly?: boolean;
  /**
   * Scan only: the server found SoDEX's history for this account unusable
   * (`TraderProfile.analyticsSuspect`). The sentence replaces the account-value
   * and PnL charts, their PnL figures are dashes, and the headline is `liveEquity`.
   */
  historyNote?: string | null;
  /** Live perps + spot equity from the server's profile, for `historyNote`. */
  liveEquity?: number | null;
  refreshToken: number;
  onChanged: () => void;
  onGoToMoney?: () => void;
  onGoToWallet?: () => void;

  perpsByName: Map<string, MarketSymbol>;
  spotByName: Map<string, MarketSymbol>;
  model: PortfolioModel;
  all: AllTime;
  vol: ReturnType<typeof useVolume14d>;
  fee: VenueFeeRate | null;
  feeError: string | null;
  feeRetry: () => void;
  venue: VenueSeries;
  /** What the CHAIN says this address holds - balances the venue cannot see. */
  chain: OnChain;
  /** Coin -> USD from the venue's spot markets. Prices spot balances, which
   *  arrive from the venue without any price of their own. */
  prices: Map<string, number>;

  period: Period;
  setPeriod: (p: Period) => void;
  mode: SeriesMode;
  setMode: (m: SeriesMode) => void;
  /** The selected series, sliced to the selected period. Shared so the rail
   *  group and the chart card cannot disagree - see `sliceCurve`. */
  win: CurveWindow | null;
}

export function usePortfolioContext({
  engine, address, unlocked, refreshToken, onChanged, onGoToMoney, onGoToWallet,
}: PortfolioProps): PortfolioContext {
  // Fetched here rather than taken from props: App.tsx's `byName` holds only the
  // CURRENTLY SELECTED engine's symbols, and this page needs both - perps for
  // the margin-tier schedules the liquidation estimate needs, spot for the fill
  // history's price precision.
  const { byName: perpsByName } = useSymbols('perps');
  const { byName: spotByName } = useSymbols('spot');
  const model = usePortfolioModel(address, refreshToken, perpsByName);
  const all = useAllTime(address);
  const vol = useVolume14d(address);
  const [period, setPeriod] = useState<Period>('30D');
  const feeRes = useAsync(() => api.feeRate(engine, address!), [engine, address, refreshToken], {
    enabled: !!address,
  });
  const fee = useMemo<VenueFeeRate | null>(() => {
    // The route wraps the gateway payload as { engine, feeRate }; tolerate an
    // unwrapped body rather than blanking the card on a shape change.
    const r = (feeRes.data?.feeRate ?? feeRes.data) as VenueFeeRate | undefined;
    return r && r.makerFeeRate !== undefined && r.takerFeeRate !== undefined ? r : null;
  }, [feeRes.data]);

  const venue = useVenueSeries(address);
  const chain = useOnChain(address);
  const prices = useCoinPrices();
  const [mode, setMode] = useStored<SeriesMode>('ot.pf.series', 'pnl-total');
  const win = useMemo(
    () => (venue.points ? sliceCurve(venue.points, period, (q) => pnlAt(mode, q)) : null),
    [venue.points, period, mode],
  );

  return {
    engine, address, unlocked, refreshToken, onChanged, onGoToMoney, onGoToWallet,
    perpsByName, spotByName, model, all, vol, fee, feeError: feeRes.error, feeRetry: feeRes.refresh, venue, chain, prices,
    period, setPeriod, mode, setMode, win,
  };
}

/* ---------------------------------------------------------------------------
 * THE ACCOUNT CARD - light, like the owner's reference: the address, total
 * equity as the headline (large), where it sits (Spot, Perps, Vaults & Wealth,
 * EVM - the EVM line collapses like the wallet menu's), the three money
 * actions, and two tiles: 7-day volume (the leaderboard's own figure) and the
 * fee rate. Everything else - per-coin breakdown, margin, fee tiers, the
 * account-value chart - is one press away in the equity detail sheet.
 * ------------------------------------------------------------------------ */

interface FundHolding {
  fundId: string;
  coin: string;
  shares: number;
  /** USDC still being subscribed / paid out (not yet in Spot). */
  pendingUsd: number;
}

/** SoDEX's wealth holdings (vaults such as MAG7.ssi, index funds): shares, plus anything in flight. */
function useFundHoldings(address: string | null): FundHolding[] | null {
  const [rows, setRows] = useState<FundHolding[] | null>(null);
  useEffect(() => {
    setRows(null);
    if (!address) return;
    let off = false;
    const read = async () => {
      try {
        const d = await readGateway<{ totals?: Array<Record<string, any>> } | null>(`/api/v1/wealth/users/${address}/fund-details`);
        if (off) return;
        setRows((d?.totals ?? []).map((t) => ({
          fundId: String(t.fundId ?? ''),
          coin: String(t.share?.coin ?? t.fundId ?? ''),
          shares: num(t.shares),
          pendingUsd: num(t.pendingProceeds) + num(t.processingCost),
        })).filter((f) => f.shares > 0 || f.pendingUsd > 0));
      } catch (e) {
        if (!off) setRows((p) => p ?? []);
        logLoadFailure('Vault holdings', e);
      }
    };
    void read();
    // Once a minute while the tab is shown; at once when it is shown again.
    const stop = pollEvery(60_000, () => void read());
    return () => { off = true; stop(); };
  }, [address]);
  return rows;
}

/** The leaderboard's 7-day volume for this wallet (0 when it has not traded in the window). */
export function useVolume7d(address: string | null): number | null {
  const [v, setV] = useState<number | null>(null);
  useEffect(() => {
    setV(null);
    if (!address) return;
    let off = false;
    // SoDEX's data host, straight from this browser.
    walletRank('7D', 'volume', address)
      .then((j: { found?: boolean; item?: { volume_usd?: string } }) => { if (!off) setV(j.found ? num(j.item?.volume_usd) : 0); })
      .catch((e) => logLoadFailure('7-day volume', e));
    return () => { off = true; };
  }, [address]);
  return v;
}

interface EquityParts {
  total: number | null;
  /** Spot balances, including share tokens that are still coins in the account. */
  spot: number | null;
  /**
   * Vault value that is NOT already one of those coins. Wealth shares that
   * left the account, pending proceeds, and the venue's own gap (SLP: MAG7
   * and sMAG7 deposited there are no longer a spot balance).
   */
  vaults: number | null;
  /** The part of `vaults` the fund list does not name. Treated as SLP. */
  slp: number | null;
  fundRows: Array<FundHolding & { usd: number | null; inSpot: boolean }>;
  perps: number | null;
  evm: number | null;
  evmLoading: boolean;
  evmRows: Array<{ chain: string; chainLabel: string; symbol: string; amount: string; usd: number }>;
}

const coinKey = (coin: string): string => coin.replace(/^v(?=[A-Z])/, '').toUpperCase();

function useEquityParts(m: PortfolioModel, venue: VenueSeries, prices: Map<string, number>, address: string | null): EquityParts {
  const totals = useAccountTotals(address);
  const funds = useFundHoldings(address);
  const spotHeld = new Set(
    m.spotBalances
      .filter((b) => num(pick(b, 'total', 'wb')) > 0)
      .map((b) => coinKey(String(pick(b, 'coin', 'a') ?? ''))),
  );
  const fundRows = (funds ?? []).map((f) => {
    const px = prices.get(f.coin);
    return { ...f, usd: px === undefined ? null : f.shares * px, inSpot: spotHeld.has(coinKey(f.coin)) };
  });
  const spot = spotValue(m.spotBalances, prices).usd;
  const pending = fundRows.reduce((acc, f) => acc + f.pendingUsd, 0);
  const outside = fundRows.reduce((acc, f) => acc + (f.inSpot ? 0 : (f.usd ?? 0)), 0);
  const perps = m.account ? m.account.accountValue : null;
  const venueTotal = venue.points?.[venue.points.length - 1]?.accountValue ?? null;
  /*
   * Depositing MAG7.ssi or sMAG7.ssi into the SLP takes those coins out of the
   * account (the vault page's Available goes to zero; the position lives on
   * the vault). The venue's account-value chart still counts them. That gap,
   * after wealth shares we already named, is the SLP.
   */
  const gap = venueTotal !== null ? venueTotal - (spot ?? 0) - (perps ?? 0) : 0;
  const slp = Math.max(0, gap - outside - pending);
  const vaults = funds === null && venueTotal === null ? null : outside + pending + (slp > 0.01 ? slp : 0);
  const evm = totals.evmUsd;
  const parts = [spot, vaults, perps, evm];
  const total = parts.every((p) => p === null) ? null : parts.reduce<number>((acc, p) => acc + (p ?? 0), 0);
  return {
    total,
    spot,
    vaults,
    slp: slp > 0.01 ? slp : null,
    fundRows,
    perps,
    evm,
    evmLoading: totals.evmLoading,
    evmRows: (totals.evm ?? []).filter((h) => h.usd >= 0.01),
  };
}

function AccountCard({ c }: { c: PortfolioContext }) {
  const { address, model: m, venue, prices } = c;
  const eq = useEquityParts(m, venue, prices, address);
  const vol = useVolume7d(address);
  const [evmOpen, setEvmOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const [copied, setCopied] = useState(false);
  const maskAddr = useAddressMask();
  const maskEquity = useMask('equity');
  const maskFunds = useMask('funds');
  const maskFees = useMask('fees');
  const copy = () => {
    if (!address) return;
    void navigator.clipboard?.writeText(address).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }, () => {});
  };
  const fee = c.fee;
  const usd = (v: number | null) => maskFunds(v === null ? DASH : fmtUsd(v));

  return (
    <div className="pfa">
      <div className="pfa__id">
        <span className="pfa__addr">{address && <ConnectedWalletLogo size={18} className="navaddr__wicon" />}{address ? maskAddr(address) : 'No wallet'}</span>
        {address && (
          <button type="button" className="pfa__copy" onClick={copy} title={copied ? 'Copied' : 'Copy address'} aria-label="Copy address">
            {copied ? <CheckGlyph /> : <CopyIcon />}
          </button>
        )}
        <span className={`pfa__state${c.unlocked ? ' is-on' : ''}`}>{c.unlocked ? 'Trading on' : 'Read-only'}</span>
      </div>

      <button type="button" className="pfa__equity" onClick={() => setDetails(true)} title="Equity breakdown, fees and account value">
        <span className="pfa__eqv">{maskEquity(eq.total === null ? DASH : fmtUsd(eq.total))}</span>
        <span className="pfa__equ">USD</span>
        <span className="pfa__more">Details <Chevron /></span>
      </button>

      <div className="pfa__parts">
        <PartRow icon={<CoinIcon coin="USDC" size={18} />} label="Spot" value={usd(eq.spot)} />
        <PartRow icon={<CoinIcon coin="USDC" size={18} />} label="Futures" value={usd(eq.perps)} />
        {(eq.vaults ?? 0) > 0.01 && <PartRow icon={<SodexMark size={18} />} label="Vaults & Wealth" value={usd(eq.vaults)} />}
        <button type="button" className={`pfa__part pfa__part--toggle${evmOpen ? ' is-open' : ''}`} onClick={() => setEvmOpen((v) => !v)} aria-expanded={evmOpen}>
          <span className="pfa__part-ic"><CoinIcon chain="VALUECHAIN" size={18} /></span>
          <span className="pfa__part-k">EVM <Chevron /></span>
          <span className="pfa__part-v">{eq.evm === null ? (eq.evmLoading ? '…' : DASH) : usd(eq.evm)}</span>
        </button>
        <Collapse open={evmOpen}>
          <ul className="pf-evm pfa__evm">
            {eq.evmRows.length === 0 && <li className="pf-dim">{eq.evmLoading ? 'Reading your wallet…' : 'Nothing on ValueChain or the other EVM chains.'}</li>}
            {eq.evmRows.map((h) => (
              <li key={`${h.chain}:${h.symbol}`}>
                <span className="pf-evm__ic"><CoinIcon coin={h.symbol} size={16} /><CoinIcon chain={h.chain} size={10} className="pf-evm__chain" /></span>
                <span className="pf-evm__t">{h.symbol}<small>{h.chainLabel}</small></span>
                <span className="pf-evm__v">{maskFunds(fmtUsd(h.usd))}</span>
              </li>
            ))}
          </ul>
        </Collapse>

      </div>

      {!c.readOnly && (
      <div className="pfa__actions">
        <button type="button" className="pfa__deposit" onClick={requestDeposit}>Deposit</button>
        <div className="pfa__pair">
          <button type="button" onClick={() => requestWithdraw()} disabled={m.account?.exists === false}>Withdraw</button>
          <button type="button" onClick={() => requestTransfer()} disabled={m.account?.exists === false}>Transfer</button>
        </div>
      </div>
      )}

      <div className="pfa__tile">
        <span className="pfa__tile-k">Volume (7d) <InfoDot title="Traded volume over the last 7 days - the SoDEX leaderboard's own figure." /></span>
        <span className="pfa__tile-v">{maskFunds(vol === null ? DASH : fmtUsd(vol))}</span>
      </div>
      <div className="pfa__tile">
        <span className="pfa__tile-k">Fees (Taker / Maker) <InfoDot title={fee ? `Fee tier ${fee.feeTier} · staking tier ${fee.stakingTier}` : "The venue's own fee rate for this account."} /></span>
        <span className="pfa__tile-v">{maskFees(fee ? `${fmtRate(num(fee.takerFeeRate))} / ${fmtRate(num(fee.makerFeeRate))}` : DASH)}</span>
      </div>

      <Modal open={details} onClose={() => setDetails(false)} title="Equity breakdown" size="lg" className="pfa-modal">
        <EquityDetails c={c} eq={eq} vol={vol} />
      </Modal>
    </div>
  );
}

function PartRow({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="pfa__part">
      <span className="pfa__part-ic">{icon}</span>
      <span className="pfa__part-k">{label}</span>
      <span className="pfa__part-v">{value}</span>
    </div>
  );
}

const CheckGlyph = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.4 6.6 11.4 12.6 4.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

export function InfoDot({ title }: { title: string }) {
  return (
    <span className="pfa__info" title={title} aria-label={title}>
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M8 7.2v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><circle cx="8" cy="5" r="0.8" fill="currentColor" /></svg>
    </span>
  );
}

/** The detail sheet: every place the money is, coin by coin, the fee rate, and the account-value chart. */
function EquityDetails({ c, eq, vol }: { c: PortfolioContext; eq: EquityParts; vol: number | null }) {
  const m = c.model;
  const a = m.account;
  const maskFunds = useMask('funds');
  const maskEquity = useMask('equity');
  const usd = (v: number | null) => maskFunds(v === null ? DASH : fmtUsd(v));
  const spotRows = m.spotBalances
    .map((b) => {
      const coin = String(pick(b, 'coin', 'a') ?? '');
      const amount = num(pick(b, 'total', 'wb'));
      const px = c.prices.get(coin);
      return { coin, amount, usd: px === undefined ? null : amount * px };
    })
    .filter((r) => r.amount > 0)
    .sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0));
  const fee = c.fee;
  return (
    <div className="pfa-d">
      <div className="pfa-d__head">
        <span className="pfa-d__k">Total equity</span>
        <span className="pfa-d__v">{maskEquity(eq.total === null ? DASH : fmtUsd(eq.total))}</span>
      </div>

      <div className="pfa-d__grid">
        <section className="pfa-d__sec">
          <h3><CoinIcon coin="USDC" size={16} /> Spot <b>{usd(eq.spot)}</b></h3>
          {spotRows.length === 0 ? <p className="pf-dim">Nothing in Spot.</p> : (
            <ul className="pfa-d__list">
              {spotRows.map((r) => (
                <li key={r.coin}>
                  <span className="pfa-d__coin"><CoinIcon coin={r.coin} size={16} />{coinLabelOf(r.coin)}{eq.fundRows.some((f) => f.inSpot && coinKey(f.coin) === coinKey(r.coin)) && <small className="pf-dim"> Vault</small>}</span>
                  <span className="pfa-d__amt">{maskFunds(fmtBalance(r.amount, r.coin))}</span>
                  <span className="pfa-d__usd">{usd(r.usd)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="pfa-d__sec">
          <h3><CoinIcon coin="USDC" size={16} /> Futures <b>{usd(eq.perps)}</b></h3>
          <ul className="pfa-d__list pfa-d__list--kv">
            <li><span>Available margin</span><span className="pfa-d__usd">{usd(a ? a.availableMargin : null)}</span></li>
            <li><span>Margin in use</span><span className="pfa-d__usd">{usd(a ? a.accountValue - a.availableMargin : null)}</span></li>
            <li><span>Unrealised PnL</span><span className={`pfa-d__usd ${m.unrealized === null ? '' : signClass(m.unrealized)}`}>{maskFunds(m.unrealized === null ? DASH : fmtUsd(m.unrealized))}</span></li>
            <li><span>Withdrawable</span><span className="pfa-d__usd">{usd(a ? a.withdrawable : null)}</span></li>
          </ul>
        </section>

        <section className="pfa-d__sec">
          <h3><SodexMark size={16} /> Vaults &amp; Wealth <b>{usd(eq.vaults)}</b></h3>
          {eq.fundRows.length === 0 && eq.slp === null ? <p className="pf-dim">No vault or wealth holdings.</p> : (
            <ul className="pfa-d__list">
              {eq.fundRows.map((f) => (
                <li key={f.fundId}>
                  <span className="pfa-d__coin"><CoinIcon coin={f.coin} size={16} />{coinLabelOf(f.coin)}{f.inSpot && <small className="pf-dim"> Counted in Spot</small>}</span>
                  <span className="pfa-d__amt">{maskFunds(`${fmt(f.shares)} shares${f.pendingUsd > 0 ? ` · ${fmtUsd(f.pendingUsd)} pending` : ''}`)}</span>
                  <span className="pfa-d__usd">{f.inSpot ? 'in Spot' : usd(f.usd === null ? null : f.usd + f.pendingUsd)}</span>
                </li>
              ))}
              {eq.slp !== null && (
                <li>
                  <span className="pfa-d__coin"><SodexMark size={16} />SLP</span>
                  <span className="pfa-d__amt">MAG7 / sMAG7 deposited into the liquidity vault. It is no longer a spot balance.</span>
                  <span className="pfa-d__usd">{usd(eq.slp)}</span>
                </li>
              )}
            </ul>
          )}
        </section>

        <section className="pfa-d__sec">
          <h3><CoinIcon chain="VALUECHAIN" size={16} /> EVM <b>{usd(eq.evm)}</b></h3>
          {eq.evmRows.length === 0 ? <p className="pf-dim">{eq.evmLoading ? 'Reading your wallet…' : 'Nothing on ValueChain or the other EVM chains.'}</p> : (
            <ul className="pfa-d__list">
              {eq.evmRows.map((h) => (
                <li key={`${h.chain}:${h.symbol}`}>
                  <span className="pfa-d__coin">
                    <span className="pf-evm__ic"><CoinIcon coin={h.symbol} size={16} /><CoinIcon chain={h.chain} size={10} className="pf-evm__chain" /></span>
                    {h.symbol} <small className="pf-dim">{h.chainLabel}</small>
                  </span>
                  <span className="pfa-d__amt">{maskFunds(fmtBalance(h.amount, h.symbol))}</span>
                  <span className="pfa-d__usd">{usd(h.usd)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="pfa-d__sec">
          <h3>Fees &amp; volume</h3>
          <ul className="pfa-d__list pfa-d__list--kv">
            <li><span>Taker</span><span className="pfa-d__usd">{fee ? fmtRate(num(fee.takerFeeRate)) : DASH}</span></li>
            <li><span>Maker</span><span className="pfa-d__usd">{fee ? fmtRate(num(fee.makerFeeRate)) : DASH}</span></li>
            <li><span>Fee tier</span><span className="pfa-d__usd">{fee ? `${fee.feeTier} · staking ${fee.stakingTier}` : DASH}</span></li>
            <li><span>Volume (7d)</span><span className="pfa-d__usd">{usd(vol)}</span></li>
          </ul>
        </section>
      </div>

      <div className="pfa-d__chart">
        <ValueCard m={m} address={c.address} equity={c.venue} />
      </div>
    </div>
  );
}

const coinLabelOf = (coin: string): string => coin.replace(/^v(?=[A-Z])/, '');

/**
 * The page, as eight panels.
 *
 * Each renders the SAME card it did when this page was a CSS grid; the card's
 * own background, border and radius are dropped in `.dash-panel .pf-card` so the
 * dashboard's panel is the single surface rather than a second box around one.
 * `pad: false` for the same reason - the card brings its own insets.
 *
 * Ids are permanent: they key the user's saved layout in localStorage.
 */
export const PORTFOLIO_PANELS: Array<PanelDefinition<PortfolioContext>> = [
  {
    id: 'account',
    title: 'Account',
    pad: false,
    minW: 8,
    minH: 6,
    render: (c) => (
      <Card className="pf-card--identity pf-card--account2">
        <AccountCard c={c} />
      </Card>
    ),
  },
  {
    id: 'fees',
    title: 'Fees and traded volume',
    // The account card shows the fee rate and 7-day volume; this detail is opt-in.
    defaultHidden: true,
    pad: false,
    minW: 8,
    minH: 5,
    render: (c) => (
      <Card className="pf-card--lists">
        <FeesGroup engine={c.engine} fee={c.fee} error={c.feeError} onRetry={c.feeRetry} />
        <VolumeGroup vol={c.vol} address={c.address} />
      </Card>
    ),
  },
  {
    id: 'performance',
    title: 'Performance',
    pad: false,
    minW: 8,
    minH: 6,
    render: (c) => (
      <Card className="pf-card--lists">
        <PerformanceGroup
          period={c.period} onPeriod={c.setPeriod} all={c.all} win={c.historyNote ? null : c.win} mode={c.mode}
        />
      </Card>
    ),
  },
  {
    id: 'value',
    title: 'Account value',
    pad: false,
    minW: 12,
    minH: 10,
    render: (c) => <ValueCard m={c.model} address={c.address} equity={c.venue} historyNote={c.historyNote} liveEquity={c.liveEquity} />,
  },
  {
    id: 'pnl',
    title: 'Performance chart',
    pad: false,
    minW: 12,
    minH: 10,
    render: (c) => (
      <PerformanceChartCard
        all={c.all}
        period={c.period}
        onPeriod={c.setPeriod}
        win={c.win}
        address={c.address}
        venue={c.venue}
        mode={c.mode}
        onMode={c.setMode}
        historyNote={c.historyNote}
      />
    ),
  },
  {
    // The id predates the rename; it keys saved layouts, so it stays.
    id: 'capital',
    title: 'Margin usage',
    pad: false,
    minW: 10,
    minH: 6,
    render: (c) => <MarginUsagePanel m={c.model} address={c.address} />,
  },
  {
    id: 'exposure',
    title: 'Net positions exposure',
    pad: false,
    minW: 10,
    minH: 6,
    render: (c) => <ExposurePanel m={c.model} perpsByName={c.perpsByName} address={c.address} />,
  },
  {
    id: 'band',
    title: 'Positions, orders and history',
    pad: false,
    minW: 16,
    minH: 8,
    render: (c) => (
      /*
       * THE SHARED ACCOUNT BAND - the same element the trade page carries along
       * its bottom edge.
       *
       * No `market` prop, and that is the honest answer: this page is
       * ACCOUNT-scoped and has no current market, so the band drops its "Current
       * market" checkbox rather than offering a filter with nothing to filter
       * to. `accountScope` is the other half of that: no engine is "the" engine
       * here, so the tables that exist on both carry their own Spot / Perps
       * switch (starting from the engine last traded), Balances lists Spot,
       * Perps and the EVM wallet together, and `symbolsFor` hands each table
       * the markets of whichever engine it is showing.
       */
      <Card className="pf-card--band">
        <div className="dash pf-band">
          <AccountTabs
            engine={c.engine}
            address={c.address}
            unlocked={c.unlocked}
            readOnly={c.readOnly}
            byName={c.engine === 'perps' ? c.perpsByName : c.spotByName}
            refreshToken={c.refreshToken}
            onChanged={c.onChanged}
            accountScope
            symbolsFor={(e) => (e === 'perps' ? c.perpsByName : c.spotByName)}
          />
        </div>
      </Card>
    ),
  },

  /* ---------------------------------------------------------------------------
   * OPT-IN PANELS. Off until added from the layout menu - see `defaultHidden`.
   * ------------------------------------------------------------------------ */
  {
    id: 'leaderboard',
    title: 'Leaderboard',
    defaultHidden: true,
    pad: false,
    minW: 12,
    minH: 8,
    render: (c) => <Leaderboard address={c.address} />,
  },
  {
    id: 'feetier',
    title: 'Fee tier',
    defaultHidden: true,
    pad: false,
    minW: 10,
    minH: 6,
    render: (c) => <FeeTier address={c.address} engine={c.engine} />,
  },
  {
    /*
     * The per-token on-chain detail.
     *
     * The account card's equity breakdown already carries the on-chain TOTAL,
     * which is what most people want. This is the itemisation behind it, and it
     * is opt-in because a wallet holding twenty tokens would otherwise take a
     * panel's worth of the page from everyone who holds none.
     */
    id: 'chain',
    title: 'On-chain holdings',
    defaultHidden: true,
    pad: false,
    minW: 8,
    minH: 6,
    render: (c) => <ChainPanel c={c} />,
  },
  {
    id: 'chart',
    title: 'Chart',
    defaultHidden: true,
    pad: false,
    scroll: 'hidden',
    minW: 12,
    minH: 8,
    render: (c) => <PortfolioChart c={c} />,
  }
];

/**
 * A chart on the PORTFOLIO page is not a price chart.
 *
 * This page is account-scoped and has no current market, so mounting the trade
 * page's candle chart here would need a symbol it does not have. What it does
 * have is the venue's own account-value series - the same one the Account value
 * card draws - so the opt-in "Chart" panel is a larger, standalone view of that.
 */
function PortfolioChart({ c }: { c: PortfolioContext }) {
  const curve = c.venue.points
    ? sliceCurve(c.venue.points, c.period, (q) => q.accountValue)
    : null;
  return (
    <Card
      title="Account value"
      className="pf-card--chart"
      action={<PeriodSeg period={c.period} onPeriod={c.setPeriod} label="Chart period" />}
    >
      {curve ? (
        <EquityCurve win={curve} tone="equity" />
      ) : (
        <p className="pf-note">
          {c.address ? 'Loading the venue series…' : 'Connect a wallet to see the curve.'}
        </p>
      )}
    </Card>
  );
}

/**
 * What the chain says, itemised.
 *
 * Amounts from the ValueChain explorer, prices from the venue's spot markets -
 * see `useOnChain`. Unpriced tokens are SHOWN, with their amount and no dollar
 * figure, rather than dropped: a wallet's biggest holding can easily be the one
 * with no market, and a list that quietly omits it is worse than one that admits
 * it cannot value it.
 */
function ChainPanel({ c }: { c: PortfolioContext }) {
  const chain = c.chain;

  if (!c.address) {
    return <Card title="On-chain holdings"><p className="pf-note">No address.</p></Card>;
  }

  return (
    <Card title="On-chain holdings" action={<span className="pf-unit">valuechain</span>}>
      {chain.error && <ReadFailed what="On-chain holdings" error={chain.error} />}

      <Group title="Wallet">
        <Row
          label="Native balance"
          value={chain.native ? fmt(chain.native.balance, 6) : chain.loading ? '…' : DASH}
          cls={chain.native ? undefined : 'pf-dim'}
          tag={chain.native ? 'venue' : undefined}
          tagHint="From the ValueChain block explorer, not the exchange."
        />
        <Row
          label="Transactions"
          value={chain.native?.txCount != null ? fmt(chain.native.txCount, 0) : DASH}
          cls={chain.native?.txCount != null ? undefined : 'pf-dim'}
          tag={chain.native?.txCount != null ? 'venue' : undefined}
        />
        <Row
          label="Token transfers"
          value={chain.native?.transferCount != null ? fmt(chain.native.transferCount, 0) : DASH}
          cls={chain.native?.transferCount != null ? undefined : 'pf-dim'}
          tag={chain.native?.transferCount != null ? 'venue' : undefined}
        />
        <Row
          label="Tokens held"
          value={chain.tokens ? fmt(chain.tokens.length, 0) : chain.loading ? '…' : DASH}
          cls={chain.tokens ? undefined : 'pf-dim'}
          tag={chain.tokens ? 'venue' : undefined}
        />
        <Row
          label="Token value"
          value={chain.tokens ? fmtUsd(chain.total) : chain.loading ? '…' : DASH}
          cls={chain.tokens ? undefined : 'pf-dim'}
          tag={chain.tokens ? 'derived' : undefined}
          tagHint="Amounts from the chain, priced at the venue's own last trade for each coin."
        />
      </Group>

      {chain.tokens && chain.tokens.length > 0 && (
        <Group title="Balances">
          {chain.tokens.slice(0, 40).map((t) => (
            <Row
              key={t.contract || t.symbol}
              label={t.symbol}
              value={`${fmt(t.amount, 6)}${t.usd !== null ? ` · ${fmtUsd(t.usd)}` : ''}`}
              cls={t.usd === null ? 'pf-dim' : undefined}
              tag="venue"
              tagHint={`${t.name || t.symbol} · ${t.contract}`}
            />
          ))}
        </Group>
      )}

      {chain.unpriced > 0 && (
        <p className="pf-note">
          {/* Listed by amount and excluded from the total rather than valued at
              zero, which would understate the wallet. */}
          {chain.unpriced} token{chain.unpriced === 1 ? '' : 's'} unpriced, excluded from the total.
        </p>
      )}
      {chain.tokens && chain.tokens.length === 0 && !chain.loading && (
        <p className="pf-note">This address holds no ERC-20 tokens on ValueChain.</p>
      )}
    </Card>
  );
}
