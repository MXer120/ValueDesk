/**
 * Bitcoin, Litecoin and Dogecoin (types.ts NativeChain): one UTXO implementation,
 * three configurations, all from the ONE secp256k1 test key (keys.ts).
 *
 *   Bitcoin   P2WPKH bc1q...   mempool.space (Esplora)            read fallback: blockstream.info (Esplora)
 *   Litecoin  P2WPKH ltc1q...  litecoinspace.org (Esplora)        read fallback: litecoin.atomicwallet.io (Blockbook)
 *   Dogecoin  P2PKH  D...      dogecoin.atomicwallet.io (Blockbook) read fallback: api.blockcypher.com
 *
 * A send spends EVERY UTXO of the address. 'max' pays everything minus the fee to `to`, no change;
 * a fixed amount pays `to` and returns the change to the same address when it is above the dust
 * limit, else the change goes to the fee. The fee is vsize x a per-chain rate in base units per
 * vbyte: the API's estimate, never below a floor, refused above a cap. vsize is an upper bound
 * (73-byte signatures; the signer grinds low-R, so the real ones are shorter): the rate actually
 * paid is never below the target.
 *
 * Dogecoin's legacy inputs are signed against the full previous transaction, whose hash must be the
 * input's txid - an API cannot make the runner pay a larger fee by lying about an amount. Segwit
 * inputs sign the amount itself (BIP143): a wrong amount only makes the signature invalid.
 * Only a chain's FIRST API broadcasts (one armed request per send); reads fall back to the next.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { Address, OutScript, Transaction, p2pkh, p2wpkh } from '@scure/btc-signer';
import { addressProblem } from '../../../src/trading/addresses';
import { NATIVE_CHAIN_KEY, NATIVE_DECIMALS, NATIVE_SYMBOL, type NativeChain, type NativeCoin, type NativeKeys, type NativeKind, type PreparedSend, type SendCosts } from './types';

type UtxoKind = Extract<NativeKind, 'bitcoin' | 'litecoin' | 'dogecoin'>;

/** btc-signer's BTC_NETWORK. An empty bech32 prefix = no segwit addresses (Dogecoin). */
interface Net {
  bech32: string;
  pubKeyHash: number;
  scriptHash: number;
  wif: number;
}

/** An unspent output of the test address, as an API reports it. */
export interface Utxo {
  txid: string;
  vout: number;
  value: bigint;
  confirmed: boolean;
}

/** Base units per vbyte (floats, as the APIs give them). */
interface FeeRates {
  normal: number;
  fast: number;
}

interface ReadApi {
  readonly name: string;
  readonly origin: string;
  /** Every unspent output, confirmed and unconfirmed. [] for an address the API has never seen. */
  utxos(address: string): Promise<Utxo[]>;
  /** The raw transaction, hex. */
  rawTx(txid: string): Promise<string>;
  /** true = in a block; null = in the mempool or not known (yet). Throws only when the API itself fails. */
  status(txid: string): Promise<true | null>;
  feeRates(): Promise<FeeRates>;
}

interface BroadcastApi extends ReadApi {
  broadcastRequest(rawHex: string): PreparedSend['request'];
  /** The txid in the node's answer; throws with the node's words when it refused. */
  broadcastAnswer(status: number, text: string): string;
}

const READ_TIMEOUT_MS = 20_000;
const BROADCAST_TIMEOUT_MS = 60_000;
const TXID = /^[0-9a-f]{64}$/;

// --- small helpers ----------------------------------------------------------------------------------

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const short = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 300 ? `${t.slice(0, 300)}...` : t;
};

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
function fromHex(h: string, what: string): Uint8Array {
  const s = h.trim();
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(s)) throw new Error(`${what}: not hex: ${short(s)}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** 8-decimal coin amount for messages: 123450000n -> "1.2345". */
function coins(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const frac = (a % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / 100_000_000n}${frac ? `.${frac}` : ''}`;
}

