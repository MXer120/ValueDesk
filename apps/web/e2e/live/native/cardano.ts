/**
 * Cardano (types.ts NativeChain): an ed25519 seed DERIVED from the test key
 * (keys.ts, HKDF "valuedesk-test:cardano") used as a plain (non-HD) payment
 * key. The test wallet is its ENTERPRISE address (header 0x61: key-hash
 * payment credential, no stake part, mainnet), addr1v..., payment key hash =
 * BLAKE2b-224(public key). Plain ADA transfers in lovelace, built and signed
 * locally (cardano-serialization-lib), no metadata, no tokens.
 *
 * API: Koios (api.koios.rest, public tier, no key; all answered 2026-10-03):
 *   GET  /tip, GET /cli_protocol_params, POST /address_utxos, POST /tx_status  - reads
 *   POST /ogmios  {"method":"submitTransaction","params":{"transaction":{"cbor":hex}}} - THE write
 * Koios's /submittx takes the transaction as RAW BINARY CBOR (application/cbor).
 * The runner's guard compares bodies as STRINGS, and fetch sends a string as
 * UTF-8 - every byte >= 0x80 would become two, so no string can carry the raw
 * bytes. Koios also forwards Ogmios v6 JSON-RPC (it lists submitTransaction and
 * evaluateTransaction among the methods it accepts): the same transaction as
 * hex inside JSON is an ordinary string body, sent and compared byte for byte.
 *
 * The transaction: every UTxO of the wallet as inputs ('max'; a fixed amount
 * uses every ADA-only UTxO), TTL = tip slot + 1000 (~17 min), one vkey
 * witness. fee = txFeePerByte * size + txFeeFixed of the SIGNED bytes, exactly
 * (the signature's size does not depend on the key). 'max': one output of
 * total - fee. A fixed amount: the output plus change back to the wallet when
 * the change is at least the min-UTxO, else the change is added to the fee.
 * An output below the min-UTxO (coinsPerUTxOByte * (160 + its size), ~1 ADA)
 * is refused before anything is signed. txid = BLAKE2b-256 of the body bytes.
 * A destination must be a mainnet address with a KEY payment part: ADA sent
 * without a datum to a Plutus script address can be locked for good.
 */
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex } from '@noble/hashes/utils';
import type { NativeChain, NativeCoin, NativeKeys, PreparedSend, SendCosts } from './types';

export const KOIOS = 'https://api.koios.rest/api/v1';
export const CARDANO_ORIGINS = ['https://api.koios.rest'] as const;
export const KOIOS_OGMIOS = `${KOIOS}/ogmios`;
const EXPLORER = 'https://cardanoscan.io/transaction/';
const HEADERS = { 'content-type': 'application/json', accept: 'application/json' } as const;

/** TTL = the tip's slot + this (1 slot = 1 s on mainnet). */
export const CARDANO_TTL_SLOTS = 1000n;
/** A send not on chain this many slots after its TTL can never be: `confirmed` says false (Koios instances may lag). */
const EXPIRED_AFTER_SLOTS = 900n;
/** costs(): the exact fee of the planned shape, + 10 %. */
const COSTS_MARGIN_PCT = 10n;
const PAGE = 1000;
const MAX_PAGES = 5;
const TIMEOUT_MS = 20_000;

/** Sends we built: their TTL, so `confirmed` can tell "never" from "not yet". */
const ttls = new Map<string, bigint>();

// --- Koios --------------------------------------------------------------------------------------------------------

async function koios(path: string, init: { method: 'GET' } | { method: 'POST'; body: unknown }, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await globalThis.fetch(`${KOIOS}${path}`, {
      method: init.method,
      headers: { ...HEADERS },
      ...(init.method === 'POST' ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Cardano: ${what}: no answer from Koios (${(e as Error).message})`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Cardano: ${what}: Koios HTTP ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Cardano: ${what}: Koios answered something that is not JSON: ${text.slice(0, 200)}`);
  }
}

const big = (v: unknown, what: string): bigint => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new Error(`Cardano: ${what} is not a whole number (${String(v)})`);
};

