/**
 * Test data: what the live runner prints and writes, taken from a real
 * `plan --throwaway-key --registry-only` run on 2026-10-02 (the wallet is the
 * random throwaway address of that run; it controls nothing) and trimmed.
 */

export const WALLET = '0xb9e8111c4f967faaa969c8c11bc3954c2cb9172a';

/** The console of a plan run, as the runner prints it (a clock in front of every line). */
export const PLAN_CONSOLE: readonly string[] = `20:23:01  Valuescan live E2E runner - PLAN (read-only: nothing is signed or sent)
20:23:01  config            defaults
20:23:01  wallet            ${WALLET} (a throwaway key generated for this plan)
20:23:01  backend           http://127.0.0.1:5180
20:23:01  SoDEX gateway     https://mainnet-gw.sodex.dev (relayer https://alpha-biz.sodex.dev)
20:23:01  steps             deposit-external, enable-trading, transfers, orders, withdraw-valuechain-other, withdraw-external, extra-withdrawals, cleanup, revoke-builder
20:23:01  == preflight: read-only checks: backend, routes, balances, account, deposit addresses, markets, receivers
20:23:01     - backend health
20:23:01       ok (0.1 s) network mainnet, chain 286623, app mainnet writes allowed
20:23:15  ok preflight (13.6 s)
20:23:15
20:23:15  PLAN for ${WALLET} (throwaway key - plan only)
20:23:15  SoDEX account     none yet (brand-new wallet)
20:23:15  Balances
20:23:15    ValueChain       SOSO 0, USDC 0
20:23:15    Arbitrum One     ETH 0, USDC 0
20:23:15  USDC deposit addresses (backend vs on-chain registry getDepositWalletList)
20:23:15    ARBITRUM_ETH   backend - | registry - -> NOT CONFIRMED (--registry-only: the backend was not asked)
20:23:15  Routes per chain (live SoDEX asset config) - one run per chain covers its custody path
20:23:15    chain              coin       deposit            withdraw           fee        runner
20:23:15    Arbitrum One       USDC       open, min 5        open, min 5        1          deposit, withdraw+verify
20:23:15    Arbitrum One       ETH*       open, min 0.0015   open, min 0.0015   0.0005     withdraw+verify
20:23:15    Base               USDC       open, min 5        open, min 5        1          deposit, withdraw+verify
20:23:15    Solana             USDC       open, min 5        open, min 5        1          withdraw (status only)
20:23:15    Zcash              ZEC*       CLOSED             CLOSED             -          -
20:23:15    (* = the chain's native coin)
20:23:15  Steps
20:23:15    deposit-external           est. cost $1.01
20:23:15        send 25 USDC on Arbitrum One (0xaf88d065e77c8cc2239327c5edb3a432268e5831) to the wallet's own SoDEX deposit address (not issued yet)
20:23:15        wait for the receipt, then until SoDEX shows the account and Spot USDC +24
20:23:15    enable-trading             est. cost $0.00
20:23:15        one EIP-712 signature (UserSignedAddAPIKeyAction) registers key "valuescan-web" for 24 h on spot + perps
20:23:15    orders                     est. cost $0.02
20:23:15        spot WSOSO_vUSDC: limit BUY 5.69 @ 0.1848 (40 % below the bid) -> verify open -> cancel -> verify gone
20:23:15    withdraw-valuechain-other  SKIPPED - receivers.valuechain is not set
20:23:15    withdraw-external          est. cost $1.00
20:23:15        USDC 5 -> Arbitrum One (0xaf88d065e77c8cC2239327C5EDb3A432268e5831) to this wallet: min 5, fee 1 USDC on-chain (~$1.00)
20:23:15    extra-withdrawals          est. cost $1.34
20:23:15        ETH 0.0015 -> Arbitrum One (native) to this wallet: min 0.0015, fee 0.0005 ETH on-chain (~$1.33)
20:23:15    cleanup                    SKIPPED - cleanup.enabled is false
20:23:15    revoke-builder             SKIPPED - no builder is configured for this run
20:23:15  Estimated total   costs $3.36 + sent to your other addresses $0.00 = $3.36 (maxSpendUsd $8.00)
20:23:15  Funding checklist (send to 0xb9e811...b9172a before a live run)
20:23:15    [ ] Arbitrum One     25.00 USDC  (deposit) - wallet holds 0.00
20:23:15    [ ] Arbitrum One     0.000200 ETH   (gas for the USDC transfer (with headroom; the rest stays in the wallet)) - wallet holds 0.00
20:23:15  Warnings
20:23:15    - deposit ARBITRUM_ETH: the backend has no verified USDC deposit address on ARBITRUM_ETH - a live run waits up to 3 min
20:23:15  Problems a live run would refuse to start with:
20:23:15    - fund the wallet: 25.00 USDC on Arbitrum One (it holds 0.00)
20:23:15    - fund the wallet: 0.000200 ETH on Arbitrum One (it holds 0.00)
20:23:15
20:23:15  report            C:\\reports\\2026-10-02T20-23-01-798Z-plan.json`.split('\n');

