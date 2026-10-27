/**
 * Where each exchange lives, for the network this app runs on.
 *
 * The network is the trading config's (trading/config.ts): pinned by the
 * build, else what the ValueDesk server reports. Every host here answers the
 * browser directly (CORS verified 2026-09-30) and every one of them is listed
 * in index.html's connect-src - nothing else is.
 */
import { GATEWAY_WS_ORIGIN, type Network } from '@sodex-core';
import { tradingConfig } from '../trading/config';
import { HL_INFO_URL } from '@sign/valuedesk/hyperliquid/info.js';
import { LIGHTER_API } from '@sign/valuedesk/extra/lighter.js';
import { ARCUS_API } from '@sign/valuedesk/extra/arcus.js';

export const network = (): Network => tradingConfig().network;

/** SoDEX trading gateway, e.g. https://mainnet-gw.sodex.dev (a build may point elsewhere). */
export const gatewayOrigin = (): string => tradingConfig().gateway;

/** The gateway's WebSocket origin: the same host as the REST gateway, wss. */
export function gatewayWsOrigin(): string {
  const gw = gatewayOrigin();
  const known = (Object.entries({ mainnet: 'https://mainnet-gw.sodex.dev', testnet: 'https://testnet-gw.sodex.dev' }) as Array<[Network, string]>)
    .find(([, o]) => o === gw);
  if (known) return GATEWAY_WS_ORIGIN[known[0]];
  return gw.replace(/^http/, 'ws');
}

/** SoDEX's analytics host: leaderboard, ranks, portfolio charts, mark/index candles. */
export const dataOrigin = (): string =>
  network() === 'testnet' ? 'https://testnet-data.sodex.dev' : 'https://mainnet-data.sodex.dev';

/** sodex.com's own API (history ledger, deposits, maintenance). Mainnet only. */
export const BIZ_ORIGIN = 'https://alpha-biz.sodex.dev';

export { HL_INFO_URL, LIGHTER_API, ARCUS_API };
