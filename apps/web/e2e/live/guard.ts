/**
 * The runner's network guard: a wrapper around globalThis.fetch that every
 * request of the app's own code (api.ts, trading/gateway.ts, trading/rpc.ts)
 * and of viem goes through.
 *
 *   1. RELATIVE URLS. The app calls its backend as '/api/...'. In Node there is
 *      no page origin, so they are sent to the configured backend origin.
 *
 *   2. ONLY KNOWN HOSTS. The backend, the SoDEX gateway and relayer, the public
 *      RPCs of the chains the runner signs on, and (GET only) ValueChain's
 *      explorer, which the app falls back to for a balance. Anything else is
 *      refused.
 *
 *   3. PLAN MODE IS READ-ONLY, ENFORCED HERE. GETs, and JSON-RPC calls made of
 *      read methods only. Every other request - any SoDEX write, the backend's
 *      POST /api/deposit/prepare, an eth_sendRawTransaction - is answered with a
 *      synthetic refusal and never leaves the process.
 *
 *   4. LIVE MODE WRITES MUST BE EXPECTED. A SoDEX write or a backend POST goes
 *      out only if the running step armed a matching Expectation: its kind, how
 *      many, and a check of the parsed body (account, coin, amount, receiver,
 *      symbol, side, quantity, price, flags, builder ...). Every kind of write
 *      the runner can make has its own kind here. A withdraw permit is DECODED
 *      and its receiver/amount checked again, independently of the wallet's
 *      policy. An order the runner builds itself (it stands in for a modified
 *      client) is its own kind, `direct-order`, and leaves only when its BYTES
 *      are exactly the ones that were armed.
 *
 *   5. THE TWO RATE-LIMITED HISTORY ROUTES (`/accounts/{a}/orders/history`,
 *      `/accounts/{a}/trades`) are refused unless the read comes through the
 *      runner's one limiter (history.ts) - and always in plan mode.
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
 * A RAW TRANSACTION (live mode) is decoded too. One that carries native value
 * with no calldata - a plain coin transfer, which only the evm-tour's deposit
 * back of a chain's native coin makes - is its own kind, `native-transfer`, and
 * leaves only when armed: chain, sender, receiver and value exactly as expected.
 * Native value INTO a contract is never a transaction the runner makes. Every
 * other raw transaction (an ERC-20 call with no value) is gated by the
 * key-backed wallet's policy, which already checked its decoded calldata.
 *
 * Every request is recorded (method, host, path, status, timing) for the
 * report. Request bodies are NOT recorded: signed writes carry signatures.
 * (The account stream is a WebSocket and does not pass here: stream.ts opens it
 * only against SoDEX's own gateway and only ever subscribes.)
 */
import { decodeAbiParameters, parseTransaction, recoverTransactionAddress } from 'viem';
import { CLOB_GATEWAY, WITHDRAW_TOKEN_TARGET } from '@sodex-core';
import { isLimitedHistoryPath } from './history';
import { READ_METHODS } from './provider';

export type GuardMode = 'plan' | 'live';
export type WriteKind =
  | 'key-registration'
  /** The master wallet revoking a trading key: POST /{engine}/exchange, type revokeAPIKey. */
  | 'key-revocation'
  /** The builder-fee approval (or, with maxFeeRate 0, its revocation): POST /user/{owner}/builders. */
  | 'builder-approval'
  | 'engine-transfer'
  | 'order'
  /** An order the RUNNER built and signed (not the app): leaves only with exactly the armed bytes. */
  | 'direct-order'
  | 'cancel'
  /** POST /{engine}/trade/orders/replace - price / size of a resting limit order. */
  | 'order-replace'
  /** POST /perps/trade/orders/modify - a TP/SL order's trigger, price or size. */
  | 'order-modify'
  /** POST /perps/trade/leverage - leverage and margin mode of one market. */
  | 'leverage'
  /** POST /perps/trade/margin - add / remove isolated margin. */
  | 'margin'
  /** POST /{engine}/trade/orders/schedule-cancel - the dead-man switch. */
  | 'schedule-cancel'
  /** A WithdrawToken permit, relayed (alpha-biz call_for_permit) or via the gateway's evm-withdraw. */
  | 'withdraw-permit'
  /** A DepositERC20WithPermit call-for-permit (the gasless wallet -> Spot deposit). */
  | 'deposit-permit'
  /** SoDEX's address risk check before a custody withdrawal (alpha-biz analyse_address). */
  | 'kyt-check'
  /** The backend building deposit calldata (the older wallet -> Spot path). */
  | 'deposit-prepare'
  /** A signed raw transaction moving a chain's native coin with no calldata (evm-tour: the deposit back of a native coin). */
  | 'native-transfer'
  /** A transaction the runner built and signed on a non-EVM chain (native/*.ts), broadcast to that chain's API - exactly the armed bytes. */
  | 'chain-broadcast';

