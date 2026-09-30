# Valuescan copy trading: integration guide

| | |
|---|---|
| Audience | Engineers building the follower UI, the gas relayer, the executor (Tokyo) and the governance monitor |
| Contract | `ValuescanCopyTrading` `1.0.0` behind an ERC-1967 proxy (UUPS), owned by a 48 h TimelockController. Spec: [`COPY-TRADING.md`](COPY-TRADING.md) (normative for behaviour) |
| Bindings | [`packages/copy-contract`](../../packages/copy-contract) (`@valuescan/copy-contract`): ABI, types, calldata, EIP-712, events, index, executor gates, Merkle, relayer, timelock |
| SoDEX side | [`packages/sodex-core`](../../packages/sodex-core) (`@valuescan/sodex-core`): API-key registration, builder approval, revocation, order signing |
| Proof | [`contracts/test/CrossCheckVectors.t.sol`](../../contracts/test/CrossCheckVectors.t.sol) replays the package's vectors against the real contract (section 10) |
| Status | **Nothing is deployed.** `DEPLOYMENTS` in the package is empty on purpose; every function takes the proxy address explicitly |

## 0. Rules that hold everywhere

- **The contract never moves funds.** SoDEX holds every balance. Every follower trades from their own SoDEX account,
  through a delegated SoDEX API key that the follower authorised. Orders carry Valuescan's builder code.
- **Always address the proxy.** It is the contract, and the EIP-712 `verifyingContract`, forever. Chain id 286623
  (ValueChain), gas token SOSO.
- **The packages never send anything.** They build typed data, calldata, log filters and requests. Your code does the
  `eth_call`, `eth_sendRawTransaction`, `eth_getLogs` and `fetch`.
- **Stopping always works.** Pause, unsubscribe, the kill switch and nonce cancellation work while the contract is
  paused, directly and by signature. The **hard** stop is revoking the SoDEX key; SoDEX enforces it, and no upgrade
  can prevent it.
- **The contract is not in the per-trade hot path.** A ValueChain block takes about 2 s; a copy takes about 0.1 s.
  The executor follows the logs and keeps its model in memory.

## 1. Who does what

| Component | Runs | Holds | Does |
|---|---|---|---|
| Follower UI | Browser | Nothing secret | Collects terms. The wallet signs: SoDEX key registration and builder approval (sodex-core), and Valuescan's EIP-712 actions (copy-contract). Posts signed actions to the relayer, or calls directly |
| Key service | TEE or HSM | Delegated private keys | Generates one delegated key per (follower, SoDEX account); returns only its address and name; records the issuance |
| Relayer | Server | A hot EOA with SOSO only | Validates and submits `...WithSig` calls; pays gas. Has no role on the contract |
| Executor | Tokyo | Signing access to the delegated keys; an executor EOA with SOSO | Indexes events, gates each leader fill, trades on SoDEX with the builder code, publishes execution commitments |
| Indexer / API | Server | Nothing secret | The same event-sourced index as the executor, for the UI |
| Governance | Multisig (Safe) + TimelockController | The multisig keys | Proposes owner calls and upgrades; the monitor announces them to followers |

## 2. Package quick reference

```ts
import {
  // chain facts and calldata                          // signing
  calls, results, decodeRevert,                          prepareSubscribe, prepareUpdateSubscription,
  VALUECHAIN_CHAIN_ID, isExpectedDomain,                 preparePauseSubscription, prepareResumeSubscription,
  // validation                                          prepareUnsubscribe, prepareUnsubscribeAll,
  subscriptionProblems, termsProblems,                   prepareInvalidateNonces, serializeTypedData,
  recommendedBuilderApproval, delegatedKeyExpiresAtMs,   nextFreeNonce, randomNonce,
  // events and the index                                // relayer
  logFilter, decodeCopyTradingLogs, attachBlockTimestamps, blocksNeedingTimestamps,
  CopyTradingIndex, ChainView,                           parseSignedAction, buildRelayTransaction,
  // executor                                            classifyRevert, isSameSignedAction,
  isServiceable, evaluatePreflight, gateSignal,          serializeSignedAction,
  builderForOrder, sodexGatewayCalls, decodeAccountsByAddress,
  // commitments                                         // governance
  executionLeaf, commitmentDocument, epochOf,            upgradeProposal, ownerCallProposal, timelockCalls,
  SkipReason, ExecutionAction,                           decodeTimelockLog, describeScheduledCall,
} from '@valuescan/copy-contract';                       // announcementSeverity, delayIsSafe
```

Integer convention (the same as viem): `uint8`..`uint48` are `number`; `uint64` and wider are `bigint`. So versions,
fees and timestamps are numbers; SoDEX account ids, stop epochs, subscription ids, nonces and deadlines are bigints.

In the snippets below, every function that is not imported from one of the two packages is your application's own:
`rpc`, `batchEthCall`, `post`, `waitForReceipt`, the `wallet` and `provider` objects, `keyService`, `keyStore`,
`index` (a `CopyTradingIndex` or `ChainView` you keep current), and the SoDEX REST readers.

## 3. Start copying

The follower is on the Valuescan site with a wallet connected, has picked a leader address (on SoDEX or Hyperliquid)
and the terms. Do the SoDEX part (3.4 and 3.5) **before** the subscription (3.6 and 3.7), so the key and the approval
exist when the executor first sees the subscription. If the subscription lands first, the executor waits in
preflight and does not trade.

### 3.1 The wallet and the SoDEX account

1. Switch the wallet to ValueChain (`wallet_switchEthereumChain`, 286623). MetaMask-style wallets refuse typed data
   whose `domain.chainId` is not the active chain. SoDEX's engine-domain signatures need the same chain, so one
   switch serves both.