async function get(url: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { headers: { accept: 'application/json, text/plain' }, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  return { status: res.status, text: await res.text() };
}
async function getOk(url: string): Promise<string> {
  const r = await get(url);
  if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${url}: ${short(r.text)}`);
  return r.text;
}
function parseJson(text: string, url: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`not JSON from ${url}: ${short(text)}`);
  }
}
const getJson = async (url: string): Promise<unknown> => parseJson(await getOk(url), url);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function txidOf(v: unknown, where: string): string {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  if (!TXID.test(s)) throw new Error(`${where}: not a txid: ${JSON.stringify(v)}`);
  return s;
}
function voutOf(v: unknown, where: string): number {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff) return v;
  throw new Error(`${where}: not an output index: ${JSON.stringify(v)}`);
}
/** Base units from a JSON number (only while exact) or a digit string. */
function unitsOf(v: unknown, where: string): bigint {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new Error(`${where}: not an amount in base units: ${JSON.stringify(v)}`);
}
function positiveRate(v: unknown, where: string): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw new Error(`${where}: no usable fee rate: ${JSON.stringify(v)}`);
  return n;
}
/** A coin-per-kB decimal (Blockbook "0.00001", BlockCypher base units per kB) -> base units per vbyte. */
const perKbCoinToPerVbyte = (coinPerKb: number): number => (coinPerKb * 1e8) / 1000;

// --- the APIs ---------------------------------------------------------------------------------------

/** Esplora (mempool.space, litecoinspace.org, blockstream.info). `base` ends in /api. */
function esplora(name: string, base: string): BroadcastApi {
  return {
    name,
    origin: new URL(base).origin,
    async utxos(address) {
      const url = `${base}/address/${address}/utxo`;
      const list = await getJson(url);
      if (!Array.isArray(list)) throw new Error(`${name}: unexpected UTXO answer: ${short(JSON.stringify(list))}`);
      return list.map((u) => {
        const o = rec(u);
        return { txid: txidOf(o.txid, name), vout: voutOf(o.vout, name), value: unitsOf(o.value, name), confirmed: rec(o.status).confirmed === true };
      });
    },
    async rawTx(txid) {
      return (await getOk(`${base}/tx/${txid}/hex`)).trim();
    },
    async status(txid) {
      const url = `${base}/tx/${txid}/status`;
      const r = await get(url);
      if (r.status === 404) return null;
      if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${url}: ${short(r.text)}`);
      // An unknown txid answers {"confirmed":false} as well: either way, not final yet.
      const confirmed = rec(parseJson(r.text, url)).confirmed;
      if (typeof confirmed !== 'boolean') throw new Error(`${name}: unexpected status answer: ${short(r.text)}`);
      return confirmed ? true : null;
    },
    async feeRates() {
      // mempool.space's own recommendation; else Esplora's per-target table (blockstream.info).
      const r = await get(`${base}/v1/fees/recommended`);
      if (r.status === 200) {
        const f = rec(parseJson(r.text, `${base}/v1/fees/recommended`));
        const normal = positiveRate(f.halfHourFee, name);
        return { normal, fast: Math.max(normal, positiveRate(f.fastestFee, name)) };
      }
      const t = rec(await getJson(`${base}/fee-estimates`));
      const normal = positiveRate(t['3'] ?? t['2'], name);
      return { normal, fast: Math.max(normal, positiveRate(t['1'] ?? t['2'] ?? t['3'], name)) };
    },
    broadcastRequest(rawHex) {
      return { url: `${base}/tx`, method: 'POST', headers: { 'content-type': 'text/plain' }, body: rawHex };
    },
    broadcastAnswer(status, text) {
      const t = text.trim().toLowerCase();
      if (status === 200 && TXID.test(t)) return t;
      throw new Error(`${name} refused the transaction (HTTP ${status}): ${short(text) || '(no text)'}`);
    },
  };
}

