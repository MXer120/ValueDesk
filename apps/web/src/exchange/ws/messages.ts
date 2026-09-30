/**
 * What tabs and the socket host say to each other.
 *
 * The host (a SharedWorker, or the elected leader tab, or the tab itself)
 * holds the actual SoDEX connections. A tab sends it subscribe / unsubscribe;
 * the host answers with pushes in exactly the shape the old Valuescan hub sent
 * over /ws, so ws.ts's fan-out is unchanged:
 *   {type:"push",   engine, channel, pushType:"snapshot"|"update", data, user?}
 *   {type:"status", engine, status}
 * Over a BroadcastChannel every tab hears every message, so host messages name
 * the tab(s) they are for in `to`.
 */
import type { SubParams } from '@sign/sodex/wsProtocol.js';

export type Engine = 'spot' | 'perps';
export type SocketStatus = 'connecting' | 'open' | 'closed' | 'reconnecting';

/** Bump when a message changes shape: a tab never talks to a host of another version. */
export const WS_PROTOCOL_VERSION = 1;

export type ToHost =
  | { op: 'hello'; client: string; v: number }
  | { op: 'subscribe'; client: string; engine: Engine; params: SubParams; wsBase: string }
  | { op: 'unsubscribe'; client: string; engine: Engine; params: SubParams }
  | { op: 'ping'; client: string }
  | { op: 'bye'; client: string };

export type ToTab = (
  | { type: 'hello'; v: number; host: 'worker' | 'leader' | 'local' }
  | { type: 'push'; engine: Engine; channel: string; pushType: 'snapshot' | 'update'; data: unknown; user?: string }
  | { type: 'status'; engine: Engine; status: SocketStatus }
  | { type: 'ack'; op: 'subscribe' | 'unsubscribe'; engine: Engine; channel: string }
  | { type: 'error'; op?: string; engine?: Engine; channel?: string; message: string }
  | { type: 'pong' }
  | { type: 'leader'; id: string }
) & { to?: string[] };

/** A tab the host talks to. */
export interface ClientPort {
  readonly id: string;
  send(msg: ToTab): void;
}
