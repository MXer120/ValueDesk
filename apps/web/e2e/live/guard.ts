/**
 * The runner's network guard: a wrapper around globalThis.fetch that every
 * request of the app's own code (api.ts, trading/gateway.ts, trading/rpc.ts)
 * and of viem goes through.
 *
 *   1. RELATIVE URLS. The app calls its backend as '/api/...'. In Node there is
 *      no page origin, so they are sent to the configured backend origin.
 *
 *   2. ONLY KNOWN HOSTS. The backend, the SoDEX gateway and the public RPCs of
 *      the chains the app knows. Anything else is refused.
 *
 *   3. PLAN MODE IS READ-ONLY, ENFORCED HERE. GETs, and JSON-RPC calls made of
 *      read methods only. Every other request - any SoDEX write, the backend's
 *      POST /api/deposit/prepare, an eth_sendRawTransaction - is answered with a
 *      synthetic refusal and never leaves the process.
 *
 *   4. LIVE MODE WRITES MUST BE EXPECTED. A SoDEX write or a backend POST goes
 *      out only if the running step armed a matching Expectation (its kind, how
 *      many, and a check of the parsed body: account, coin, amount, receiver,
 *      symbol, quantity...). An evm-withdraw permit is DECODED here and its
 *      receiver/amount checked again, independently of the wallet's policy.
 *
 * A refused request gets a definite "no" (HTTP 403 with an error envelope, or a
 * JSON-RPC error) - never a network error - so the app does not report "it may
 * still have gone through" for something that was never sent.
 *
 * SoDEX's relayer host (alpha-biz, trading/relay.ts) is known too: its GETs
 * (maintenance) are reads; `call_for_permit` is decoded (a WithdrawToken or a
 * DepositERC20WithPermit command) and checked like any other write, and the
 * address risk check (`analyse_address`) must be expected for that receiver.
 * The older gateway route for permits (`/user/{owner}/evm-withdraw`) is decoded
 * the same way, so either channel meets the same check.
 *
 * Every request is recorded (method, host, path, status, timing) for the
 * report. Request bodies are NOT recorded: signed writes carry signatures.
 */
import { decodeAbiParameters } from 'viem';
import { CLOB_GATEWAY, WITHDRAW_TOKEN_TARGET } from '@sodex-core';
import { READ_METHODS } from './provider';

export type GuardMode = 'plan' | 'live';
export type WriteKind =
  | 'key-registration'
  | 'engine-transfer'
  | 'order'
  | 'cancel'
  /** A WithdrawToken permit, relayed (alpha-biz call_for_permit) or via the gateway's evm-withdraw. */
  | 'withdraw-permit'
  /** A DepositERC20WithPermit call-for-permit (the gasless wallet -> Spot deposit). */
  | 'deposit-permit'
  /** SoDEX's address risk check before a custody withdrawal (alpha-biz analyse_address). */
  | 'kyt-check'
  /** The backend building deposit calldata (the older wallet -> Spot path). */
  | 'deposit-prepare';

/** The decoded WithdrawToken command of an evm-withdraw permit. */
export interface PermitCmd {
  coinSymbol: string;
  chain: string;
  receiver: string;
  amount: bigint;
  withdrawType: number;
  memo: string;
  failedBackToClob: boolean;
}

export interface WriteRequest {
  kind: WriteKind;
  method: string;
  url: URL;
  /** Parsed JSON body (null when there is none or it is not JSON). */
  body: any;
  /** For 'withdraw-permit': the decoded WithdrawToken command. */
  permit?: PermitCmd;
  /** For 'deposit-permit': the decoded DepositERC20WithPermit command. */
  deposit?: { token: string; amount: bigint };
  /** For 'engine-transfer' / 'order' / 'cancel' / 'key-registration': which engine's path. */
  engine?: 'spot' | 'perps';
}

export interface Expectation {
  kind: WriteKind;
  /** Shown in refusals and the report. */
  label: string;
  /** How many matching requests may go out (default 1). */
  times?: number;
  /** null = this request is the expected one. */
  check?: (r: WriteRequest) => string | null;
}

export interface NetRecord {
  t: number;
  ms?: number;
  method: string;
  dest: 'backend' | 'gateway' | 'relayer' | 'rpc' | 'other';
  url: string;
  status?: number;
  what: string;
  /** Set when the guard refused it: nothing left the process. */
  blocked?: string;
  /** Short response for writes (order ids, transfer ids, tx hashes) - no secrets travel in responses. */
  response?: string;
  error?: string;
}

