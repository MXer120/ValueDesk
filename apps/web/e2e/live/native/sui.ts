/**
 * Sui (types.ts NativeChain): the test key used as it is, as a Sui
 * Secp256k1 keypair (address = BLAKE2b-256(0x01 || compressed public key)).
 * Plain SUI transfers in MIST (9 decimals), built and signed locally
 * (@mysten/sui Transaction, offline: every gas field set by hand), sent as
 * ONE HTTPS POST per call through global fetch so the runner's guard sees the
 * exact bodies.
 *
 * API: Mysten's public GraphQL endpoint (graphql.mainnet.sui.io). The public
 * fullnodes' JSON-RPC is gone: fullnode.mainnet.sui.io answered every method
 * (suix_getReferenceGasPrice, suix_getBalance, ...) on 2026-10-03 with
 * "Method not found. JSON-RPC on public fullnodes has been deprecated. Please
 * migrate to gRPC or GraphQL". GraphQL is a plain JSON POST (gRPC is binary
 * protobuf, which the guard could not compare as a string). The broadcast is the
 * one `mutation executeTransaction`; everything else is a `query` (a read).
 *
 * Where SUI sits: in Coin<SUI> objects AND in the address balance (Sui's
 * accumulator; faucets, exchanges and `send_funds` pay there - a public address
 * checked 2026-10-03 held 8,703 SUI with zero coin objects). The gas payment
 * is every SUI coin object plus, when the address balance is not 0, a COIN
 * RESERVATION of all of it (a special object ref the validators read as "this
 * much from the address balance" - what @mysten/sui's own resolver does,
 * client/core-resolver.ts, re-made here because the SDK does not export it).
 * So the gas coin (`tx.gas`) holds the whole balance:
 *   'max'   -> TransferObjects([GasCoin], to): the receiver gets the gas coin, i.e.
 *              balance - the gas actually CHARGED. PreparedSend.amount is
 *              balance - BUDGET, the guaranteed minimum (the charge is never more
 *              than the budget, usually less - the receiver then gets that much more).
 *   amount  -> SplitCoins(GasCoin, [amount]) + TransferObjects([that], to).
 * The budget comes from a dry run (simulateTransaction with a mocked gas coin),
 * plus margin; the REAL signed bytes are dry-run once more (checks on, real gas
 * objects) and their balance changes checked before anything is returned.
 * A coin reservation names the epoch: a send prepared in one epoch is refused
 * by the validators in the next (epochs are ~24 h) - prepare it again.
 */
import { bcs, TypeTagSerializer } from '@mysten/sui/bcs';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Transaction, TransactionDataBuilder, type ObjectRef } from '@mysten/sui/transactions';
import { deriveDynamicFieldID, fromBase58, fromBase64, fromHex, normalizeSuiAddress, toBase58, toBase64, toHex } from '@mysten/sui/utils';
import type { NativeChain, NativeCoin, NativeKeys, PreparedSend, SendCosts } from './types';

export const SUI_GRAPHQL = 'https://graphql.mainnet.sui.io/graphql';
export const SUI_ORIGINS = ['https://graphql.mainnet.sui.io'] as const;
/** Sui mainnet's chain identifier (its genesis checkpoint digest): a node of another network is refused. */
export const SUI_MAINNET_CHAIN_ID = '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S';
const EXPLORER = 'https://suiscan.xyz/mainnet/tx/';
const SUI_TYPE = '0x2::sui::SUI';
const SUI_COIN_TYPE = '0x2::coin::Coin<0x2::sui::SUI>';
const HEADERS = { 'content-type': 'application/json' } as const;

/** The protocol's limit on gas payment objects (inclusive since protocol 96; a reservation takes one). */
export const SUI_MAX_GAS_OBJECTS = 256;
/** The dry run's budget with the mocked gas coin (the SDK's MAX_GAS: 50 SUI). Never signed. */
const SIMULATE_BUDGET = 50_000_000_000n;
/** Overhead added to every budget, gas units at the gas price (the SDK's GAS_SAFE_OVERHEAD is 1000). */
export const SUI_GAS_OVERHEAD_UNITS = 2000n;
const COIN_PAGE = 50;
const MAX_COIN_PAGES = 6;
const TIMEOUT_MS = 20_000;

