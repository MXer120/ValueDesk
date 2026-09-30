/**
 * Data layer for the Performance chart.
 *
 * Every call here goes STRAIGHT from the browser to SoDEX - no backend proxy.
 * All four endpoints are CORS-open and need no credentials (verified against
 * mainnet). That is not just convenient: SoDEX rate-limits per IP, so routing
 * every user's polling through one server would share a single 6000/min bucket
 * across all of them. Fetching direct puts each user on their own budget, and
 * means nothing about a user's account passes through us.
 *
 * WHAT EXISTS, AND WHAT DOES NOT.
 *
 * The equity/PnL series is one endpoint and it is unusually complete: a single
 * response carries account value AND the PnL split by venue, so "perps only",
 * "spot only" and "total" are field selections rather than extra round trips.
 *
 * Deposits and withdrawals are the slow part. They live on two different biz
 * endpoints that OVERLAP, both capped at 100 rows per page, so a full history is
 * a real pager - which is why this module reports progress instead of pretending
 * to be instant.
 *
 * Airdrops: only CLAIM STATUS is public. There is no public endpoint returning a
 * claimed amount, so an airdrop-adjusted equity curve cannot be built from
 * public data - see `fetchAirdropStatus`. We surface the status and say so,
 * rather than inventing a number.
 */

import { dataGet } from './exchange/sodexData';
import { gwGet } from './exchange/sodexGateway';
import { network as appNetwork } from './exchange/hosts';

const DATA_HOST = (net: string) => (net === 'testnet' ? 'https://testnet-data.sodex.dev' : 'https://mainnet-data.sodex.dev');
const BIZ_HOST = 'https://alpha-biz.sodex.dev';

/**
 * The windows the endpoint accepts, verbatim from its own error message:
 * "invalid window: must be 24H, 7D, 30D, 90D, or 1Y". Everything else - 1D, 14D,
 * 180D, 365D, ALL, MAX - is a 400.
 *
 * There is no ALL. 1Y is the longest available, so a UI that offers "ALL" is
 * really offering "up to one year"; that is said out loud where it is shown
 * rather than quietly implying full history.
 */
export const WINDOWS = ['24H', '7D', '30D', '90D', '1Y'] as const;
export type Window = (typeof WINDOWS)[number];

export type MarketType = 'all' | 'perps' | 'spot';

export interface ChartPoint {
  ts: number;
  accountValue: number;
  pnl: number;
  spotPnl: number;
  perpsPnl: number;
  vaultPnl: number;
  roi: number;
}

export interface FlowRow {
  ts: number;
  /** Positive for money in, negative for money out. */
  amount: number;
  coin: string;
  kind: 'deposit' | 'withdraw';
  chain?: string;
  txHash?: string;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url.split('?')[0]} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url.split('?')[0]} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The equity + PnL series.
 *
 * One call returns account value and the PnL split three ways, so the chart's
 * venue modes cost nothing extra. `market_type` only changes which balance
 * `account_value_usd` reflects - the *_pnl_usd fields are always all present.
 */
export async function fetchChart(
  accountId: number,
  window: Window,
  marketType: MarketType,
  network: string,
): Promise<{ points: ChartPoint[]; totalPnl: number; roi: number }> {
  const path = `/api/v1/wallet/portfolio/chart?account_id=${accountId}&window=${window}&market_type=${marketType}`;
  // The app's own network goes through the shared data-host client (its limiter and
  // rate-limit cooldown, shared by every tab); another network is read as before.
  const d = (network === appNetwork()
    ? await dataGet<Record<string, unknown>>(path)
    : (await getJson<{ code: number; data?: Record<string, unknown> }>(`${DATA_HOST(network)}${path}`))?.data) ?? {};
  const raw = Array.isArray(d.chart) ? (d.chart as Array<Record<string, unknown>>) : [];
  return {
    points: raw
      .map((p) => ({
        ts: num(p.ts_ms),
        accountValue: num(p.account_value_usd),
        pnl: num(p.pnl_usd),
        spotPnl: num(p.spot_pnl_usd),
        perpsPnl: num(p.perps_pnl_usd),
        vaultPnl: num(p.vault_pnl_usd),
        roi: num(p.roi),
      }))
      .filter((p) => p.ts > 0)
      .sort((a, b) => a.ts - b.ts),
    totalPnl: num(d.total_pnl_usd),
    roi: num(d.roi),
  };
}

/** Rows per page on both flow endpoints. Server-side cap; asking for more is silently clamped. */
const PAGE = 100;
/** A hard stop so a pathological account cannot spin forever. 200 pages = 20k rows. */
const MAX_PAGES = 200;

interface FlowProgress {
  /** Steps finished. */
  done: number;
  /** Best current estimate of total steps. Grows as totals are learned. */
  total: number;
}

/**
 * Walk the full deposit/withdrawal history.
 *
 * Two feeds, both needed and both overlapping:
 *   - `mirror/account_flow`       cross-chain movements (offset paginated)
 *   - `mirror/v2/combined_transfers` on-chain transfers (page/size paginated)
 *
 * They are drained concurrently, exactly as SoDEX's own frontend does, and the
 * union is de-duplicated by txHash with account_flow winning - it is the richer
 * row (it carries chain, coin and a status).
 *
 * `onProgress` fires after every page so the caller can render a counter. The
 * total is an estimate until both feeds report their own totals, which they do
 * on the first page; it is published as a maximum so the counter never goes
 * backwards.
 */