2. Find the follower's SoDEX account id: a read-only `eth_call` to the ClobGateway.

```ts
const data = sodexGatewayCalls.getAccountsByAddress(follower);
const accounts = decodeAccountsByAddress(await rpc('eth_call', [{ to: SODEX_CLOB_GATEWAY, data }, 'latest']));
// No account: the follower must deposit on SoDEX first. Several: let the follower choose.
```

### 3.2 Read the chain facts (one block, batched)

```ts
const at = blockTag; // pin one block for every read below
const [domain, paused, venue, builder, stopEpoch, existing, lastId] = await batchEthCall(at, proxy, [
  [calls.eip712Domain(), results.eip712Domain],
  [calls.paused(), results.paused],
  [calls.venueInfo(venueId), results.venueInfo],
  [calls.builderTerms(), results.builderTerms],
  [calls.stopEpochOf(follower), results.stopEpochOf],
  [calls.liveSubscriptionFor(follower, accountId, venueId, leader), results.liveSubscriptionFor],
  [calls.lastSubscriptionFor(follower, accountId, venueId, leader), results.lastSubscriptionFor],
]);
if (!isExpectedDomain(domain, { verifyingContract: proxy })) throw new Error('domain changed: re-read eip712Domain');
```

`isExpectedDomain` protects against a deliberate domain bump after an upgrade (spec §10.4). After such an upgrade,
build the domain with `domainFromEip712Domain(domain)` and update the package.

### 3.3 Validate the terms

```ts
const problems = subscriptionProblems(
  { follower, venue: venueId, leader, sodexAccountId: accountId },
  terms,
  nowSeconds,
  { paused, venueEnabled: venue.enabled, existingLiveId: existing, currentStopEpoch: stopEpoch, currentLastId: lastId },
);
// problems[0] is exactly the revert the contract would raise (checked against the contract by the Foundry test).
```

There are no product limits (no cap on subscriptions, symbols, lifetime, sizing or leverage). The only bounds are
SoDEX's (builder-fee caps 200 perps / 2000 spot in tenths of a bp; key names `^[0-9a-zA-Z_-]{1,36}$`, not
`default`) and plain validity. Tell the follower before they sign that allocation, stop levels and fee consent are
public on-chain.

### 3.4 Get a delegated key