export const adaText = (lovelace: bigint): string => `${lovelace / 1_000_000n}.${(lovelace % 1_000_000n).toString().padStart(6, '0')} ADA`;

export interface CardanoParams {
  /** min_fee_a, lovelace per byte. */
  feePerByte: bigint;
  /** min_fee_b, lovelace. */
  feeFixed: bigint;
  coinsPerUtxoByte: bigint;
  maxTxSize: number;
}

/** The protocol parameters the node uses now (cardano-cli shape), with sanity bounds. */
export async function cardanoParams(): Promise<CardanoParams> {
  const p = (await koios('/cli_protocol_params', { method: 'GET' }, 'protocol parameters')) as Record<string, unknown> | null;
  if (!p || typeof p !== 'object') throw new Error('Cardano: no protocol parameters');
  const pp: CardanoParams = {
    feePerByte: big(p.txFeePerByte, 'txFeePerByte'),
    feeFixed: big(p.txFeeFixed, 'txFeeFixed'),
    coinsPerUtxoByte: big(p.utxoCostPerByte, 'utxoCostPerByte'),
    maxTxSize: Number(big(p.maxTxSize, 'maxTxSize')),
  };
  if (pp.feePerByte < 1n || pp.feePerByte > 1_000n || pp.feeFixed > 10_000_000n || pp.coinsPerUtxoByte < 1n || pp.coinsPerUtxoByte > 100_000n || pp.maxTxSize < 1_000 || pp.maxTxSize > 1_000_000) {
    throw new Error(`Cardano: protocol parameters out of any believable range (${JSON.stringify({ ...pp, feePerByte: String(pp.feePerByte), feeFixed: String(pp.feeFixed), coinsPerUtxoByte: String(pp.coinsPerUtxoByte) })})`);
  }
  return pp;
}

/** The chain's tip slot. */
export async function cardanoTip(): Promise<bigint> {
  const t = (await koios('/tip', { method: 'GET' }, 'the tip')) as Array<{ abs_slot?: unknown }> | null;
  const slot = Array.isArray(t) ? t[0]?.abs_slot : undefined;
  return big(slot, 'the tip slot');
}

export interface CardanoUtxo {
  txHash: string;
  index: number;
  lovelace: bigint;
  /** Native tokens on it (a fixed send leaves it alone; 'max' refuses). */
  tokens: number;
  /** It carries a reference script (its fee rules differ; not spent here). */
  refScript: boolean;
}

interface KoiosUtxo {
  tx_hash?: unknown;
  tx_index?: unknown;
  value?: unknown;
  asset_list?: unknown;
  reference_script?: unknown;
  is_spent?: unknown;
}