/** A decoded raw transaction (kind 'native-transfer'). */
export interface RawTx {
  chainId: number | null;
  /** lower-case; null for a contract creation */
  to: string | null;
  /** The signer, recovered from the signature (lower-case). */
  from: string;
  value: bigint;
  data: string;
}

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
  /** The body exactly as it would be sent. */
  raw: string | null;
  /** For 'withdraw-permit': the decoded WithdrawToken command. */
  permit?: PermitCmd;
  /** For 'deposit-permit': the decoded DepositERC20WithPermit command. */
  deposit?: { token: string; amount: bigint };
  /** For 'native-transfer': the decoded, signer-recovered transaction. */
  tx?: RawTx;
  /** Which engine's path (transfers, orders, cancels, key writes ...). */
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
  /** The body, byte for byte. Required for 'direct-order'; allowed with any kind. */
  exact?: string;
  /** The check (scenario) this write belongs to - handed to `onWrite`. */
  tag?: string;
}

export interface NetRecord {
  t: number;
  ms?: number;
  method: string;
  dest: 'backend' | 'gateway' | 'relayer' | 'rpc' | 'explorer' | 'chain' | 'other';
  url: string;
  status?: number;
  what: string;
  /** Set when the guard refused it: nothing left the process. */
  blocked?: string;
  /** Short response for writes (order ids, transfer ids, tx hashes) - no secrets travel in responses. */
  response?: string;
  error?: string;
  /** A read sent again this many times after a network failure (READ_RETRY_MS). */
  retries?: number;
}