export interface GuardOptions {
  mode: GuardMode;
  /** The backend origin that relative '/api/...' URLs go to, e.g. http://127.0.0.1:5180. */
  backend: string;
  /** SoDEX gateway origin, e.g. https://mainnet-gw.sodex.dev. */
  gateway: string;
  /** SoDEX's relayer / business API origin (trading/relay.ts BIZ_ORIGIN). */
  relayer: string;
  /** Public JSON-RPC URLs (ValueChain + EVM chains). */
  rpcUrls: readonly string[];
  /** The wallet (lower-case): an evm-withdraw for anyone else is refused. */
  owner: string;
  /** Plan mode: do not even let the backend ask SoDEX to issue deposit addresses. */
  blockDepositIssuing?: boolean;
  onRecord?: (r: NetRecord) => void;
}

export interface Guard {
  readonly mode: GuardMode;
  /** Arm expectations; returns the disarm function (call it in `finally`). */
  expect(e: Expectation | Expectation[]): () => void;
  /** Expectations armed and not used up (for a step's own sanity check). */
  pending(): Array<{ label: string; left: number }>;
  readonly records: NetRecord[];
  /** Refused requests only. */
  readonly refusals: NetRecord[];
  uninstall(): void;
}

const norm = (u: string): string => u.replace(/\/+$/, '');

/** Methods a JSON-RPC body may carry in plan mode (and in live mode without a raw tx). */
const RPC_READS = new Set([...READ_METHODS, 'eth_chainId', 'net_version', 'eth_fillTransaction']);

const PERMIT_CMD = [
  { type: 'string' },
  { type: 'string' },
  { type: 'string' },
  { type: 'uint256' },
  { type: 'uint8' },
  { type: 'string' },
  { type: 'bool' },
] as const;

export function decodePermitCmd(cmdData: string): PermitCmd {
  const [coinSymbol, chain, receiver, amount, withdrawType, memo, failedBackToClob] = decodeAbiParameters(PERMIT_CMD, cmdData as `0x${string}`);
  return { coinSymbol, chain, receiver, amount, withdrawType: Number(withdrawType), memo, failedBackToClob };
}

const DEPOSIT_CMD = [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }] as const;

/** DepositERC20WithPermit's cmdData: abi.encode(token, amount, deadline, v, r, s). */
export function decodeDepositCmd(cmdData: string): { token: string; amount: bigint } {
  const [token, amount] = decodeAbiParameters(DEPOSIT_CMD, cmdData as `0x${string}`);
  return { token: token.toLowerCase(), amount };
}

/** What kind of write a gateway request is, or null when it is not one the runner ever makes. */
export function classifyGatewayWrite(method: string, path: string, owner: string): { kind: WriteKind; engine?: 'spot' | 'perps' } | null {
  let m: RegExpExecArray | null;
  if (method === 'POST' && (m = /^\/api\/v1\/(spot|perps)\/exchange$/.exec(path))) return { kind: 'key-registration', engine: m[1] as 'spot' | 'perps' };
  if (method === 'POST' && (m = /^\/api\/v1\/(spot|perps)\/accounts\/transfers$/.exec(path))) return { kind: 'engine-transfer', engine: m[1] as 'spot' | 'perps' };
  if (path === '/api/v1/spot/trade/orders/batch') return method === 'POST' ? { kind: 'order', engine: 'spot' } : method === 'DELETE' ? { kind: 'cancel', engine: 'spot' } : null;
  if (path === '/api/v1/perps/trade/orders') return method === 'POST' ? { kind: 'order', engine: 'perps' } : method === 'DELETE' ? { kind: 'cancel', engine: 'perps' } : null;
  if (method === 'POST' && (m = /^\/api\/v1\/user\/(0x[0-9a-fA-F]{40})\/evm-withdraw$/.exec(path))) {
    return m[1]!.toLowerCase() === owner.toLowerCase() ? { kind: 'withdraw-permit' } : null;
  }
  return null;
}

/** What kind of write a relayer request is (decoded), or a reason it is not one the runner ever makes. */
export function classifyRelayerWrite(method: string, path: string, body: any): { req: Pick<WriteRequest, 'kind' | 'permit' | 'deposit'> } | { refuse: string } {
  if (method !== 'POST') return { refuse: `${method} ${path} is not a relayer write the runner makes` };
  if (path === '/biz/mirror/analyse_address') return { req: { kind: 'kyt-check' } };
  if (path !== '/biz/mirror/call_for_permit') return { refuse: `${path} is not a relayer write the runner makes` };
  const to = String(body?.to ?? '').toLowerCase();
  try {
    if (body?.cmdType === 'WithdrawToken' && to === WITHDRAW_TOKEN_TARGET.toLowerCase()) return { req: { kind: 'withdraw-permit', permit: decodePermitCmd(String(body.cmdData)) } };
    if (body?.cmdType === 'DepositERC20WithPermit' && to === CLOB_GATEWAY.toLowerCase()) return { req: { kind: 'deposit-permit', deposit: decodeDepositCmd(String(body.cmdData)) } };
  } catch {
    return { refuse: `call_for_permit with an undecodable ${String(body?.cmdType)} command` };
  }
  return { refuse: `call_for_permit ${String(body?.cmdType)} to ${to} is not a command the runner sends` };
}