const planStep = (id: string, lines: string[], costUsd: number, skip?: string): Record<string, unknown> => ({ id, title: `title of ${id}`, lines, costUsd, sentAwayUsd: 0, problems: [], ...(skip ? { skip } : {}) });

/** The plan part of the report the runner writes for the console above. */
export function planReport(o: { funded?: boolean; problems?: string[]; receiversNeeded?: unknown; suggestedMaxSpendUsd?: number; handDeposits?: unknown; budget?: unknown } = {}): Record<string, unknown> {
  const mark = o.funded ? 'x' : ' ';
  const holdsUsdc = o.funded ? '25.00' : '0.00';
  const holdsEth = o.funded ? '0.000300' : '0.00';
  return {
    tool: 'valuescan-live-e2e',
    version: 1,
    mode: 'plan',
    exitCode: o.funded && !o.problems?.length ? 0 : 2,
    wallet: WALLET,
    throwawayKey: true,
    config: { maxSpendUsd: 8, deposit: { chain: 'ARBITRUM_ETH', amount: '25' } },
    selectedSteps: ['deposit-external', 'enable-trading', 'orders', 'withdraw-valuechain-other', 'withdraw-external', 'extra-withdrawals', 'cleanup', 'revoke-builder'],
    plan: {
      problems: [...(o.funded ? [] : ['fund the wallet: 25.00 USDC on Arbitrum One (it holds 0.00)', 'fund the wallet: 0.000200 ETH on Arbitrum One (it holds 0.00)']), ...(o.problems ?? [])],
      warnings: ['deposit ARBITRUM_ETH: the backend has no verified USDC deposit address on ARBITRUM_ETH'],
      checklist: [
        `[${mark}] Arbitrum One     25.00 USDC  (deposit) - wallet holds ${holdsUsdc}`,
        `[${mark}] Arbitrum One     0.000200 ETH   (gas for the USDC transfer (with headroom; the rest stays in the wallet)) - wallet holds ${holdsEth}`,
      ],
      estimatedCostUsd: 3.36,
      estimatedSentAwayUsd: 0,
      balances: ['ValueChain       SOSO 0, USDC 0', `Arbitrum One     ETH ${o.funded ? '0.0003' : '0'}, USDC ${o.funded ? '25' : '0'}`],
      routes: [
        'chain              coin       deposit            withdraw           fee        runner',
        'Arbitrum One       USDC       open, min 5        open, min 5        1          deposit, withdraw+verify',
        'Arbitrum One       ETH*       open, min 0.0015   open, min 0.0015   0.0005     withdraw+verify',
        'Base               USDC       open, min 5        open, min 5        1          deposit, withdraw+verify',
        'Solana             USDC       open, min 5        open, min 5        1          withdraw (status only)',
        'Zcash              ZEC*       CLOSED             CLOSED             -          -',
        "(* = the chain's native coin)",
      ],
      ...(o.receiversNeeded !== undefined ? { receiversNeeded: o.receiversNeeded } : {}),
      ...(o.suggestedMaxSpendUsd !== undefined ? { suggestedMaxSpendUsd: o.suggestedMaxSpendUsd } : {}),
      ...(o.handDeposits !== undefined ? { handDeposits: o.handDeposits } : {}),
      ...(o.budget !== undefined ? { budget: o.budget } : {}),
      steps: [
        planStep('deposit-external', ["send 25 USDC on Arbitrum One (0xaf88d065e77c8cc2239327c5edb3a432268e5831) to the wallet's own SoDEX deposit address (not issued yet)", 'wait for the receipt, then until SoDEX shows the account and Spot USDC +24'], 1.01),
        planStep('enable-trading', ['one EIP-712 signature registers key "valuescan-web"'], 0),
        planStep('orders', ['spot WSOSO_vUSDC: limit BUY 5.69 @ 0.1848 -> verify open -> cancel -> verify gone'], 0.02),
        planStep('withdraw-valuechain-other', [], 0, 'receivers.valuechain is not set'),
        planStep('withdraw-external', ['USDC 5 -> Arbitrum One (0xaf88d065e77c8cC2239327C5EDb3A432268e5831) to this wallet: min 5, fee 1 USDC on-chain (~$1.00)'], 1),
        planStep('extra-withdrawals', ['ETH 0.0015 -> Arbitrum One (native) to this wallet: min 0.0015, fee 0.0005 ETH on-chain (~$1.33)'], 1.34),
        planStep('cleanup', [], 0, 'cleanup.enabled is false'),
        planStep('revoke-builder', [], 0, 'no builder is configured for this run'),
      ],
    },
    steps: [{ id: 'preflight', title: 'read-only checks', status: 'ok', ms: 13600, amounts: {}, fees: {}, txs: [], subSteps: [], notes: [] }],
    spend: { costUsd: 0, sentAwayUsd: 0 },
    whereFunds: null,
    inFlight: [],
  };
}

