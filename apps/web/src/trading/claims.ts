/**
 * Claiming a Wealth result in the app (owner 2026-11-28: "EVERYTHING should be fully doable on valuedesk"). Most results
 * arrive by themselves; one that did not shows `claimable` (or a settled delayed leg) in the fund ledger. The claim needs
 * the on-chain request id, which the API does not give (and says not to take from entryId), so it is read from the
 * request's own receipt (the ledger's txHash), from the event that created it. Event layouts checked on real receipts,
 * 2026-11-28 (UNITREE batch deposit 0xa9e7..., batch redeem 0xa0ff..., RFQ buy 0xb49a..., RFQ sell 0xa415...):
 *
 *   vault  RequestedDeposit / RequestedRedeem(address caller, address owner, address receiver, uint256 requestId, ...)
 *          no indexed fields: the id is the 4th data word.     claimDeposit / claimRedeem / claimDelayedRedeem(receiver, id)
 *   RFQ    BuySubmitted / SellSubmitted(address indexed vault, address indexed owner, uint256 indexed orderId, ...)
 *          the id is the 3rd indexed topic.                    claimBuy / claimSell / claimDelayedBuy / claimDelayedSell(vault, id)
 *
 * Which claim: each candidate is simulated first (eth_call from the wallet); the first that would succeed is sent.
 */
import { WalletError, type Eip1193Provider } from '../wallet';
import { VALUECHAIN_RPC, rpcCall } from './rpc';
import { promptCounter, type StepSink } from './funds';
import { addrWord, ensureChain, readFund, send, uintWord, type WealthEntry } from './wealth';

export const CLAIM_TOPIC = {
  requestedDeposit: '0xaa5d2db5e98599dfc943f98a4c5bdf1904a4614b36a895671be27327ca5f1723',
  requestedRedeem: '0xa0f951d15335a94c8158ed3d7bf3dc5a4861d24eea3738d4058cf516d2fb0a3b',
  buySubmitted: '0xd3def918b76a349e6d1dcfc489bb3c66608eaad553abd14b5bd6f6209172cf77',
  sellSubmitted: '0x53fd92e0e9075a7bcb4d41b73265955d24bbb1772433148595cb482ec3d9000a',
} as const;

export const CLAIM_SELECTOR = {
  claimDeposit: '0xa1bfe1ba',
  claimRedeem: '0x95ab1924',
  claimDelayedRedeem: '0xccc5f7aa',
  claimBuy: '0x13e2d734',
  claimSell: '0xc42f1ead',
  claimDelayedBuy: '0xad1b7a0e',
  claimDelayedSell: '0xede39a91',
} as const;

type Log = { address: string; topics: string[]; data: string };
export interface ClaimRef { kind: 'vault' | 'rfq'; side: 'buy' | 'sell'; contract: string; id: bigint }

/** The request a receipt created: a vault's RequestedDeposit/Redeem or an RFQ contract's Buy/SellSubmitted. */
export function requestOfLogs(logs: readonly Log[], vault: string): ClaimRef | null {
  for (const l of logs) {
    const t0 = l.topics[0]?.toLowerCase();
    if (l.address.toLowerCase() === vault.toLowerCase() && (t0 === CLAIM_TOPIC.requestedDeposit || t0 === CLAIM_TOPIC.requestedRedeem)) {
      const d = l.data.startsWith('0x') ? l.data.slice(2) : l.data;
      if (d.length < 64 * 4) continue;
      return { kind: 'vault', side: t0 === CLAIM_TOPIC.requestedDeposit ? 'buy' : 'sell', contract: l.address, id: BigInt(`0x${d.slice(64 * 3, 64 * 4)}`) };
    }
    if ((t0 === CLAIM_TOPIC.buySubmitted || t0 === CLAIM_TOPIC.sellSubmitted) && l.topics.length >= 4 && l.topics[1]?.toLowerCase().endsWith(vault.slice(2).toLowerCase())) {
      return { kind: 'rfq', side: t0 === CLAIM_TOPIC.buySubmitted ? 'buy' : 'sell', contract: l.address, id: BigInt(l.topics[3]!) };
    }
  }
  return null;
}

/** The claims that could apply, most likely first: the immediate leg, then a delayed one. */
export function claimCalls(ref: ClaimRef, owner: string, vault: string): Array<{ to: string; data: string; what: string }> {
  const id = uintWord(ref.id);
  if (ref.kind === 'vault') {
    if (ref.side === 'buy') return [{ to: ref.contract, data: `${CLAIM_SELECTOR.claimDeposit}${addrWord(owner)}${id}`, what: 'claim' }];
    return [
      { to: ref.contract, data: `${CLAIM_SELECTOR.claimRedeem}${addrWord(owner)}${id}`, what: 'claim' },
      { to: ref.contract, data: `${CLAIM_SELECTOR.claimDelayedRedeem}${addrWord(owner)}${id}`, what: 'claim of the delayed part' },
    ];
  }
  const v = addrWord(vault);
  return ref.side === 'buy'
    ? [{ to: ref.contract, data: `${CLAIM_SELECTOR.claimBuy}${v}${id}`, what: 'claim' }, { to: ref.contract, data: `${CLAIM_SELECTOR.claimDelayedBuy}${v}${id}`, what: 'claim of the delayed part' }]
    : [{ to: ref.contract, data: `${CLAIM_SELECTOR.claimSell}${v}${id}`, what: 'claim' }, { to: ref.contract, data: `${CLAIM_SELECTOR.claimDelayedSell}${v}${id}`, what: 'claim of the delayed part' }];
}

/** Find the request behind a ledger entry and claim what is ready. */
export async function claimEntry(o: { provider: Eip1193Provider; owner: string; entry: WealthEntry; onStep?: StepSink }): Promise<string> {
  if (!o.entry.txHash) throw new WalletError('This entry has no transaction to find its request by.');
  const fund = await readFund(o.entry.fundId);
  const vault = fund.contracts.vault;
  if (!vault) throw new WalletError('SoDEX lists no vault for this fund right now.');
  const r = await rpcCall<{ logs?: Log[] } | null>(VALUECHAIN_RPC, 'eth_getTransactionReceipt', [o.entry.txHash]);
  const ref = r.result?.logs ? requestOfLogs(r.result.logs, vault) : null;
  if (!ref) throw new WalletError('Could not find the request in its transaction. Nothing was sent.');
  for (const c of claimCalls(ref, o.owner, vault)) {
    const sim = await rpcCall<string>(VALUECHAIN_RPC, 'eth_call', [{ from: o.owner, to: c.to, data: c.data }, 'latest']);
    if (sim.error) continue;
    const { chainId, switched } = await ensureChain(o.provider);
    const ask = promptCounter(o.onStep, (switched ? 1 : 0) + 1);
    if (switched) ask('approve');
    ask('confirm');
    return send(o.provider, o.owner, chainId, c.to, c.data, c.what);
  }
  throw new WalletError('Nothing is ready to claim for this request yet. Nothing was sent.');
}