/**
 * sodex.com's deposit-address reads (the app builds deposit options in the
 * browser now, exchange/deposits.ts): POSTs that only read - except that
 * create_deposit_addresses makes SoDEX ISSUE a new wallet's addresses, which
 * --registry-only exists to avoid.
 */
const RELAYER_READ_POSTS = new Set(['/biz/mirror/create_deposit_addresses', '/biz/mirror/deposit_address']);

export function installGuard(o: GuardOptions): Guard {
  const original = globalThis.fetch;
  const backend = new URL(o.backend);
  const gateway = new URL(o.gateway);
  const relayer = new URL(o.relayer);
  const rpcs = new Set(o.rpcUrls.map(norm));
  const armed: Array<Expectation & { left: number }> = [];
  const records: NetRecord[] = [];
  const refusals: NetRecord[] = [];
  /** Long waits poll for up to half an hour: keep the report bounded (writes and refusals are always kept). */
  const MAX_READ_RECORDS = 4000;
  let reads = 0;
  const push = (r: NetRecord) => {
    const isRead = (r.what === 'read' || r.what === 'rpc-read') && !r.blocked && !r.error;
    if (!isRead || ++reads <= MAX_READ_RECORDS) records.push(r);
    if (r.blocked) refusals.push(r);
    try {
      o.onRecord?.(r);
    } catch {
      /* ignore */
    }
  };

  const refused = (rec: NetRecord, reason: string, shape: 'gateway' | 'backend' | 'rpc', rpcId: unknown = null): Response => {
    rec.blocked = reason;
    rec.status = 403;
    push(rec);
    if (shape === 'rpc') {
      const one = (id: unknown) => ({ jsonrpc: '2.0', id, error: { code: -32000, message: `E2E guard: ${reason} (nothing was sent)` } });
      const body = Array.isArray(rpcId) ? rpcId.map(one) : one(rpcId);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // Every shape the app parses reads this as a definite refusal: the gateway's
    // envelope (code), the backend's { error }, the relayer's { code, msg }.
    const text = `E2E guard refused this request: ${reason}. Nothing was sent.`;
    const body = shape === 'gateway' ? { code: -1, error: text, msg: text } : { error: text };
    return new Response(JSON.stringify(body), { status: 403, headers: { 'content-type': 'application/json' } });
  };

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let urlText: string;
    let method = (init?.method ?? 'GET').toUpperCase();
    let bodyText: string | null = typeof init?.body === 'string' ? init.body : null;
    if (typeof input === 'string') urlText = input;
    else if (input instanceof URL) urlText = input.href;
    else {
      urlText = input.url;
      method = (init?.method ?? input.method ?? 'GET').toUpperCase();
      if (bodyText === null && method !== 'GET' && method !== 'HEAD') bodyText = await input.clone().text().catch(() => null);
    }
    const url = urlText.startsWith('/') ? new URL(urlText, backend) : new URL(urlText);
    const target = url.href;
    const dest: NetRecord['dest'] =
      url.origin === backend.origin
        ? 'backend'
        : url.origin === gateway.origin
          ? 'gateway'
          : url.origin === relayer.origin
            ? 'relayer'
            : rpcs.has(norm(`${url.origin}${url.pathname}`))
              ? 'rpc'
              : 'other';
    const rec: NetRecord = { t: Date.now(), method, dest, url: `${url.origin}${url.pathname}${url.search}`, what: 'read' };
    const send = async (): Promise<Response> => {
      const t0 = Date.now();
      try {
        // A relative string goes to the backend; a URL or Request object goes on exactly as given.
        const res = await original(typeof input === 'string' ? target : input, init);
        rec.status = res.status;
        rec.ms = Date.now() - t0;
        if (rec.what !== 'read' && rec.what !== 'rpc-read') {
          rec.response = (await res.clone().text().catch(() => '')).slice(0, 600);
        }
        push(rec);
        return res;
      } catch (e) {
        rec.ms = Date.now() - t0;
        rec.error = e instanceof Error ? e.message : String(e);
        push(rec);
        throw e;
      }
    };

    if (dest === 'other') return refused(rec, `host ${url.host} is not one the runner talks to`, 'backend');

    if (dest === 'rpc') {
      if (method !== 'POST') return send();
      let calls: Array<{ method?: unknown; id?: unknown }>;
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText ?? '');
        calls = Array.isArray(parsed) ? parsed : [parsed as { method?: unknown }];
      } catch {
        return refused(rec, 'unreadable JSON-RPC body', 'rpc');
      }
      const methods = calls.map((c) => String(c?.method ?? ''));
      const ids = Array.isArray(parsed) ? calls.map((c) => c?.id ?? null) : (calls[0]?.id ?? null);
      rec.what = methods.every((m) => RPC_READS.has(m)) ? 'rpc-read' : `rpc ${methods.join(',')}`;
      if (methods.every((m) => RPC_READS.has(m))) return send();
      const writes = methods.filter((m) => !RPC_READS.has(m));
      if (o.mode === 'plan') return refused(rec, `plan mode is read-only (${writes.join(', ')})`, 'rpc', ids);
      // Live: only raw transactions, which the key-backed wallet signed under its policy.
      if (writes.every((m) => m === 'eth_sendRawTransaction')) return send();
      return refused(rec, `JSON-RPC method not allowed: ${writes.join(', ')}`, 'rpc', ids);
    }

    if (method === 'GET' || method === 'HEAD') {
      if (dest === 'backend' && o.blockDepositIssuing && url.pathname === '/api/mirror/deposit-options') {
        return refused(rec, '--registry-only: not asking the backend (and through it SoDEX) to issue deposit addresses', 'backend');
      }
      return send();
    }

    if (dest === 'relayer' && method === 'POST' && RELAYER_READ_POSTS.has(url.pathname)) {
      if (o.blockDepositIssuing && url.pathname === '/biz/mirror/create_deposit_addresses') {
        return refused(rec, '--registry-only: not asking SoDEX to issue deposit addresses', 'gateway');
      }
      return send();
    }

    // A write.
    let body: any = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      body = null;
    }
    let req: WriteRequest | null = null;
    let notOurs: string | null = null;
    if (dest === 'backend') {
      if (method === 'POST' && url.pathname === '/api/deposit/prepare') req = { kind: 'deposit-prepare', method, url, body };
    } else if (dest === 'relayer') {
      const c = classifyRelayerWrite(method, url.pathname, body);
      if ('req' in c) req = { ...c.req, method, url, body };
      else notOurs = c.refuse;
    } else {
      const k = classifyGatewayWrite(method, url.pathname, o.owner);
      if (k) {
        req = { kind: k.kind, engine: k.engine, method, url, body };
        if (k.kind === 'withdraw-permit') {
          try {
            req.permit = decodePermitCmd(String(body?.cmdData ?? ''));
          } catch {
            return refused(rec, 'evm-withdraw with an undecodable cmdData', 'gateway');
          }
        }
      }
    }
    const shape = dest === 'backend' ? 'backend' : 'gateway';
    rec.what = req ? req.kind : `${method} ${url.pathname}`;
    if (o.mode === 'plan') return refused(rec, `plan mode is read-only (${rec.what})`, shape);
    if (!req) return refused(rec, notOurs ?? `not a write the runner ever makes (${method} ${url.pathname})`, shape);
    const reasons: string[] = [];
    for (const e of armed) {
      if (e.kind !== req.kind || e.left <= 0) continue;
      const why = e.check ? e.check(req) : null;
      if (why === null) {
        e.left -= 1;
        rec.what = `${req.kind}: ${e.label}`;
        return send();
      }
      reasons.push(`${e.label}: ${why}`);
    }
    return refused(rec, reasons.length ? `does not match what this step expects - ${reasons.join('; ')}` : `no ${req.kind} is expected right now`, shape);
  };

  globalThis.fetch = wrapped as typeof fetch;
  return {
    mode: o.mode,
    expect(e) {
      const list = (Array.isArray(e) ? e : [e]).map((x) => ({ ...x, left: x.times ?? 1 }));
      armed.push(...list);
      return () => {
        for (const x of list) {
          const i = armed.indexOf(x);
          if (i >= 0) armed.splice(i, 1);
        }
      };
    },
    pending: () => armed.filter((e) => e.left > 0).map((e) => ({ label: e.label, left: e.left })),
    records,
    refusals,
    uninstall() {
      if (globalThis.fetch === (wrapped as typeof fetch)) globalThis.fetch = original;
    },
  };
}