/** A write that left: what the ledger is built from. */
export interface SentWrite {
  kind: WriteKind;
  engine?: 'spot' | 'perps';
  tag: string | null;
  label: string;
  body: any;
  status: number | null;
  responseText: string | null;
  at: number;
  /** Armed with its exact bytes: a request the RUNNER built (labelled DIRECT), not the app. */
  direct: boolean;
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
  /** Origins that may be READ (GET) and nothing else - ValueChain's explorer API. */
  readOnlyOrigins?: readonly string[];
  /**
   * The non-EVM chains' public APIs (native/*.ts): reads pass; a write (`isWrite` - a broadcast) leaves only
   * as a 'chain-broadcast' the running step armed with its exact body.
   */
  chainApis?: ReadonlyArray<{ label: string; origins: readonly string[]; isWrite(url: URL, method: string, body: string | null): boolean }>;
  /** The wallet (lower-case): an evm-withdraw for anyone else is refused. */
  owner: string;
  /** Plan mode: do not even let the backend ask SoDEX to issue deposit addresses. */
  blockDepositIssuing?: boolean;
  /** The door to the rate-limited history routes (history.ts). Without it they are refused. */
  history?: { admit(): string | null } | null;
  /** Every answer of the backend's builder-terms route, before the caller sees it (terms.ts). */
  onTerms?: (url: URL, status: number, bodyText: string) => void;
  /** Every write that left, with its answer (ledger.ts). */
  onWrite?: (w: SentWrite) => void;
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

/**
 * A READ that failed for a reason of the network is sent again - a public node or SoDEX
 * dropping one request must not stop a run of hours (live run of 2026-10-03: Polygon's
 * node "not a batch answer", a SoDEX timeout). Only reads, which change nothing:
 * never a write, never a rate-limited history read, never the fee terms (a hint),
 * never once the caller gave up (its own timeout aborted the request).
 */
export const READ_RETRY_MS = [1_000, 3_000, 8_000];
const RETRY_STATUS = new Set([502, 503, 504]);
const transientError = (e: unknown): boolean => {
  const m = `${e instanceof Error ? `${e.name} ${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e)}`;
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|other side closed|UND_ERR|network|terminated/i.test(m);
};
/** A JSON-RPC node's answer to `request` (one call or a batch): anything else - HTML, a bare error object - is not one. */
export function isRpcAnswer(request: unknown, text: string): boolean {
  let a: unknown;
  try {
    a = JSON.parse(text);
  } catch {
    return false;
  }
  const one = (x: unknown): boolean => !!x && typeof x === 'object' && ('result' in x || ('error' in x && 'id' in x));
  return Array.isArray(request) ? Array.isArray(a) && a.length > 0 && a.every(one) : one(a);
}

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

/** Decode a signed raw transaction and recover its signer (throws when it is not one). */
export async function decodeRawTx(raw: string): Promise<RawTx> {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error('not a hex transaction');
  const tx = parseTransaction(raw as `0x${string}`);
  const from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
  const data = String((tx as { data?: string }).data ?? '0x').toLowerCase();
  return { chainId: typeof tx.chainId === 'number' ? tx.chainId : null, to: tx.to ? tx.to.toLowerCase() : null, from, value: tx.value ?? 0n, data: data === '' ? '0x' : data };
}

/** The backend's builder-terms route (docs/BUILDER-TIERS.md section 3): a read. */
const TERMS_PATH = '/api/vs/builder/terms';

/** What kind of write a gateway request is, or null when it is not one the runner ever makes. */
export function classifyGatewayWrite(method: string, path: string, owner: string, body: unknown = null): { kind: WriteKind; engine?: 'spot' | 'perps' } | null {
  let m: RegExpExecArray | null;
  const eng = (s: string | undefined): 'spot' | 'perps' => (s === 'spot' ? 'spot' : 'perps');
  if (method === 'POST' && (m = /^\/api\/v1\/(spot|perps)\/exchange$/.exec(path))) {
    // One route, two master-wallet actions: told apart by the body's own `type`.
    const type = (body as { type?: unknown } | null)?.type;
    if (type === 'addAPIKey') return { kind: 'key-registration', engine: eng(m[1]) };
    if (type === 'revokeAPIKey') return { kind: 'key-revocation', engine: eng(m[1]) };
    return null;
  }
  if (method === 'POST' && (m = /^\/api\/v1\/(spot|perps)\/accounts\/transfers$/.exec(path))) return { kind: 'engine-transfer', engine: eng(m[1]) };
  if (path === '/api/v1/spot/trade/orders/batch') return method === 'POST' ? { kind: 'order', engine: 'spot' } : method === 'DELETE' ? { kind: 'cancel', engine: 'spot' } : null;
  if (path === '/api/v1/perps/trade/orders') return method === 'POST' ? { kind: 'order', engine: 'perps' } : method === 'DELETE' ? { kind: 'cancel', engine: 'perps' } : null;
  if (method === 'POST' && (m = /^\/api\/v1\/(spot|perps)\/trade\/orders\/replace$/.exec(path))) return { kind: 'order-replace', engine: eng(m[1]) };
  if (method === 'POST' && path === '/api/v1/perps/trade/orders/modify') return { kind: 'order-modify', engine: 'perps' };
  if (method === 'POST' && path === '/api/v1/perps/trade/leverage') return { kind: 'leverage', engine: 'perps' };
  if (method === 'POST' && path === '/api/v1/perps/trade/margin') return { kind: 'margin', engine: 'perps' };
  if (method === 'POST' && (m = /^\/api\/v1\/(spot|perps)\/trade\/orders\/schedule-cancel$/.exec(path))) return { kind: 'schedule-cancel', engine: eng(m[1]) };
  if (method === 'POST' && (m = /^\/api\/v1\/user\/(0x[0-9a-fA-F]{40})\/evm-withdraw$/.exec(path))) {
    return m[1]!.toLowerCase() === owner.toLowerCase() ? { kind: 'withdraw-permit' } : null;
  }
  // A builder approval for any account but this wallet's is not a write the runner makes.
  if (method === 'POST' && (m = /^\/api\/v1\/user\/(0x[0-9a-fA-F]{40})\/builders$/.exec(path))) {
    return m[1]!.toLowerCase() === owner.toLowerCase() ? { kind: 'builder-approval' } : null;
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
  const readOnly = new Set((o.readOnlyOrigins ?? []).map((u) => new URL(u).origin));
  const chainApiOf = (origin: string) => (o.chainApis ?? []).find((a) => a.origins.some((x) => new URL(x).origin === origin)) ?? null;
  const armed: Array<Expectation & { left: number }> = [];
  /** Native transfers that went out (their raw signed bytes): the same bytes again are a rebroadcast, never a second payment. */
  const sentRawTx = new Set<string>();
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
              : readOnly.has(url.origin)
                ? 'explorer'
                : chainApiOf(url.origin)
                  ? 'chain'
                  : 'other';
    const rec: NetRecord = { t: Date.now(), method, dest, url: `${url.origin}${url.pathname}${url.search}`, what: 'read' };
    /**
     * A read sent again after a network failure (READ_RETRY_MS). `rpcRequest`: the parsed JSON-RPC body,
     * so a node's answer that is not JSON-RPC (or 429) is retried too. A Request object is sent once (its
     * body cannot be read twice).
     */
    const retrying = async (rpcRequest: unknown | undefined): Promise<Response> => {
      const once = () => original(typeof input === 'string' ? target : input, init);
      if (!(typeof input === 'string' || input instanceof URL)) return once();
      for (let i = 0; ; i++) {
        const last = i >= READ_RETRY_MS.length;
        let res: Response;
        try {
          res = await once();
        } catch (e) {
          if (last || init?.signal?.aborted || !transientError(e)) throw e;
          rec.retries = (rec.retries ?? 0) + 1;
          await new Promise((r) => setTimeout(r, READ_RETRY_MS[i]));
          continue;
        }
        let again = RETRY_STATUS.has(res.status);
        if (!again && rpcRequest !== undefined) again = res.status === 429 || !isRpcAnswer(rpcRequest, await res.clone().text().catch(() => ''));
        if (!again || last || init?.signal?.aborted) return res;
        rec.retries = (rec.retries ?? 0) + 1;
        await new Promise((r) => setTimeout(r, READ_RETRY_MS[i]));
      }
    };
    /** Send it. `after` sees the answer's text first (terms answers, writes). `retry`: a read, sent again after a network failure. */
    const send = async (after?: (status: number, text: string) => void, retry?: { rpc?: unknown }): Promise<Response> => {
      const t0 = Date.now();
      try {
        // A relative string goes to the backend; a URL or Request object goes on exactly as given.
        const res = retry ? await retrying(retry.rpc) : await original(typeof input === 'string' ? target : input, init);
        rec.status = res.status;
        rec.ms = Date.now() - t0;
        if (after || (rec.what !== 'read' && rec.what !== 'rpc-read')) {
          const text = await res.clone().text().catch(() => '');
          if (rec.what !== 'read' && rec.what !== 'rpc-read') rec.response = text.slice(0, 600);
          try {
            after?.(res.status, text);
          } catch {
            /* a listener must not change what the caller gets */
          }
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

    if (dest === 'chain') {
      const api = chainApiOf(url.origin)!;
      if (!api.isWrite(url, method, bodyText)) {
        rec.what = `${api.label} read`;
        return send(undefined, {});
      }
      rec.what = `${api.label} broadcast`;
      if (o.mode === 'plan') return refused(rec, `plan mode is read-only (${api.label} broadcast)`, 'backend');
      return dispatch({ kind: 'chain-broadcast', method, url, body: null, raw: bodyText }, rec, 'backend');
    }

    if (dest === 'explorer') {
      if (method === 'GET' || method === 'HEAD') return send(undefined, {});
      return refused(rec, `${url.host} is read-only for the runner (${method})`, 'backend');
    }

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
      if (methods.every((m) => RPC_READS.has(m))) return send(undefined, { rpc: parsed });
      const writes = methods.filter((m) => !RPC_READS.has(m));
      if (o.mode === 'plan') return refused(rec, `plan mode is read-only (${writes.join(', ')})`, 'rpc', ids);
      if (!writes.every((m) => m === 'eth_sendRawTransaction')) return refused(rec, `JSON-RPC method not allowed: ${writes.join(', ')}`, 'rpc', ids);
      // Live: raw transactions only, which the key-backed wallet signed under its policy - decoded here once more.
      const raws = calls.filter((c) => String(c?.method) === 'eth_sendRawTransaction').map((c) => (c as { params?: unknown[] }).params?.[0]);
      const txs: RawTx[] = [];
      for (const raw of raws) {
        try {
          txs.push(await decodeRawTx(String(raw)));
        } catch (e) {
          return refused(rec, `an undecodable raw transaction (${e instanceof Error ? (e.message.split('\n')[0] ?? '') : String(e)})`, 'rpc', ids);
        }
      }
      if (txs.some((t) => t.value > 0n && t.data !== '0x')) return refused(rec, 'native value sent INTO a contract is not a transaction the runner makes', 'rpc', ids);
      const plain = txs.filter((t) => t.value > 0n);
      if (!plain.length) return send();
      if (txs.length > 1) return refused(rec, 'a native-coin transfer goes out alone, never in a batch', 'rpc', ids);
      const rawKey = String(raws[0] ?? '').toLowerCase();
      if (sentRawTx.has(rawKey)) {
        // The wallet's RPC client sends once more after a time-out or a 5xx: the SAME signed transaction (one nonce,
        // one hash) cannot pay twice - refusing it would only hide whether the first copy arrived.
        rec.what = 'native-transfer: the same signed transaction again (a rebroadcast)';
        return send();
      }
      rec.what = 'native-transfer';
      const res = await dispatch({ kind: 'native-transfer', method, url, body: parsed, raw: bodyText, tx: plain[0]! }, rec, 'rpc', ids);
      if (!rec.blocked) sentRawTx.add(rawKey);
      return res;
    }

    if (method === 'GET' || method === 'HEAD') {
      if (dest === 'backend' && o.blockDepositIssuing && url.pathname === '/api/mirror/deposit-options') {
        return refused(rec, '--registry-only: not asking the backend (and through it SoDEX) to issue deposit addresses', 'backend');
      }
      if (dest === 'gateway' && isLimitedHistoryPath(url.pathname)) {
        rec.what = 'history-read';
        if (o.mode === 'plan') return refused(rec, 'plan mode makes no history reads (orders/history and trades are limited to about 4 a minute per IP)', 'gateway');
        const why = o.history ? o.history.admit() : 'history reads (orders/history, trades) go through the runner\'s limiter, and none is set up';
        if (why) return refused(rec, why, 'gateway');
        return send();
      }
      if (dest === 'backend' && url.pathname === TERMS_PATH && o.onTerms) return send((status, text) => o.onTerms!(url, status, text));
      return send(undefined, {});
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
      if (method === 'POST' && url.pathname === '/api/deposit/prepare') req = { kind: 'deposit-prepare', method, url, body, raw: bodyText };
    } else if (dest === 'relayer') {
      const c = classifyRelayerWrite(method, url.pathname, body);
      if ('req' in c) req = { ...c.req, method, url, body, raw: bodyText };
      else notOurs = c.refuse;
    } else {
      const k = classifyGatewayWrite(method, url.pathname, o.owner, body);
      if (k) {
        req = { kind: k.kind, engine: k.engine, method, url, body, raw: bodyText };
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
    return dispatch(req, rec, shape);

    /** Send a write only if an armed expectation takes it; otherwise refuse it, saying why. */
    async function dispatch(req: WriteRequest, rec: NetRecord, shape: 'gateway' | 'backend' | 'rpc', rpcIds: unknown = null): Promise<Response> {
      const reasons: string[] = [];
      // An order whose exact bytes were armed as the runner's own is a `direct-order`; anything else on that route is the app's.
      const kinds: WriteKind[] = req.kind === 'order' ? ['direct-order', 'order'] : [req.kind];
      for (const kind of kinds) {
        for (const e of armed) {
          if (e.kind !== kind || e.left <= 0) continue;
          let why: string | null = null;
          if (e.exact !== undefined && req.raw !== e.exact) why = 'the body is not, byte for byte, the one that was armed';
          if (why === null && e.check) why = e.check({ ...req, kind });
          if (why === null) {
            e.left -= 1;
            rec.what = `${kind}: ${e.label}`;
            const sent: SentWrite = { kind, engine: req.engine, tag: e.tag ?? null, label: e.label, body: req.body, status: null, responseText: null, at: Date.now(), direct: e.exact !== undefined };
            try {
              return await send((status, text) => {
                sent.status = status;
                sent.responseText = text;
              });
            } finally {
              try {
                o.onWrite?.(sent);
              } catch {
                /* the ledger must not change what the caller gets */
              }
            }
          }
          reasons.push(`${e.label}: ${why}`);
        }
      }
      return refused(rec, reasons.length ? `does not match what this step expects - ${reasons.join('; ')}` : `no ${req.kind} is expected right now`, shape, rpcIds);
    }
  };

  globalThis.fetch = wrapped as typeof fetch;
  return {
    mode: o.mode,
    expect(e) {
      const list = (Array.isArray(e) ? e : [e]).map((x) => ({ ...x, left: x.times ?? 1 }));
      for (const x of list) {
        if (x.kind === 'direct-order' && (typeof x.exact !== 'string' || x.exact === '')) throw new Error(`guard: a direct-order expectation needs its exact body ("${x.label}")`);
      }
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
