/**
 * The non-EVM chains the runner signs on (native/types.ts), simulated: the test
 * wallet's address there is fixed (each valid for its format), its balance is
 * what the simulated SoDEX paid out to it (world.offchain) less what it sent,
 * and a transfer back reaches the simulated SoDEX through `https://<kind>.chain.test`
 * - so the runner's network guard sees the same broadcast it would see live.
 */
import { NATIVE_CHAIN_KEY, NATIVE_SYMBOL, type NativeChain, type NativeKind } from '../native/types';

/** The test wallet's address on each chain in the simulation (derived from a throwaway key - valid for the app's own checks). */
export const FAKE_NATIVE_ADDRESS: Readonly<Record<NativeKind, string>> = {
  bitcoin: 'bc1qe0ew2s3d3x8k5j5vcvlxy46dz8wp2v0mcxy60r',
  litecoin: 'ltc1qe0ew2s3d3x8k5j5vcvlxy46dz8wp2v0mu677hn',
  dogecoin: 'DPjUgst6XFhL2ucLi9bUZ8kLcbVb7tSmmv',
  xrp: 'rKbP9cATDqosVuRjyZbvr42jjTmH8ZcPjf',
  stellar: 'GA6RPJSRHG5PVSXE2G7Q4XEUZGKHJWNGC4OLNZEGE6QZOAJHC75ORQ3D',
  solana: 'Ejf6Xf3mc1mAU8PfXToLDUFSJAbixbA79YCKPoauZztg',
  sui: '0xfdedca2ea9e0c5356b1732153897ad6f4ec414be8817940825f6f72551029c4e',
  cardano: 'addr1v9q24g8zlzhcswmngulx5ycqv35qgkyvje26zvmpuara5es7kzhdw',
};
/** A transfer's network fee, native base units. */
export const FAKE_NATIVE_FEE: Readonly<Record<NativeKind, bigint>> = { bitcoin: 300n, litecoin: 1_000n, dogecoin: 1_000_000n, xrp: 12n, stellar: 100n, solana: 5_000n, sui: 2_000_000n, cardano: 200_000n };
/** What must stay at an account (the XRP Ledger's and Stellar's reserves). */
export const FAKE_NATIVE_KEEP: Readonly<Partial<Record<NativeKind, bigint>>> = { xrp: 1_000_000n, stellar: 10_000_000n };
/** A Solana token transfer also pays the receiving token account's rent. */
const TOKEN_ACCOUNT_RENT = 2_039_280n;

const kinds = Object.keys(NATIVE_CHAIN_KEY) as NativeKind[];
let n = 0;

function fake(kind: NativeKind): NativeChain {
  const origin = `https://${kind}.chain.test`;
  const from = FAKE_NATIVE_ADDRESS[kind];
  const balance = async (address: string, coin: { symbol: string }): Promise<bigint> => {
    const r = await fetch(`${origin}/balance?address=${encodeURIComponent(address)}&coin=${encodeURIComponent(coin.symbol)}`);
    return BigInt(((await r.json()) as { balance: string }).balance);
  };
  return {
    kind,
    label: `${kind} (simulated)`,
    chainKey: NATIVE_CHAIN_KEY[kind],
    origins: [origin],
    isWrite: (u, m) => m === 'POST' && u.pathname === '/broadcast',
    address: () => from,
    balance,
    costs: async (_a, coin) => ({ fee: FAKE_NATIVE_FEE[kind], keep: coin.native ? FAKE_NATIVE_KEEP[kind] ?? 0n : 0n, nativeNeeded: coin.native ? 0n : FAKE_NATIVE_FEE[kind] + TOKEN_ACCOUNT_RENT }),
    async prepare(_keys, coin, to, amount) {
      const bal = await balance(from, coin);
      const fee = FAKE_NATIVE_FEE[kind];
      const keep = coin.native ? FAKE_NATIVE_KEEP[kind] ?? 0n : 0n;
      const amt = amount === 'max' ? (coin.native ? bal - fee - keep : bal) : amount;
      if (amt <= 0n || amt + (coin.native ? fee + keep : 0n) > bal) throw new Error(`${from} holds ${bal} of ${coin.symbol}: not enough to send ${amt} and its fee`);
      const txid = `sim-${kind}-${++n}`;
      const body = JSON.stringify({ chain: NATIVE_CHAIN_KEY[kind], coin: coin.symbol, native: NATIVE_SYMBOL[kind], from, to, amount: String(amt), nativeFee: String(fee + (coin.native ? 0n : TOKEN_ACCOUNT_RENT)), txid });
      return { request: { url: `${origin}/broadcast`, method: 'POST', headers: { 'content-type': 'application/json' }, body }, txid, amount: amt, fee, explorer: `${origin}/tx/${txid}` };
    },
    async broadcast(p) {
      const r = await fetch(p.request.url, { method: p.request.method, headers: p.request.headers, body: p.request.body });
      const t = await r.text();
      if (!r.ok) throw new Error(`the simulated node refused it: ${t}`);
      return (JSON.parse(t) as { txid: string }).txid;
    },
    async confirmed(txid) {
      const r = await fetch(`${origin}/tx/${encodeURIComponent(txid)}`);
      return r.ok ? ((await r.json()) as { confirmed: boolean }).confirmed : null;
    },
  };
}

export const fakeNativeChains = (): NativeChain[] => kinds.map(fake);