export const TX_DEPOSIT = `0x${'d1'.repeat(32)}`;
export const TX_WITHDRAW = `0x${'e2'.repeat(32)}`;

const liveStep = (id: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, title: `title of ${id}`, status, ms: 4200, amounts: {}, fees: {}, txs: [], subSteps: [], notes: [], estimateUsd: 0.5, ...extra });

/** A live run's report: finished, or stopped at `stoppedAt`. */
export function liveReport(o: { stoppedAt?: string; checks?: unknown; chains?: unknown; orderTypes?: unknown; exitCode?: number } = {}): Record<string, unknown> {
  const order = ['deposit-external', 'enable-trading', 'orders', 'withdraw-external', 'extra-withdrawals'];
  const steps: Array<Record<string, unknown>> = [liveStep('preflight', 'ok')];
  for (const id of order) {
    if (o.stoppedAt === id) {
      steps.push(liveStep(id, 'failed', { error: 'TimeoutError: the withdrawal did not become final in 30 min' }));
      break;
    }
    steps.push(
      liveStep(id, 'ok', {
        measured: { valueBeforeUsd: 25, valueAfterUsd: 24, sentAwayUsd: 0, costUsd: id === 'deposit-external' ? 1.01 : 0.02 },
        ...(id === 'deposit-external' ? { txs: [{ chain: 'ARBITRUM_ETH', hash: TX_DEPOSIT, what: 'wallet tx', explorer: `https://arbiscan.io/tx/${TX_DEPOSIT}` }] } : {}),
        ...(id === 'withdraw-external' ? { txs: [{ chain: 'VALUECHAIN', hash: TX_WITHDRAW, what: 'permit' }] } : {}),
        ...(id === 'orders'
          ? {
              subSteps: [
                { title: 'spot WSOSO_vUSDC: limit BUY 5.69 @ 0.1848 (40 % below the best bid 0.3081)', status: 'ok', ms: 900 },
                { title: 'spot WSOSO_vUSDC: verify the order is open', status: 'ok', ms: 300 },
                { title: 'spot WSOSO_vUSDC: cancel it (cancelOrder)', status: 'ok', ms: 400 },
                { title: 'spot WSOSO_vUSDC: verify it is gone', status: 'ok', ms: 300 },
                { title: 'perps BTC-USD: market BUY 0.00014 (~11.81 USD)', status: 'ok', ms: 800 },
                { title: 'verify: the position is open', status: 'ok', ms: 300 },
                { title: 'Spot -> Perps 3 USDC collateral (leverage 20x)', status: 'ok', ms: 500 },
              ],
            }
          : {}),
      }),
    );
  }
  const failed = !!o.stoppedAt;
  // A run that stops records nothing after the step it stopped at.
  if (!failed) steps.push({ id: 'cleanup', title: 'cleanup', status: 'skipped', reason: 'cleanup.enabled is false', amounts: {}, fees: {}, txs: [], subSteps: [], notes: [] });
  return {
    tool: 'valuescan-live-e2e',
    version: 1,
    mode: 'live',
    exitCode: o.exitCode ?? (failed ? 1 : 0),
    startedAt: '2026-10-02T21:00:00.000Z',
    finishedAt: '2026-10-02T21:12:00.000Z',
    wallet: WALLET,
    config: { maxSpendUsd: 8 },
    selectedSteps: [...order, 'cleanup'],
    plan: planReport({ funded: true }).plan,
    steps,
    spend: { costUsd: failed ? 1.03 : 3.41, sentAwayUsd: 0 },
    whereFunds: ['  SoDEX Spot               vUSDC 9.1 ($9.10)', '  Arbitrum One wallet      ETH 0.001, USDC 4 ($6.65)', '  Open orders              none', '  Total (priced)           $15.75'],
    inFlight: failed ? [{ what: 'withdrawal of 5 USDC to Arbitrum One', since: 1790000000000, ref: `https://main-scan.valuechain.xyz/tx/${TX_WITHDRAW}` }] : [],
    ...(o.checks !== undefined ? { checks: o.checks } : {}),
    ...(o.chains !== undefined ? { chains: o.chains } : {}),
    ...(o.orderTypes !== undefined ? { orderTypes: o.orderTypes } : {}),
  };
}