The key service generates a fresh key for (follower, account), or reuses the existing one (one key per follower and
account is recommended; it is shared by that follower's subscriptions on that account). It returns only
`{ address, name }` and records the issuance `{ delegatedKey, follower, sodexAccountId }`. Name it with
`generateApiKeyName('vs')` from sodex-core. Key names are public on SoDEX, so never put anything identifying in them.
The relayer and the executor use the issuance record (sections 6 and 7.4).

### 3.5 Authorise the key on SoDEX

**Path A (default, trade-only): two master-wallet signatures**, with `@valuescan/sodex-core`:

```ts
import { prepareApiKeyRegistration, prepareBuilderFeeApproval, assembleWalletSignedRequest,
         createNonceManager, nonceKey } from '@valuescan/sodex-core';

const nonces = createNonceManager();
const walletNonce = () => nonces.next(nonceKey(follower, 286_623));

// a) The key, with permission mask 14: TRADE enabled; CANCEL, WITHDRAW and TRANSFER disabled.
const reg = prepareApiKeyRegistration({
  userAddress: follower, accountID: accountId, name: key.name, publicKey: key.address,
  expiresAt: delegatedKeyExpiresAtMs(terms),            // ms: the subscription's expiry, or 0 for "never"
  permissions: 14,
  expiryPolicy: { maxTtlMs: Number.MAX_SAFE_INTEGER, allowNeverExpires: true }, // a server-held key, not a browser key
  nonce: await walletNonce(), sodexChainId: 286_623, signatureChainId: 286_623,
});
const req1 = assembleWalletSignedRequest(reg, await wallet.signTypedData(reg.typedData));
// fetch(req1.path, { method: req1.method, headers: req1.headers, body: req1.body }) -> parseEnvelope(...)

// b) The builder approval: one maxFeeRate for both engines.
const maxFeeRate = recommendedBuilderApproval(terms); // max(maxBuilderFeePerps, maxBuilderFeeSpot)
if (maxFeeRate > 0) {
  const appr = prepareBuilderFeeApproval({
    userAddress: follower, accountID: accountId, builderID: builder.builderId, maxFeeRate,
    nonce: await walletNonce(), sodexChainId: 286_623, signatureChainId: 286_623,
  });
  const req2 = assembleWalletSignedRequest(appr, await wallet.signTypedData(appr.typedData));
  // fetch(...)
}
```

Then verify with `GET /api/v1/user/{follower}/api-keys` (the key is listed on both engines with `permissions: 14`)
and `GET /api/v1/user/{follower}/builders` (the approval for `builderId` is at least `maxFeeRate`).

- SoDEX does not accept `builder` and `permissions` in one request. That is why Path A needs two signatures.
- Mask 14 is documented as trade-only by the schema and both SoDEX SDKs, but its enforcement has **not** been observed
  on mainnet (research report 07, G2). The UI must say "trade-only per SoDEX docs".
- Copy orders are IOC, so they never rest and the executor never needs to cancel them. Under the documented reading,
  TRADE covers cancel anyway.
- A key expires on SoDEX at `expiresAt`. If the subscription never expires (`expiry = 0`), the key never expires
  either. The executor's preflight catches expired keys (section 7.5).

**Path B (fallback, one signature): `AddAPIKeyWithBuilder`.** Call `prepareApiKeyRegistration` with
`builder: { id: builder.builderId, maxFeeRate }` instead of `permissions`. The key is an **ordinary full-permission
key**. Per SoDEX docs it can also move funds between the follower's own spot, perps and EVM balances, though not to
anyone else. Show `ORDINARY_KEY_SCOPE` (sodex-core) and ask for explicit acceptance.

**Path C (accounts owned by a contract, for example a Safe).** The owning contract sends
`sodexGatewayCalls.addAPIKey('perps', name, key.address)` (and `'spot'`) to `SODEX_CLOB_GATEWAY` itself. These keys
have no mask and never expire. No builder approval path is known for contract accounts (SoDEX has no ERC-1271), so
both fee consents must be 0.

### 3.6 Sign `Subscribe`

```ts
const req = prepareSubscribe({ verifyingContract: proxy }, {
  follower, venue: venueId, leader, sodexAccountId: accountId, terms,
  stopEpoch,                                              // stopEpochOf(follower): a kill switch voids older ones
  expectedLastId: lastId,                                 // lastSubscriptionFor(...): any later subscribe of this key voids it
  nonce: nextFreeNonce((n) => index.isNonceUsed(follower, n), pendingNonces(follower)),
  deadline: BigInt(nowSeconds + RISK_ACTION_DEADLINE_SECONDS),   // 15 minutes
});
const signature = await provider.request({
  method: 'eth_signTypedData_v4',
  params: [follower, serializeTypedData(req.typedData)],
});
```

- **Nonces.** They are unordered: bit `nonce & 0xff` of word `nonce >> 8`. Pick them sequentially, but skip every
  nonce of a message the UI signed that may still land (`pendingNonces`). Two pending messages that share a nonce
  cancel each other silently: the first to land wins (audit SEC-03). Give stops **random** nonces (`randomNonce()`,
  section 5).
- **Key history (audit SEC-04, fixed on-chain).** A Subscribe carries `expectedLastId`, the key's
  `lastSubscriptionFor` when it was signed. Any subscription that lands for the same (follower, account, venue,
  leader) afterwards voids it (`LastSubscriptionMismatch`), and a later `unsubscribe` keeps it void, so a withheld
  Subscribe can no longer restart a copy the follower stopped. Never sign a Subscribe while `existing` (the live id) is
  non-zero: it would become valid the moment that subscription stops. Change terms with an update instead.
- **Deadlines.** Keep them short for anything that starts or raises risk (Subscribe, UpdateSubscription,
  ResumeSubscription). A withheld signature stays valid until its deadline, or until the key's history, the
  subscription's version or the stop epoch moves on. Keep the UI's list of pending signed messages until each one
  lands, expires or is cancelled.

### 3.7 Relay, or call directly

```ts
const body = serializeSignedAction({ action: { type: 'Subscribe', ...inputs }, signature, chainId: 286_623,
                                     verifyingContract: proxy });
const { txHash } = await post('/relay', body);   // the relayer: section 6
const receipt = await waitForReceipt(txHash);
const subscriptionId = subscriptionIdFromReceipt(receipt, proxy);
```

A follower with SOSO may call directly: `{ to: proxy, data: calls.subscribe(venueId, leader, accountId, terms),
value: 0 }` from the follower's own wallet. The UI must offer both paths, so a relayer that is down or censoring
never blocks anyone.

### 3.8 Offer an emergency stop

Offer to pre-sign `UnsubscribeAll` with a random nonce and a one-year deadline (`EMERGENCY_STOP_DEADLINE_SECONDS`).
The follower keeps it, or hands it to Valuescan's watchdog; anyone can submit it, even while the contract is paused.
It stops whatever is live when it lands. It is cancelled only by its deadline, by `invalidateNonces`, or by a
deliberate domain bump (spec §10.4).

### 3.9 What the executor does next

It sees `Subscribed`, checks that the key is one Valuescan issued (section 7.4), runs the preflight (section 7.5),
waits 2 confirmations, and starts copying. With `copyExisting`, it also opens the leader's already open positions.

## 4. Change terms, pause, resume

| Action | Typed data | Notes |
|---|---|---|
| Update terms | `prepareUpdateSubscription({ follower, subscriptionId, expectedVersion: record.version, terms, nonce, deadline })` | Version-bound: it reverts `VersionMismatch` if anything changed since the follower looked. Venue, leader and account cannot change: stop and subscribe again. An update also renews an expired subscription. To **change the key**: register the new key on SoDEX first, then update, then revoke the old key |
| Pause (reduce-only) | `preparePauseSubscription({ follower, subscriptionId, nonce: randomNonce(), deadline })` | A stop: not version-bound, works while paused |
| Resume | `prepareResumeSubscription({ follower, subscriptionId, expectedVersion: record.version, nonce, deadline })` | Version-bound, so a withheld resume cannot undo a later pause. Blocked while the contract is paused, and after expiry (update first) |

Drawdown and take-profit counters re-arm on `Subscribed`, `SubscriptionResumed`, and `SubscriptionUpdated` while
ACTIVE (`IndexedSubscription.armedAt`). A drawdown or take-profit halt is executor state, not on-chain state. The
follower re-arms it with an update, or with a pause and a resume.

## 5. Stop copying

Run these in order. Step 1 is the public record and the executor's instruction; step 3 is the hard stop.

1. **Contract.** Choose one:
   - One subscription: `prepareUnsubscribe({ follower, subscriptionId, closePositions, nonce: randomNonce(), deadline })`,
     relayed to `unsubscribeWithSig`, or directly `calls.unsubscribe(id, closePositions)`.
   - Everything: `prepareUnsubscribeAll({ follower, closePositions, nonce: randomNonce(), deadline })`, or directly
     `calls.unsubscribeAll(closePositions)`. This is the kill switch: it costs the same gas for 1 or 10,000
     subscriptions. It raises the follower's stop epoch, so every older live subscription is STOPPED at once, and it
     also voids every pending signed Subscribe.

   Both work while the contract is paused. Stops use random nonces, so no earlier resume or update can consume a stop's
   nonce.
2. **Cancel pending signatures.** If the UI signed a Subscribe, an update or a resume that has not landed, cancel it:
   `prepareInvalidateNonces({ follower, word: n >> 8n, mask: 1n << (n & 0xffn), nonce: randomNonce(), deadline })`, or
   directly `calls.invalidateNonces(word, mask)`. Since the SEC-04 fix, a pending Subscribe for a key that got a
   subscription after it was signed is already void on-chain, and the kill switch voids every pending Subscribe; a
   pending Subscribe for a key that never had a subscription is voided only by its deadline or by this step. Updates
   and resumes of a stopped subscription revert anyway (`InvalidStatus`).
3. **Flatten.** If `closePositions`, wait until the executor reports the subscription flat (it has 60 s, best
   effort).
4. **Revoke the SoDEX key** once no live subscription uses it: `index.liveSubscriptionsUsingKey(key)` is empty.
   - Off-chain and gasless, with sodex-core: `prepareApiKeyRevocationBothEngines({ userAddress: follower, accountID,
     name, nonces: [await walletNonce(), await walletNonce()], sodexChainId: 286_623 })`. This needs two wallet
     signatures on the engine domains (wallet on ValueChain), then two `DELETE /api/v1/{spot,perps}/accounts/api-keys`
     requests. The route is documented, but this codebase has not exercised it yet.
   - On-chain (needs SOSO): the account owner sends `sodexGatewayCalls.revokeAPIKey('spot', name)` and
     `sodexGatewayCalls.revokeAPIKey('perps', name)` to `SODEX_CLOB_GATEWAY`. It takes effect after at least one
     block plus engine ingest. Whether it also removes keys registered through REST is not verified yet.
5. **Optionally clear the builder approval** if no Valuescan subscription remains:
   `prepareBuilderFeeApproval({ ..., maxFeeRate: 0 })`. This frees one of the follower's 10 approval slots.

**Emergency:** revoke the key first (step 4, a hard stop that SoDEX enforces, independent of Valuescan and of any
upgrade), then the kill switch. An EIP-7702-delegated follower may batch `unsubscribeAll` with both on-chain
`revokeAPIKey` calls in one transaction.

## 6. The relayer's duties

The relayer is untrusted by design: every field is bound by the signature. It can only submit or withhold, and the
follower can always go elsewhere. Its duties:

1. **Accept** `POST /relay` with a `serializeSignedAction` body. `parseSignedAction(body, limits)` is strict and
   bigint-safe. `ParseLimits` sets the relayer's resource limits (body size, number and length of symbols, signature
   length). These are relay policy, not protocol limits.