export async function fetchFlows(
  address: string,
  accountId: number,
  onProgress?: (p: FlowProgress) => void,
): Promise<FlowRow[]> {
  let flowOffset = 0;
  let flowTotal: number | null = null;
  let combinedPage = 0;
  let combinedTotal: number | null = null;

  const rows: FlowRow[] = [];
  const seen = new Set<string>();
  let done = 0;

  const steps = (): number => {
    // Two feeds; until a total is known assume one more page than we have done.
    const a = flowTotal === null ? done + 1 : Math.max(1, Math.ceil(flowTotal / PAGE));
    const b = combinedTotal === null ? done + 1 : Math.max(1, Math.ceil(combinedTotal / PAGE));
    return a + b;
  };

  for (let guard = 0; guard < MAX_PAGES; guard++) {
    const flowDrained = flowTotal !== null && flowOffset >= flowTotal;
    const combinedDrained = combinedTotal !== null && combinedPage * PAGE >= combinedTotal;
    if (flowDrained && combinedDrained) break;

    const [flowRes, combRes] = await Promise.all([
      flowDrained
        ? Promise.resolve(null)
        : postJson<any>(`${BIZ_HOST}/biz/mirror/account_flow`, {
            account: address,
            start: flowOffset,
            end: 0,
            limit: PAGE,
          }).catch(() => null),
      combinedDrained
        ? Promise.resolve(null)
        : postJson<any>(`${BIZ_HOST}/biz/mirror/v2/combined_transfers`, {
            walletAddress: address,
            page: combinedPage + 1,
            size: PAGE,
          }).catch(() => null),
    ]);

    if (flowRes) {
      const d = flowRes?.data ?? {};
      const list: any[] = Array.isArray(d.accountFlows) ? d.accountFlows : [];
      flowTotal = Math.max(flowTotal ?? 0, num(d.total));
      for (const r of list) {
        const hash = String(r.txHash || r.originTxHash || '').toLowerCase();
        if (hash) seen.add(hash);
        const dec = num(r.decimals) || 0;
        const amt = num(r.amount) / 10 ** dec;
        const isWithdraw = String(r.type || '').toLowerCase().includes('withdraw');
        rows.push({
          ts: num(r.stmp) * (String(r.stmp).length <= 10 ? 1000 : 1),
          amount: isWithdraw ? -amt : amt,
          coin: String(r.displaySymbol || r.coin || ''),
          kind: isWithdraw ? 'withdraw' : 'deposit',
          chain: r.chain ? String(r.chain) : undefined,
          txHash: hash || undefined,
        });
      }
      flowOffset += list.length;
      // A short page means the feed is exhausted regardless of what total said.
      if (list.length < PAGE) flowTotal = flowOffset;
      done++;
    }

    if (combRes) {
      const d = combRes?.data ?? {};
      const list: any[] = Array.isArray(d.fundTransfers) ? d.fundTransfers : [];
      combinedTotal = Math.max(combinedTotal ?? 0, num(d.total));
      for (const r of list) {
        const hash = String(r.txHash || '').toLowerCase();
        if (hash && seen.has(hash)) continue; // account_flow already has it, richer
        if (hash) seen.add(hash);
        // transferType: negative = out, positive = in (observed -1 and 2).
        const out = num(r.transferType) < 0;
        rows.push({
          ts: num(r.blockTimestamp) * 1000,
          // No decimals field here; amounts are raw. Left unscaled deliberately -
          // see the note in the component: these rows are used for COUNTS and
          // event markers, not summed into the equity curve.
          amount: out ? -num(r.amount) : num(r.amount),
          coin: '',
          kind: out ? 'withdraw' : 'deposit',
          txHash: hash || undefined,
        });
      }
      combinedPage++;
      if (list.length < PAGE) combinedTotal = combinedPage * PAGE;
      done++;
    }

    onProgress?.({ done, total: Math.max(steps(), done) });
    if (!flowRes && !combRes) break; // both errored - stop rather than spin
  }

  void accountId;
  return rows.filter((r) => r.ts > 0).sort((a, b) => a.ts - b.ts);
}

export interface AirdropStatus {
  epochId: string;
  claimStatus: string;
  claimEnabled: boolean;
}

/**
 * Airdrop CLAIM STATUS only.
 *
 * There is no public endpoint that returns a claimed AMOUNT - `my_claim` and
 * `claim` both sit behind a bearer token. So this can tell the user where they
 * stand, but it cannot contribute a number to an equity curve, and the chart
 * must not pretend otherwise.
 */
export async function fetchAirdropStatus(address: string): Promise<AirdropStatus | null> {
  try {
    const body = await getJson<any>(`${BIZ_HOST}/biz/soso_airdrop/claim_status?address=${address}`);
    const d = body?.data;
    if (!d) return null;
    return {
      epochId: String(d.epochId ?? ''),
      claimStatus: String(d.claimStatus ?? ''),
      claimEnabled: Boolean(d.claimEnabled),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a wallet to its numeric SoDEX account id.
 *
 * The chart endpoint keys on `account_id`, not on an address. The gateway's
 * account state is public and unauthenticated, so this is one more direct read
 * rather than a reason to thread the id down through the page's model.
 */
export async function fetchAccountId(address: string, network: string): Promise<number | null> {
  const gw = network === 'testnet' ? 'https://testnet-gw.sodex.dev' : 'https://mainnet-gw.sodex.dev';
  try {
    // Shared with every other read of this account's state (one request, one budget).
    const state = network === appNetwork()
      ? await gwGet<{ aid?: unknown } | null>(`/api/v1/perps/accounts/${address}/state`)
      : (await getJson<any>(`${gw}/api/v1/perps/accounts/${address}/state`))?.data;
    const aid = num(state?.aid);
    return aid > 0 ? aid : null;
  } catch {
    return null;
  }
}