/** Every unspent output at `address` (Koios's indexed view: an output spent by a transaction still in the mempool still shows). */
export async function cardanoUtxos(address: string): Promise<CardanoUtxo[]> {
  const out: CardanoUtxo[] = [];
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) throw new Error(`Cardano: ${address} has more than ${MAX_PAGES * PAGE} UTxOs`);
    const rows = await koios(`/address_utxos?order=tx_hash.asc,tx_index.asc&offset=${page * PAGE}&limit=${PAGE}`, { method: 'POST', body: { _addresses: [address], _extended: true } }, `the UTxOs of ${address}`);
    if (!Array.isArray(rows)) throw new Error(`Cardano: the UTxOs of ${address}: not a list`);
    for (const r of rows as KoiosUtxo[]) {
      if (r.is_spent === true) continue;
      const txHash = typeof r.tx_hash === 'string' && /^[0-9a-f]{64}$/.test(r.tx_hash) ? r.tx_hash : null;
      const index = Number(big(r.tx_index, 'tx_index'));
      if (!txHash || index > 0xffff) throw new Error(`Cardano: an unreadable UTxO in Koios's answer (${JSON.stringify(r).slice(0, 200)})`);
      out.push({
        txHash,
        index,
        lovelace: big(r.value, `the value of ${txHash}#${index}`),
        tokens: Array.isArray(r.asset_list) ? r.asset_list.length : 0,
        refScript: r.reference_script !== null && r.reference_script !== undefined,
      });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

// --- key, address -------------------------------------------------------------------------------------------------

function assertAda(coin: NativeCoin): void {
  if (!coin.native || coin.token !== null || coin.decimals !== 6) {
    throw new Error(`Cardano: only ADA itself is sent here (6 decimals, lovelace), not ${coin.symbol}${coin.token ? ` (${coin.token})` : ''}`);
  }
}

/** The payment key: the derived seed as a plain ed25519 key. */
export function cardanoKey(keys: NativeKeys): CSL.PrivateKey {
  const seed = keys.ed25519('cardano');
  if (seed.length !== 32) throw new Error('Cardano: the derived seed must be 32 bytes');
  return CSL.PrivateKey.from_normal_bytes(seed);
}

/** The enterprise (no stake part) mainnet address of a key. */
export function cardanoEnterpriseAddress(sk: CSL.PrivateKey): CSL.Address {
  return CSL.EnterpriseAddress.new(1, CSL.Credential.from_keyhash(sk.to_public().hash())).to_address();
}

/** A Shelley MAINNET address (addr1...) or a throw. */
function shelleyAddress(a: string, what: string): CSL.Address {
  let addr: CSL.Address;
  try {
    if (typeof a !== 'string' || !a.startsWith('addr1')) throw new Error('prefix');
    addr = CSL.Address.from_bech32(a);
  } catch {
    throw new Error(`Cardano: ${what} ${String(a)} is not a Shelley mainnet address (addr1...)`);
  }
  if (addr.network_id() !== 1 || addr.is_malformed()) throw new Error(`Cardano: ${what} ${a} is not a mainnet address`);
  return addr;
}

/** A destination: a mainnet address whose payment part is a KEY (ADA sent without a datum to a Plutus script can be locked for good). */
function destinationAddress(a: string): CSL.Address {
  const addr = shelleyAddress(a, 'the destination');
  const cred = addr.payment_cred();
  if (!cred) throw new Error(`Cardano: the destination ${a} has no payment part (a reward address?)`);
  if (cred.has_script_hash()) {
    throw new Error(`Cardano: the destination ${a} is a SCRIPT address - ADA sent there without a datum can be locked for good; refused (a per-wallet deposit address is a key address)`);
  }
  return addr;
}

// --- build --------------------------------------------------------------------------------------------------------

const bn = (v: bigint): CSL.BigNum => CSL.BigNum.from_str(v.toString());

export function cardanoMinUtxo(address: CSL.Address, lovelace: bigint, pp: CardanoParams): bigint {
  const out = CSL.TransactionOutput.new(address, CSL.Value.new(bn(lovelace)));
  return BigInt(CSL.min_ada_for_output(out, CSL.DataCost.new_coins_per_byte(bn(pp.coinsPerUtxoByte))).to_str());
}

interface Out {
  address: CSL.Address;
  lovelace: bigint;
}

function buildBody(inputs: readonly CardanoUtxo[], outputs: readonly Out[], fee: bigint, ttl: bigint): CSL.TransactionBody {
  const ins = CSL.TransactionInputs.new();
  for (const u of inputs) ins.add(CSL.TransactionInput.new(CSL.TransactionHash.from_hex(u.txHash), u.index));
  const outs = CSL.TransactionOutputs.new();
  for (const o of outputs) outs.add(CSL.TransactionOutput.new(o.address, CSL.Value.new(bn(o.lovelace))));
  const body = CSL.TransactionBody.new_tx_body(ins, outs, bn(fee));
  body.set_ttl(bn(ttl));
  return body;
}

/** The body signed with `sk`: the transaction's bytes and its id (BLAKE2b-256 of the body bytes, as signed). */
function signBody(body: CSL.TransactionBody, sk: CSL.PrivateKey): { bytes: Uint8Array; txid: string } {
  const tx = CSL.FixedTransaction.new_from_body_bytes(body.to_bytes());
  tx.sign_and_add_vkey_signature(sk);
  const bytes = tx.to_bytes();
  const txid = bytesToHex(blake2b(tx.raw_body(), { dkLen: 32 }));
  if (tx.transaction_hash().to_hex() !== txid) throw new Error('Cardano: the library and BLAKE2b disagree on the transaction id');
  return { bytes, txid };
}

const feeOf = (size: number, pp: CardanoParams): bigint => pp.feePerByte * BigInt(size) + pp.feeFixed;

/**
 * The smallest fee that covers the signed size of the transaction `outputsFor(fee)` builds. Each try builds and
 * signs the real thing; a larger fee can only grow the encoding by a few bytes, so it settles in 2-3 tries.
 */
function settleFee(inputs: readonly CardanoUtxo[], outputsFor: (fee: bigint) => Out[] | null, ttl: bigint, sk: CSL.PrivateKey, pp: CardanoParams): { fee: bigint; outputs: Out[]; bytes: Uint8Array; txid: string } | null {
  let fee = feeOf(0, pp);
  for (let i = 0; i < 6; i++) {
    const outputs = outputsFor(fee);
    if (!outputs) return null;
    const signed = signBody(buildBody(inputs, outputs, fee, ttl), sk);
    const need = feeOf(signed.bytes.length, pp);
    if (need <= fee) return { fee, outputs, ...signed };
    fee = need;
  }
  throw new Error('Cardano: the fee did not settle');
}

export interface CardanoPlan {
  inputs: CardanoUtxo[];
  outputs: Out[];
  fee: bigint;
  ttl: bigint;
  bytes: Uint8Array;
  txid: string;
  /** What the receiver gets. */
  amount: bigint;
}

/**
 * The transfer: inputs, outputs, fee - signed with `sk`. `change`: the wallet's own address. Throws with a plain
 * reason when it cannot be built.
 */
export function planCardanoTransfer(o: { utxos: readonly CardanoUtxo[]; to: CSL.Address; change: CSL.Address; amount: bigint | 'max'; ttl: bigint; pp: CardanoParams; sk: CSL.PrivateKey }): CardanoPlan {
  const { to, change, amount, ttl, pp, sk } = o;
  const withTokens = o.utxos.filter((u) => u.tokens > 0);
  const withScript = o.utxos.filter((u) => u.refScript);
  let inputs: CardanoUtxo[];
  if (amount === 'max') {
    if (withTokens.length) throw new Error(`Cardano: ${withTokens.length} UTxO(s) of the test wallet carry native tokens - 'max' would have to send them too; refused (send a fixed amount: those UTxOs are then left alone)`);
    if (withScript.length) throw new Error(`Cardano: ${withScript.length} UTxO(s) of the test wallet carry a reference script - 'max' does not spend those; refused`);
    inputs = [...o.utxos];
  } else {
    if (amount <= 0n) throw new Error('Cardano: the amount must be more than 0 lovelace');
    inputs = o.utxos.filter((u) => u.tokens === 0 && !u.refScript);
  }
  if (!inputs.length) throw new Error('Cardano: the test wallet has no ADA-only UTxO to spend');
  const total = inputs.reduce((s, u) => s + u.lovelace, 0n);

  let r: ReturnType<typeof settleFee>;
  let sent: bigint;
  if (amount === 'max') {
    r = settleFee(inputs, (fee) => (total > fee ? [{ address: to, lovelace: total - fee }] : null), ttl, sk, pp);
    if (!r) throw new Error(`Cardano: nothing can leave: ${adaText(total)} does not cover the fee`);
    sent = total - r.fee;
    const min = cardanoMinUtxo(to, sent, pp);
    if (sent < min) throw new Error(`Cardano: everything that can leave (${adaText(sent)}) is below the min-UTxO of the output (${adaText(min)})`);
  } else {
    const min = cardanoMinUtxo(to, amount, pp);
    if (amount < min) throw new Error(`Cardano: ${adaText(amount)} is below the min-UTxO of the output (${adaText(min)}) - the network refuses a smaller output`);
    sent = amount;
    // With change back (when the change can be an output of its own).
    r = settleFee(inputs, (fee) => (total - amount - fee > 0n ? [{ address: to, lovelace: amount }, { address: change, lovelace: total - amount - fee }] : null), ttl, sk, pp);
    if (r && r.outputs[1]!.lovelace < cardanoMinUtxo(change, r.outputs[1]!.lovelace, pp)) r = null;
    if (!r) {
      // No change output: what is left over is added to the fee.
      const one = settleFee(inputs, () => [{ address: to, lovelace: amount }], ttl, sk, pp);
      if (!one || total - amount < one.fee) {
        throw new Error(`Cardano: too little ADA: ${adaText(amount)} + fee ${adaText(one?.fee ?? feeOf(0, pp))} > ${adaText(total)} (ADA-only UTxOs)`);
      }
      const fee = total - amount;
      const signed = signBody(buildBody(inputs, [{ address: to, lovelace: amount }], fee, ttl), sk);
      if (feeOf(signed.bytes.length, pp) > fee) throw new Error('Cardano: the fee does not cover the transaction');
      r = { fee, outputs: [{ address: to, lovelace: amount }], ...signed };
    }
  }
  if (r.bytes.length > pp.maxTxSize) throw new Error(`Cardano: the transaction would be ${r.bytes.length} bytes, more than the ${pp.maxTxSize} allowed (${inputs.length} inputs) - consolidate first`);
  return { inputs, outputs: r.outputs, fee: r.fee, ttl, bytes: r.bytes, txid: r.txid, amount: sent };
}

/** What the signed bytes say (for the read-back check and the tests). */
export interface CardanoTransferRead {
  txid: string;
  inputs: string[];
  outputs: Array<{ address: string; lovelace: bigint; plain: boolean }>;
  fee: bigint;
  ttl: bigint | null;
  /** Anything a plain transfer does not carry: certificates, withdrawals, mint, metadata, scripts, a validity start ... */
  extras: string[];
  /** The vkey witnesses: public key hex and whether its signature verifies over the txid. */
  witnesses: Array<{ vkey: string; valid: boolean }>;
  size: number;
}

export function readCardanoTransfer(bytes: Uint8Array): CardanoTransferRead {
  const ftx = CSL.FixedTransaction.from_bytes(bytes);
  const txid = bytesToHex(blake2b(ftx.raw_body(), { dkLen: 32 }));
  const body = ftx.body();
  const ins = body.inputs();
  const inputs: string[] = [];
  for (let i = 0; i < ins.len(); i++) inputs.push(`${ins.get(i).transaction_id().to_hex()}#${ins.get(i).index()}`);
  const outs = body.outputs();
  const outputs: CardanoTransferRead['outputs'] = [];
  for (let i = 0; i < outs.len(); i++) {
    const o = outs.get(i);
    outputs.push({ address: o.address().to_bech32(), lovelace: BigInt(o.amount().coin().to_str()), plain: !o.amount().multiasset() && !o.has_data_hash() && !o.has_plutus_data() && !o.has_script_ref() });
  }
  const extras: string[] = [];
  if (body.certs()) extras.push('certificates');
  if (body.withdrawals()) extras.push('withdrawals');
  if (body.mint()) extras.push('mint');
  if (body.auxiliary_data_hash() || ftx.auxiliary_data()) extras.push('metadata');
  if (body.validity_start_interval_bignum()) extras.push('validity start');
  if (body.collateral() || body.reference_inputs() || body.required_signers() || body.script_data_hash()) extras.push('script fields');
  if (body.voting_procedures() || body.voting_proposals() || body.donation() || body.current_treasury_value()) extras.push('governance');
  const ws = ftx.witness_set();
  if (ws.native_scripts() || ws.plutus_scripts() || ws.redeemers() || ws.plutus_data() || ws.bootstraps()) extras.push('other witnesses');
  if (!ftx.is_valid()) extras.push('is_valid = false');
  const witnesses: CardanoTransferRead['witnesses'] = [];
  const vk = ws.vkeys();
  const hash = CSL.TransactionHash.from_hex(txid);
  for (let i = 0; vk && i < vk.len(); i++) {
    const w = vk.get(i);
    const pub = w.vkey().public_key();
    witnesses.push({ vkey: bytesToHex(pub.as_bytes()), valid: pub.verify(hash.to_bytes(), w.signature()) });
  }
  const ttl = body.ttl_bignum();
  return { txid, inputs, outputs, fee: BigInt(body.fee().to_str()), ttl: ttl ? BigInt(ttl.to_str()) : null, extras, witnesses, size: bytes.length };
}

/** The exact body of the broadcast: Ogmios v6 submitTransaction through Koios (see the header). */
export const cardanoSubmitBody = (bytes: Uint8Array, txid: string): string =>
  JSON.stringify({ jsonrpc: '2.0', method: 'submitTransaction', params: { transaction: { cbor: bytesToHex(bytes) } }, id: txid });

// --- the chain ----------------------------------------------------------------------------------------------------

const OGMIOS_READ = (m: string) => m.startsWith('queryNetwork/') || m.startsWith('queryLedgerState/') || m === 'evaluateTransaction';

function isOgmiosWrite(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 0 || v.some(isOgmiosWrite);
  if (!v || typeof v !== 'object') return true;
  const m = (v as { method?: unknown }).method;
  return typeof m !== 'string' || !OGMIOS_READ(m);
}

export const cardano: NativeChain = {
  kind: 'cardano',
  label: 'Cardano',
  chainKey: 'ADA',
  origins: CARDANO_ORIGINS,

  isWrite(url, method, body) {
    const path = url.pathname.replace(/\/+$/, '');
    if (/\/submittx$/i.test(path)) return true;
    if (!/\/ogmios$/i.test(path)) return false;
    const m = method.toUpperCase();
    if (m === 'GET' || m === 'HEAD') return /submit/i.test(decodeURIComponent(url.search));
    if (body === null || body === '') return false;
    try {
      return isOgmiosWrite(JSON.parse(body));
    } catch {
      return true; // cannot tell: treat as a write
    }
  },

  address(keys) {
    return cardanoEnterpriseAddress(cardanoKey(keys)).to_bech32();
  },

  async balance(address, coin) {
    assertAda(coin);
    shelleyAddress(address, 'address');
    // Lovelace on every UTxO, the ones carrying tokens too (their tokens are not counted).
    return (await cardanoUtxos(address)).reduce((s, u) => s + u.lovelace, 0n);
  },

  /** The exact fee of the planned shape (every ADA-only UTxO in, the output + change out), + 10 %. Nothing must stay. */
  async costs(address, coin, to): Promise<SendCosts> {
    assertAda(coin);
    const own = shelleyAddress(address, 'address');
    let dest: CSL.Address;
    try {
      dest = shelleyAddress(to, 'the destination');
    } catch {
      dest = own;
    }
    const [pp, utxos] = await Promise.all([cardanoParams(), cardanoUtxos(address)]);
    const plain = utxos.filter((u) => u.tokens === 0 && !u.refScript);
    // The shape with a stand-in key (a signature is 64 bytes whatever the key) and stand-in inputs when there are none.
    const inputs = plain.length ? plain : [{ txHash: '00'.repeat(32), index: 0, lovelace: 0n, tokens: 0, refScript: false }];
    const sk = CSL.PrivateKey.from_normal_bytes(new Uint8Array(32).fill(7));
    const big64 = (1n << 63n) - 1n; // the widest CBOR encoding of an amount
    const r = settleFee(inputs, () => [{ address: dest, lovelace: big64 }, { address: own, lovelace: big64 }], 0xffffffffn, sk, pp);
    const fee = r!.fee + (r!.fee * COSTS_MARGIN_PCT + 99n) / 100n;
    return { fee, keep: 0n, nativeNeeded: 0n };
  },

  async prepare(keys, coin, to, amount): Promise<PreparedSend> {
    assertAda(coin);
    const dest = destinationAddress(to);
    const sk = cardanoKey(keys);
    const own = cardanoEnterpriseAddress(sk);
    const from = own.to_bech32();
    if (dest.to_bech32() === from) throw new Error('Cardano: the destination is the test wallet itself');
    const [pp, tip, utxos] = await Promise.all([cardanoParams(), cardanoTip(), cardanoUtxos(from)]);
    if (!utxos.length) throw new Error(`Cardano: the test wallet ${from} has no UTxO (balance 0)`);
    const ttl = tip + CARDANO_TTL_SLOTS;
    const plan = planCardanoTransfer({ utxos, to: dest, change: own, amount, ttl, pp, sk });

    // Read back what was signed: exactly the transfer asked for.
    const back = readCardanoTransfer(plan.bytes);
    const want = plan.outputs.map((o) => ({ address: o.address.to_bech32(), lovelace: o.lovelace }));
    const pubHex = bytesToHex(sk.to_public().as_bytes());
    const inSum = plan.inputs.reduce((s, u) => s + u.lovelace, 0n);
    const outSum = back.outputs.reduce((s, o) => s + o.lovelace, 0n);
    if (
      back.txid !== plan.txid || back.fee !== plan.fee || back.ttl !== ttl || back.extras.length > 0 ||
      back.inputs.length !== plan.inputs.length || !plan.inputs.every((u) => back.inputs.includes(`${u.txHash}#${u.index}`)) ||
      back.outputs.length !== want.length || !back.outputs.every((o, i) => o.plain && o.address === want[i]!.address && o.lovelace === want[i]!.lovelace) ||
      back.outputs[0]!.address !== to || back.outputs[0]!.lovelace !== plan.amount || inSum !== outSum + back.fee ||
      back.witnesses.length !== 1 || back.witnesses[0]!.vkey !== pubHex || !back.witnesses[0]!.valid ||
      feeOf(back.size, pp) > back.fee
    ) {
      throw new Error('Cardano: the signed transaction does not read back as the transfer asked for - not sent');
    }

    ttls.set(plan.txid, ttl);
    return {
      request: { url: KOIOS_OGMIOS, method: 'POST', headers: { ...HEADERS }, body: cardanoSubmitBody(plan.bytes, plan.txid) },
      txid: plan.txid,
      amount: plan.amount,
      fee: plan.fee,
      explorer: `${EXPLORER}${plan.txid}`,
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
      throw new Error(`Cardano: submitTransaction got no answer (${(e as Error).message}) - the transaction may still have reached the network; check ${p.txid}`);
    }
    const text = await res.text();
    let json: { result?: { transaction?: { id?: unknown } }; error?: unknown };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      throw new Error(`Cardano: submitTransaction HTTP ${res.status}, not JSON: ${text.slice(0, 300)}`);
    }
    if (json.error !== undefined && json.error !== null) {
      const e = json.error as { code?: unknown; message?: unknown; data?: unknown } | string;
      const words = typeof e === 'string' ? e : `${String(e.message ?? 'error')}${e.code !== undefined ? ` (code ${String(e.code)})` : ''}${e.data !== undefined ? `: ${JSON.stringify(e.data).slice(0, 400)}` : ''}`;
      throw new Error(`Cardano refused the transaction: ${words}`);
    }
    if (!res.ok) throw new Error(`Cardano: submitTransaction HTTP ${res.status}: ${text.slice(0, 300)}`);
    const id = json.result?.transaction?.id;
    if (typeof id !== 'string') throw new Error(`Cardano: submitTransaction gave no transaction id: ${text.slice(0, 300)}`);
    if (id.toLowerCase() !== p.txid.toLowerCase()) throw new Error(`Cardano: the node reports id ${id}, the signed transaction is ${p.txid}`);
    return p.txid;
  },

  async confirmed(txid) {
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error(`Cardano: ${txid} is not a transaction id`);
    const id = txid.toLowerCase();
    const rows = await koios('/tx_status', { method: 'POST', body: { _tx_hashes: [id] } }, `transaction ${id}`);
    const row = Array.isArray(rows) ? (rows as Array<{ tx_hash?: unknown; num_confirmations?: unknown }>).find((r) => r.tx_hash === id) : undefined;
    const n = row?.num_confirmations;
    if (typeof n === 'number' && n >= 1) return true;
    const ttl = ttls.get(id);
    if (ttl !== undefined && (await cardanoTip()) > ttl + EXPIRED_AFTER_SLOTS) return false;
    return null;
  },
};
