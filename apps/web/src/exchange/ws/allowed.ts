/**
 * The only WebSocket origins the socket host will ever open.
 *
 * Tabs name the gateway in each subscribe (it follows the network the app runs
 * on), and the host serves every tab of this origin - so a message naming any
 * other server would let one foothold feed forged books, balances and fills to
 * all of them. The host therefore opens nothing but SoDEX's own gateways (and
 * a gateway this build was explicitly pointed at), always over wss.
 */
// network.ts itself, not the package index: the SharedWorker needs these two
// strings, not the signing code the index also carries.
import { GATEWAY_WS_ORIGIN } from '../../../../../packages/sodex-core/src/network.ts';

// `import.meta.env` is Vite's; absent under the node test runner.
const env = ((import.meta as { env?: Record<string, string | undefined> }).env ?? {}) as Record<string, string | undefined>;

export function allowedGatewayWs(): ReadonlySet<string> {
  const set = new Set<string>([GATEWAY_WS_ORIGIN.mainnet, GATEWAY_WS_ORIGIN.testnet]);
  const override = env.VITE_SODEX_GATEWAY?.trim().replace(/\/+$/, '');
  if (override && /^https:\/\/[^/\s]+$/.test(override)) set.add(override.replace(/^https:/, 'wss:'));
  return set;
}

/** Exactly one of the allowed origins (no path, no plaintext ws://). */
export function isAllowedGatewayWs(base: unknown): boolean {
  return typeof base === 'string' && base.startsWith('wss://') && allowedGatewayWs().has(base);
}
