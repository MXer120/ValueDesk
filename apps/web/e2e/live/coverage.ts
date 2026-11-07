/**
 * What of the app's trading and funds layer a live run exercises: every
 * exported function of those modules, mapped to the checks that exercise it -
 * or marked as not exercised, with why. `run.ts capabilities` prints it, and
 * units.test.ts fails when the app exports a function this table does not
 * name (so a new action cannot go untested unnoticed).
 *
 * Check ids ending in `*` stand for the per-route checks declared at run time
 * (`deposit-<coin>-<chain>`, `withdraw-<coin>-<chain>`, `manual-deposit-<coin>-<chain>`)
 * and the read-only `route-<coin>-<chain>` every plan records for every route.
 */

export interface Covered {
  checks: readonly string[];
  /** How the run reaches it, when not directly. */
  via?: string;
}
export interface Uncovered {
  uncovered: string;
}
export type Coverage = Covered | Uncovered;

const c = (checks: string[], via?: string): Covered => (via ? { checks, via } : { checks });
const no = (why: string): Uncovered => ({ uncovered: why });
const TEST_HOOK = no('a test hook of the app, not something it does for a user');
const PURE = (checks: string[], what: string): Covered => c(checks, `pure ${what}, exercised inside the calls of these checks`);

/** module (apps/web/src/trading/<module>.ts) -> exported function -> coverage. */
export const APP_COVERAGE: Readonly<Record<string, Readonly<Record<string, Coverage>>>> = {
  actions: {
    placeOrder: c(['perps-market-by-quantity', 'perps-limit-rest', 'perps-gtx-rest', 'perps-ioc-cross', 'perps-entry-with-tp-sl', 'perps-position-stop-loss', 'spot-limit-rest', 'spot-market-buy-by-funds', 'spot-market-sell', 'builder-fee-default', 'builder-fee-lowered', 'refuse-perps-market-below-min-notional']),
    cancelOrder: c(['perps-limit-cancel', 'spot-limit-cancel', 'perps-position-take-profit']),
    cancelAll: c(['perps-cancel-all']),
    placeAlgoChildren: no('the children of a live browser algo; real algo orders are off in the browser (algo/liveAlgos.ts) and are tested by apps/executor/tools/live-test'),
    placeAlgoStops: no('the exits of a live browser algo; real algo orders are off in the browser (algo/liveAlgos.ts) and are tested by apps/executor/tools/live-test'),
    cancelAlgoChildren: no('the cancels of a live browser algo; real algo orders are off in the browser (algo/liveAlgos.ts) and are tested by apps/executor/tools/live-test'),
    algoAccountId: no('the account a live browser algo trades; real algo orders are off in the browser (algo/liveAlgos.ts) and are tested by apps/executor/tools/live-test'),
    changeOrder: c(['perps-limit-change-price', 'perps-limit-change-size', 'spot-limit-change-price', 'spot-limit-change-size', 'perps-position-stop-loss', 'perps-position-take-profit', 'builder-replace-keeps-builder', 'builder-modify-keeps-builder']),
    changeRoute: PURE(['spot-limit-change-price', 'perps-position-stop-loss'], 'route choice of changeOrder'),
    recreateOrder: c(['spot-limit-change-price', 'perps-limit-change-price'], 'changeOrder makes the change as cancel + new order where the G6 constant says so'),
    ticketFromOpenOrder: PURE(['spot-limit-change-price'], 'rebuilding of an open order for cancel + new'),
    modifyOrder: no('an older entry point: the app and the run change orders through changeOrder, which sends the same modify request'),
    replaceOrder: no('an older entry point: the app and the run change orders through changeOrder, which sends the same replace request'),
    setLeverage: c(['perps-leverage-cross', 'perps-leverage-isolated', 'perps-end-flat']),
    adjustMargin: c(['perps-margin-add', 'perps-margin-remove']),
    scheduleCancel: c(['spot-schedule-cancel', 'perps-schedule-cancel-clear', 'perps-schedule-cancel-fires']),
    transferCross: c(['transfer-spot-to-perps', 'transfer-perps-to-spot'], 'transferFunds'),
    withdraw: c(['transfer-spot-to-evm-usdc', 'withdraw-valuechain-self'], 'transferFunds / withdrawFunds'),
    symbolFor: PURE(['perps-limit-rest', 'spot-limit-rest'], 'market lookup'),
  },
  funds: {
    transferFunds: c(['transfer-spot-to-perps', 'transfer-perps-to-spot', 'transfer-spot-to-evm-usdc', 'transfer-spot-to-evm-soso', 'transfer-evm-to-spot', 'refuse-transfer-over-balance']),
    withdrawFunds: c(['withdraw-valuechain-self', 'withdraw-valuechain-other', 'withdraw-*', 'refuse-withdraw-over-balance', 'refuse-withdraw-below-minimum', 'refuse-malformed-receiver']),
    depositFromWallet: c(['transfer-evm-to-spot', 'cleanup-sweep'], 'transferFunds (wallet -> Spot)'),
    sendOnValueChain: c(['withdraw-valuechain-other'], 'withdrawFunds to another ValueChain address'),
    withdrawQuote: c(['withdraw-*', 'route-*']),
    withdrawalProgress: c(['withdraw-*']),
    recordAmountIs: c(['withdraw-*']),
    recordUnits: c(['withdraw-*']),
    // Called after each withdrawal / gasless deposit the run followed to its end (the next permit is not stopped by it).
    forgetSettledPermit: c(['withdraw-*', 'transfer-evm-to-spot']),
    permitExecuted: c(['withdraw-*']),
    balancesOf: c(['transfer-spot-to-perps', 'refuse-transfer-over-balance', 'manual-deposit-*']),
    assetConfigs: c(['deposit-*', 'withdraw-*', 'route-*'], 'preflight'),
    cachedAssetConfigs: c(['deposit-*'], 'the app\'s sheets; the runner reads assetConfigs'),
    receiverProblem: c(['refuse-malformed-receiver', 'route-*']),
    arrivalCheck: PURE(['withdraw-*', 'withdraw-valuechain-other'], "check of withdrawFunds: what arrives at a SoDEX deposit address must clear SoDEX's deposit minimum (the runner's own withdrawTo makes the same check before it asks the app)"),
    receiverAccount: c(['withdraw-*', 'withdraw-valuechain-other'], "withdrawFunds asks the registries whose deposit address the receiver is (reads only)"),
    depositAccountsCallData: PURE(['withdraw-*'], 'calldata of the registry read inside receiverAccount'),
    memoProblem: c(['withdraw-*', 'route-*'], 'every withdrawal\'s receiver check; the memo rules of XRP and Stellar in the route checks'),
    planWithdraw: PURE(['refuse-withdraw-over-balance'], 'source planning of withdrawFunds'),
    transferProblem: PURE(['transfer-spot-to-perps'], 'check of transferFunds'),
    transferNeedsKey: PURE(['transfer-spot-to-perps'], 'rule'),
    transferNeedsWallet: PURE(['transfer-evm-to-spot'], 'rule'),
    perpsCollateral: PURE(['transfer-spot-to-perps'], 'rule'),
    canDepositCoin: PURE(['deposit-*'], 'rule of the Deposit sheet'),
    canWithdrawCoin: PURE(['withdraw-*'], 'rule of the Withdraw sheet'),
    chainLabel: PURE(['withdraw-*'], 'label'),
    promptCounter: no('counts wallet prompts for the sheets\' buttons: UI only'),
    unitsDown: PURE(['transfer-spot-to-perps'], 'decimal helper'),
    toChecksumAddress: PURE(['withdraw-*', 'refuse-malformed-receiver'], 'address helper'),
    valueChain: PURE(['transfer-evm-to-spot'], 'ValueChain parameters'),
    _clearConfigCache: TEST_HOOK,
    _clearPendingWithdrawals: TEST_HOOK,
  },
  session: {
    enableTrading: c(['key-enable', 'builder-approval', 'key-reenable']),
    restoreTrading: c(['key-restore']),
    keyStillRegistered: c(['key-enable', 'key-still-registered', 'key-disable-revoke']),
    disableTrading: c(['key-disable-revoke', 'key-old-key-rejected']),
    approveBuilderFee: c(['builder-reapproved-orders-resume']),
    revokeBuilderApproval: c(['builder-revoke', 'builder-approval-enforced']),
    readBuilderApproval: c(['builder-approval', 'builder-revoke']),
    refreshBuilderApproval: c(['builder-approval', 'builder-approval-enforced']),
    sodexAccountId: c(['deposit-*', 'key-enable'], 'preflight and enabling trading'),
    requireSigner: PURE(['key-still-registered'], 'the session\'s signer'),
    getTradingState: PURE(['key-enable'], 'state read'),
    tradingKeyName: PURE(['key-enable'], 'key name'),
    nonces: PURE(['key-enable'], 'nonce manager'),
    builderApprovalPending: PURE(['builder-approval'], 'state read'),
    checkKeyAfterRejection: no('runs when SoDEX refuses a signed action with a key error: the run sends the old-key order around the app (key-old-key-rejected), so the app\'s own reaction is not exercised'),
    keyRejected: no('the app\'s reaction to "API key not found": not exercised for the same reason as checkKeyAfterRejection'),
    refreshAccount: no('the account-status look of the first-deposit watch (trading/accountWatch.ts): UI only'),
    nudgeAccountCheck: no('the Deposit sheet nudges the first-deposit watch (trading/accountWatch.ts, its own unit tests): UI only'),
    subscribeTrading: no('UI subscription'),
    describeTradingKey: no('text for the key view: UI only'),
    sessionInfoOf: no('state in the UI\'s old shape: UI only'),
    _resetTradingForTests: TEST_HOOK,
  },
  builderApproval: {
    submitBuilderApproval: c(['builder-approval', 'builder-approval-enforced', 'builder-revoke']),
    readBuilderRates: c(['builder-approval', 'refuse-unapproved-builder', 'refuse-builder-fee-above-approval']),
    pollBuilderRates: c(['builder-approval'], 'enableTrading / approveBuilderFee'),
    _setBuilderPollDelaysForTests: TEST_HOOK,
  },
  terms: {
    configureTerms: c(['builder-terms-signed'], 'the runner configures the app\'s module with its pinned keys'),
    refreshTerms: c(['builder-terms-tamper-rejected', 'builder-fee-lowered', 'builder-terms-back-to-default']),
    feeNow: c(['builder-fee-default', 'builder-fee-lowered', 'builder-terms-back-to-default']),
    ensureTerms: c(['builder-fee-lowered'], 'placeOrder, before every order'),
    followTerms: c(['builder-fee-lowered'], 'enabling / restoring trading'),
    hintTerms: c(['builder-volume-verified'], 'placeOrder, after an order'),
    currentTerms: PURE(['builder-fee-lowered'], 'held terms'),
    readTermsAnswer: PURE(['builder-terms-tamper-rejected'], 'answer check'),
    termsMessage: PURE(['builder-terms-signed'], 'signed bytes'),
    termsKeyId: PURE(['builder-terms-signed'], 'key id'),
    termsPossible: PURE(['builder-terms-signed'], 'rule'),
    subscribeTerms: no('UI subscription'),
    termsRevision: no('UI subscription'),
    termsView: no('the fee lines of the order ticket: UI only'),
    _resetTermsForTests: TEST_HOOK,
  },
  feeGuard: {
    guardAction: c(['builder-approval-enforced', 'builder-fee-lowered', 'builder-terms-back-to-default'], 'every signed action of the app passes it'),
    builderNow: c(['builder-fee-default', 'builder-fee-lowered'], 'the runner\'s guard asks it what an order placed now carries'),
    mustRecreate: c(['spot-limit-change-price', 'builder-replace-keeps-builder', 'builder-modify-keeps-builder']),
    classifyAction: PURE(['builder-approval-enforced'], 'gate classification'),
    isFeeFreeMarket: no('a fixed list of spot markets SoDEX charges nothing on (the USDT/USDC swap): no live scenario places a swap yet'),
  },
  onboard: {
    sendUsdcDeposit: c(['deposit-*'], 'deposit-external, extra-deposits and the USDC legs of the evm-tour'),
    usdcRoutes: c(['deposit-*']),
    readToken: c(['deposit-*'], "inside sendUsdcDeposit: the token's symbol, decimals and balance are read before every USDC deposit"),
    erc20TransferData: PURE(['deposit-*'], 'calldata'),
    parseUnits: PURE(['deposit-*'], 'decimal helper'),
    formatUnits: PURE(['deposit-*'], 'decimal helper'),
    decodeString: PURE(['deposit-*'], 'ABI helper'),
  },
};

/** Coverage as `capabilities` prints it: one entry per function. */
export function coverageList(): Array<{ action: string; checks?: readonly string[]; via?: string; uncovered?: string }> {
  return Object.entries(APP_COVERAGE).flatMap(([mod, fns]) =>
    Object.entries(fns).map(([name, cov]) => ({ action: `${mod}.${name}`, ...('uncovered' in cov ? { uncovered: cov.uncovered } : { checks: cov.checks, ...(cov.via ? { via: cov.via } : {}) }) })),
  );
}