2. **Rate-limit** per signer and per IP (`FixedWindowLimiter`, `RELAY_LIMITS`). Stops (`isStopAction`) have their own,
   looser bucket, so a follower who hit the subscribe limit can still stop.
3. **Check policy against fresh chain facts,** read at one block:

   ```ts
   const tx = buildRelayTransaction(signed, {
     contract: proxy, now,
     currentStopEpoch,        // Subscribe: stopEpochOf(follower)
     currentLastId,           // Subscribe: lastSubscriptionFor(follower, sodexAccountId, venue, leader)
     currentVersion,          // update and resume: getSubscription(id).version
     subscriptionFollower,    // id-based actions: getSubscription(id).follower
     subscriptionAccount,     // update: getSubscription(id).sodexAccountId
     paused,
     isValuescanKey: (key, follower, account) => keyService.issuedFor(key, follower, account),
   });
   if (tx.problems.length) return reject(422, tx.problems);
   ```

   `isValuescanKey` is the spam defence: relay a Subscribe or an update only if its delegated key is one Valuescan
   issued for exactly that follower and account. Anyone can record a subscription to any leader with any key, and
   without this check Valuescan's relayer would pay for it. Stops are always relayed.
4. **Normalise the signature.** Wallets produce `v` 0/1, high-`s` or 64-byte signatures, and OpenZeppelin's ECDSA
   rejects all three. `buildRelayTransaction` rewrites them to 65 bytes, `v` 27/28, low `s` (`tx.path === 'ecdsa'`).
   For anything else (`'erc1271?'`, a smart wallet) it passes the bytes through.
5. **Simulate** with `eth_call({ from: relayer, to: tx.to, data: tx.data })`. On a revert, `classifyRevert(data)`:

   | Class | Errors | Answer |
   |---|---|---|
   | `already-used` | `NonceAlreadyUsed` | See 7. below |
   | `expired` | `SignatureExpired` | Ask the follower to sign again |
   | `bad-signature` | `InvalidSignature` | Wrong account, chain or contract, or an ERC-1271 wallet said no |
   | `stale` | `VersionMismatch`, `InvalidStatus`, `StopEpochMismatch`, `LastSubscriptionMismatch` | Refresh and re-sign. For `LastSubscriptionMismatch` the key got a subscription since the follower signed: ask the follower, never re-sign automatically |
   | `paused` | `EnforcedPause` | New activity is paused; stops still work |
   | `rejected` | `InvalidTerms`, `UnknownSubscription`, `DuplicateSubscription`, `VenueDisabled`, `NotFollower`, `FundsNotAccepted` | Show the error; do not retry |
   | `unknown` | Empty or undecodable data | Out of gas or RPC trouble; retry the simulation, never re-sign |
6. **Send immediately,** with `value: 0` and gas at most `tx.gasLimit` (2 M caps ERC-1271 gas griefing). Never hold a
   signature for later, never queue it behind anything, and never submit after its deadline. The contract now voids
   a held Subscribe once its key gets a subscription (SEC-04 fix), but a held Subscribe for a fresh key still lands
   until its deadline.
