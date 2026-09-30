import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFromName, resolveLook, type Catalog } from './detect';

const CATALOG: Catalog = {
  platforms: [
    { id: 'bitget', name: 'Bitget', kind: 'cex', aliases: ['bitget', 'bg'] },
    { id: 'binance', name: 'Binance', kind: 'cex', aliases: ['binance', 'bn'] },
    { id: 'okx', name: 'OKX', kind: 'cex', aliases: ['okx', 'okex'] },
    { id: 'trust', name: 'Trust Wallet', kind: 'wallet', aliases: ['trust wallet', 'trustwallet'] },
    { id: 'ledger', name: 'Ledger', kind: 'wallet', aliases: ['ledger', 'ledger live', 'nano'] },
  ],
  chains: [
    { id: 'ethereum', name: 'Ethereum', sodexKey: 'ETH', aliases: ['eth', 'erc20', 'mainnet'], addressKind: 'evm' },
    { id: 'arbitrum', name: 'Arbitrum One', sodexKey: 'ARBITRUM_ETH', aliases: ['arb', 'arbitrum'], addressKind: 'evm' },
    { id: 'bsc', name: 'BNB Smart Chain', sodexKey: 'BSC_BNB', aliases: ['bsc', 'bnb', 'bep20', 'binance smart chain'], addressKind: 'evm' },
    { id: 'solana', name: 'Solana', sodexKey: 'SOL', aliases: ['sol', 'spl'], addressKind: 'solana' },
    { id: 'bitcoin', name: 'Bitcoin', sodexKey: 'BTC', aliases: ['btc'], addressKind: 'bitcoin' },
    { id: 'tron', name: 'Tron', sodexKey: null, aliases: ['trx', 'trc20'], addressKind: 'tron' },
  ],
};
const COINS = new Set(['ETH', 'USDC', 'USDT', 'ARB', 'BNB', 'SOL', 'BTC', 'OKB']);
const d = (name: string) => detectFromName(name, CATALOG, COINS);

test('names: the platform, the coin and the chain, whatever the order or case', () => {
  assert.deepEqual(d('bitget eth deposit'), { platform: 'bitget', coin: 'ETH', chain: 'ethereum' });
  assert.deepEqual(d('BG - USDC (Arbitrum)'), { platform: 'bitget', coin: 'USDC', chain: 'arbitrum' });
  assert.deepEqual(d('arb usdc'), { platform: null, coin: 'USDC', chain: 'arbitrum' }, 'the coin named on its own wins over the chain word');
  assert.deepEqual(d('usdt trc20 okex'), { platform: 'okx', coin: 'USDT', chain: 'tron' });
  assert.deepEqual(d('my trust wallet'), { platform: 'trust', coin: null, chain: null }, 'two-word platform');
  assert.deepEqual(d('binance smart chain payout'), { platform: null, coin: null, chain: 'bsc' }, 'a chain phrase is not the exchange');
  assert.deepEqual(d('Ledger Nano btc'), { platform: 'ledger', coin: 'BTC', chain: 'bitcoin' });
  assert.deepEqual(d('Mom'), { platform: null, coin: null, chain: null });
});

test('the chain badge: picked > named > the only chain the address allows; never one the address cannot be on', () => {
  const evm = { name: 'bitget eth deposit', kind: 'evm' as const };
  assert.equal(resolveLook(evm, CATALOG, COINS).chain, 'ethereum');
  assert.equal(resolveLook({ ...evm, look: { chain: 'arbitrum' } }, CATALOG, COINS).chain, 'arbitrum', 'the user picked another EVM chain');
  assert.equal(resolveLook({ ...evm, look: { chain: 'solana' } }, CATALOG, COINS).chain, null, 'a Solana badge on a 0x address is refused');
  assert.equal(resolveLook({ name: 'cold storage', kind: 'bitcoin' }, CATALOG, COINS).chain, 'bitcoin', 'a bc1 address is Bitcoin whatever it is called');
  assert.equal(resolveLook({ name: 'sol stuff', kind: 'evm' }, CATALOG, COINS).chain, null, 'a Solana word on a 0x address gives no chain');
  assert.equal(resolveLook({ name: 'friend', kind: 'evm' }, CATALOG, COINS).chain, null, 'an EVM address with nothing named: generic');
  const picked = resolveLook({ ...evm, look: { platform: 'okx', coin: null } }, CATALOG, COINS);
  assert.deepEqual([picked.platform, picked.coin], ['okx', null], 'picks override, including an explicit "none"');
});