const SUI_RE = /^0x[0-9a-fA-F]{64}$/;

// --- GraphQL ------------------------------------------------------------------------------------------------------

const STATE_QUERY = `query SuiState($owner: SuiAddress!, $after: String) {
  chainIdentifier
  epoch { epochId referenceGasPrice }
  address(address: $owner) {
    balance(coinType: "${SUI_TYPE}") { totalBalance coinBalance addressBalance }
    objects(first: ${COIN_PAGE}, after: $after, filter: { type: "${SUI_COIN_TYPE}" }) {
      pageInfo { hasNextPage endCursor }
      nodes { address version digest contents { json } }
    }
  }
}`;

const BALANCE_QUERY = `query SuiBalance($owner: SuiAddress!) {
  address(address: $owner) { balance(coinType: "${SUI_TYPE}") { totalBalance } }
}`;

const NETWORK_QUERY = `query SuiNetwork {
  chainIdentifier
  epoch { epochId referenceGasPrice }
}`;

const SIMULATE_QUERY = `query SuiDryRun($tx: JSON!) {
  simulateTransaction(transaction: $tx, doGasSelection: false, checksEnabled: true) {
    effects {
      status
      executionError { message }
      gasEffects { gasSummary { computationCost storageCost storageRebate nonRefundableStorageFee } }
      balanceChanges(first: 50) { nodes { owner { address } coinType { repr } amount } }
    }
  }
}`;

/** The one write: exactly this text goes out in `request.body` (with the variables). */
export const SUI_EXECUTE_MUTATION = `mutation SuiExecute($tx: Base64!, $signatures: [Base64!]!) {
  executeTransaction(transactionDataBcs: $tx, signatures: $signatures) {
    effects { digest status executionError { message } }
  }
}`;

const EFFECTS_QUERY = `query SuiEffects($digest: String!) {
  transactionEffects(digest: $digest) { digest status checkpoint { sequenceNumber } executionError { message } }
}`;

interface GqlError {
  message?: string;
}