7. **Idempotency.** `NonceAlreadyUsed(signer, nonce)` does **not** prove that *this* message landed. Another message
   with the same nonce may have consumed it (audit SEC-03). Find the `NonceUsed(signer, nonce)` log, fetch its
   transaction, and check `isSameSignedAction({ verifyingContract: proxy }, action, tx.input, followerOf)`. Only
   `true` means done; `false` means not done, and the follower must re-sign with a fresh nonce.
8. **Report** `{ txHash }` to the UI, and read the result from the receipt (`eventsFromReceipt`,
   `subscriptionIdFromReceipt`).
9. **Operate:** monitor the SOSO float, alert early, and keep the relayer key's only asset SOSO. It has no role on
   the contract.

## 7. The executor loop

### 7.1 Bootstrap

```ts
const view = new ChainView(proxy, ACTIVATION_CONFIRMATIONS);      // 2
for (let from = deployBlock; from <= head; from += 2_000n) {
  const to = min(from + 1_999n, head);
  const logs = await rpc('eth_getLogs', [logFilter(proxy, from, to)]);
  let events = decodeCopyTradingLogs(logs, proxy);
  const blocks = blocksNeedingTimestamps(events);                  // KillSwitchTriggered, ExecutorSet, ...
  events = attachBlockTimestamps(events, await blockTimestamps(blocks)); // eth_getBlockByNumber(n, false).timestamp
  view.update(to, events);
}
```

Persist `view.confirmed().clone()` snapshots, keyed by `confirmedBlock`, so a restart does not replay from the
deployment block. There is no cold start from views alone: the symbol lists exist only in the events.

### 7.2 Follow

Poll every block (about 2 s): read the new head, fetch the logs of the new blocks, and call
`view.update(head, events)`. Keep the hashes of the last few blocks. If one changes (a reorg), refetch from the first
changed block and call `view.update(head, events, reorgFrom)`. A reorg deeper than the confirmed line throws
`DeepReorgError`: rebuild from a snapshot. How deep ValueChain can reorg is still an open question (spec §16, Q10).

### 7.3 React to events

Act on stops at the **tip** (`view.tip()`, 0 confirmations). A reorg that removes a stop only made the executor more
conservative. Open or increase positions only if `view.mayOpen(id, now)`: copyable at the tip **and** in the
confirmed view.

| Event | Executor action |
|---|---|
| `Subscribed` | New work (section 7.4). Activation waits 2 confirmations |
| `SubscriptionUpdated` | Act on the latest version only; drop work queued for older versions. A key change or a tightened bound is a stop-type event (SLA) |
| `SubscriptionPaused` | Reduce-only within the SLA |
| `SubscriptionResumed` | Re-arm counters; activation waits 2 confirmations |
| `SubscriptionStopped` | Wind down: cancel resting copy orders, flatten if `closePositions`, stop using the key for it |
| `KillSwitchTriggered` | **The only event for a kill switch.** Wind down every id in `index.killedBy(follower, stopEpoch)`, with `closePositions` from the event. The records do not change, so apply the stop-epoch rule (`statusOf` does) |
| `BuilderTermsUpdated` | Nothing: `effectiveBuilderFee` is computed on read, min(current fee, consent) |
| `ExecutorSet` | If this executor was de-authorised: stop committing and alert. Trading is unaffected |
| `VenueUpdated`, `Paused`, `Unpaused` | Nothing for existing subscriptions: both only gate NEW activity |
| `Upgraded`, `EIP712DomainChanged` | Section 8.4 |

**Stop SLA: 10 s** from the timestamp of the block that contains the stop (`stopDeadline(blockTimestamp)`); the target
is 2 blocks. After it, the executor places no opening or increasing order for that subscription.

### 7.4 Serve only what Valuescan issued

```ts
const serviceable = (r: Subscription) => isServiceable(r, (key) => keyStore.issuance(key));
```

Skip every subscription whose delegated key Valuescan did not issue for exactly that follower and account: no
preflight, no fan-out, no reconciliation. Anyone can record any number of subscriptions to any leader, with fake keys
and fake accounts, and the contract cannot tell them apart. This filter makes that cost nothing.

### 7.5 Preflight: before the first order and after every update

```ts
const pre = evaluatePreflight({
  subscription: index.getSubscription(id)!,
  now,
  followerAccounts: decodeAccountsByAddress(await ethCall(SODEX_CLOB_GATEWAY, sodexGatewayCalls.getAccountsByAddress(r.follower))),
  apiKeys: { perps: await sodexKeys('perps', r.sodexAccountId), spot: await sodexKeys('spot', r.sodexAccountId) },
  keyStoreHasKey: keyStore.has(r.delegatedKey),
  builderApproval: await sodexBuilderApproval(r.follower, builder.builderId), // GET /api/v1/user/{follower}/builders
  effective: index.effectiveBuilderFee(id)!,
});
if (!pre.ok) { report(id, pre.problems); recheckAfter(PREFLIGHT_RECHECK_SECONDS); }
```

It checks that the follower owns the account, that the key is registered under `keyName` with public key
`delegatedKey` on every engine in scope and has not expired, that Valuescan holds the private key, and the builder
approval. `pre.feeCeiling` is min(effective fee, approval) per engine. `pre.notes` flags an ordinary (full-permission)
key where a mask-14 key was expected.

### 7.6 Per leader fill