/** Blockbook (Trezor's indexer) API v2. `base` = the origin. */
function blockbook(name: string, base: string): BroadcastApi {
  const errorOf = (body: unknown): string | null => {
    const e = rec(body).error;
    if (typeof e === 'string') return e;
    const m = rec(e).message;
    return typeof m === 'string' ? m : null;
  };
  return {
    name,
    origin: new URL(base).origin,
    async utxos(address) {
      const url = `${base}/api/v2/utxo/${address}`;
      const list = await getJson(url);
      if (!Array.isArray(list)) throw new Error(`${name}: unexpected UTXO answer: ${short(JSON.stringify(list))}`);
      return list.map((u) => {
        const o = rec(u);
        return { txid: txidOf(o.txid, name), vout: voutOf(o.vout, name), value: unitsOf(o.value, name), confirmed: typeof o.confirmations === 'number' && o.confirmations > 0 };
      });
    },
    async rawTx(txid) {
      const h = rec(await getJson(`${base}/api/v2/tx/${txid}`)).hex;
      if (typeof h !== 'string') throw new Error(`${name}: no raw hex for ${txid}`);
      return h;
    },
    async status(txid) {
      const url = `${base}/api/v2/tx/${txid}`;
      const r = await get(url);
      if (r.status !== 200) {
        // {"error":"Transaction '...' not found"} (HTTP 400)
        if (/not found/i.test(r.text)) return null;
        throw new Error(`HTTP ${r.status} from ${url}: ${short(r.text)}`);
      }
      const c = rec(parseJson(r.text, url)).confirmations;
      if (c !== undefined && typeof c !== 'number') throw new Error(`${name}: unexpected tx answer: ${short(r.text)}`);
      return typeof c === 'number' && c > 0 ? true : null;
    },
    async feeRates() {
      // {"result":"0.00000998"}: coins per kB for confirmation within 2 blocks.
      const rate = perKbCoinToPerVbyte(positiveRate(rec(await getJson(`${base}/api/v2/estimatefee/2`)).result, name));
      return { normal: rate, fast: rate };
    },
    broadcastRequest(rawHex) {
      return { url: `${base}/api/v2/sendtx/`, method: 'POST', headers: { 'content-type': 'text/plain' }, body: rawHex };
    },
    broadcastAnswer(status, text) {
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* not JSON: the words go into the error below */
      }
      const result = rec(body).result;
      if (status === 200 && typeof result === 'string' && TXID.test(result.toLowerCase())) return result.toLowerCase();
      throw new Error(`${name} refused the transaction (HTTP ${status}): ${short(errorOf(body) ?? text) || '(no text)'}`);
    },
  };
}