/** The usage text the runner of 2026-10-02 prints for an argument it does not know (its exit code is then 2). */
export const USAGE_TODAY = `unknown argument capabilities

usage: npx tsx e2e/live/run.ts [plan|live] --config e2e/live/config.json [options]

  plan                    read-only (default): checks, routes, estimates, funding checklist
  live                    moves real funds (needs --confirm and acknowledgeRealFunds)
  --config <file>         the run's config (see config.example.json); plan falls back to the defaults
  --confirm <address>     live: the wallet address VS_E2E_KEY controls
  --only a,b              run only these steps (preflight always runs): deposit-external, enable-trading, transfers, orders, spot-to-evm, evm-to-spot, withdraw-valuechain-self, withdraw-valuechain-other, withdraw-external, extra-deposits, extra-withdrawals, cleanup, revoke-builder
  --throwaway-key         plan only: use a random in-memory key instead of VS_E2E_KEY
  --registry-only         plan only: read deposit addresses from the on-chain registry alone
                          (does not ask the backend, which asks SoDEX to issue addresses)
  --backend <origin>      override config.backend (default http://127.0.0.1:5180)
  --report-dir <dir>      where the JSON report goes (default e2e/live/reports)

The key comes only from the environment: VS_E2E_KEY=0x<64 hex>.`;

/** The hand-sent deposits of an all-chains plan (as plan.ts writes them), trimmed. */
export function handDeposits(state: { sol?: string; xrp?: string } = {}): Array<Record<string, unknown>> {
  return [
    { coin: 'SOL', chain: 'SOL', label: 'Solana', state: state.sol ?? 'offered', order: 'withdraw-first', withdraw: '0.047001', arrives: '0.035001', sendBack: '0.03', amount: '0.03', depositMin: '0.03', sodexFee: '0.012', walletFee: '0.00001', feeCoin: 'SOL', keep: '0.00089088', needFirst: '0', needFirstFeeCoin: '0', withdrawalRuns: true, line: 'SOL on Solana [x]: the run withdraws 0.047001 SOL to you, 0.035001 arrives; you send back 0.03 SOL (deposit minimum 0.03)' },
    { coin: 'XRP', chain: 'XRP', label: 'XRP Ledger', state: state.xrp ?? 'offered', order: 'withdraw-first', withdraw: '5.80002', arrives: '5.00002', sendBack: '4', amount: '4', depositMin: '4', sodexFee: '0.8', walletFee: '0.00002', feeCoin: 'XRP', keep: '1', needFirst: '0', needFirstFeeCoin: '0', withdrawalRuns: true, line: 'XRP on XRP Ledger [x]: the run withdraws 5.80002 XRP to you, 5.00002 arrives; you send back 4 XRP (deposit minimum 4); 1 XRP stays at your address' },
  ];
}

/** The budget block of a plan (plan.ts `budget`). */
export const BUDGET = {
  fund: ['[ ] Arbitrum One     25.00 USDC  (deposit) - wallet holds 0.00'],
  costUsd: 41.5,
  sentAwayUsd: 80.2,
  returnsUsd: 50.1,
  leftOnChains: ['Polygon: ~1.00 USDC stays in the test wallet there - no POL for gas to send it back'],
  ownerWallet: ['XRP on XRP Ledger: nothing of your own - the run sends 5.00002 XRP, you send back 4'],
  minutes: { expected: 210, worst: 900 },
  suggestedMaxSpendUsd: 160,
};