```ts
for (const sub of index.subscriptionsForLeader(venue, leader)) {
  if (!serviceable(sub.record)) continue;
  const d = gateSignal(index, sub.id, { sodexSymbol, engine, increases, leaderOrderSigner, signalTimeMs, nowMs });
  if (!d.go) { recordLeaf(sub, ExecutionAction.SKIP, d.skipReason); continue; }
  if (increases && !view.mayOpen(sub.id, nowSeconds)) { recordLeaf(sub, ExecutionAction.SKIP, SkipReason.NOT_COPYABLE); continue; }
  const order = size(sub, fill);                  // spec §4.5 sizing and clipping: the executor's own code
  const fee = builderForOrder({
    effective: index.effectiveBuilderFee(sub.id)!, engine, reduceOnly: !increases,
    approvedMaxFeeRate: approval(sub.record.follower),
  });
  if (!fee.trade) { recordLeaf(sub, ExecutionAction.SKIP, SkipReason.NO_BUILDER_APPROVAL); continue; }
  const action = engine === 'perps'
    ? perpsActions.newOrder(sub.record.sodexAccountId, symbolId, [order], fee.builder ?? undefined)
    : spotActions.batchNewOrder(sub.record.sodexAccountId, [order], fee.builder ?? undefined);
  const key = signingKeyFrom(keyStore.tradingKey(sub.record.delegatedKey),
                             { name: sub.record.keyName, expiresAt: keyExpiryMs });
  const req = await signAndBuildWithNonceManager(action, key, { chainId: 286_623, nonces: executorNonces });
  // fetch(req.path, ...) -> parseEnvelope(...); record a MIRROR leaf with the clobscan tx hash
}
```

- `gateSignal` checks, in order: the subscription is live, cycle protection, staleness (2 s), the SoDEX symbol
  mapping, `marketScope`, the symbol filter, and reduce-only for PAUSED or expired subscriptions.
  - Cycle protection: `index.isDelegatedKey(leaderOrderSigner)`. A fill from an order signed by a key Valuescan
    executes for is a copy, not a leader decision; skipping it breaks A-copies-B-copies-A loops.
- Copy orders are IOC with limit = reference ± `slippageBps` (`OrderType.LIMIT`, `TimeInForce.IOC` in sodex-core).
  The reference is the leader's fill price for mirrors, and the mark price for `copyExisting` openings and risk
  closes.
- `builderForOrder` never attaches more than the effective fee (min(current fee, consent)) or the SoDEX approval.
  By default it puts no fee on reduce-only orders. A consent of 0 means no `builder` field at all. A missing approval
  blocks opening orders, never reductions.
- The executor uses one `createMemoryNonceManager()` from sodex-core; it keeps nonces per signing key. Never replay a
  signed write: `isTransientFailure` in sodex-core is for reads only.

### 7.7 Execution commitments

```ts
const epoch = epochOf(windowStart);                         // the unix hour
const doc = commitmentDocument(executorAddress, epoch, records);  // every record, its leaf and proof
const uri = await publish(doc.json);                        // IPFS or HTTPS, immutable
const data = calls.commitExecutions(epoch, doc.root, doc.count, uri);
// sent by the executor EOA (setExecutor-authorised), within an hour after the epoch ends; epochs strictly increase
```

Record every decision, skips included, with the documented `SkipReason` codes. Leaf format v1 is in spec §7.2. Anyone
can check a published record: `verifyExecution(await commitment(executor, epoch), record, proof)`, then the order on
clobscan. An order signed by the delegated key that no commitment lists is a violation.

### 7.8 Hourly reconciliation

Every hour, read the serviceable subscriptions through the views at one pinned block (`getSubscription`, `statusOf`,
`stopEpochOf`, `liveSubscriptionsOfFollower`; batch the `eth_call`s and paginate) and compare them with the index.
Alert on any difference; never "fix" it by trading. `test/vectors.test.ts` proves that the index answers every view
exactly as the contract does.

## 8. Upgrades through the timelock

The owner of the proxy is a TimelockController (delay 48 h, no admin), and the multisig is its only proposer,
executor and canceller. Every owner action waits 48 h: upgrades, builder terms, venues, executors and pause.

### 8.1 Proposing (the multisig)

```ts
const op = upgradeProposal({ proxy, newImplementation, initData: '0x', salt: saltFromLabel('v1.1.0') });
// Safe transaction:  to = timelock, data = timelockCalls.schedule(op)       (announces; starts the 48 h)
// after 48 h:        to = timelock, data = timelockCalls.execute(op)        (the upgrade takes effect)
// to abort:          to = timelock, data = timelockCalls.cancel(op.id)
const feeChange = ownerCallProposal({ target: proxy, data: calls.setBuilderTerms(builderId, 60, 100), salt: saltFromLabel('fees-2026-10') });
```

Check before proposing:

- the storage-layout guard (`node tools/storage-layout.mjs check`) and the full Foundry suite, including
  `CrossCheckVectors.t.sol`;
- the EIP-170 size;
- a new `VERSION()`;
- the EIP-712 name and version are unchanged, unless the bump is deliberate and announced (spec §10.4);
- if the ABI or any type changed: `npm run abi` and `npm run vectors` in `packages/copy-contract`, then its tests;
- **enum ordinals unchanged.** Since the SEC-01 fix, `node tools/storage-layout.mjs check` rejects any enum change
  except an append, and `test/upgrade/StorageLayout.t.sol` (`test_enumOrdinalsArePinned`) pins every ordinal. A
  renumbered enum would make an indexer misread every status, so still review the interface diff by hand;
  `packages/copy-contract/test/constants.test.ts` pins the ordinals the package assumes.

`contracts/test/CrossCheckVectors.t.sol` (`test_timelockGovernance`) runs exactly this flow through a real
TimelockController: ownership moves to the timelock through its own delay, an early execute reverts, and the upgrade
executes after 48 h. A signature made before the upgrade still lands afterwards.

### 8.2 Announcing (the monitor, the UI)

Watch **every** timelock event, not only calls that target the proxy:

```ts
for (const log of await rpc('eth_getLogs', [{ address: timelock, fromBlock, toBlock }])) {
  const ev = decodeTimelockLog(log, timelock);
  if (!ev) continue;
  if (ev.eventName === 'CallScheduled') {
    const what = describeScheduledCall(ev.args, proxy, timelock);  // upgrade | owner-call | timelock-admin | ...
    if (announcementSeverity(what) === 'critical') alertFollowers(what, readyAt(blockTimestamp, ev.args.delay));
  }
  if (ev.eventName === 'MinDelayChange' && !delayIsSafe(ev.args.newDuration)) alertFollowers('notice window reduced');
  if (ev.eventName === 'RoleGranted' || ev.eventName === 'RoleRevoked') alertFollowers('timelock roles changed');
}
```

- A call on the **timelock itself** (`updateDelay`, `grantRole`, `revokeRole`) is as serious as an upgrade. It can
  lower the delay after 48 h, and the next upgrade could then execute in the same block it is scheduled (audit
  SEC-02). Check `delayIsSafe(getMinDelay())` at start-up too.
- For a critical announcement, the UI shows a banner to every follower with a live subscription and sends push or
  e-mail. It shows the time the call becomes executable, the new implementation's verified source, the diff, and the
  storage-layout check. Followers who do not accept the upgrade stop and revoke their key within the window
  (section 5).

### 8.3 After the upgrade

- Treat `Upgraded(newImpl)` as a schema checkpoint. Re-read `VERSION()`, and continue with the event ABI of that
  version. Stop and alert if `VERSION()` is not one the package knows.
- On `EIP712DomainChanged`, re-read `eip712Domain()`. Tell followers that pending signatures and pre-signed emergency
  stops are void, and ask them to re-sign.
- Re-run the hourly reconciliation (section 7.8) at once.

## 9. Reference

### 9.1 Events

Every state change emits an event, and an indexer starting at the deployment block needs no call (spec §9).

| Event | Carries | Index rule |
|---|---|---|
| `Subscribed(id, follower, leader, subscription, symbols)` | The full record and the symbol list | New record; its symbol list must hash to `symbolsHash` (`symbolsMatchCommitment`) |
| `SubscriptionUpdated(id, follower, subscription, symbols)` | The full new record and list | Full replacement; version + 1 |
| `SubscriptionPaused` / `SubscriptionResumed(id, follower, version, updatedAt)` | | Status, version, updatedAt |
| `SubscriptionStopped(id, follower, closePositions, version, updatedAt)` | | STOPPED; leaves the live set (swap-and-pop) |
| `KillSwitchTriggered(follower, stopEpoch, closePositions)` | One event per kill switch | Every older ACTIVE or PAUSED subscription of the follower is STOPPED; nothing else is emitted |
| `NonceUsed(signer, nonce)` / `NoncesInvalidated(signer, word, mask)` | | Nonce bitmap. `NonceUsed` does not say which message used the nonce |
| `ExecutorSet`, `ExecutionsCommitted`, `BuilderTermsUpdated`, `VenueUpdated` | | Need the block timestamp (`attachBlockTimestamps`) where the rule stores a time |
| OpenZeppelin `Paused`, `Unpaused`, `OwnershipTransferStarted`, `OwnershipTransferred`, `Upgraded`, `Initialized`, `EIP712DomainChanged` | | Governance state |

### 9.2 Errors

| Error | Meaning |
|---|---|
| `InvalidTerms(field)` | A terms or target field is invalid; `field` is a `TermsField` ordinal. `termsProblems` reports the same field first |
| `VenueDisabled(venue)` | Unknown or disabled venue (new subscriptions only) |
| `DuplicateSubscription(id)` | A live subscription to this leader, venue and account exists (a correctness guard, spec §5.3) |
| `StopEpochMismatch(follower, expected, actual)` | The Subscribe was signed before a kill switch |
| `LastSubscriptionMismatch(expected, actual)` | The Subscribe was signed for an older history of its key: a subscription for the same (follower, account, venue, leader) was created since (audit SEC-04) |
| `VersionMismatch(id, expected, actual)` | The update or resume was signed for another version |
| `InvalidStatus(id, status)` | The effective status does not allow the action |
| `NotFollower(id, caller)` / `UnknownSubscription(id)` | Wrong caller, or no such id |
| `SignatureExpired(deadline)` / `NonceAlreadyUsed(signer, nonce)` / `InvalidSignature(signer)` | Signature checks, in that order |
| `EnforcedPause()` | The owner paused subscribe, update and resume |
| `NotExecutor(caller)` / `EpochNotIncreasing(last, epoch)` | Commitments |
| `FundsNotAccepted()` | A call carried value (only `upgradeToAndCall` is payable, and it rejects value) |

## 10. Test vectors and the cross-check

```bash
cd packages/copy-contract
npx tsx --test test/*.test.ts      # 95 tests: the package against viem, the Solidity sources and the vectors
npm run typecheck                  # src/ with no Node or DOM typings; tests and tools with Node typings
npm run vectors:check              # test/vectors.json and CrossCheckVectors.t.sol are up to date
npm run abi:check                  # the committed ABIs equal contracts/out (after forge build)

cd ../../contracts
forge test --match-path test/CrossCheckVectors.t.sol    # the contract agrees with every vector (8 tests)
```

`tools/gen-vectors.ts` builds one scenario and writes both `test/vectors.json` and
`contracts/test/CrossCheckVectors.t.sol`, so the two cannot drift apart. The keys are TEST-ONLY: keccak256 of the
public labels in the file. They are published, so never fund them. The Foundry test deploys the V1 implementation and
the proxy at fixed addresses, initialised with the package's `initialize` calldata, inside the test EVM only. It
checks:

- **Digests.** Foundry's `vm.eip712HashTypedData` on the package's `eth_signTypedData_v4` JSON gives the package's
  digest for every signed vector, and so does a Solidity recomputation from the package's calldata with the contract's
  own type hashes and `DOMAIN_SEPARATOR()`.