/** BlockCypher (reads only - its push wants JSON, not the raw hex). `base` e.g. https://api.blockcypher.com/v1/doge/main. */
function blockcypher(name: string, base: string): ReadApi {
  return {
    name,
    origin: new URL(base).origin,
    async utxos(address) {
      const a = rec(await getJson(`${base}/addrs/${address}?unspentOnly=true&includeScript=true&limit=2000`));
      if (a.hasMore === true) throw new Error(`${name}: more UTXOs than one page - cannot see them all`);
      const refs = [...(Array.isArray(a.txrefs) ? a.txrefs : []), ...(Array.isArray(a.unconfirmed_txrefs) ? a.unconfirmed_txrefs : [])].map(rec);
      return refs
        .filter((o) => typeof o.tx_output_n === 'number' && o.tx_output_n >= 0 && o.spent !== true)
        .map((o) => ({ txid: txidOf(o.tx_hash, name), vout: voutOf(o.tx_output_n, name), value: unitsOf(o.value, name), confirmed: typeof o.confirmations === 'number' && o.confirmations > 0 }));
    },
    async rawTx(txid) {
      const h = rec(await getJson(`${base}/txs/${txid}?includeHex=true`)).hex;
      if (typeof h !== 'string') throw new Error(`${name}: no raw hex for ${txid}`);
      return h;
    },
    async status(txid) {
      const url = `${base}/txs/${txid}`;
      const r = await get(url);
      if (r.status === 404) return null;
      if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${url}: ${short(r.text)}`);
      const c = rec(parseJson(r.text, url)).confirmations;
      return typeof c === 'number' && c > 0 ? true : null;
    },
    async feeRates() {
      const c = rec(await getJson(base));
      const normal = positiveRate(c.medium_fee_per_kb, name) / 1000;
      return { normal, fast: Math.max(normal, positiveRate(c.high_fee_per_kb, name) / 1000) };
    },
  };
}

// --- the chains -------------------------------------------------------------------------------------

interface Config {
  kind: UtxoKind;
  label: string;
  net: Net;
  /** The test wallet's own script type (its inputs and its change). */
  input: 'wpkh' | 'pkh';
  txVersion: number;
  /** Outputs below this are refused (`to`) or go to the fee (change). Base units. */
  dust: bigint;
  /** Fee rate, base units per vbyte: never below `floor`; above `cap` nothing is built. */
  feeFloor: number;
  feeCap: number;
  /** When no API gives an estimate, is the floor alone safe to pay? (Not for Bitcoin: its fees swing.) */
  floorIsSafe: boolean;
  broadcaster: BroadcastApi;
  /** Read APIs in order of preference; the broadcaster first. */
  apis: readonly ReadApi[];
  explorer: string;
}

const BTC_NET: Net = { bech32: 'bc', pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 };
const LTC_NET: Net = { bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };
const DOGE_NET: Net = { bech32: '', pubKeyHash: 0x1e, scriptHash: 0x16, wif: 0x9e };

const MEMPOOL = esplora('mempool.space', 'https://mempool.space/api');
const BLOCKSTREAM = esplora('blockstream.info', 'https://blockstream.info/api');
const LITECOINSPACE = esplora('litecoinspace.org', 'https://litecoinspace.org/api');
const LTC_BLOCKBOOK = blockbook('litecoin.atomicwallet.io', 'https://litecoin.atomicwallet.io');
const DOGE_BLOCKBOOK = blockbook('dogecoin.atomicwallet.io', 'https://dogecoin.atomicwallet.io');
const DOGE_BLOCKCYPHER = blockcypher('api.blockcypher.com', 'https://api.blockcypher.com/v1/doge/main');

const BTC: Config = {
  kind: 'bitcoin', label: 'Bitcoin', net: BTC_NET, input: 'wpkh', txVersion: 2,
  // 546 sat: the largest standard dust threshold (a P2PKH output); P2WPKH's is 294.
  dust: 546n,
  // mempool.space's halfHourFee, at least 2 sat/vB; above 300 sat/vB the network is in a fee storm - wait.
  feeFloor: 2, feeCap: 300, floorIsSafe: false,
  broadcaster: MEMPOOL, apis: [MEMPOOL, BLOCKSTREAM],
  explorer: 'https://mempool.space/tx/',
};

const LTC: Config = {
  kind: 'litecoin', label: 'Litecoin', net: LTC_NET, input: 'wpkh', txVersion: 2,
  // 10x Bitcoin's 546: on the safe side of every Litecoin Core dust rule (0.0000546 LTC).
  dust: 5_460n,
  // The network clears at 1 lit/vB; 10 lit/vB (~0.000011 LTC for a 1-in-1-out send) is far above any relay minimum.
  feeFloor: 10, feeCap: 1_000, floorIsSafe: true,
  broadcaster: LITECOINSPACE, apis: [LITECOINSPACE, LTC_BLOCKBOOK],
  explorer: 'https://litecoinspace.org/tx/',
};

const DOGE: Config = {
  kind: 'dogecoin', label: 'Dogecoin', net: DOGE_NET, input: 'pkh', txVersion: 1,
  // Dogecoin Core's dust limit: 0.01 DOGE.
  dust: 1_000_000n,
  // 1 DOGE per kB (100,000 koinu/byte, ~0.2 DOGE a send): 100x Dogecoin Core's 0.01 DOGE/kB wallet minimum,
  // at or above what pre-1.14.4 nodes demand for relay, and about twice what the network pays now (~0.5 DOGE/kB).
  feeFloor: 100_000, feeCap: 1_000_000, floorIsSafe: true,
  broadcaster: DOGE_BLOCKBOOK, apis: [DOGE_BLOCKBOOK, DOGE_BLOCKCYPHER],
  explorer: 'https://blockchair.com/dogecoin/transaction/',
};

/** Ask the APIs in order; the first that answers wins. Throws with every API's words when none does. */
async function firstAnswer<T>(cfg: Config, what: string, fn: (api: ReadApi) => Promise<T>): Promise<T> {
  const errors: string[] = [];
  for (const api of cfg.apis) {
    try {
      return await fn(api);
    } catch (e) {
      errors.push(`${api.name}: ${errText(e)}`);
    }
  }
  throw new Error(`${cfg.label}: no API could tell ${what} (${errors.join(' | ')})`);
}

function checkCoin(cfg: Config, coin: NativeCoin): void {
  const symbol = NATIVE_SYMBOL[cfg.kind];
  const decimals = NATIVE_DECIMALS[cfg.kind];
  if (!coin.native || coin.token !== null || coin.symbol.toUpperCase() !== symbol || coin.decimals !== decimals) {
    throw new Error(`${cfg.label} moves only its own coin ${symbol} (${decimals} decimals), not ${coin.symbol}${coin.native ? '' : ' (a token)'} with ${coin.decimals} decimals`);
  }
}

function ownScript(cfg: Config, keys: NativeKeys): { address: string; script: Uint8Array } {
  const pub = secp256k1.getPublicKey(keys.secp256k1, true);
  const pay = cfg.input === 'wpkh' ? p2wpkh(pub, cfg.net) : p2pkh(pub, cfg.net);
  if (!pay.address) throw new Error(`${cfg.label}: no address for the test key`);
  return { address: pay.address, script: pay.script };
}

/** Types a deposit can go to. (Not BIP433 pay-to-anchor bc1pfeessrawgf: anyone can spend that.) */
const SPENDABLE = new Set(['pkh', 'sh', 'wpkh', 'wsh', 'tr']);

/** The output script paying `to`; throws when `to` is not a standard address of this chain. */
function receiverScript(cfg: Config, to: string): Uint8Array {
  const a = to.trim();
  const problem = addressProblem(cfg.kind, a);
  if (problem) throw new Error(`"${to}" is not a ${cfg.label} address (${problem})`);
  const addr = cfg.net.bech32 && a.toLowerCase().startsWith(`${cfg.net.bech32}1`) ? a.toLowerCase() : a;
  let decoded: ReturnType<ReturnType<typeof Address>['decode']>;
  try {
    decoded = Address(cfg.net).decode(addr);
  } catch (e) {
    // Litecoin's old P2SH addresses (3..., Bitcoin's version byte), which the app accepts too.
    if (cfg.kind === 'litecoin' && addr.startsWith('3')) decoded = Address({ ...cfg.net, scriptHash: 0x05 }).decode(addr);
    else throw new Error(`"${to}" is not a ${cfg.label} address (${errText(e)})`);
  }
  const allowed = cfg.kind === 'dogecoin' ? decoded.type === 'pkh' || decoded.type === 'sh' : SPENDABLE.has(decoded.type);
  if (!allowed) throw new Error(`"${to}" is a ${decoded.type} address, not one the runner sends ${NATIVE_SYMBOL[cfg.kind]} to`);
  return OutScript.encode(decoded);
}

const varintLen = (n: number): number => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5);

/**
 * The transaction's vsize, an upper bound: a signature is at most 73 bytes with its sighash byte.
 *   P2PKH input   32 txid + 4 vout + 1 + (1+73 sig, 1+33 key) + 4 sequence = 149 bytes
 *   P2WPKH input  41 bytes + witness (1 count, 1+73 sig, 1+33 key = 109 weight units); marker+flag 2 WU
 */
export function estimateVsize(input: 'wpkh' | 'pkh', inputs: number, outScripts: readonly Uint8Array[]): number {
  const outBytes = outScripts.reduce((s, sc) => s + 8 + varintLen(sc.length) + sc.length, 0);
  const base = 4 + varintLen(inputs) + varintLen(outScripts.length) + outBytes + 4;
  if (input === 'pkh') return base + inputs * 149;
  return Math.ceil((4 * (base + inputs * 41) + 2 + inputs * 109) / 4);
}

async function feeRate(cfg: Config, which: keyof FeeRates): Promise<bigint> {
  let estimate = 0;
  try {
    estimate = (await firstAnswer(cfg, 'the fee rate', (api) => api.feeRates()))[which];
  } catch (e) {
    if (!cfg.floorIsSafe) throw e;
  }
  const rate = Math.ceil(Math.max(cfg.feeFloor, estimate));
  if (rate > cfg.feeCap) {
    throw new Error(`${cfg.label}'s fee rate is ${rate} base units/vbyte now, above the runner's cap of ${cfg.feeCap} - not sending at that price`);
  }
  return BigInt(rate);
}

async function loadUtxos(cfg: Config, address: string): Promise<Utxo[]> {
  const list = await firstAnswer(cfg, `the coins at ${address}`, (api) => api.utxos(address));
  const seen = new Set<string>();
  for (const u of list) {
    const k = `${u.txid}:${u.vout}`;
    if (seen.has(k)) throw new Error(`${cfg.label}: the API listed ${k} twice`);
    seen.add(k);
  }
  return list;
}

/** The previous transaction of a legacy input, checked: it hashes to the txid and pays `script` exactly `u.value`. */
function checkedPrevTx(cfg: Config, rawHex: string, u: Utxo, script: Uint8Array): Uint8Array {
  const raw = fromHex(rawHex, `${cfg.label} transaction ${u.txid}`);
  const tx = Transaction.fromRaw(raw, { allowUnknownOutputs: true, allowUnknownInputs: true, allowUnknownVersion: true, disableScriptCheck: true });
  if (tx.id !== u.txid) throw new Error(`${cfg.label}: the transaction served for ${u.txid} hashes to ${tx.id}`);
  if (u.vout >= tx.outputsLength) throw new Error(`${cfg.label}: ${u.txid} has no output ${u.vout}`);
  const out = tx.getOutput(u.vout);
  if (!out.script || !sameBytes(out.script, script)) throw new Error(`${cfg.label}: ${u.txid}:${u.vout} does not pay the test wallet`);
  if (out.amount !== u.value) throw new Error(`${cfg.label}: ${u.txid}:${u.vout} holds ${out.amount}, the API said ${u.value}`);
  return raw;
}

async function prepare(cfg: Config, keys: NativeKeys, coin: NativeCoin, to: string, amount: bigint | 'max'): Promise<PreparedSend> {
  checkCoin(cfg, coin);
  if (amount !== 'max' && (typeof amount !== 'bigint' || amount <= 0n)) throw new Error(`${cfg.label}: the amount must be a positive bigint or 'max', not ${String(amount)}`);
  const own = ownScript(cfg, keys);
  const toScript = receiverScript(cfg, to);
  const [utxos, rate] = await Promise.all([loadUtxos(cfg, own.address), feeRate(cfg, 'normal')]);
  const sym = NATIVE_SYMBOL[cfg.kind];
  if (!utxos.length) throw new Error(`${cfg.label}: ${own.address} holds no ${sym} to send`);
  const total = utxos.reduce((s, u) => s + u.value, 0n);
  const feeFor = (scripts: Uint8Array[]): bigint => BigInt(estimateVsize(cfg.input, utxos.length, scripts)) * rate;

  let send: bigint;
  let fee: bigint;
  const outputs: Array<{ script: Uint8Array; amount: bigint }> = [];
  if (amount === 'max') {
    fee = feeFor([toScript]);
    send = total - fee;
    if (send < cfg.dust) throw new Error(`${cfg.label}: ${coins(total)} ${sym} minus the ${coins(fee)} ${sym} fee leaves ${coins(send)} ${sym}, below the dust limit of ${coins(cfg.dust)} ${sym}`);
    outputs.push({ script: toScript, amount: send });
  } else {
    send = amount;
    if (send < cfg.dust) throw new Error(`${cfg.label}: ${coins(send)} ${sym} is below the dust limit of ${coins(cfg.dust)} ${sym}`);
    const feeWithChange = feeFor([toScript, own.script]);
    const change = total - send - feeWithChange;
    outputs.push({ script: toScript, amount: send });
    if (change > cfg.dust) {
      fee = feeWithChange;
      outputs.push({ script: own.script, amount: change });
    } else {
      const feeAlone = feeFor([toScript]);
      if (total - send < feeAlone) throw new Error(`${cfg.label}: ${own.address} holds ${coins(total)} ${sym}, too little for ${coins(send)} ${sym} plus the ${coins(feeAlone)} ${sym} fee`);
      fee = total - send; // the change would be dust: it goes to the fee
    }
  }
  if (fee > send) throw new Error(`${cfg.label}: the fee (${coins(fee)} ${sym}) would be more than the ${coins(send)} ${sym} sent - not building that`);

  const prev: Uint8Array[] = [];
  if (cfg.input === 'pkh') {
    for (const u of utxos) prev.push(await firstAnswer(cfg, `transaction ${u.txid}`, async (api) => checkedPrevTx(cfg, await api.rawTx(u.txid), u, own.script)));
  }
  const tx = new Transaction({ version: cfg.txVersion, lowR: true, strictPrevoutValidation: cfg.input === 'pkh' });
  utxos.forEach((u, i) =>
    tx.addInput(
      cfg.input === 'wpkh'
        ? { txid: u.txid, index: u.vout, witnessUtxo: { script: own.script, amount: u.value } }
        : { txid: u.txid, index: u.vout, nonWitnessUtxo: prev[i]! },
    ),
  );
  for (const o of outputs) tx.addOutput(o);
  for (let i = 0; i < tx.inputsLength; i++) {
    if (!tx.signIdx(keys.secp256k1, i)) throw new Error(`${cfg.label}: input ${i} could not be signed with the test key`);
  }
  tx.finalize();
  const raw = tx.extract();
  // What was built is what was planned.
  if (tx.fee !== fee) throw new Error(`${cfg.label}: built a fee of ${tx.fee}, planned ${fee}`);
  if (BigInt(tx.vsize) * rate > fee) throw new Error(`${cfg.label}: ${tx.vsize} vbytes at ${rate}/vbyte is more than the ${fee} fee`);
  const txid = tx.id;
  return { request: cfg.broadcaster.broadcastRequest(toHex(raw)), txid, amount: send, fee, explorer: `${cfg.explorer}${txid}` };
}

/**
 * Broadcast endpoints on any origin of these APIs: Blockbook /api/v2/sendtx/<hex> (also a GET),
 * BlockCypher /txs/push, Blockchair /push/transaction, Bitcore /tx/send.
 */
const BROADCAST_PATH = /\/(?:sendtx|pushtx|push)(?:\/|$)|\/tx\/send(?:\/|$)/i;

function utxoChain(cfg: Config): NativeChain {
  return {
    kind: cfg.kind,
    label: cfg.label,
    chainKey: NATIVE_CHAIN_KEY[cfg.kind],
    origins: [...new Set(cfg.apis.map((a) => a.origin))],
    // The only POST the module makes is the broadcast; any other write-shaped request counts as one
    // too, so the guard never lets a send out as a "read".
    isWrite(url, method) {
      const m = method.toUpperCase();
      return (m !== 'GET' && m !== 'HEAD') || BROADCAST_PATH.test(url.pathname);
    },
    address: (keys) => ownScript(cfg, keys).address,
    async balance(address, coin) {
      checkCoin(cfg, coin);
      const problem = addressProblem(cfg.kind, address);
      if (problem) throw new Error(`"${address}" is not a ${cfg.label} address (${problem})`);
      return (await loadUtxos(cfg, address.trim())).reduce((s, u) => s + u.value, 0n);
    },
    async costs(address, coin, to): Promise<SendCosts> {
      checkCoin(cfg, coin);
      const toScript = receiverScript(cfg, to);
      const changeScript = receiverScript(cfg, address);
      const [utxos, rate] = await Promise.all([loadUtxos(cfg, address.trim()), feeRate(cfg, 'fast')]);
      // On the high side: every UTXO in, a change output, the fast rate.
      const fee = BigInt(estimateVsize(cfg.input, Math.max(utxos.length, 1), [toScript, changeScript])) * rate;
      return { fee, keep: 0n, nativeNeeded: 0n };
    },
    prepare: (keys, coin, to, amount) => prepare(cfg, keys, coin, to, amount),
    async broadcast(p) {
      const { url, method, headers, body } = p.request;
      if (new URL(url).origin !== cfg.broadcaster.origin) throw new Error(`${cfg.label}: ${url} is not where ${cfg.label} transactions are broadcast`);
      let res: Response;
      try {
        res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS) });
      } catch (e) {
        throw new Error(`${cfg.label}: no answer from ${cfg.broadcaster.name} (${errText(e)}) - the transaction may still have gone out: ${p.explorer}`);
      }
      const txid = cfg.broadcaster.broadcastAnswer(res.status, await res.text());
      if (txid !== p.txid) throw new Error(`${cfg.label}: ${cfg.broadcaster.name} answered txid ${txid}, the signed transaction is ${p.txid}`);
      return txid;
    },
    async confirmed(txid) {
      const id = txidOf(txid, `${cfg.label} confirmed()`);
      // UTXO chains have no "failed": a transaction is in a block, or not (yet). Only an API failure throws.
      return firstAnswer(cfg, `the status of ${id}`, (api) => api.status(id));
    },
  };
}

export const bitcoin: NativeChain = utxoChain(BTC);
export const litecoin: NativeChain = utxoChain(LTC);
export const dogecoin: NativeChain = utxoChain(DOGE);