async function gql<T>(query: string, variables: Record<string, unknown>, what: string): Promise<T> {
  let res: Response;
  try {
    res = await globalThis.fetch(SUI_GRAPHQL, {
      method: 'POST',
      headers: { ...HEADERS },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Sui: ${what}: no answer from ${SUI_GRAPHQL} (${(e as Error).message})`);
  }
  const text = await res.text();
  let json: { data?: T | null; errors?: GqlError[] };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new Error(`Sui: ${what}: HTTP ${res.status}, not JSON: ${text.slice(0, 200)}`);
  }
  if (Array.isArray(json.errors) && json.errors.length) {
    throw new Error(`Sui: ${what}: ${json.errors.map((e) => e?.message ?? JSON.stringify(e)).join('; ').slice(0, 500)}`);
  }
  if (!res.ok || !json.data) throw new Error(`Sui: ${what}: HTTP ${res.status}: ${text.slice(0, 200)}`);
  return json.data;
}

const big = (v: unknown, what: string): bigint => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new Error(`Sui: ${what} is not an amount (${String(v)})`);
};
/** Signed (balance changes). */
const sbig = (v: unknown, what: string): bigint => {
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  throw new Error(`Sui: ${what} is not an amount (${String(v)})`);
};

export const suiText = (mist: bigint): string => {
  const neg = mist < 0n;
  const m = neg ? -mist : mist;
  return `${neg ? '-' : ''}${m / 1_000_000_000n}.${(m % 1_000_000_000n).toString().padStart(9, '0')} SUI`;
};

// --- key, coin, reservation ---------------------------------------------------------------------------------------

function assertSui(coin: NativeCoin): void {
  if (!coin.native || coin.token !== null || coin.decimals !== 9) {
    throw new Error(`Sui: only SUI itself is sent here (9 decimals, MIST), not ${coin.symbol}${coin.token ? ` (${coin.token})` : ''}`);
  }
}

/** The test key as a Sui Secp256k1 keypair. */
export function suiKeypair(keys: NativeKeys): Secp256k1Keypair {
  if (keys.secp256k1.length !== 32) throw new Error('Sui: the test key must be 32 bytes');
  return Secp256k1Keypair.fromSecretKey(Uint8Array.from(keys.secp256k1));
}

function suiAddress(a: string, what: string): string {
  if (typeof a !== 'string' || !SUI_RE.test(a)) throw new Error(`Sui: ${what} ${String(a)} is not a Sui address (0x + 64 hex)`);
  return a.toLowerCase();
}

const ACCUMULATOR_ROOT = normalizeSuiAddress('0xacc');
const RESERVATION_MAGIC = new Uint8Array(20).fill(0xac);

/**
 * A coin reservation: an object ref the validators read as "`amount` MIST out of `owner`'s address balance"
 * (the @mysten/sui 2.34 resolver's createCoinReservationRef, client/core-resolver.ts + utils/coin-reservation.ts).
 * objectId = the address balance's accumulator field id XOR the chain id; version 0;
 * digest = amount (u64 LE) || epoch (u32 LE) || 20 x 0xAC.
 */
export function suiCoinReservation(amount: bigint, owner: string, chainId: string, epoch: bigint): ObjectRef {
  if (amount <= 0n || amount >= 1n << 64n) throw new Error(`Sui: a reservation of ${amount} MIST is out of range`);
  if (epoch < 0n || epoch > 0xffffffffn) throw new Error(`Sui: epoch ${epoch} is out of the reservation's u32 range`);
  const keyTag = TypeTagSerializer.parseFromStr(`0x2::accumulator::Key<0x2::balance::Balance<${SUI_TYPE}>>`);
  const field = deriveDynamicFieldID(ACCUMULATOR_ROOT, keyTag, bcs.Address.serialize(owner).toBytes());
  const acc = fromHex(field.slice(2));
  const chain = fromBase58(chainId);
  if (chain.length !== 32 || acc.length !== 32) throw new Error('Sui: bad chain identifier for a coin reservation');
  const id = new Uint8Array(32);
  for (let i = 0; i < 32; i++) id[i] = acc[i]! ^ chain[i]!;
  const digest = new Uint8Array(32);
  const view = new DataView(digest.buffer);
  view.setBigUint64(0, amount, true);
  view.setUint32(8, Number(epoch), true);
  digest.set(RESERVATION_MAGIC, 12);
  return { objectId: `0x${toHex(id)}`, version: '0', digest: toBase58(digest) };
}

export const isSuiCoinReservation = (ref: ObjectRef): boolean => {
  const d = fromBase58(ref.digest);
  return d.length === 32 && d.slice(12).every((b) => b === 0xac);
};

// --- state --------------------------------------------------------------------------------------------------------

export interface SuiCoinRef extends ObjectRef {
  balance: bigint;
}

export interface SuiState {
  chainId: string;
  epoch: bigint;
  gasPrice: bigint;
  total: bigint;
  coinBalance: bigint;
  addressBalance: bigint;
  coins: SuiCoinRef[];
}

interface StateAnswer {
  chainIdentifier: string;
  epoch: { epochId: number | string; referenceGasPrice: string } | null;
  address: {
    balance: { totalBalance: string; coinBalance: string; addressBalance: string } | null;
    objects: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{ address: string; version: number | string; digest: string; contents: { json: { balance?: unknown } | null } | null }>;
    } | null;
  } | null;
}

function checkNetwork(chainIdentifier: unknown, epoch: StateAnswer['epoch']): { chainId: string; epoch: bigint; gasPrice: bigint } {
  if (chainIdentifier !== SUI_MAINNET_CHAIN_ID) throw new Error(`Sui: the node is not on mainnet (chain ${String(chainIdentifier)})`);
  if (!epoch) throw new Error('Sui: the node gave no epoch');
  const gasPrice = big(epoch.referenceGasPrice, 'the reference gas price');
  if (gasPrice <= 0n || gasPrice > 100_000n) throw new Error(`Sui: a reference gas price of ${gasPrice} MIST is not believed`);
  return { chainId: chainIdentifier, epoch: big(epoch.epochId, 'the epoch'), gasPrice };
}

/** Chain, epoch, gas price, the SUI balance (coin objects + address balance) and every SUI coin object of `owner`. */
export async function suiState(owner: string): Promise<SuiState> {
  const coins: SuiCoinRef[] = [];
  let after: string | null = null;
  let first: Omit<SuiState, 'coins'> | null = null;
  for (let page = 0; ; page++) {
    if (page >= MAX_COIN_PAGES) throw new Error(`Sui: ${owner} holds more than ${MAX_COIN_PAGES * COIN_PAGE} SUI coin objects - merge them first`);
    const d: StateAnswer = await gql<StateAnswer>(STATE_QUERY, { owner, after }, `the state of ${owner}`);
    const net = checkNetwork(d.chainIdentifier, d.epoch);
    const bal = d.address?.balance ?? null;
    const now = {
      ...net,
      total: bal ? big(bal.totalBalance, 'totalBalance') : 0n,
      coinBalance: bal ? big(bal.coinBalance, 'coinBalance') : 0n,
      addressBalance: bal ? big(bal.addressBalance, 'addressBalance') : 0n,
    };
    if (now.coinBalance + now.addressBalance !== now.total) throw new Error(`Sui: the balance of ${owner} does not add up (${now.coinBalance} + ${now.addressBalance} != ${now.total})`);
    if (!first) first = now;
    else if (now.epoch !== first.epoch) throw new Error('Sui: the epoch changed while the coins were read - prepare again');
    const objs = d.address?.objects ?? null;
    for (const n of objs?.nodes ?? []) {
      const balance = big(n.contents?.json?.balance, `the balance of coin ${n.address}`);
      if (!SUI_RE.test(n.address) || typeof n.digest !== 'string') throw new Error(`Sui: an unreadable coin object in the answer (${JSON.stringify(n).slice(0, 200)})`);
      if (balance > 0n) coins.push({ objectId: n.address.toLowerCase(), version: String(big(n.version, 'a coin version')), digest: n.digest, balance });
    }
    if (!objs?.pageInfo.hasNextPage) break;
    after = objs.pageInfo.endCursor;
    if (!after) throw new Error('Sui: the coin list says there is more but gives no cursor');
  }
  const sum = coins.reduce((s, c) => s + c.balance, 0n);
  if (sum !== first!.coinBalance) {
    throw new Error(`Sui: the coin objects of ${owner} (${suiText(sum)}) do not match its coin balance (${suiText(first!.coinBalance)}) - it changed while it was read; prepare again`);
  }
  return { ...first!, coins };
}

// --- build, dry run, read back ------------------------------------------------------------------------------------

export interface SuiTransferPlan {
  sender: string;
  to: string;
  amount: bigint | 'max';
  gasPrice: bigint;
  budget: bigint;
  payment: ObjectRef[];
  /** Only for a dry run with the mocked gas coin (payment []), which needs replay protection. */
  validDuring?: { epoch: bigint; chainId: string } | null;
}

/** The transfer's BCS bytes (TransactionData V1), built offline: every input and gas field is given. */
export async function buildSuiTransfer(p: SuiTransferPlan): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(p.sender);
  tx.setGasPrice(p.gasPrice);
  tx.setGasBudget(p.budget);
  tx.setGasPayment(p.payment);
  if (p.validDuring) {
    tx.setExpiration({
      ValidDuring: {
        minEpoch: String(p.validDuring.epoch),
        maxEpoch: String(p.validDuring.epoch + 1n),
        minTimestamp: null,
        maxTimestamp: null,
        chain: p.validDuring.chainId,
        nonce: (Math.random() * 0x100000000) >>> 0,
      },
    });
  }
  if (p.amount === 'max') {
    tx.transferObjects([tx.gas], p.to);
  } else {
    const [part] = tx.splitCoins(tx.gas, [p.amount]);
    tx.transferObjects([part!], p.to);
  }
  return tx.build();
}

/** What the bytes say (Transaction.from): the transfer, and nothing else, or a throw. */
export interface SuiTransferRead {
  sender: string;
  to: string;
  /** 'max' = the whole gas coin is transferred. */
  amount: bigint | 'max';
  gasPrice: bigint;
  budget: bigint;
  gasOwner: string | null;
  payment: ObjectRef[];
  expiration: string | null;
  digest: string;
}

export function readSuiTransfer(bytes: Uint8Array): SuiTransferRead {
  const d = Transaction.from(bytes).getData();
  const bad = (why: string): never => {
    throw new Error(`Sui: the transaction bytes are not a plain SUI transfer (${why})`);
  };
  if (!d.sender) bad('no sender');
  if (d.gasData.price == null || d.gasData.budget == null || !d.gasData.payment) bad('gas data missing');
  const pure = (i: number): Uint8Array => {
    const input = d.inputs[i];
    if (!input || input.$kind !== 'Pure') return bad(`input ${i} is not a pure value`);
    return fromBase64(input.Pure.bytes);
  };
  const isGas = (a: unknown) => !!a && typeof a === 'object' && (a as { $kind?: string }).$kind === 'GasCoin';
  const inputIdx = (a: unknown): number => {
    const x = a as { $kind?: string; Input?: number };
    return x?.$kind === 'Input' && typeof x.Input === 'number' ? x.Input : bad('an argument is not an input');
  };
  let amount: bigint | 'max';
  let to: string;
  const c = d.commands;
  if (c.length === 1) {
    const t = c[0]!.TransferObjects;
    if (!t || t.objects.length !== 1 || !isGas(t.objects[0])) return bad('one command, but not TransferObjects([GasCoin])');
    to = bcs.Address.parse(pure(inputIdx(t.address)));
    amount = 'max';
    if (d.inputs.length !== 1) bad('extra inputs');
  } else if (c.length === 2) {
    const s = c[0]!.SplitCoins;
    const t = c[1]!.TransferObjects;
    if (!s || !isGas(s.coin) || s.amounts.length !== 1) return bad('not SplitCoins(GasCoin, [amount])');
    if (!t || t.objects.length !== 1) return bad('not TransferObjects([the split coin])');
    const o = t.objects[0] as { $kind?: string; NestedResult?: [number, number]; Result?: number };
    const isSplit = (o.$kind === 'NestedResult' && o.NestedResult?.[0] === 0 && o.NestedResult?.[1] === 0) || (o.$kind === 'Result' && o.Result === 0);
    if (!isSplit) bad('the transferred object is not the split coin');
    amount = BigInt(bcs.u64().parse(pure(inputIdx(s.amounts[0]))));
    to = bcs.Address.parse(pure(inputIdx(t.address)));
    if (d.inputs.length !== 2) bad('extra inputs');
  } else {
    return bad(`${c.length} commands`);
  }
  const exp = d.expiration;
  return {
    sender: normalizeSuiAddress(d.sender!),
    to: normalizeSuiAddress(to),
    amount,
    gasPrice: BigInt(d.gasData.price!),
    budget: BigInt(d.gasData.budget!),
    gasOwner: d.gasData.owner ? normalizeSuiAddress(d.gasData.owner) : null,
    payment: d.gasData.payment!.map((r) => ({ objectId: normalizeSuiAddress(r.objectId), version: String(r.version), digest: r.digest })),
    expiration: !exp || exp.$kind === 'None' ? null : exp.$kind,
    digest: TransactionDataBuilder.getDigestFromBytes(bytes),
  };
}

export interface SuiDryRun {
  ok: boolean;
  error: string | null;
  computation: bigint;
  storage: bigint;
  rebate: bigint;
  /** SUI balance change per address (MIST, signed). */
  changes: Map<string, bigint>;
}

interface SimAnswer {
  simulateTransaction: {
    effects: {
      status: 'SUCCESS' | 'FAILURE' | null;
      executionError: { message: string } | null;
      gasEffects: { gasSummary: { computationCost: unknown; storageCost: unknown; storageRebate: unknown } | null } | null;
      balanceChanges: { nodes: Array<{ owner: { address: string } | null; coinType: { repr: string } | null; amount: unknown }> } | null;
    } | null;
  } | null;
}

const isSuiType = (repr: string | undefined) => !!repr && /^0x0*2::sui::SUI$/.test(repr);

/** A dry run of these bytes (simulateTransaction: a read; gas as given, `doGasSelection: false`). */
export async function suiDryRun(bytes: Uint8Array): Promise<SuiDryRun> {
  const d = await gql<SimAnswer>(SIMULATE_QUERY, { tx: { bcs: { value: toBase64(bytes) } } }, 'dry run');
  const e = d.simulateTransaction?.effects;
  const g = e?.gasEffects?.gasSummary;
  if (!e || !g || !e.status) throw new Error('Sui: the dry run gave no effects');
  const changes = new Map<string, bigint>();
  for (const n of e.balanceChanges?.nodes ?? []) {
    if (!n.owner?.address || !isSuiType(n.coinType?.repr)) continue;
    const k = normalizeSuiAddress(n.owner.address);
    changes.set(k, (changes.get(k) ?? 0n) + sbig(n.amount, 'a balance change'));
  }
  return {
    ok: e.status === 'SUCCESS',
    error: e.executionError?.message ?? (e.status === 'SUCCESS' ? null : 'failed'),
    computation: big(g.computationCost, 'computationCost'),
    storage: big(g.storageCost, 'storageCost'),
    rebate: big(g.storageRebate, 'storageRebate'),
    changes,
  };
}

/**
 * The budget for gas the dry run measured: computation + storage (BEFORE the rebate - the high side) + 2000 gas
 * units at the gas price, then + 20 %. What is charged in the end is computation + storage - rebate, which is lower.
 */
export function suiBudgetFor(run: Pick<SuiDryRun, 'computation' | 'storage'>, gasPrice: bigint): bigint {
  const base = run.computation + run.storage + SUI_GAS_OVERHEAD_UNITS * gasPrice;
  return base + (base + 4n) / 5n;
}

/** The dry run with the MOCKED gas coin (payment [], 50 SUI budget, a simulate-only ValidDuring): the budget for `plan`. */
async function estimateBudget(sender: string, to: string, amount: bigint | 'max', net: { chainId: string; epoch: bigint; gasPrice: bigint }): Promise<bigint> {
  const bytes = await buildSuiTransfer({ sender, to, amount, gasPrice: net.gasPrice, budget: SIMULATE_BUDGET, payment: [], validDuring: { epoch: net.epoch, chainId: net.chainId } });
  const run = await suiDryRun(bytes);
  if (!run.ok) throw new Error(`Sui: the gas dry run of a transfer to ${to} fails: ${run.error}`);
  return suiBudgetFor(run, net.gasPrice);
}

// --- the chain ----------------------------------------------------------------------------------------------------

function isWriteBody(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 0 || v.some(isWriteBody);
  if (!v || typeof v !== 'object') return true;
  const q = (v as { query?: unknown }).query;
  if (typeof q !== 'string') return true; // a persisted query or anything else: cannot tell
  return isWriteQuery(q);
}
/** A GraphQL document that is (or contains) a mutation: comments and string literals do not count. */
function isWriteQuery(q: string): boolean {
  const code = q.replace(/"""[\s\S]*?"""/g, '""').replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/#[^\n\r]*/g, '');
  return /\bmutation\b/.test(code) || /\bexecuteTransaction\b/.test(code) || /\bsubscription\b/.test(code);
}

export const sui: NativeChain = {
  kind: 'sui',
  label: 'Sui',
  chainKey: 'SUI',
  origins: SUI_ORIGINS,

  isWrite(url, method, body) {
    const m = method.toUpperCase();
    if (m === 'GET' || m === 'HEAD') {
      const q = url.searchParams.get('query');
      return q !== null && isWriteQuery(q);
    }
    if (m !== 'POST') return true;
    if (body === null || body === '') return false;
    try {
      return isWriteBody(JSON.parse(body));
    } catch {
      return true; // cannot tell: treat as a write
    }
  },

  address(keys) {
    return suiKeypair(keys).toSuiAddress();
  },

  async balance(address, coin) {
    assertSui(coin);
    const owner = suiAddress(address, 'address');
    const d = await gql<{ address: { balance: { totalBalance: string } | null } | null }>(BALANCE_QUERY, { owner }, `the balance of ${owner}`);
    const b = d.address?.balance;
    return b ? big(b.totalBalance, 'totalBalance') : 0n;
  },

  /**
   * The budget of a fixed-amount transfer (SplitCoins: it creates a coin object for the receiver - more storage than
   * 'max', which hands over the gas coin), from a dry run with the mocked gas coin. Nothing must stay on Sui.
   */
  async costs(address, coin, to): Promise<SendCosts> {
    assertSui(coin);
    const sender = suiAddress(address, 'address');
    const dest = SUI_RE.test(to) ? to.toLowerCase() : sender;
    const d = await gql<{ chainIdentifier: string; epoch: StateAnswer['epoch'] }>(NETWORK_QUERY, {}, 'the gas price');
    const net = checkNetwork(d.chainIdentifier, d.epoch);
    const fee = await estimateBudget(sender, dest, 1_000_000n, net);
    return { fee, keep: 0n, nativeNeeded: 0n };
  },

  async prepare(keys, coin, to, amount): Promise<PreparedSend> {
    assertSui(coin);
    const dest = suiAddress(to, 'the destination');
    const kp = suiKeypair(keys);
    const sender = kp.toSuiAddress();
    if (dest === sender) throw new Error('Sui: the destination is the test wallet itself');
    if (amount !== 'max' && amount <= 0n) throw new Error('Sui: the amount must be more than 0 MIST');

    const st = await suiState(sender);
    if (st.total === 0n) throw new Error(`Sui: the test wallet ${sender} holds no SUI`);
    const payment: ObjectRef[] = [
      ...(st.addressBalance > 0n ? [suiCoinReservation(st.addressBalance, sender, st.chainId, st.epoch)] : []),
      ...st.coins.map(({ objectId, version, digest }) => ({ objectId, version, digest })),
    ];
    if (payment.length > SUI_MAX_GAS_OBJECTS) {
      throw new Error(`Sui: ${sender} holds ${st.coins.length} SUI coin objects - more than one transaction can pay gas with (${SUI_MAX_GAS_OBJECTS}); merge them first`);
    }

    const budget = await estimateBudget(sender, dest, amount, st);
    let value: bigint;
    if (amount === 'max') {
      value = st.total - budget;
      if (value <= 0n) throw new Error(`Sui: nothing can leave ${sender}: balance ${suiText(st.total)}, gas budget ${suiText(budget)}`);
    } else {
      value = amount;
      if (st.total < amount + budget) {
        throw new Error(`Sui: too little SUI: ${suiText(amount)} + gas budget ${suiText(budget)} > balance ${suiText(st.total)}`);
      }
    }

    const bytes = await buildSuiTransfer({ sender, to: dest, amount, gasPrice: st.gasPrice, budget, payment });

    // Read back what will be signed: exactly the transfer asked for.
    const back = readSuiTransfer(bytes);
    const samePayment = back.payment.length === payment.length && back.payment.every((r, i) => r.objectId === normalizeSuiAddress(payment[i]!.objectId) && r.version === String(payment[i]!.version) && r.digest === payment[i]!.digest);
    if (
      back.sender !== sender || back.to !== dest || back.amount !== amount || back.gasPrice !== st.gasPrice || back.budget !== budget ||
      (back.gasOwner !== null && back.gasOwner !== sender) || !samePayment || back.expiration !== null
    ) {
      throw new Error('Sui: the built transaction does not read back as the transfer asked for - not signed');
    }

    // Dry-run the real bytes: the real gas objects, checks on. Nothing is signed before it passes.
    const run = await suiDryRun(bytes);
    if (!run.ok) throw new Error(`Sui: the dry run of the transfer fails: ${run.error}`);
    if (run.computation + run.storage > budget) {
      throw new Error(`Sui: the dry run needs ${suiText(run.computation + run.storage)} of gas, more than the budget ${suiText(budget)}`);
    }
    const got = run.changes.get(dest) ?? 0n;
    if (amount === 'max' ? got < value : got !== value) {
      throw new Error(`Sui: in the dry run the receiver gets ${suiText(got)}, not ${amount === 'max' ? 'at least ' : ''}${suiText(value)}`);
    }

    const { signature } = await kp.signTransaction(bytes);
    const txid = back.digest;
    return {
      request: {
        url: SUI_GRAPHQL,
        method: 'POST',
        headers: { ...HEADERS },
        body: JSON.stringify({ query: SUI_EXECUTE_MUTATION, variables: { tx: toBase64(bytes), signatures: [signature] } }),
      },
      txid,
      amount: value,
      // The budget: the most this transaction can be charged (the dry run's charge is computation + storage - rebate).
      fee: budget,
      explorer: `${EXPLORER}${txid}`,
    };
  },

  async broadcast(p) {
    let res: Response;
    try {
      res = await globalThis.fetch(p.request.url, {
        method: p.request.method,
        headers: p.request.headers,
        body: p.request.body,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new Error(`Sui: executeTransaction got no answer (${(e as Error).message}) - the transaction may still have reached the network; check ${p.txid}`);
    }
    const text = await res.text();
    let json: { data?: { executeTransaction?: { effects?: { digest?: string; status?: string } | null } | null } | null; errors?: GqlError[]; error?: string };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      throw new Error(`Sui: executeTransaction HTTP ${res.status}, not JSON: ${text.slice(0, 300)}`);
    }
    if (Array.isArray(json.errors) && json.errors.length) {
      // Usually a refusal before execution; a timeout here can still end on chain - `confirmed(txid)` tells.
      throw new Error(`Sui refused the transaction: ${json.errors.map((e) => e?.message ?? JSON.stringify(e)).join('; ').slice(0, 500)} (digest ${p.txid})`);
    }
    if (!res.ok) throw new Error(`Sui: executeTransaction HTTP ${res.status}: ${(json.error ?? text).slice(0, 300)}`);
    const digest = json.data?.executeTransaction?.effects?.digest;
    if (!digest) throw new Error(`Sui: executeTransaction gave no effects: ${text.slice(0, 300)}`);
    if (digest !== p.txid) throw new Error(`Sui: the node reports digest ${digest}, the signed transaction is ${p.txid}`);
    // A FAILURE status is on chain all the same (gas charged): `confirmed` says false for it.
    return digest;
  },

  async confirmed(txid) {
    let raw: Uint8Array;
    try {
      raw = fromBase58(txid);
    } catch {
      raw = new Uint8Array();
    }
    if (raw.length !== 32) throw new Error(`Sui: ${txid} is not a transaction digest`);
    const d = await gql<{ transactionEffects: { status: string | null; checkpoint: { sequenceNumber: unknown } | null } | null }>(EFFECTS_QUERY, { digest: txid }, `transaction ${txid}`);
    const e = d.transactionEffects;
    if (!e || !e.status) return null;
    if (e.status === 'FAILURE') return false;
    return e.status === 'SUCCESS' ? true : null;
  },
};