- **The contract's own digest.** An ERC-1271 wallet follower signs all 7 action types, and `vm.expectCall` asserts
  that the contract asked the wallet about exactly the package's digest. EOA signatures over the same digests are
  accepted.
- **Signers.** `vm.sign` with the TEST key reproduces the package's 65 bytes, and `ecrecover` gives the expected
  signer.
- **The scenario** (42 steps: relayed, direct, executor, owner). Every log, return value and revert payload is compared.
  It includes:
  - the kill switch while paused;
  - a Subscribe voided by the stop epoch;
  - a Subscribe withheld by the relayer, then voided by a direct subscribe and stop of the same key
    (`LastSubscriptionMismatch`, audit SEC-04);
  - a `v` = 0/1 signature that must be normalised;
  - a replay, a wrong key, an expired deadline;
  - a duplicate, a disabled venue, a stranger.
- **92 views afterwards,** including the stop-epoch rule and the live set's swap-and-pop order. `vectors.test.ts`
  shows that an index rebuilt only from the logs answers all of them the same way.
- **63 invalid-terms cases.** `validate.ts`'s first problem is exactly the contract's revert, for single and combined
  faults.
- **Commitments:** the leaf format re-encoded in Solidity, and every proof verified with OpenZeppelin's `MerkleProof`.
- **Governance:** the timelock flow of section 8.1.

## 11. Open points

- **SoDEX, not yet verified:**
  - whether mask-14 keys are enforced as trade-only on mainnet;
  - which key-revocation route the gateway accepts (the documented `DELETE` has not been exercised);
  - whether an on-chain `revokeAPIKey` removes keys registered through REST;
  - how long key changes take to propagate;
  - the real per-account key limit;
  - builder approvals for contract-owned accounts.

  See spec §16 Q9 and research reports 07 and 08.
- **Audit findings** (all tests in `contracts/test/audit/` now pass as regression tests; see the Audit log below):
  - SEC-04 is fixed in the contract (key-history binding), and SEC-01 in the storage-layout guard.
  - SEC-02 and SEC-03 are closed off-chain by this guide: monitor every `CallScheduled` of the timelock (and
    `delayIsSafe`); digest-based idempotency and random nonces for stops. Their on-chain variants (a timelock delay
    floor, a digest in `NonceUsed`) are the owner's decision (spec §16, Q14 and Q15).
- **ValueChain reorg depth** decides the confirmation count (default 2) and the snapshot depth.

## 12. Audit log (2026-09-25)

The full table (findings, verdicts, resolutions and regression tests) is in the spec's
[Audit log](COPY-TRADING.md#audit-log-2026-09-25). What changed for integrators:

**SEC-04 (medium), fixed in the contract: a withheld Subscribe can no longer restart a stopped copy.**

- The `Subscribe` type has a new field after `stopEpoch`: `uint256 expectedLastId`. The type hash is now
  `0x9f83367e0514f6df54c98de57d31d3931ff835719531b30ebe06c8ba66ab81e1`. Signatures made for the previous type do not
  verify; nothing was deployed, so none exist in the field.
- `subscribeWithSig(follower, venue, leader, sodexAccountId, terms, stopEpoch, expectedLastId, sig)`: the new argument
  sits before `sig`.
- New view `lastSubscriptionFor(follower, sodexAccountId, venue, leader)`: the last id ever created for the key, live
  or not (0 for none). Sign it as `expectedLastId` (section 3.6). `liveSubscriptionFor` is unchanged.
- New error `LastSubscriptionMismatch(expected, actual)`: the key got a subscription after the follower signed. The
  relayer classifies it as `stale`, but asks the follower instead of re-signing automatically (section 6).
- SDK: `calls.lastSubscriptionFor` / `results.lastSubscriptionFor`, `SubscribeInput.expectedLastId`,
  `ChainChecks.currentLastId` with the new `LAST_SUBSCRIPTION` problem in `subscriptionProblems(…, signedLastId)`,
  `RelayContext.currentLastId`, and `index.lastSubscriptionFor` (the index no longer drops the key on a stop, exactly
  like the contract).
- `test/vectors.json` and `contracts/test/CrossCheckVectors.t.sol` were regenerated: 42 steps (three new ones replay
  the auditor's attack and expect `LastSubscriptionMismatch(0, id)`), 92 views, 26 signed vectors.

**SEC-01 (medium), fixed in the storage-layout guard.** `node tools/storage-layout.mjs check` now rejects any enum
change except an append, and `StorageLayout.t.sol` pins every ordinal (section 8.1).

**Leader spam (medium), fixed in the executor and relayer rules.** Nothing on-chain links a follower to its SoDEX
account and there are no limits, so spam subscriptions are cheap. The executor admits a subscription to the leader
fan-out only after preflight and serves only keys Valuescan issued (sections 7.4 and 7.5); stops travel on their own
topic-filtered path; the relayer relays only Valuescan-issued keys for the follower's own account (section 6). Spec
§6.7 and §8.3 make this normative.

**SEC-02 and SEC-03 (low), closed off-chain; the on-chain variants are open owner decisions.** Monitor every
`CallScheduled` of the timelock, including calls on the timelock itself (section 8.2, spec Q14). Check idempotency
against the landed transaction's digest, never against `NonceUsed` alone, and give stops random nonces (sections 3.6
and 6, spec Q15).

**Verification** (local only, nothing deployed or broadcast): `forge test` 235/235 in 23 suites, invariants included; `CrossCheckVectors.t.sol` 8/8;
`npx tsx --test test/*.test.ts` 95/95; `tsc` typecheck clean; `abi:check` and `vectors:check` up to date.
