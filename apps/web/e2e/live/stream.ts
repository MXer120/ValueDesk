/**
 * The wallet's account stream, held open for the whole run: SoDEX's
 * `accountOrderUpdate` and `accountTrade` pushes on both engines.
 *
 * Why: the two REST routes that list an account's orders and fills are limited
 * to about four requests a minute per IP (history.ts). The stream costs none of
 * that budget, so the steps take every order state and every fill from here and
 * the REST history is read only once, for the final cross-check.
 *
 * The connection is the app's own (`SodexSocket`, exchange/ws/sodexSocket.ts:
 * keepalive, reconnect with backoff, re-subscription, one connection per
 * wallet), opened only against SoDEX's own gateway (exchange/ws/allowed.ts).
 * It only ever SUBSCRIBES - account channels need no signature and send nothing
 * else. Pushes are also fed to the app's own reading of them
 * (exchange/historyTables.ts notePush), which the cross-check uses to ask the
 * app's question: "does the history hold everything the stream reported?".
 *
 * A stream that cannot connect is not a failure of the run: the checks that
 * need a fill then wait for the final cross-check, and say so.
 */
import { isAllowedGatewayWs } from '../../src/exchange/ws/allowed';
import { SodexSocket, type SocketFactory, type SocketLike } from '../../src/exchange/ws/sodexSocket';
import { newWants, notePush, type StreamWants } from '../../src/exchange/historyTables';
import { fillFromStream, type Engine } from './fees';
import type { Ledger } from './ledger';

const CHANNELS = ['accountOrderUpdate', 'accountTrade'] as const;
const ENGINES: readonly Engine[] = ['spot', 'perps'];

/** Forwards everything to the real socket and lets the stream read each message first (for subscription answers). */
class Tap implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(
    private readonly ws: SocketLike,
    onRaw: (text: string) => void,
    onOpen: () => void,
  ) {
    ws.onopen = (ev) => {
      onOpen();
      this.onopen?.(ev);
    };
    ws.onmessage = (ev) => {
      try {
        onRaw(String(ev.data));
      } catch {
        /* the tap must never break the connection */
      }
      this.onmessage?.(ev);
    };
    ws.onclose = (ev) => this.onclose?.(ev);
    ws.onerror = (ev) => this.onerror?.(ev);
  }
  get readyState(): number {
    return this.ws.readyState;
  }
  send(data: string): void {
    this.ws.send(data);
  }
  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
}

export interface AccountStreamOptions {
  owner: string;
  ledger: Ledger;
  /** The gateway's WebSocket origin, e.g. wss://mainnet-gw.sodex.dev. */
  base: string;
  /** How to open a socket (default: the runtime's WebSocket). Tests pass a fake. */
  factory?: SocketFactory;
  say?: (line: string) => void;
}

export class AccountStream {
  /** What the app's own reader makes of the pushes, per engine. */
  readonly wants: Record<Engine, StreamWants> = { spot: newWants(), perps: newWants() };
  /** Reconnects after a drop: pushes may be missing since. */
  readonly gaps: Record<Engine, number> = { spot: 0, perps: 0 };
  /**
   * When each engine's subscriptions were first all accepted (null: never). A brand-new wallet's account
   * does not exist when the run starts: SoDEX refuses the subscription ("user not found") until it does,
   * and nothing before this moment was pushed.
   */
  readonly readySince: Record<Engine, number | null> = { spot: null, perps: null };
  /** Refused subscriptions and other things the gateway said. */
  readonly errors: string[] = [];
  private readonly socks = new Map<Engine, SodexSocket>();
  private readonly acks: Record<Engine, number> = { spot: 0, perps: 0 };
  private readonly opened: Record<Engine, number> = { spot: 0, perps: 0 };
  private pushes = 0;
  private started = false;
  private listeners = new Set<() => void>();

  constructor(private readonly o: AccountStreamOptions) {}

  /** Why the stream may not be opened (null: fine). */
  static problem(base: string): string | null {
    if (!isAllowedGatewayWs(base)) return `${base} is not one of SoDEX's own gateways (wss) - the account stream is not opened`;
    if (typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'function') return 'this runtime has no WebSocket (Node 22 or newer is needed for the account stream)';
    return null;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const owner = this.o.owner.toLowerCase();
    const open: SocketFactory = this.o.factory ?? ((url) => new (globalThis as unknown as { WebSocket: new (u: string) => SocketLike }).WebSocket(url));
    for (const engine of ENGINES) {
      const factory: SocketFactory = (url) =>
        new Tap(
          open(url),
          (text) => this.onRaw(engine, text),
          () => {
            this.acks[engine] = 0;
            this.opened[engine] += 1;
            if (this.opened[engine] > 1) this.gaps[engine] += 1;
          },
        );
      const sock = new SodexSocket(
        this.o.base,
        engine,
        {
          onPush: (_s, msg) => this.onPush(engine, msg),
          onAckError: (_s, message) => {
            this.errors.push(`${engine}: ${message}`);
            this.o.say?.(`account stream (${engine}): the gateway refused a subscription: ${message}`);
          },
        },
        factory,
        owner,
      );
      this.socks.set(engine, sock);
      for (const channel of CHANNELS) sock.subscribe({ channel, user: owner });
    }
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  private onRaw(engine: Engine, text: string): void {
    let msg: { op?: unknown; success?: unknown } | null = null;
    try {
      msg = JSON.parse(text) as { op?: unknown; success?: unknown };
    } catch {
      return;
    }
    if (msg?.op === 'subscribe' && msg.success === true) {
      this.acks[engine] += 1;
      if (this.readySince[engine] === null && this.acks[engine] >= CHANNELS.length) this.readySince[engine] = Date.now();
      this.notify();
    }
  }

  private onPush(engine: Engine, msg: { channel?: unknown; type?: unknown; data?: unknown }): void {
    const channel = String(msg?.channel ?? '');
    if (channel !== 'accountOrderUpdate' && channel !== 'accountTrade') return;
    this.pushes += 1;
    notePush(this.wants[engine], channel, msg.data);
    const list: unknown[] = Array.isArray(msg.data) ? msg.data : msg.data && typeof msg.data === 'object' ? [msg.data] : [];
    for (const item of list) {
      const row = (item ?? {}) as Record<string, unknown>;
      if (channel === 'accountTrade') {
        const f = fillFromStream(engine, row);
        if (f) this.o.ledger.noteFill(f);
      } else {
        this.o.ledger.noteRecord(engine, row, 'stream');
      }
    }
    this.notify();
  }

  /** Open, and both channels acknowledged since the last (re)connect. */
  ready(engine: Engine): boolean {
    return this.socks.get(engine)?.status === 'open' && this.acks[engine] >= CHANNELS.length;
  }

  /** Wait until both engines are ready, at most `timeoutMs`. */
  waitReady(timeoutMs: number): Promise<boolean> {
    const done = (): boolean => ENGINES.every((e) => this.ready(e));
    if (done()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const check = (): void => {
        if (!done()) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        resolve(done());
      }, timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.listeners.add(check);
    });
  }

  describe(): { spot: string; perps: string; pushes: number; gaps: Record<Engine, number>; errors: string[] } {
    const one = (e: Engine): string => `${this.socks.get(e)?.status ?? 'not started'}${this.ready(e) ? ', subscribed' : ''}`;
    return { spot: one('spot'), perps: one('perps'), pushes: this.pushes, gaps: { ...this.gaps }, errors: [...this.errors] };
  }

  close(): void {
    for (const s of this.socks.values()) s.close();
    this.socks.clear();
    this.listeners.clear();
  }
}
