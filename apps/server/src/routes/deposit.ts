/**
 * Deposits.
 *
 * A deposit is an ON-CHAIN action on ValueChain, so this backend never moves
 * funds: it reads chain state and returns UNSIGNED transaction requests that the
 * user's wallet signs and broadcasts. That keeps the deposit path on the same
 * footing as the rest of the app — the master wallet key is never involved here
 * either, beyond signing its own transaction in the wallet UI.
 *
 * Two shapes, both hitting `depositERC20(address token, uint256 amount)` on the
 * exchange contract:
 *
 *   native (SOSO):  token = 0x0,   msg.value = amount  (must match exactly)
 *   ERC-20:         token = <addr>, msg.value = 0,
 *                   preceded by approve(exchange, amount) when the current
 *                   allowance is short.
 *
 * See src/sodex/chain.ts for how this was established and verified.
 */
import type { FastifyInstance } from 'fastify';
import {
  CHAIN,
  NATIVE_TOKEN,
  depositRegistry,
  encodeApprove,
  encodeDeposit,
  findAsset,
  fromBaseUnits,
  nativeBalance,
  toBaseUnits,
  tokenAllowance,
  tokenBalance,
  verifyAsset,
  rpc,
  explorerTxUrl,
  simulateDeposit,
  registration,
} from '../sodex/chain.js';
import { sodex } from '../sodex/rest.js';
import { enginePath } from '../config.js';
import { decimalCompare } from '../decimal.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });

export async function depositRoutes(app: FastifyInstance): Promise<void> {
  /** Chain metadata the wallet needs in order to add/switch to ValueChain. */
  app.get('/api/deposit/chain', async () => ({
    chainId: CHAIN.chainId,
    chainIdHex: '0x' + CHAIN.chainId.toString(16),
    name: CHAIN.name,
    rpcUrl: CHAIN.rpcUrl,
    explorerUrl: CHAIN.explorerUrl,
    nativeCurrency: CHAIN.nativeCurrency,
    exchange: CHAIN.exchange,
  }));

  /**
   * Depositable assets, with the wallet's on-chain balance for each.
   * Only assets whose gateway precision matches their on-chain decimals appear;
   * the rest are surfaced as warnings rather than silently offered.
   */
  app.get('/api/deposit/assets', async (req) => {
    const { address } = req.query as { address?: string };
    const { assets, warnings } = await depositRegistry();

    let balances: Record<number, string> = {};
    if (address && ADDRESS_RE.test(address)) {
      const results = await Promise.all(
        assets.map(async (a) => {
          try {
            const raw = a.isNative ? await nativeBalance(address) : await tokenBalance(a.address, address);
            return [a.coinId, fromBaseUnits(raw, a.decimals)] as const;
          } catch {
            return [a.coinId, '0'] as const;
          }
        }),
      );
      balances = Object.fromEntries(results);
    }

    // Checked here so the UI can warn before the user picks an amount, rather
    // than only when the deposit is prepared.
    const reg = address && ADDRESS_RE.test(address)
      ? await registration(address).catch(() => ({ registered: false, accountId: null }))
      : { registered: false, accountId: null };

    return {
      chain: { chainId: CHAIN.chainId, name: CHAIN.name, explorerUrl: CHAIN.explorerUrl },
      exchange: CHAIN.exchange,
      assets: assets.map((a) => ({ ...a, walletBalance: balances[a.coinId] ?? null })),
      registered: reg.registered,
      accountId: reg.accountId,
      registrationNote: reg.registered
        ? null
        : 'This wallet has no SoDEX account yet. Its first deposit of USDC or SOSO creates it - SoDEX keeps 1 USDC or 1 SOSO of that deposit as a one-time activation fee.',
      warnings,
    };
  });

  /**
   * Build the transaction(s) for a deposit. Returns unsigned requests only.
   *
   * The asset's contract is re-verified against the chain (symbol + decimals)
   * before any calldata is produced, so a bad registry join fails here rather
   * than sending funds to the wrong token.
   */
  app.post('/api/deposit/prepare', async (req) => {
    const b = req.body as { address?: string; coinId?: number; amount?: string };
    if (!b?.address || !ADDRESS_RE.test(b.address)) throw bad('a valid 0x wallet address is required');
    if (!b.amount || decimalCompare(b.amount, '0') <= 0) throw bad('amount must be positive');
    if (b.coinId === undefined || b.coinId === null) throw bad('coinId is required');

    const found = await findAsset(Number(b.coinId));
    if (!found) throw bad(`coinId ${b.coinId} is not depositable on ${CHAIN.name}`);

    // Ground truth check before we hand the user calldata.
    const asset = await verifyAsset(found);

    let amount: bigint;
    try {
      amount = toBaseUnits(b.amount, asset.decimals);
    } catch (e) {
      throw bad((e as Error).message);
    }
    if (amount <= 0n) throw bad('amount rounds to zero at this asset precision');

    const balance = asset.isNative
      ? await nativeBalance(b.address)
      : await tokenBalance(asset.address, b.address);

    const transactions: Array<{
      kind: 'approve' | 'deposit';
      to: string;
      data: string;
      value: string;
      description: string;
    }> = [];

    if (asset.isNative) {
      // The contract requires msg.value === amount; a mismatch reverts.
      transactions.push({
        kind: 'deposit',
        to: CHAIN.exchange,
        data: encodeDeposit(NATIVE_TOKEN, amount),
        value: '0x' + amount.toString(16),
        description: `Deposit ${b.amount} ${asset.symbol} to SoDEX`,
      });
    } else {
      const allowance = await tokenAllowance(asset.address, b.address, CHAIN.exchange);
      if (allowance < amount) {
        transactions.push({
          kind: 'approve',
          to: asset.address,
          data: encodeApprove(CHAIN.exchange, amount),
          value: '0x0',
          description: `Allow SoDEX to move ${b.amount} ${asset.symbol}`,
        });
      }
      transactions.push({
        kind: 'deposit',
        to: CHAIN.exchange,
        data: encodeDeposit(asset.address, amount),
        value: '0x0',
        description: `Deposit ${b.amount} ${asset.symbol} to SoDEX`,
      });
    }

    /**
     * Pre-flight the deposit itself.
     *
     * For an ERC-20 the allowance may legitimately still be missing at this
     * point (the approve is the tx we are about to return), so an allowance
     * revert is expected and ignored. Anything else - most importantly "this
     * wallet has no SoDEX account" - is a real blocker and is surfaced now,
     * before the user pays for a transaction that cannot succeed.
     */
    const sim = await simulateDeposit(
      b.address,
      asset.isNative ? NATIVE_TOKEN : asset.address,
      amount,
      asset.isNative ? amount : 0n,
    );
    let blocker: string | undefined;
    if (!sim.ok && sim.selector !== '0xfb8f41b2') {
      const insufficientFunds = /insufficient funds/i.test(sim.reason ?? '');
      if (!insufficientFunds || asset.isNative) blocker = sim.reason;
    }

    return {
      asset,
      amount: b.amount,
      amountBaseUnits: amount.toString(),
      walletBalance: fromBaseUnits(balance, asset.decimals),
      sufficient: balance >= amount,
      // Non-null means the transaction would revert; the UI must not send it.
      blocker: blocker ?? null,
      chainId: CHAIN.chainId,
      chainIdHex: '0x' + CHAIN.chainId.toString(16),
      exchange: CHAIN.exchange,
      transactions,
      // A native deposit also needs gas, so it can never spend the full balance.
      note: asset.isNative
        ? 'Leave some SOSO for gas - a native deposit cannot use the entire balance.'
        : undefined,
    };
  });

  /** Poll a submitted transaction until it is mined. */
  app.get('/api/deposit/tx/:hash', async (req) => {
    const { hash } = req.params as { hash: string };
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw bad('expected a 32-byte transaction hash');
    const receipt = await rpc<any>('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (!receipt) return { hash, status: 'pending', explorerUrl: explorerTxUrl(hash) };
    return {
      hash,
      status: receipt.status === '0x1' ? 'success' : 'failed',
      blockNumber: receipt.blockNumber ? Number(BigInt(receipt.blockNumber)) : null,
      gasUsed: receipt.gasUsed ? BigInt(receipt.gasUsed).toString() : null,
      explorerUrl: explorerTxUrl(hash),
    };
  });

  /**
   * Deposit status: what the chain shows versus what the exchange has credited.
   * The gateway credits asynchronously after observing the transfer, so the UI
   * polls this until `accountExists` flips or the balance moves.
   */
  app.get('/api/deposit/status', async (req) => {
    const { address } = req.query as { address?: string };
    if (!address || !ADDRESS_RE.test(address)) throw bad('a valid 0x wallet address is required');

    const [spotState, perpsBal, blockHex] = await Promise.all([
      sodex.get<any>(`${enginePath('spot')}/accounts/${address}/state`).catch(() => null),
      sodex.get<any>(`${enginePath('perps')}/accounts/${address}/balances`).catch(() => null),
      rpc<string>('eth_blockNumber').catch(() => null),
    ]);

    const accountId = spotState?.aid ?? 0;
    const onChain = await registration(address).catch(() => ({ registered: false, accountId: null }));
    return {
      address,
      accountId,
      accountExists: accountId !== 0,
      // Both sources are reported; they have agreed in every case observed.
      onChainRegistered: onChain.registered,
      onChainAccountId: onChain.accountId,
      chainHead: blockHex ? Number(BigInt(blockHex)) : null,
      spotBalances: spotState?.B ?? [],
      perpsBalances: perpsBal?.balances ?? [],
      exchange: CHAIN.exchange,
      chainId: CHAIN.chainId,
    };
  });
}
