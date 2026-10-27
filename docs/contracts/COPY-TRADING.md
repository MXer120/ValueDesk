# ValueDesk copy trading contract: specification v1 (upgradeable)

| | |
|---|---|
| Contract | `ValuescanCopyTrading` implementation `1.0.0` behind an ERC-1967 proxy (UUPS). EIP-712 domain `ValuescanCopyTrading` / `1` |
| Chain | ValueChain (EVM, chain id 286623, native gas token SOSO, Prague rules, ~2 s blocks), where SoDEX settles |
| Interface (normative for names, types, events, errors) | [`contracts/src/interfaces/IValuescanCopyTrading.sol`](../../contracts/src/interfaces/IValuescanCopyTrading.sol) |
| Implementation | [`contracts/src/ValuescanCopyTrading.sol`](../../contracts/src/ValuescanCopyTrading.sol) |
| This document (normative for behaviour) | `docs/contracts/COPY-TRADING.md` |
| Storage-layout snapshot | [`contracts/storage-layout/ValuescanCopyTrading.json`](../../contracts/storage-layout/ValuescanCopyTrading.json), checked by `contracts/tools/storage-layout.mjs` |
| Toolchain | Foundry 1.8.3, solc 0.8.36 (via-IR), `evm_version = prague`, OpenZeppelin Contracts and Contracts Upgradeable 5.7.0 (see [`contracts/README.md`](../../contracts/README.md)) |
| Status | Implemented and tested, 2026-09-25. **Nothing is deployed.** Nothing may be deployed or broadcast without the owner's explicit go. |

Words in capitals (MUST, MUST NOT, SHOULD, MAY) are used as in RFC 2119.

### What changed in this revision

The owner's decisions of 2026-09-25 ("No why. No limits, no possibility to opt out of being copied. Why would the
contract not be upgradable?") replace the previous draft:

1. **No leader opt-out.** Leaders have no role in the contract. Any address can be copied.
2. **No permissionless operators.** ValueDesk runs the executor. An owner-managed set of executor addresses publishes
   the execution commitments. Each subscription still records the follower's delegated SoDEX API key (address and
   name).
3. **No limits.** There is no cap on subscriptions per follower, no cap on the lifetime (expiry 0 = never), and no
   cap on symbol lists, symbol length, sizing, leverage or take profit. The only bounds left are SoDEX's rules and
   plain validity checks. The kill switch is O(1), and no function loops over a stored list.
4. **Upgradeable.** UUPS behind an ERC1967Proxy, ERC-7201 storage, a locked implementation, owner-only upgrades, and
   a 48 h TimelockController in front of a multisig as the recommended owner. The EIP-712 domain is stable across
   upgrades, and a storage-layout guard is in place.

Appendix B lists the removed and added items.

**Audit fixes (2026-09-25, same day; details in the [Audit log](#audit-log-2026-09-25)):** a signed `Subscribe` is now
also bound to the last subscription of its (follower, account, venue, leader) key, so a per-leader stop voids withheld
Subscribes (SEC-04, §6.6); the storage-layout guard pins the members of every stored enum (SEC-01, §10.3); the relayer
rules, nonce advice and timelock monitoring are corrected (SEC-02, SEC-03; §6.5, §6.7, §10.2); and executor admission
control against spam subscriptions is normative (§8.3).

---

## 1. The product model this contract serves

In the owner's words: an on-chain copy trading platform based on SoDEX's builder codes and SDK. ValueDesk tracks and
analyses on-chain addresses with high win rates and high PnL. Users decide themselves whether to switch on copy
trading for an address. The trades are executed on SoDEX. "We don't move funds. SoDEX handles ALL of that already. We
JUST need the copy trading contract."

So:

- **Funds, margin, deposits, withdrawals and settlement are 100 % SoDEX's job.** Every follower trades from their own
  SoDEX account.
- **Execution is off-chain**, with SoDEX's SDK. ValueDesk's executor watches the leader and places mirrored orders on
  the follower's SoDEX account. The orders are signed by a delegated SoDEX API key the follower authorised, and they
  carry ValueDesk's **builder code**. SoDEX credits builder fees to ValueDesk in real time. Builder fees are
  ValueDesk's revenue.
- **The contract is the public, auditable record** of copy trading. It records:
  - who copies which leader address (on SoDEX or Hyperliquid; always executed on SoDEX);
  - under which sizing and risk rules;
  - through which delegated key;
  - at which maximum builder fee the follower consented to;
  - when copying started, paused or stopped.

  ValueDesk's executors also publish commitments to what they executed.

## 2. What the contract does and never does

| The contract does | The contract never does |
|---|---|
| Records subscriptions (follower → leader address on a venue), their terms and status | Hold, receive, escrow, move or account for funds |
| Records the delegated SoDEX key (address and name) per subscription | Call SoDEX, or add or revoke SoDEX keys (the gateway requires `msg.sender` = account owner) |
| Records the follower's builder-fee consent and ValueDesk's current builder terms | Settle, split or distribute fees |
| Lets anyone submit a follower's signed action (gasless for the follower) | Verify trades or enforce sizing and risk on SoDEX |
| Keeps an owner-managed set of executor addresses and their execution commitments | Have a `receive` or `fallback` function, a payable function of its own, token calls, or a balance-dependent path |
| Emits events from which the whole state can be rebuilt | Let the owner, an executor or a relayer change a follower's subscription |
| Can be upgraded by its owner (the timelock) | Loop over a stored list |

The external calls the contract makes are these:

- a `STATICCALL` to a signer's own smart wallet, to check an ERC-1271 signature;
- in an owner-only upgrade, OpenZeppelin's `proxiableUUID` check on the new implementation and the optional
  `DELEGATECALL` of its re-initializer.

## 3. Roles and trust

| Role | Who | Can | Cannot |
|---|---|---|---|
| **Follower** | The master wallet that owns the SoDEX account being traded (EOA, EIP-7702 account or ERC-1271 smart wallet) | Create, update, pause, resume and stop its own subscriptions, directly or by EIP-712 signature; trigger its kill switch; invalidate its nonces | Change anyone else's subscription |
| **Leader** | Any address on a venue (SoDEX, Hyperliquid, others the owner adds) | Nothing: leaders have no role and need no opt-in | Opt out, or influence subscriptions to it |
| **Executor** | One of ValueDesk's executor addresses, authorised by the owner | Publish execution commitments | Change any subscription |
| **Relayer** | Anyone who submits a `...WithSig` call and pays the gas (ValueDesk runs one) | Choose whether and when (before the deadline) to submit a signed action | Change anything the signer signed; act without a valid signature |
| **Owner** | `Ownable2Step` owner. Recommended: a TimelockController (48 h) whose proposer and executor is a multisig (§10.2) | Set builder terms within SoDEX's caps; enable or disable venues for new subscriptions; authorise executors; pause new activity; **upgrade the implementation** | Outside an upgrade: touch subscriptions, stop epochs, commitments or nonces; make any follower pay a builder fee above its consent; renounce ownership |
| **SoDEX** | The exchange | Custody, margin, matching, settlement, API-key and builder-fee enforcement | (Not controlled by this contract) |

Where each rule is enforced:

| Rule | Enforced by |
|---|---|
| Funds cannot be paid to a third party | SoDEX: EVM withdrawals pay the account owner only; internal transfers are documented as unsupported (report 07, G5) |
| The executor's key cannot withdraw or transfer | SoDEX, **if** the follower registered a mask-14 key. Documented, **not yet observed on mainnet** (report 07, G2) |
| Per-order builder fee ≤ the follower's SoDEX approval and ≤ the engine cap | SoDEX |
| Per-order builder fee ≤ the consent recorded here | Executor honesty, publicly auditable: every SoDEX order carries `builder{id, fee}` and is visible on clobscan, and executors commit to their executions |
| Sizing, leverage, notional, slippage, symbol, stop-loss rules | Executor honesty, auditable in the same way |
| Stop copying | The contract records the stop (always possible, O(1)). The executor stops within the SLA (§8.3). The **hard** stop is revoking the SoDEX key, which SoDEX enforces and no upgrade can prevent |
| Only the follower changes its subscription | This contract (and, across upgrades, the timelock delay: §10) |

## 4. Data model

### 4.1 Identifiers

| Thing | Representation |
|---|---|
| Subscription | `uint256` id, sequential from 1. `0` means "none" |
| Venue | `uint8` id in an owner-managed registry: `1` = SoDEX and `2` = Hyperliquid are enabled by `initialize`. More ids can be added without an upgrade. `0` is never valid |
| Leader | `address` on that venue. SoDEX and Hyperliquid both use 20-byte EVM addresses |
| Follower's SoDEX account | `uint64 sodexAccountId`: the primary account or, once SoDEX offers them, a sub-account. The executor checks off-chain that the follower owns it (§8.3) |
| Delegated key | `address delegatedKey` (the key's EVM address, SoDEX `keyType` 1) plus `string keyName` (the name it is registered under on SoDEX) |
| Symbol | `string`, the SoDEX symbol name exactly as SoDEX lists it (for example `BTC-USD`) |

### 4.2 Terms (follower-chosen, signed)

All fields are validated on `subscribe` and `updateSubscription` (direct and signed). A failed check reverts with
`InvalidTerms(TermsField)`. **There are no product limits.** The table lists every bound that remains and why.

| Field | Type | Unit | Bound | Why this bound exists |
|---|---|---|---|---|
| `delegatedKey` | address | | `!= 0`, `!= follower` | Validity: a key must exist, and the master key is never delegated |
| `keyName` | string | | SoDEX's rule `^[0-9a-zA-Z_-]{1,36}$`, not `default` | **SoDEX rule** (36 is SoDEX's maximum; `default` is the master key's reserved name) |
| `marketScope` | enum | | `PERPS`, `SPOT` or `PERPS_AND_SPOT` | Validity |
| `sizingMode` | enum | | `PROPORTIONAL`, `FIXED_RATIO`, `FIXED_NOTIONAL` | Validity |
| `sizingValue` | uint64 | ppm, or USD 6 dec | `> 0`; for `FIXED_NOTIONAL` also `≤ maxPositionNotional` | Validity and consistency (a fixed opening size above the per-position maximum could never be placed). No upper bound |
| `allocationCap` | uint64 | USD 6 dec | `> 0` | Validity. No upper bound |
| `maxPositionNotional` | uint64 | USD 6 dec | `1 .. allocationCap × maxLeverage` | Consistency: a position cannot exceed the committed capital times the leverage |
| `maxLeverage` | uint8 | whole x | `≥ 1`; exactly 1 for `SPOT` | Validity (spot has no leverage). No upper bound other than the type (255); the executor also clamps to the venue's maximum per symbol |
| `tradeStopLossBps` | uint16 | bps of entry price | 0 (off) or `≤ 10,000` | Validity: a loss beyond 100 % of the price is meaningless |
| `maxDrawdownBps` | uint16 | bps of `allocationCap` | 0 (off) or `≤ 10,000` | Validity |
| `takeProfitBps` | uint32 | bps of `allocationCap` | 0 (off) or any | None |
| `slippageBps` | uint16 | bps | `1 .. 10,000` | Validity: 0 would forbid every fill; above 100 % is meaningless |
| `symbolMode` | enum | | `ALL`, `ALLOW`, `DENY` | See §4.4 |
| `symbols` | string[] | | `ALL`: empty. `ALLOW`/`DENY`: at least one entry; each entry non-empty printable ASCII (0x21–0x7E) | Validity (an empty filter would mean ALL; SoDEX symbols are printable ASCII, and this keeps the signed text unambiguous in wallets). **No count or length limit** |
| `copyExisting` | bool | | | On activation, also open the leader's already open positions |
| `maxBuilderFeePerps` | uint16 | tenths of a bp | `0 .. 200` | **SoDEX cap** |
| `maxBuilderFeeSpot` | uint16 | tenths of a bp | `0 .. 2,000` | **SoDEX cap** |
| `expiry` | uint40 | unix s | `0` (never) or `> now` | Validity. **No lifetime cap** |

Target fields are fixed for the life of a subscription:

- `venue`: enabled in the registry, else `VenueDisabled`;
- `leader`: `!= 0`. On SoDEX it must also differ from the follower: copying yourself on SoDEX would feed your copies
  back in as leader trades. From Hyperliquid it is allowed ("mirror my own HL trading into my SoDEX account");
- `sodexAccountId`: `!= 0`.

To copy another leader, or into another account, stop and subscribe again.

Fields are checked so that the reported field is the root cause: allocation cap and leverage are checked before max
position notional, and max position notional before a `FIXED_NOTIONAL` sizing value.

### 4.3 Stored record, storage layout and indexes

The stored `Subscription` struct is declared in the interface in its packing order: seven slots.

| Slot | Fields (bytes) |
|---|---|
| 0 | `follower` 20, `status` 1, `venue` 1, `marketScope` 1, `sizingMode` 1, `symbolMode` 1, `copyExisting` 1, `maxLeverage` 1, `closePositions` 1, `version` 4 |
| 1 | `leader` 20, `createdAt` 5, `updatedAt` 5, `slippageBps` 2 |
| 2 | `delegatedKey` 20, `expiry` 5, `takeProfitBps` 4, `tradeStopLossBps` 2 |
| 3 | `sodexAccountId` 8, `stopEpoch` 8, `sizingValue` 8, `maxDrawdownBps` 2, `maxBuilderFeePerps` 2, `maxBuilderFeeSpot` 2 |
| 4 | `allocationCap` 8, `maxPositionNotional` 8 |
| 5 | `symbolsHash` 32 (the commitment to the symbol list, §4.4) |
| 6 | `keyName`: up to 31 bytes in place; a name of 32–36 bytes is a long string (slot 6 holds its length, and the data takes one or two more slots) |

`version` starts at 1 and increases by exactly 1 on every change of the record (update, pause, resume, unsubscribe).
`stopEpoch` is the follower's stop epoch at creation (§5.2).

All state lives in one ERC-7201 namespace, `valuescan.storage.CopyTrading`, at
`0xc3b2bc2cf6fc6db46d2b311dd8531e2120cf7207f8eeaaf9015bcf1d32c6bf00`. The members are, in order:

| # | Member | Structure | Purpose |
|---|---|---|---|
| 0 | `subscriptionCount` | `uint256` | Highest id |
| 1 | `subscriptions` | `id → Subscription` | Records |
| 2 | `followerHistory` | `follower → uint256[]`, append-only | Every id a follower created (paginated view) |
| 3 | `leaderHistory` | `venue → leader → uint256[]`, append-only | Every id created to a leader (paginated view) |
| 4 | `followerLive` | `follower → stopEpoch → EnumerableSet` | Live ids of the follower's current epoch (paginated view) |
| 5 | `liveByKey` | `keccak(follower, account, venue, leader) → id` | The last id created for the key, never cleared: the uniqueness guard (§5.3) and the history a signed `Subscribe` is bound to (§6.6) |
| 6 | `stopEpoch` | `follower → uint64` | Kill-switch epochs (§5.2) |
| 7 | `killSwitches` | `follower → epoch → {triggeredAt, closePositions}` | Kill-switch records |
| 8 | `executors` | `executor → {authorised, updatedAt, lastEpoch}` | Executor records (§7.1) |
| 9 | `commitments` | `executor → epoch → {merkleRoot, count, committedAt}` | Execution commitments (§7.2) |
| 10 | `venues` | `venue → {enabled, name}` | Venue registry |
| 11 | `nonceBitmap` | `signer → word → bitmap` | Unordered nonces (§6.5) |
| 12 | `builderTerms` | inline `{builderId, perpsFee, spotFee, updatedAt}` | Builder terms (§8.1); the last member, so it may grow |

OpenZeppelin's parents use their own ERC-7201 namespaces (`Ownable`, `Ownable2Step`, `Pausable`, `Initializable`), so
the contract has no sequential storage at all. The `EIP712` namespace stays empty, because the domain is pinned in
code (§10.4). Every index is a function of the records and the epochs, and can be rebuilt from the events (§9).

### 4.4 Symbol filter: a commitment, not a stored list

Decision: the contract validates the list, stores only its **commitment** `symbolsHash`, and emits the full list in
`Subscribed` and `SubscriptionUpdated`. The commitment is the EIP-712 encoding of `string[]`: `keccak256` of the
concatenated `keccak256` of each entry, with `keccak256("")` for an empty list. The follower signs the symbols as
strings, so a wallet shows `BTC-USD`, not hex.

Why:

- **No cap, and O(1) storage.** Storing a list would cost one slot per symbol and invite a cap. The commitment is one
  slot whatever the list length. The per-call work (the character check and one hash per symbol) is proportional to
  the caller's own calldata, which the caller pays for. Nothing loops over stored data.
- **The same hash the follower signed.** The commitment equals the `symbols` member of the signed `Terms`, so the
  signature, the record and the event all agree. Anyone can check an event's list against `symbolsHash`. The
  invariant tests do this for every event.
- **Self-describing.** A symbol name means the same thing forever and needs no trusted index table. A bitmap over an
  off-chain table would let whoever edits the table silently change what every follower allowed.
- Order and duplicates are the follower's choice; the commitment covers the list exactly as signed.

The filter applies to the **SoDEX symbol the executor would trade**. For a Hyperliquid leader, the executor first maps
the HL coin to a SoDEX symbol (off-chain table published by ValueDesk); if there is none, the trade is skipped.

### 4.5 Sizing (normative for executors)

Let `L` be the leader, `F` the follower's copied book for this subscription, and `v = sizingValue`.

| Mode | Rule |
|---|---|
| `PROPORTIONAL` | Target notional of F in a symbol = L's position notional × (`allocationCap` / L's account equity) × v / 1e6. The executor trades the difference between the target and F's current copied position. L's equity is read from the venue (SoDEX account state, HL `clearinghouseState`) and cached for at most 60 s |
| `FIXED_RATIO` | Each L fill of quantity q produces an F order of q × v / 1e6 in the same direction (reduce-only if L reduced) |
| `FIXED_NOTIONAL` | When L opens a position from flat, F opens v USD (6 dec) of notional. Later L increases and reductions are mirrored in proportion to L's position size at that moment |

After sizing, in this order:

1. Drop the order if the symbol is outside `marketScope` or filtered out.
2. Clip so that F's position notional ≤ `maxPositionNotional`.
3. Clip so that committed capital ≤ `allocationCap`.
4. Set leverage ≤ `maxLeverage`, and ≤ the venue's maximum for the symbol.
5. Drop the order if it is below the venue's minimum size.

If the subscription is `PAUSED`, drop any part that opens or increases a position. Reductions and closes are never
clipped by the caps.

### 4.6 Risk rules (normative for executors)

- **Arming.** Drawdown and take profit are measured on the realised plus unrealised PnL of this subscription's copied
  positions since the subscription was last **armed**. It is armed by the latest of these events: `Subscribed`,
  `SubscriptionResumed`, or `SubscriptionUpdated` while ACTIVE.
- **Per-trade stop loss:** close a copied position (reduce-only) when the mark price has moved `tradeStopLossBps`
  against its average entry.
- **Drawdown stop and take profit:** flatten every copied position of the subscription and **halt** it: no new opens
  or increases until the follower re-arms it (an update, or pause then resume).
  - A halt is off-chain state. The executor MUST record it in its commitments (§7.2) and show it through its API.
  - The on-chain status stays ACTIVE, because only the follower changes a subscription.
- **Slippage:** every copy order is IOC with limit price = reference ± `slippageBps`. The reference is:
  - the leader's fill price, for mirrors;
  - the mark price, for `copyExisting` openings and for risk closes.

## 5. Lifecycle

### 5.1 States and actions

```
             subscribe / subscribeWithSig
                          |
                          v
                     +--------+   pauseSubscription(+WithSig)     +--------+
                     | ACTIVE | --------------------------------> | PAUSED |
                     |        | <-------------------------------- |        |
                     +--------+   resumeSubscription(+WithSig)    +--------+
                          |       (blocked while the contract          |
                          |        is paused)                          |
                          +------------------+   +---------------------+
                                             |   |
                  unsubscribe(+WithSig), or unsubscribeAll(+WithSig) (kill switch, §5.2)
                                             v   v
                                          +---------+
                                          | STOPPED |   terminal
                                          +---------+

  updateSubscription(+WithSig) replaces the terms in ACTIVE or PAUSED and keeps the status.
```

| Action | From → to | Authority | While the contract is paused | Other checks |
|---|---|---|---|---|
| `subscribe` / `subscribeWithSig` | – → ACTIVE | follower | **blocked** | venue enabled; valid target and terms; no live duplicate (§5.3); signed variant: `stopEpoch` = the follower's current epoch and `expectedLastId` = `lastSubscriptionFor` of the key (§6.6) |
| `updateSubscription` / `...WithSig` | ACTIVE → ACTIVE, PAUSED → PAUSED | follower | **blocked** | live; valid terms; signed variant: `expectedVersion` = version. Venue enablement is not checked; an expired subscription can be renewed this way |
| `pauseSubscription` / `...WithSig` | ACTIVE → PAUSED | follower | **allowed** | effective status ACTIVE |
| `resumeSubscription` / `...WithSig` | PAUSED → ACTIVE | follower | **blocked** | effective status PAUSED; not expired (`InvalidTerms(EXPIRY)`: renew with an update); signed variant: `expectedVersion` = version |
| `unsubscribe` / `...WithSig` | ACTIVE or PAUSED → STOPPED | follower | **allowed** | live. The signed variant is **not** version-bound |
| `unsubscribeAll` / `...WithSig` | every live → STOPPED | follower | **allowed** | none: it never reverts (except on a bad signature) |
| `invalidateNonces` / `...WithSig` | – | follower | **allowed** | none |

Every change of a record increases `version` by exactly 1 and sets `updatedAt = block.timestamp`. `STOPPED` never
changes again.

Why `resume` is blocked while the contract is paused: the owner's pause means "no new risk enters", and resuming
re-enters risk exactly as a new subscription would. Pausing and stopping reduce risk, so they are never blocked.

"Expired" means `expiry != 0 && block.timestamp >= expiry`. An expired subscription keeps its status, is not
copyable (`isCopyable` is false), and is renewed by an update. Nobody else can close it: only the follower changes a
subscription.

### 5.2 The kill switch: O(1) with stop epochs

Each follower has a **stop epoch** (`stopEpochOf`, starting at 0), and each subscription records the epoch in which it
was created. `unsubscribeAll(closePositions)`:

1. raises the follower's epoch by 1;
2. records `KillSwitch{triggeredAt, closePositions}` for the new epoch;
3. emits `KillSwitchTriggered(follower, newEpoch, closePositions)`.

That is the whole effect, and it costs the same gas whether the follower has 0 or 10,000 subscriptions (tested with
200: 73,987 gas either way).

**Rule (definition of the effective status):** a stored ACTIVE or PAUSED subscription whose `stopEpoch` is below its
follower's current epoch is **STOPPED**, with reason `KILL_SWITCH`. Every view computes it:

- `getSubscription` and `statusOf` return STOPPED;
- `isCopyable` returns false;
- `liveSubscriptionFor` returns 0, while `lastSubscriptionFor` still returns the killed id (the key's history, §6.6);
- `stopDetails(id)` returns `(KILL_SWITCH, k.closePositions, k.triggeredAt)`, where `k = killSwitchInfo(follower,
  stopEpoch + 1)`: the first kill switch after creation is the one that stopped it;
- `liveSubscriptionsOfFollower` reads the live set of the **current** epoch, which starts empty.

The record itself is not written, so its `version` does not change. No per-subscription event is emitted.
Executors and indexers apply the rule to every subscription of that follower whose `stopEpoch` is below the event's
`stopEpoch`.

Consequences:

- Subscriptions created **after** a kill switch are unaffected. The next kill switch stops them.
- A kill switch also voids every signed but unsubmitted `Subscribe` of that follower, because `Subscribe` binds the
  stop epoch (§6.6).
- Nothing can revive a killed subscription: all mutating functions require an effective status of ACTIVE or PAUSED.

### 5.3 Uniqueness per (follower, account, venue, leader): a correctness guard

`subscribe` reverts with `DuplicateSubscription(existingId)` if the follower already has a **live** subscription to
the same leader on the same venue for the same SoDEX account. This is not a limit; it is kept for correctness:

- Two concurrent copies of one leader into one account would double the exposure the follower chose.
- SoDEX nets them into one position per symbol, so the executor could not attribute fills, PnL, drawdown or a
  `closePositions` request to one subscription or the other.

A follower who wants a different size updates the existing subscription instead. The same leader into another account,
or on another venue, is allowed. A stopped subscription (by `unsubscribe` or by the kill switch) frees the key:
`liveByKey` keeps its id (it is never cleared), and the guard ignores an id that is not live. `liveSubscriptionFor`
returns only a live id; `lastSubscriptionFor` returns the stored one, which a signed `Subscribe` must carry (§6.6). The
guard costs O(1): one mapping slot per key, read and written only for that key. **Flagged for the owner (§16, Q1).**

## 6. Signatures (gasless follower actions)

Many SoDEX users hold no SOSO. Every follower action therefore also exists as `...WithSig`, which anyone can submit.
ValueDesk's relayer pays the gas.

### 6.1 Domain

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
name = "ValuescanCopyTrading", version = "1", chainId = block.chainid (286623), verifyingContract = the PROXY
```

- The name and version are pinned in the implementation's code (§10.4).
- `verifyingContract` is the proxy address, which never changes across upgrades.
- The chain id is read on every call, so a signature for chain 286623 is invalid on any fork with another id.
- ERC-5267 `eip712Domain()` is exposed.

Wallet note: MetaMask-style wallets require `domain.chainId` to equal the wallet's current chain. The UI MUST switch
the wallet to ValueChain (286623) before asking for these signatures. SoDEX's own `universal`-domain signatures also
use the wallet's current chain, so a wallet kept on ValueChain serves both.

### 6.2 Types and type hashes

```
Terms(address delegatedKey,string keyName,uint8 marketScope,uint8 sizingMode,uint64 sizingValue,uint64 allocationCap,
      uint64 maxPositionNotional,uint8 maxLeverage,uint16 tradeStopLossBps,uint16 maxDrawdownBps,uint32 takeProfitBps,
      uint16 slippageBps,uint8 symbolMode,string[] symbols,bool copyExisting,uint16 maxBuilderFeePerps,
      uint16 maxBuilderFeeSpot,uint40 expiry)
Subscribe(address follower,uint8 venue,address leader,uint64 sodexAccountId,Terms terms,uint64 stopEpoch,
          uint256 expectedLastId,uint256 nonce,uint256 deadline)
UpdateSubscription(address follower,uint256 subscriptionId,uint32 expectedVersion,Terms terms,uint256 nonce,
                   uint256 deadline)
PauseSubscription(address follower,uint256 subscriptionId,uint256 nonce,uint256 deadline)
ResumeSubscription(address follower,uint256 subscriptionId,uint32 expectedVersion,uint256 nonce,uint256 deadline)
Unsubscribe(address follower,uint256 subscriptionId,bool closePositions,uint256 nonce,uint256 deadline)
UnsubscribeAll(address follower,bool closePositions,uint256 nonce,uint256 deadline)
InvalidateNonces(address follower,uint256 word,uint256 mask,uint256 nonce,uint256 deadline)
```

The line breaks above are for reading only; the real strings have no whitespace. `Subscribe` and
`UpdateSubscription` are followed by the `Terms` string, as EIP-712 requires for referenced types.

| Type | Type hash |
|---|---|
| `Terms` | `0x4836445cef1a48d6c13fd7b25c5a0c1aea5b79c376ba7bf3e291aa826c4bda13` |
| `Subscribe` | `0x9f83367e0514f6df54c98de57d31d3931ff835719531b30ebe06c8ba66ab81e1` |
| `UpdateSubscription` | `0x9edc7b1f1dce4c621fab4163454b540147d0bb06f50e068005bd38343256611e` |
| `PauseSubscription` | `0xada566bbbc82b7e983663be2501f0a3b282f5c89abb16a5a2756f15a256e1e35` |
| `ResumeSubscription` | `0x742f800a62127bcff440e887780727786fa1d07c42cf824a2317a7262deb1000` |
| `Unsubscribe` | `0x0393009ed3c7c395080d3cd2b68b698f33344f2df3d47bcea22bc4be00538440` |
| `UnsubscribeAll` | `0x6f5c9aba97af2ddc806df4faff312b4feb13afbfab1ae4a60ba7dce22e958177` |
| `InvalidateNonces` | `0x2666c3d4e309127c5355dfdd7da6cc09b9323956e84c17da20538a388b80fd03` |

The exact strings and hashes live in `CopyTradingConstants` in the interface file. `test/spec/EIP712Spec.t.sol`
checks every string against Foundry's canonical `eip712HashType`.

### 6.3 Encoding rules

- Enums are `uint8` (their Solidity ordinal).
- `string` fields (`keyName`) are hashed: `keccak256(bytes(s))`.
- `string[] symbols` is `keccak256(concat(keccak256(bytes(s0)), keccak256(bytes(s1)), …))`; an empty list is
  `keccak256("")`. This is also the stored `symbolsHash`.
- `Terms` is a nested struct: its `hashStruct` is encoded in place of `terms`.
- `Terms` has 19 words (the type hash plus 18 members). The implementation encodes it as
  `bytes.concat(abi.encode(first 10), abi.encode(last 9))`, which is byte-identical to one `abi.encode`.

### 6.4 Verification

For signer `s` (the stored follower of the subscription, or the `follower` argument):

1. Every non-signature check of the action runs first (existence, status, version, fields, uniqueness, and for
   `Subscribe` the stop epoch, then the key's last subscription).
2. `block.timestamp <= deadline`, else `SignatureExpired(deadline)`.
3. The nonce is unused, else `NonceAlreadyUsed(s, nonce)`.
4. **ECDSA first:** if `ECDSA.tryRecoverCalldata` returns `s` without error, the signature is valid. OpenZeppelin
   rejects high-`s` (malleable) signatures, signatures that are not 65 bytes (EIP-2098 64-byte signatures included),
   and never recovers the zero address.
5. **ERC-1271 otherwise:** if `s` has code, `STATICCALL s.isValidSignature(digest, signature)` must return
   `0x1626ba7e`. A revert or any other answer counts as invalid.
6. Else `InvalidSignature(s)`.
7. Only now: the nonce is marked used, `NonceUsed(s, nonce)` is emitted (always the first event of a signed call),
   and the action is applied.

Why ECDSA comes before ERC-1271:

- An EIP-7702-delegated EOA has code (`0xef0100 ‖ delegate`), so OpenZeppelin's `SignatureChecker` would send it
  straight to ERC-1271, which many delegates do not implement.
- The EOA's own key still controls the account, and SoDEX treats such an account as an EOA. Trying ECDSA first
  accepts it.
- A real contract wallet cannot produce an ECDSA signature for its own address, so the order is safe.

The ERC-1271 check is a `STATICCALL` made before any state write, so there is no re-entrancy surface. ERC-6492
(signatures from smart wallets that are not deployed yet) is not supported.

### 6.5 Nonces: unordered bitmap

- Each signer has a bitmap: nonce `n` is bit `n & 0xff` of word `n >> 8` (Permit2 style). Any unused value is valid.
- One nonce space is shared by all action types.
- `invalidateNonces(word, mask)` (direct or signed) burns bits, to cancel signed messages that were never submitted.
  The signed variant consumes its own nonce first; that nonce may lie inside `mask`.

Why not sequential nonces: with a sequential nonce, a relayer holding an older signed message could submit it first
and so invalidate the follower's newer `Unsubscribe`, which shares the same nonce. Unordered nonces make every signed
stop independent of every other message. They also let a relayer submit in parallel and out of order.

UIs MUST NOT give the same nonce to two messages that can be pending at the same time (audit SEC-03):
`NonceUsed(signer, nonce)` does not say which message consumed a nonce, so after a resume and a later stop that shared
one, nobody could tell from the chain whether the stop landed. Sequential nonces are fine only if the UI skips every
nonce of a message that may still land; stops use random 256-bit nonces (`randomNonce()` in the SDK). A random nonce
costs one fresh storage word (about 20k gas more than a packed sequential one), which the relayer pays.

### 6.6 Binding to version, stop epoch and key history

- `UpdateSubscription` and `ResumeSubscription` include `expectedVersion`. The call reverts with
  `VersionMismatch(id, expected, actual)` unless it equals the stored `version`. Otherwise a relayer could withhold a
  signed resume and submit it after a later pause, which would turn copying back on against the follower's latest
  wish.
- `Subscribe` includes `stopEpoch`. The call reverts with `StopEpochMismatch` unless it equals the follower's current
  epoch, so a kill switch also voids every pending `Subscribe`.
- `Subscribe` also includes `expectedLastId`: the id of the last subscription created for its (follower, SoDEX account,
  venue, leader) key when the follower signed, `lastSubscriptionFor(follower, account, venue, leader)`, or 0 for a key
  with no subscription yet. The call reverts with `LastSubscriptionMismatch(expected, actual)` unless it equals the
  key's current last id. `liveByKey` is never cleared, so **any subscription that lands for the key (direct or signed)
  voids every Subscribe signed before it, and a later `unsubscribe` keeps them void** (audit SEC-04: before this fix,
  a per-leader stop did not void a withheld Subscribe for that leader, and the untrusted relayer could restart copying
  against the follower's latest wish). Keys are independent: landing a Subscribe for one leader does not void a
  pending Subscribe for another. UIs MUST NOT sign a Subscribe for a key whose last subscription is still live: it
  would be a duplicate now and would become valid the moment that subscription stops. There is no reason to: terms
  change with an update.
- Stops are **not** bound: `PauseSubscription`, `Unsubscribe` and `UnsubscribeAll` stay valid whatever happens
  before they land.

A follower MAY pre-sign `UnsubscribeAll` with a long deadline and keep it (or give it to a watchdog) as an emergency
stop that anyone can submit, even while the contract is paused. It stops whatever is live when it lands, including
subscriptions created after it was signed. It is cancelled only by its deadline, by `invalidateNonces`, or by a
deliberate domain bump in an upgrade (§10.4).

### 6.7 Relayer rules

- The relayer is untrusted. It can only submit or withhold. Everything else is bound by the signature: follower,
  leader, venue, account, all terms (symbols included), key, fees, nonce, deadline, chain and contract.
- It SHOULD simulate (`eth_call`) before sending, and cap gas per transaction (for example 2 M), to avoid ERC-1271 gas
  griefing by a hostile wallet.
- It MUST NOT report a message as landed just because the call reverts with `NonceAlreadyUsed` and a
  `NonceUsed(signer, nonce)` event exists: the event does not identify the message (audit SEC-03). The message counts
  as landed only if the transaction that emitted that `NonceUsed` carried the relayer's own message (same digest, from
  its calldata), or, for a stop, after re-reading the target (`statusOf` is STOPPED, or `stopEpochOf` rose).
  Otherwise the relayer reports it as not landed, and the follower re-signs with a fresh nonce.
- It sends at once or rejects; it never holds a signature for later. Messages that start or raise risk (Subscribe,
  UpdateSubscription, ResumeSubscription) carry short deadlines (15 minutes in the SDK).
- It SHOULD rate-limit per signer and per IP, but that does not stop spam: signers are free. It MUST relay a
  `Subscribe` or `UpdateSubscription` only if `delegatedKey` is a key ValueDesk's key service issued for exactly this
  follower and SoDEX account, and SHOULD also check that the follower owns the account (ClobGateway
  `getAccountsByAddress`, read-only) and cap the calldata size. This is relay policy, not a protocol rule: a refused
  follower can still call the contract directly and pay the gas.
- If the relayer withholds, the follower can submit the same signature through any other relayer, or call directly.
  The UI MUST offer both.

### 6.8 Test vectors

From `test/spec/EIP712Spec.t.sol` (`forge test -vv --match-path test/spec/EIP712Spec.t.sol`). Domain: chain id
286623, `verifyingContract` `0x00000000000000000000000000000000c0ffee01`. Every digest equals Foundry's independent
`eip712HashTypedData` on the `eth_signTypedData_v4` JSON a wallet would receive. A separate test signs Foundry's
digest for the live proxy, and the contract accepts it: no code is shared between the signer and the contract.

Common inputs: follower `0x3333…3333`, deadline `1790000000`. Vector Terms:

- key `0x2222…2222`, name `vs-000001`;
- PERPS, PROPORTIONAL 1,000,000;
- allocation 1,000,000,000, max position 2,500,000,000, leverage 5;
- stop loss 500, drawdown 2000, take profit 5000, slippage 50;
- ALLOW [`BTC-USD`, `ETH-USD`], copyExisting false;
- fees 50 / 0, expiry 1806000000.

| Vector | Value |
|---|---|
| Domain separator | `0xfbd6a915ede01c4ff68b16571b7903fa09b3d1adc9eedc87455d299eb8f8e7be` |
| `hashStruct(Terms)` | `0x9f3bb65f95299cbdfce6255b2e72c644174a47be9ce7b196fa6cfdd58eb9fb74` |
| `Subscribe` (venue 2, leader `0x4444…4444`, account 224678, stopEpoch 0, expectedLastId 0, nonce 7) | hashStruct `0x29c14b18ca1052980458a39bf4368c18cee82e7094fa5db07b4300d6f4b4fd15`, digest `0xebba0ab9d19db149bb7318d59bfe1af32d251a0ae1673eeb3c78c030e5914e17` |
| `UpdateSubscription` (id 42, expectedVersion 3, same Terms, nonce 8) | digest `0x0c87513387836c9db403b3894f2e5cbd37d9fdb1208ba33bf8e80927f264b580` |
| `PauseSubscription` (id 42, nonce 9) | digest `0x1402860d5946a3305b26ecd3e1cb86d91773ed6c9351aecfb1f1bb50bd8b5366` |
| `ResumeSubscription` (id 42, expectedVersion 4, nonce 10) | digest `0x8d3a843eeb7068e26924c76d8cec8a1dcfe6073e17973d6ff2f7e9c4bdee87e0` |
| `Unsubscribe` (id 42, closePositions true, nonce 11) | digest `0xdc731e8c8e3c805234909cb387b33794cc2bd3add352b74110bf2021f28d41c4` |
| `UnsubscribeAll` (closePositions true, nonce 12) | digest `0xd7ef89ad580b0dd870bb68feca617515f29e6ef2f7c55e169c4a812c2e7ae82f` |
| `InvalidateNonces` (word 0, mask 255, nonce 13) | digest `0x5f7248c2cac4d9524a32ff303bcf0f1509e5b7a68ac2df4ab973f8f8b215d21c` |

The contract has no `hash*` views. Clients compute digests with any EIP-712 library, check the domain with
`DOMAIN_SEPARATOR()` or `eip712Domain()`, and test against these vectors.

## 7. Executors and execution commitments

### 7.1 An owner-managed executor set

ValueDesk runs the executor. The owner authorises ValueDesk's executor addresses with
`setExecutor(executor, authorised)`, and `initialize` can authorise the first ones atomically. Executors can do
exactly one thing on-chain: publish execution commitments. They have **no power over subscriptions**.

- `isExecutor(addr)` and `executorInfo(addr)` return `{authorised, updatedAt, lastEpoch}`.
- The set of authorised executors is rebuilt from `ExecutorSet` events. There is no on-chain list, because the set
  is small, owner-managed and fully evented, and an enumerable set would cost bytecode the implementation needs to
  keep for upgrades (§11).
- De-authorising keeps the record, `lastEpoch` and every published commitment.
- Which executor serves which subscription is ValueDesk's internal routing and is not recorded. The follower authorises
  a **key**, and the subscription records that key.

### 7.2 Commitments and leaf format

`commitExecutions(epoch, merkleRoot, count, uri)`:

- Only an authorised executor may call it (else `NotExecutor`). It is allowed while the contract is paused.
- `epoch` MUST be strictly greater than the executor's `lastEpoch` (else `EpochNotIncreasing`). It SHOULD be the unix
  hour, `floor(t / 3600)`, committed within one hour after that hour ends.
- The contract stores `{merkleRoot, count, committedAt}` per (executor, epoch), never changes it, and emits
  `ExecutionsCommitted`.
- It does **not** verify trades. Inclusion proofs are checked off-chain against `commitment(executor, epoch)`, using an
  OpenZeppelin sorted-pair tree (`MerkleProof.verify` semantics).

Leaf format v1 uses OpenZeppelin's "standard" double hash, so a leaf can never be confused with an inner node. The
fields are ABI-encoded as the listed types, in this order (`encodeAbiParameters` in viem, `abi.encode` on-chain):

```text
leaf = keccak256(bytes.concat(keccak256(abi.encode(
    keccak256("ValuescanExecution.v1"),
    address(copyTradingProxy),
    uint256 subscriptionId,
    uint32  subscriptionVersion,   // the version the executor acted on
    uint8   action,                // 0 MIRROR, 1 SKIP, 2 COPY_EXISTING, 3 STOP_LOSS, 4 DRAWDOWN_HALT,
                                   // 5 TAKE_PROFIT_HALT, 6 STOP_FLATTEN, 7 REDUCE_WHILE_PAUSED
    uint8   leaderVenue,
    bytes32 leaderFillRef,         // keccak256 of the venue's fill id: SoDEX "engine:symbol:t", HL "hash:tid"; 0 if none
    uint64  leaderFillTimeMs,
    uint8   engine,                // SoDEX: 0 spot, 1 perps
    bytes32 symbolHash,            // keccak256(bytes(symbol)), as in the symbol commitment
    uint8   side,                  // 0 buy, 1 sell
    bool    reduceOnly,
    uint256 quantity,              // 1e18 fixed point
    uint256 limitPrice,            // 1e18 fixed point
    uint16  builderFee,            // tenths of a bp actually attached; 0 if none
    bytes32 followerTxHash,        // clobscan tx_hash of the order; 0 for SKIP
    uint64  followerOrderTimeMs,
    uint16  skipReason             // 0 none; otherwise a documented code (filter, cap, min size, stale, copy-of-copy, ...)
))));
```

The file at `uri` MUST list every leaf's fields and the proofs. Anyone can then check against clobscan that:

- each order existed;
- its `builder.fee` ≤ the subscription's effective fee;
- no opening order was placed after a stop plus the SLA;
- the bounds were respected.

Omissions are detectable too. clobscan keeps each order's original EIP-712 signature, so the signer of every order on
the follower's account can be recovered (report 01 §3). Any order signed by the delegated key that is missing from
the commitments is a violation.

## 8. Builder fees and the executor's rules

### 8.1 Builder terms and the effective fee

`BuilderTerms{builderId, perpsFee, spotFee, updatedAt}`, set by the owner with `setBuilderTerms` (and by
`initialize`):

- `builderId` is ValueDesk's SoDEX account id (on SoDEX, builder id = account id). It must be non-zero.
- `perpsFee ≤ 200` and `spotFee ≤ 2000`, in tenths of a bp. These are SoDEX's hard caps, hard-coded as constants.

For each subscription and engine:

```
effectiveFee(engine) = min(currentFee(engine), the follower's consent(engine))
```

`effectiveBuilderFee(id)` returns it, computed on read. Consequences:

- **Raising the fee never raises consent.** A follower who consented to 50 pays at most 50, even if the owner sets
  200. This is fuzz-tested for every fee sequence.
- Lowering the fee applies to every follower at once.
- A consent of 0 means no builder fee: the executor omits `builder` from those orders.
- The executor MAY attach less than the effective fee (for example no fee on reduce-only and closing orders, as report
  08 recommends). It MUST NOT attach more.

Changing `builderId` needs no follower action on this contract. But SoDEX rejects orders that name a builder the
follower never approved, so followers would have to approve the new id on SoDEX. The owner SHOULD change it only if
the builder account is compromised.

### 8.2 Relation to the SoDEX approval

SoDEX enforces its own ceiling:

- the follower's `ApproveBuilderFee{builderID, maxFeeRate}`: one `maxFeeRate` for both engines, 0..2000;
- per order, `fee ≤ maxFeeRate` and `fee ≤` the engine cap;
- orders naming an unapproved builder are rejected.

The UI SHOULD request `maxFeeRate = max(maxBuilderFeePerps, maxBuilderFeeSpot)`, so that the two consents agree. On
perps the SoDEX ceiling may be looser than the on-chain consent. The on-chain consent is the one the executor MUST
honour, and the commitments make it auditable.

Also on the SoDEX side (documented):

- at most 10 active builder approvals per user; one approval covers all of a follower's ValueDesk subscriptions;
- the builder account must keep at least 100 vUSDC in both spot and perps;
- builder fees are additive to exchange fees and are charged on maker fills too (verified on spot, report 08 G6);
- fee revenue is reconciled from `fee − baseRate × notional`, or from the builder account's balance changes. REST
  fills have no `builderFee` field (report 08).

### 8.3 The executor (normative)

**What it reads**

- This contract's events from the proxy's deployment block, via `eth_getLogs` in chunks, then by polling every block
  (about 2 s). It keeps an in-memory model of every subscription, the stop epochs, the builder terms and the venue
  flags, built with the rules of §9. The contract is **not in the per-trade hot path**: leader fill → follower order
  takes about 75–110 ms from Tokyo, while a ValueChain block takes about 2 s.
- Every hour it reconciles its model with the views at a pinned block number (`getSubscription`, `statusOf`,
  `liveSubscriptionsOfFollower`, `stopEpochOf`), batching `eth_call`s.
- Leader activity from the venues: the SoDEX `trade` firehose and `accountTrade` / `accountOrderUpdate` (report 07,
  G7), and Hyperliquid fills.
- **Stops on their own path.** `SubscriptionStopped`, `SubscriptionPaused`, `KillSwitchTriggered` and
  `SubscriptionUpdated` are read with topic-filtered `eth_getLogs` on a dedicated path that never waits for the leader
  fan-out or for bulk `Subscribed` events. Symbol lists have no size limit, so they are parsed and hashed lazily, only
  for admitted subscriptions, within a byte budget per subscription.

**Preflight, before the first order of a subscription and after every update**

1. `sodexAccountId` is owned by `follower`: ClobGateway `getAccountsByAddress(follower)` (`0x380e78af`, read-only)
   contains it.
2. A key named `keyName` with public key `delegatedKey` exists on every engine in `marketScope`, is not expired, and
   ValueDesk holds its private key. Read with `GET /api/v1/user/{follower}/api-keys` or
   `/api/v1/{engine}/accounts/{id}/api-keys`.
3. The follower's builder approval for `builderId` (`GET /api/v1/user/{follower}/builders`) is ≥ the fee it will
   attach. If it is lower, attach at most the approval. If there is none and the effective fee is > 0, do not trade.
4. If any check fails: do not trade, and report the reason through ValueDesk's API. Re-check with exponential
   backoff (for example 1 minute, doubling up to 1 day) under a global re-check budget, and at once when the
   follower's own `SubscriptionUpdated` or `SubscriptionResumed` arrives; never on a fixed timer for every failing
   subscription.

**Admission control (normative).** Nothing on-chain links `follower` to `sodexAccountId`, and there are no limits, so
anyone can record any number of never-expiring subscriptions to any leader for about 0.7 µSOSO each (audit finding
"leader spam", `test/audit/dos/LeaderSpam.t.sol`). On-chain this harms no one (no call gets more expensive), so the
contract stays limit-free, and the executor keeps the spam out of the copy path:

- A subscription enters the per-leader fan-out only after its preflight passed. The result is cached per (follower,
  `sodexAccountId`, `delegatedKey`, `keyName`).
- The executor serves only delegated keys that ValueDesk's key service issued for exactly that follower and account.
- UIs and analytics count only admitted followers: on-chain follower counts per leader can be faked.
- The unpaginated `subscriptionsOfLeader(v, leader, 0, type(uint256).max)` can exceed an RPC's `eth_call` gas cap for
  a spammed leader (about 2,600 gas per id); always read in pages.

**Per leader event.** For each **admitted** subscription of that (venue, leader) in the model that is copyable
(`isCopyable` semantics: effective status ACTIVE and not expired) or PAUSED:

1. Map the symbol (Hyperliquid → SoDEX; skip if unmapped). Apply `marketScope` and the symbol filter. The executor
   checks the filter against the list from the latest `Subscribed` / `SubscriptionUpdated` event, whose hash MUST
   equal `symbolsHash`.
2. **Cycle protection:** skip leader fills from orders signed by a delegated key that ValueDesk executes for (a copy is
   not a leader decision). This breaks A-copies-B-copies-A loops.
3. Size and clip per §4.5. In PAUSED keep only reductions. Skip signals older than the published staleness limit (for
   example 2 s).
4. Build an IOC order (limit = reference ± `slippageBps`) with `builder{id: builderId, fee}`, where
   `fee ≤ effectiveBuilderFee(engine)` (omit `builder` when the fee is 0). Sign it with the delegated key and send it.
5. Record a commitment leaf, including skips.

**MUST rules**

- MUST NOT open or increase a position for a subscription that is not effectively ACTIVE or is past `expiry`. PAUSED is
  reduce-only. A kill switch (§5.2) makes every older subscription of that follower STOPPED at once.
- MUST respect every bound in §4.2, §4.5 and §4.6, and MUST NOT attach a builder fee above the effective fee.
- MUST act on the **latest version** of a subscription and ignore work queued for an older version.
- **Stop SLA: N = 10 seconds.** This applies from the timestamp of the block containing `SubscriptionStopped`,
  `SubscriptionPaused`, `KillSwitchTriggered`, or a `SubscriptionUpdated` that changes the key or tightens a bound.
  After 10 s it MUST place no further opening or increasing order for the affected subscriptions (with the old key,
  for a key change). Target: 2 blocks (about 4 s).
  - Stops and tightenings are acted on at first sight (0 confirmations); a reorg that removes them only makes the
    executor more conservative.
  - Activations (subscribe, resume, loosening updates) SHOULD wait 2 blocks.
- On a stop (by the follower or by a kill switch):
  1. cancel the subscription's resting copy orders;
  2. if `closePositions` (from the event, or from `killSwitchInfo`), flatten its copied positions with reduce-only
     orders within 60 s (best effort, bounded by slippage, retried with a widening limit up to 3 × `slippageBps`);
  3. stop using the key for that subscription;
  4. when no live subscription references the key any more, destroy the private key.
- MUST publish commitments per epoch (§7.2).
- The contract's pause (by the owner) does **not** stop executors: existing ACTIVE subscriptions stay copyable.

**Flows around the contract**

- **Onboarding (what the follower signs)**
  1. **Choose.** In ValueDesk the follower picks a leader address and the terms.
  2. **Get a key.** ValueDesk generates a fresh delegated key for (follower, account) in its key store (TEE or HSM
     recommended) and returns only the address and a name such as `vs-3f9a1c07`. One key per (follower, account) is
     RECOMMENDED and is reused across that follower's subscriptions.
  3. **On SoDEX** (off-chain, gasless, master-wallet EIP-712 signatures), one of three paths:
     - *Path A (default, trade-only):* `addPermissionedAPIKey` with `permissions = 14`, the key address, the name,
       and `expiresAt` = the subscription expiry (ms). Then `ApproveBuilderFee{builderID = builderTerms().builderId,
       maxFeeRate = max(consents)}`. `builder` and `permissions` cannot share one registration request, hence two
       signatures. Mask 14 is documented as trade-only by the schema and both SDKs, but its enforcement has **not**
       been observed on mainnet (report 07, G2). UI copy MUST say "trade-only per SoDEX docs".
     - *Path B (fallback, one signature):* `AddAPIKeyWithBuilder` registers the key and approves the builder fee
       together. The key is an **ordinary full-permission key**: per the docs it can also move funds between the
       follower's own spot, perps and EVM balances, though not to anyone else (report 07, G5). The UI MUST say so and
       ask for explicit acceptance.
     - *Path C (contract-owned accounts, for example a Safe):* the owning contract calls ClobGateway
       `addAPIKey(engine, name, publicKey)` (`0x8b53c6b9`, engine 0 spot, 1 perps) itself. Such keys have no mask
       and no expiry. No builder approval path is known for contract accounts (no ERC-1271 on SoDEX), so builder fees
       are impossible today: the consents must be 0, and ValueDesk decides whether to serve the account.

     The gateway is `0x0101010101010101010101010101010101010101`.
  4. **On ValueChain.** The follower signs `Subscribe` (§6) and the UI posts it to the relayer, which calls
     `subscribeWithSig`. A follower with SOSO MAY call `subscribe` directly.

  Do step 3 before step 4, so that the key and the approval exist when the executor first sees the subscription. If
  the subscription lands first, the executor waits in preflight and does not trade.
- **Changing terms.** Same as step 4, with `UpdateSubscription` (it carries `expectedVersion`). If the key changes,
  the follower first authorises the new key on SoDEX, and afterwards revokes the old one.
- **Stop copying** (the UI runs these in order):
  1. **Contract:** sign `Unsubscribe(id, closePositions)` or `UnsubscribeAll` (gasless), or call directly. This is the
     public record and the executor's instruction. It works even while the contract is paused.
  2. If `closePositions`: wait until the executor reports the subscription flat (or 60 s).
  3. **SoDEX key**, once no live subscription of this follower references it:
     - off-chain and gasless: `DELETE /api/v1/spot/accounts/api-keys` and `DELETE /api/v1/perps/accounts/api-keys`,
       each with an engine-domain master-wallet signature over `{accountID, name}` (documented; verify the route on
       testnet); **or**
     - on-chain (needs SOSO): ClobGateway `revokeAPIKey(0, name)` and `revokeAPIKey(1, name)` (`0x54ed5933`), sent by
       the account owner. Effective after at least one block plus engine ingest.
  4. Optionally revoke the builder approval (`ApproveBuilderFee{maxFeeRate: 0}`) if no ValueDesk subscription remains.
     This frees one of the 10 approval slots.
- **Emergency stop:** step 3 first (a hard stop that SoDEX enforces, independent of ValueDesk and of any upgrade), then
  `UnsubscribeAll`. An EIP-7702-delegated follower MAY batch `unsubscribeAll` with both on-chain `revokeAPIKey` calls in
  one transaction.
- **Upgrade window** (§10.5): when an upgrade is scheduled on the timelock, the UI shows it together with the new
  implementation's verified source. Followers who do not accept it stop and revoke within the 48 h.

**Failure cases**

| Situation | Behaviour |
|---|---|
| Relayer down or censoring | The follower submits the signature elsewhere or calls directly. The SoDEX key revoke (REST) needs no ValueChain gas |
| Executor ignores a stop | Revoke the key on SoDEX (hard stop). The violation is public: orders on clobscan after the stop plus the SLA, and missing or wrong commitments |
| Executor offline | `isCopyable` stays true, but nothing trades |
| Contract paused by the owner | No new subscribe, update or resume. Every stop works. Executors keep serving existing ACTIVE subscriptions |
| Owner raises the fee | No follower pays above its consent |
| Venue disabled | New subscriptions to it revert. Existing ones are unaffected |
| Subscription expired | Not copyable. The follower renews with an update, or stops |
| SoDEX key expired or revoked by the follower, subscription still ACTIVE | Preflight fails and nothing trades. The UI prompts to renew or stop |
| Builder approval missing or lower | Attach at most the approval. None → do not trade (if the fee is > 0) |
| Upgrade scheduled that a follower distrusts | Stop, and revoke the SoDEX key, within the 48 h timelock window |

## 9. Events and rebuilding state

Every state change emits an event. An indexer that starts at the proxy's deployment block needs no call at all.
Timestamps not carried in an event equal the timestamp of the block that contains it.

| Event | Rebuild rule |
|---|---|
| `Subscribed(id, follower, leader, Subscription, string[] symbols)` | `S[id] = record` (status ACTIVE, version 1); `SYM[id] = symbols` (its hash equals `record.symbolsHash`); append id to `followerHistory[follower]` and `leaderHistory[venue][leader]` |
| `SubscriptionUpdated(id, follower, Subscription, string[] symbols)` | `S[id] = record` (full replacement; version + 1; target, `createdAt` and `stopEpoch` unchanged); `SYM[id] = symbols` |
| `SubscriptionPaused(id, follower, version, updatedAt)` | `S[id].status = PAUSED`; set version and updatedAt |
| `SubscriptionResumed(id, follower, version, updatedAt)` | `S[id].status = ACTIVE`; set version and updatedAt |
| `SubscriptionStopped(id, follower, closePositions, version, updatedAt)` | `S[id].status = STOPPED`; set closePositions, version and updatedAt |
| `KillSwitchTriggered(follower, stopEpoch, closePositions)` | `E[follower] = stopEpoch`; `K[follower][stopEpoch] = {block time, closePositions}` |
| `NonceUsed(signer, nonce)` / `NoncesInvalidated(signer, word, mask)` | set the bit / `bitmap[signer][word] \|= mask` |
| `ExecutorSet(executor, authorised)` | `X[executor].authorised = authorised`; `X[executor].updatedAt = block time` |
| `ExecutionsCommitted(executor, epoch, root, count, uri)` | `C[executor][epoch] = {root, count, block time}`; `X[executor].lastEpoch = epoch` |
| `BuilderTermsUpdated(builderId, perpsFee, spotFee)` | `B = {builderId, perpsFee, spotFee, block time}` |
| `VenueUpdated(venue, enabled, name)` | `V[venue] = {enabled, name}` |
| OpenZeppelin `Paused` / `Unpaused`, `OwnershipTransferStarted` / `OwnershipTransferred`, `Upgraded`, `Initialized` | pause flag, pending owner, owner, implementation, initialised version |

Derived values:

- **Effective status** = `S[id].status`, except that an ACTIVE or PAUSED record with `S[id].stopEpoch < E[follower]` is
  STOPPED (§5.2).
- The live set of a follower = its ids with an effective status of ACTIVE or PAUSED (all of them from the current
  epoch).
- The uniqueness key points to the live id, or to none.

Ordering within one transaction: `NonceUsed` comes first in every signed call. `initialize` emits
`OwnershipTransferred`, `VenueUpdated(1)`, `VenueUpdated(2)`, `BuilderTermsUpdated`, one `ExecutorSet` per initial
executor, and `Initialized(1)`. The proxy's constructor emits `Upgraded(implementation)` before them.

The invariant suite runs exactly this indexer (`test/invariant/EventIndexer.sol`) over the logs of every call and
compares it with every view after every call (§12, I2).

Views: `getSubscription`, `statusOf`, `stopDetails`, `subscriptionCount`, and the paginated
`subscriptionsOfFollower`, `liveSubscriptionsOfFollower` and `subscriptionsOfLeader`. Also `liveSubscriptionFor`,
`isCopyable`, `stopEpochOf`, `killSwitchInfo`, `effectiveBuilderFee`, `builderTerms`, `isExecutor`, `executorInfo`,
`commitment`, `venueInfo`, `isNonceUsed`, `nonceBitmap`, `DOMAIN_SEPARATOR`, `eip712Domain`, `VERSION`, `owner`,
`pendingOwner`, `paused` and `proxiableUUID` (the last only on the implementation).

- **Pagination:** an offset at or past the end returns an empty page. `limit` is not capped; the page is clamped to
  the list's end, so the caller bounds the work.
- The live set uses swap-and-pop, so its order changes when an element leaves. A multi-call scan is consistent only at
  one block (`eth_call` at a fixed block number).
- To read many subscriptions, batch `eth_call`s.

## 10. Upgrades and governance

### 10.1 The UUPS pattern

- **Proxy:** OpenZeppelin `ERC1967Proxy` (v5.7.0). Its address is the contract everyone uses and the EIP-712
  `verifyingContract`.
- **Implementation:** `ValuescanCopyTrading is Initializable, UUPSUpgradeable, Ownable2StepUpgradeable,
  PausableUpgradeable, EIP712Upgradeable`, from OpenZeppelin Contracts Upgradeable 5.7.0 (vendored, SHA-256 verified;
  `contracts/README.md`).
- **Locked implementation:** its constructor calls `_disableInitializers()`, so the implementation can never be
  initialised, never has an owner, and has no enabled venue. `upgradeToAndCall` on it reverts
  (`UUPSUnauthorizedCallContext`): `onlyProxy`.
- **Atomic initialisation:** `initialize(owner, builderId, perpsFee, spotFee, executors)` runs inside the proxy's
  constructor (its `_data`), so it cannot be front-run. It can never run again (`InvalidInitialization`). A later
  implementation uses `reinitializer(n)` for its own set-up.
- **Upgrade authorisation:** `_authorizeUpgrade` is `onlyOwner`. OpenZeppelin checks the new implementation's
  `proxiableUUID` (a target without it, or without code, is rejected), sets the ERC-1967 slot, emits `Upgraded`, and
  delegatecalls `data` if it is non-empty.
- **No funds, even here:** `upgradeToAndCall` is `payable` by the UUPS standard. This contract overrides it to revert
  with `FundsNotAccepted` on any value. The proxy's `fallback` forwards value only to non-payable functions, which
  revert, and the proxy's constructor rejects value because `initialize` is non-payable. The invariant I1 checks the
  balance of the proxy and of both implementations.
- `renounceOwnership` is disabled (`RenounceDisabled`), so the proxy can never be left without an upgrade authority by
  accident.

### 10.2 Governance: TimelockController in front of a multisig

Recommended owner, configured **at deployment** (nothing is deployed now; `script/DeployValuescanCopyTrading.s.sol`
documents the wiring and cannot be run):

```
multisig (Safe, N-of-M)  --proposes/executes/cancels-->  TimelockController(minDelay = 48 h, admin = none)
                                                                  |  owner()
                                                                  v
                                                       ERC1967Proxy  --delegatecall-->  ValuescanCopyTrading impl
```

- `TimelockController(48 hours, proposers = [multisig], executors = [multisig], admin = address(0))`. Proposers are
  also cancellers. With no admin, the timelock administers itself: even its delay can change only through a scheduled,
  delayed operation.
- The proxy is initialised with the **timelock** as owner, so no ownership transfer is needed. If ownership ever moves,
  `Ownable2Step` requires the new owner to accept, and a timelock accepts only through its own delay.
- **Every** owner action goes through the 48 h delay: upgrades, builder terms, venues, executors and pause. That is
  acceptable because:
  - the pause only blocks new activity, and stops never depend on the owner;
  - a fee increase is capped by consent;
  - a compromised executor can only publish bogus commitments on-chain; its SoDEX keys are the real risk, and those
    are revoked on SoDEX.

  Whether an instant pause or executor removal is needed is open question Q3.
- **Why 48 h:** followers see `CallScheduled` (target = proxy, data = `upgradeToAndCall(newImpl, …)`) two days before
  it can execute. They can inspect the new implementation's verified source and, if they disagree, stop copying and
  revoke their SoDEX key. No upgrade can block the key revoke.
- **Monitor every `CallScheduled` of the timelock, not only those for the proxy** (audit SEC-02). The timelock
  administers itself, so `updateDelay(0)` is a call whose target is the timelock. Once it has waited its own 48 h and
  run, a proxy upgrade can be scheduled and executed in the same block. Calls on the timelock itself (`updateDelay`,
  `grantRole`, `revokeRole`) and any ownership transfer are therefore announced like an upgrade, 48 h ahead. With that
  rule followers always get the full 48 h (`test/audit/security/SEC02_TimelockNoticeBypass.t.sol`). Enforcing a floor
  on-chain (a TimelockController whose `updateDelay` reverts below 48 h) is open question Q14.

`test/upgrade/Upgrade.t.sol` runs this exact wiring:

- the timelock takes ownership through its own delay;
- an upgrade cannot execute one second early;
- the multisig cannot upgrade directly;
- a follower stops during the window;
- the upgrade executes after 48 h.

### 10.3 Storage layout and the guard

Rules for every future implementation:

1. **Never** remove, reorder, retype or rename a member of `CopyTradingStorage` or of a struct stored in it. Never
   change `STORAGE_LOCATION` or the namespace id.
2. New fields are **appended** to the end of `CopyTradingStorage`, or to the end of a struct that is stored in a
   mapping (`Subscription`, `Executor`, `Commitment`, `KillSwitch`, `Venue`), or placed in a **new** ERC-7201
   namespace (the pattern of `ValuescanCopyTradingV2Mock`). An inline struct may grow only while it is the last member
   (today `builderTerms`).
3. Do not add sequential state variables. The contract has none, and the tests assert that slots 0–63 stay empty.
4. Enum members may only be **appended**. `Status`, `MarketScope`, `SizingMode` and `SymbolMode` are stored as their
   ordinals in every `Subscription`: inserting, removing, reordering or renaming a member changes what every stored
   record means, for example a `HALTED` inserted before `STOPPED` would make every stopped subscription live again, and
   swapping `ALLOW` and `DENY` would turn "never trade X" into "trade only X" (audit SEC-01). `StopReason` and
   `TermsField` are not stored, but they are ABI: the same rule applies.

The guard has two parts. Both fail on any incompatible change:

- **Snapshot + script:** `storage-layout/ValuescanCopyTrading.json` is the committed, id-free layout of the namespace:
  every struct reachable from it, with every member's name, slot, offset and type, and the member list of every enum
  stored in it. The compiler's layout describes an enum only by its name and size, so the script reads the enum
  members from the definitions under `src/` (comments stripped, scopes resolved). Run
  `node tools/storage-layout.mjs check` after `forge build`. It compares the compiler's current layout (read through
  the harness `test/upgrade/StorageLayoutHarness.sol`, because a namespaced struct is not a state variable) with the
  snapshot, and applies the rules above. `update` records an append (and refuses anything else); `selftest` proves
  that the checker rejects the following and accepts appends:
  - reordering, retyping, renaming or removing a member;
  - inserting a member in the middle;
  - changing a packing offset;
  - removing a struct;
  - moving the location;
  - growing an inline struct that is not the last member;
  - inserting, reordering, renaming or removing an enum member, or removing a stored enum (appending is accepted).

  It was also checked end to end: moving `stopEpoch` to the end of the namespace fails `check` with the list of
  shifted members, and the auditor's SEC-01 edit (`HALTED` inserted into `Status`, `ALLOW` and `DENY` swapped), which
  the previous version accepted, now fails with `INCOMPATIBLE storage layout change`.
- **Raw-slot test:** `test/upgrade/StorageLayout.t.sol` writes through the public API and reads raw storage with
  `vm.load`. It pins:
  - the ERC-7201 root, recomputed from the formula;
  - every member's slot and every packed field's bit offset, including the `Subscription` packing and the `keyName`
    encoding;
  - the OpenZeppelin namespaces;
  - the empty EIP-712 namespace;
  - the locked implementation's `_initialized = type(uint64).max`;
  - the ordinal of every member of every stored enum, and of `StopReason` and `TermsField`
    (`test_enumOrdinalsArePinned`), so an in-place edit of an enum fails the suite.

### 10.4 The EIP-712 domain across upgrades

- `name = "ValuescanCopyTrading"` and `version = "1"` are returned by `_EIP712Name()` and `_EIP712Version()`, which
  are overridden to return the constants in `CopyTradingConstants`. They are not read from storage, so the domain
  never depends on an initialiser.
- `verifyingContract` is the proxy, and `chainId` is read live. **An upgrade that keeps the two constants keeps the
  domain separator byte for byte, and every outstanding signature stays valid.** This is tested: an unsubscribe, a
  subscribe and an emergency `UnsubscribeAll`, all signed before the upgrade, all land after it.
- **A deliberate bump** means a new implementation returns another name or version. Its effect:
  - **every** outstanding signature becomes invalid at the moment the upgrade executes: pending subscribes, updates,
    resumes, stops, nonce invalidations, and the pre-signed emergency `UnsubscribeAll` that followers or watchdogs
    keep;
  - direct calls are unaffected, and the kill switch stays available directly;
  - the upgrade MUST emit ERC-5267 `EIP712DomainChanged()`, from its re-initializer;
  - the UI MUST re-read `eip712Domain()`, tell followers that their stored emergency stops are void, and ask them to
    re-sign;
  - the 48 h timelock window is when followers should use or replace them.

  This is tested with `ValuescanCopyTradingDomainBumpMock`.
- Bump only if old signatures could become **dangerous** under the new code. Changing a type (adding a field)
  already changes its type hash, so old signatures of that type stop matching without a bump.

### 10.5 Upgrade procedure

1. Write the new implementation: append-only storage, `reinitializer(n)` for its own set-up, a new `VERSION()`, and
   either the same EIP-712 name and version or a documented bump (§10.4). Keep the event ABI backward compatible, or
   version it, because indexers rebuild state from events.
2. Check it: `forge build`, `node tools/storage-layout.mjs check`, the full test suite (the upgrade tests take a V1
   state with every kind of record and assert that all views are unchanged after the upgrade), `forge build --sizes`
   (EIP-170: the V1 implementation is 22,531 bytes, and the test suite asserts at least 1,536 bytes of headroom),
   `test/audit/dos/ComplexityGuards.t.sol` (every call's cost must stay independent of list sizes), and an external
   review.
3. Deploy the new implementation. Its constructor locks it. Verify its source on the ValueChain explorer.
4. The multisig schedules `upgradeToAndCall(newImpl, reinitData)` on the timelock. ValueDesk announces it, and the UI
   shows it with a link to the verified source and a diff.
5. After 48 h, the multisig executes it. `Upgraded(newImpl)` is emitted. Indexers and executors continue from the
   events.

### 10.6 What the owner can and cannot do

| Owner can | Owner cannot (without an upgrade) |
|---|---|
| `setBuilderTerms` within SoDEX's caps | Raise any follower's effective fee above its consent |
| `setVenue(id, enabled, name)`: enable or disable a venue for **new** subscriptions | Stop, pause or edit any subscription; change a stop epoch |
| `setExecutor(addr, authorised)` | Edit or delete commitments; touch nonces |
| `pause()` / `unpause()`: block subscribe, update and resume (and their signed variants) | Block pause, unsubscribe, unsubscribeAll, their signed variants, nonce invalidation or commitments |
| Transfer ownership in two steps | Renounce ownership |
| **Upgrade the implementation** (through the 48 h timelock) | Move funds: there are none, and the contract never had access to any SoDEX account |

**Upgradeability is a trust trade-off, stated plainly:** an upgrade can replace every rule above. The mitigations are:

- the 48 h public delay and the multisig;
- verified sources and the storage-layout guard;
- the follower's hard stop on SoDEX (revoke the key), which no upgrade can prevent;
- the absence of funds.

## 11. Gas and bounded work

Measured on ValueChain rules (Prague) with `forge test --match-path test/gas/Gas.t.sol`, with the proxy's storage
cold (`vm.cool`). The figures are **transaction gas** as Foundry 1.8.3 reports it for a top-level call: 21,000
intrinsic gas, plus calldata (with Prague's EIP-7623 floor), plus execution. The call frame alone is about 21k less
(for example 52,994 for `unsubscribeAll`; `test/audit/dos/GasAccounting.t.sol`). The numbers are written to
`contracts/snapshots/ValuescanCopyTrading.json`, and each is bounded by an assertion, so a regression fails the
suite. Cost column: gas × the measured `eth_gasPrice` of 0.002 gwei (2,000,000 wei); nothing is added.

| Action | Gas | Cost |
|---|---|---|
| `subscribe` (ALL symbols, follower's first) | 385,520 | ≈ 0.77 µSOSO |
| `subscribe` (follower's second) | 368,420 | ≈ 0.74 µSOSO |
| `subscribe` (2 symbols) | 391,950 | ≈ 0.78 µSOSO |
| `subscribe` (50 symbols) | 569,487 | ≈ 1.14 µSOSO |
| each extra symbol (execution and calldata) | ≈ 3,700 | ≈ 0.007 µSOSO |
| `subscribeWithSig` (EOA / ERC-1271) | 421,944 / 431,267 | ≈ 0.84 / 0.86 µSOSO |
| `updateSubscription` / `...WithSig` | 90,827 / 116,604 | ≈ 0.18 / 0.23 µSOSO |
| `pauseSubscription` / `...WithSig` | 41,291 / 72,611 | ≈ 0.08 / 0.15 µSOSO |
| `resumeSubscription` / `...WithSig` | 45,637 / 78,050 | ≈ 0.09 / 0.16 µSOSO |
| `unsubscribe` / `...WithSig` | 46,319 / 75,755 | ≈ 0.09 / 0.15 µSOSO |
| `unsubscribeAll` with 1 **or 200** live subscriptions | 73,987 (identical) | ≈ 0.15 µSOSO |
| `unsubscribeAllWithSig` | 105,442 | ≈ 0.21 µSOSO |
| `invalidateNonces` | 50,943 | ≈ 0.10 µSOSO |
| `commitExecutions` | 82,028 | ≈ 0.16 µSOSO |
| `setBuilderTerms` / `setVenue` (new) / `setExecutor` / `pause` | 36,434 / 77,693 / 52,694 / 52,073 | ≤ 0.16 µSOSO |
| `upgradeToAndCall` (with a re-initializer) | 68,803 | ≈ 0.14 µSOSO |
| view `getSubscription` / `isCopyable` / `effectiveBuilderFee` | 28,201 / 14,681 / 12,956 | free (`eth_call`) |
| view `liveSubscriptionsOfFollower`, page of 100 | 249,513 | free (`eth_call`) |

`unsubscribe` became about 4.7k cheaper with the SEC-04 fix, because a stop no longer clears the key's `liveByKey`
slot; the next subscription of the same key then rewrites a non-zero slot. `subscribeWithSig` costs about 80 gas more
(one more signed word).

`forge snapshot` writes `.gas-snapshot` for every test.

Consequences:

- **Gas is not a design driver on ValueChain.** One SOSO pays for more than a million relayed subscriptions.
  Readability and auditability win over micro-optimisation: events carry full records, and symbols are
  self-describing.
- **Bytecode is a design driver.** The implementation is 22,531 bytes (EIP-170 limit 24,576) and the V2 mock
  22,897.
  To keep room for upgrades, this version removed:
  - the `hash*` digest views (clients compute digests; §6.8);
  - `getSubscriptions` (batch `eth_call`s instead);
  - `verifyExecution` (check proofs off-chain);
  - the enumerable executor list (rebuilt from events).

  The suite fails if the headroom falls below 1.5 KB.
- **Bounded work per call:** no function loops over a stored list. The loops that exist run over the caller's own
  input: the key name (≤ 36 bytes), the symbols, the page `limit`, and the initial executors. The kill switch is O(1)
  (§5.2). With no caps, a follower may create any number of subscriptions, and each costs that follower gas. It
  affects no one else's gas, because no path iterates over them. Lists are paginated, and `limit` is the caller's
  choice. An `eth_call` gas cap (geth's default is 50 M) allows pages of thousands of ids.
  `test/audit/dos/ComplexityGuards.t.sol` measures 14 state-changing entry points and 9 views on a state with 256
  entries in every list against a state with 1, and fails if any call costs more than 100 gas extra.
- **Followers need no SOSO** (signed variants). The relayer needs a small SOSO float and monitoring.

## 12. Invariants and security considerations

Stateful invariants (`test/invariant/`), checked after every call of every run:

- The handler drives the proxy with bounded random actions:
  - three EOA followers and one ERC-1271 smart-wallet follower, each acting directly and through signatures submitted
    by a relayer;
  - the owner (pause, builder terms, venues, executors);
  - two executors (commitments);
  - time warps across expiries;
  - one live upgrade to the V2 mock in the middle of a run.
- A separate attack handler interleaves: strangers, the owner and executors touching someone else's subscription;
  forged and replayed signatures; plain value transfers and calls with value; and unauthorised governance and
  upgrades.

| # | Invariant |
|---|---|
| I1 | **No funds:** the proxy, the implementation and the V2 implementation hold 0; no call carrying value ever succeeded |
| I2 | **Events rebuild the state:** an indexer fed only the logs (§9) matches every view after every call: every record, follower history, live set, leader history, stop epoch and kill-switch record, nonce bitmap, venue, builder terms, executor and last commitment, pause flag, owner, pending owner and implementation. Every event's symbol list matches its `symbolsHash`. There are no unknown events |
| I3 | **Only the follower changes its subscriptions:** every subscription event was authorised by that subscription's follower (directly or by signature), and every attack failed |
| I4 | **A follower can always stop:** after every call, with the contract paused on purpose, each follower can unsubscribe every live subscription, a signed `UnsubscribeAll` submitted by a stranger stops them all, and the direct kill switch still works afterwards |
| I5 | **Stop-epoch semantics:** every ACTIVE or PAUSED record from an older epoch is STOPPED, not copyable, and reports the right kill switch in `stopDetails`; the live set holds only current-epoch ids; `stopEpochOf` equals the number of kill switches; `liveSubscriptionFor` never returns a stale id |
| I6 | **The model agrees with the contract:** every call the handler's model says must succeed (valid, authorised, not blocked by the pause) succeeded, and every call it says must fail failed (pause scope, validity, duplicates, expiry). Versions increase by exactly 1; STOPPED is never revived; target fields, `createdAt` and `stopEpoch` never change. The handler signs only current, valid messages, so the version, stop-epoch and key-history bindings and stale or invalid signatures are covered by the unit, signature and audit tests, not by the campaign (audit leftover) |

Security notes:

- **Zero funds.** There is no receive, no fallback, no payable function of the contract's own, and
  `upgradeToAndCall` rejects value. Every function reverts when called with value (tested for 33 functions and three
  callers). SOSO can still be forced in (a `SELFDESTRUCT` beneficiary, or a coinbase payment). It would then be stuck
  forever, because a rescue function would be a fund-moving function. This is tested, documented and deliberate.
- **Re-entrancy.** The only external call on a follower path is the ERC-1271 `STATICCALL`, made before any state write.
  No guard is needed. The `reentrancy-events` lint is reviewed and excluded for this reason (`foundry.toml`).
- **Authorisation.** Every subscription mutation checks `msg.sender == follower`, or a valid signature by the stored
  follower for that exact action type, subscription, version (update and resume), stop epoch and key history
  (subscribe), nonce, deadline, chain and proxy.
- **Replay** across actions, chains, contracts and time is covered in §6 and tested case by case.
- **Denial of service.** No function iterates over stored data, so no amount of spam by anyone can make a stop, a
  kill switch or another follower's action more expensive **on-chain** (`test/audit/dos/ComplexityGuards.t.sol`).
  Anyone can create subscriptions, but only for themselves. Index growth is append-only and paginated. Off-chain,
  spam subscriptions to a leader are cheap and look like real followers; the executor's admission control and
  separate stop path (§8.3) and the relayer's rules (§6.7) keep them out of the copy path and away from the stop SLA.
- **Upgrade risk.** See §10.6. The storage guard, the timelock and the tests reduce the risk of accidents; followers'
  SoDEX key revoke bounds malice.
- **Owner key risk.** A compromised multisig can schedule a malicious upgrade, which becomes public 48 h before it can
  execute. Followers MUST be alerted by ValueDesk's monitoring of **every** `CallScheduled` on the timelock,
  including calls on the timelock itself (§10.2, audit SEC-02).
- **Privacy.** Everything is public: who copies whom, allocation caps, stop levels and fee consents. Aggregate copy
  demand per leader can be computed, and stop-loss levels could be hunted. This is inherent to an on-chain record; UIs
  MUST tell followers before they subscribe.
- **Front-running of copy orders** on SoDEX is possible for anyone who watches leaders; the slippage cap and IOC orders
  bound the damage. The contract does not change this.
- **ERC-1271 gas griefing** only affects the transaction of the wallet that signs; relayers cap gas and simulate.
- **Clock.** `block.timestamp` on ValueChain is trusted to within a few seconds. Expiry and deadlines are in seconds
  and are not sensitive to that.
- **solc 0.8.36 known bugs** are avoided by coding rule (`contracts/README.md`). The contract has no recursion, so
  via-IR's spill-slot bug cannot apply.

## 13. Deployment checklist (nothing is deployed)

Deployment needs the owner's written go. `script/DeployValuescanCopyTrading.s.sol` is marked **"DO NOT RUN"**:
`run()` always reverts, it holds no key, no RPC URL and no address, and its wiring is only exercised inside the local
test EVM (`test/script/DeployWiring.t.sol`). Before any deployment:

1. External audit of the implementation, the interface and this spec.
2. Owner decisions on the open questions (§16), at least Q1–Q4.
3. The multisig (signers, threshold) exists on ValueChain, and the timelock parameters are confirmed (48 h, the
   multisig as the only proposer and executor, no admin).
4. `builderId` = ValueDesk's SoDEX account id. That account holds ≥ 100 vUSDC on both engines.
5. The executor addresses, generated in the key store.
6. Deploy order: timelock → implementation → proxy with `initialize(timelock, builderId, perpsFee, spotFee,
   executors)` in its constructor. Verify all three sources on the explorer.
7. Post-deploy read-only checks:
   - `owner()` = timelock;
   - `eip712Domain()` = (`ValuescanCopyTrading`, `1`, 286623, proxy);
   - the implementation's `_initialized` is `type(uint64).max`;
   - `node tools/storage-layout.mjs check` passes on the deployed commit.
8. The TypeScript SDK in `packages/copy-contract` follows this ABI: `npm run abi:check` and `npm run vectors:check`
   must pass on the deployed commit.

## 14. Test plan and results

Run from `contracts/` (see the README for the commands). Results on 2026-09-25, Foundry 1.8.3, solc 0.8.36:

| Suite | File | Tests | What it covers |
|---|---|---|---|
| Deployment | `test/unit/Deployment.t.sol` | 13 | Proxy deployment and `initialize` state; the exact event order an indexer needs; zero owner, invalid fees and zero executor at init; re-initialisation of the proxy; the locked implementation; the domain and ERC-5267 fields; chain-id binding; two-step ownership; renounce disabled; EIP-170 headroom |
| Subscribe | `test/unit/Subscribe.t.sol` | 26 | The stored record field by field; the full `Subscribed` event; ids; every target and terms revert with its exact field; edge values; the uniqueness guard (live, paused, after stop, after kill switch, other account, venue or follower); enum decoding; **no limits** (60 subscriptions, 300 symbols, symbols over 32 bytes, 255x leverage, uint64 sizing, uint32 take profit, expiry `type(uint40).max`) |
| Lifecycle | `test/unit/Lifecycle.t.sol` | 20 | Update (full `SubscriptionUpdated` record, status kept, renewal of an expired subscription, venue ignored, every revert), pause, resume (expiry), unsubscribe, STOPPED terminal, pause scope, views, the expiry boundary, `effectiveBuilderFee`, pagination edges |
| Kill switch | `test/unit/KillSwitch.t.sol` | 6 | Epochs, effective status, `stopDetails`, live-set reset, terminality, new subscriptions after a kill switch, O(1) gas (100 subscriptions vs 1) |
| Governance | `test/unit/Governance.t.sol` | 10 | Every owner function against strangers, executors, followers and the relayer; builder terms, venues, pause; the executor set; commitments (epochs, pause, de-authorisation); the owner and executors cannot touch subscriptions |
| Nonces and funds | `test/unit/NoncesAndFunds.t.sol` | 8 | Nonce invalidation; every function rejects value (33 functions × 3 callers); plain transfers; unknown selectors; `upgradeToAndCall` with value; proxy deployment with value; forced funds are inert |
| Signatures | `test/signatures/Signatures.t.sol` | 30 | Every `...WithSig` for an EOA and an ERC-1271 wallet; `NonceUsed` first; wrong signer for every action; another follower's signature; the relayer cannot alter any field (symbols included); zero follower; deadline (inclusive, then expired); replay; nonces shared across types; invalidated nonces; wrong chain and fork; wrong contract; cross-type; version binding for update and resume; stops not version-bound; stop-epoch binding; pre-signed emergency stop while paused; pause scope; high-s; 64-byte; garbage; rejecting and reverting 1271 wallets; an EIP-7702 account |
| Fuzz | `test/fuzz/Bounds.t.sol` | 22 × 1,000 runs | Every terms field against its exact bound and reported field (key name as random bytes and from the charset, key, allocation/leverage/notional, sizing, stop loss, drawdown, take profit, slippage, symbol mode and count, symbol content, fee consents, expiry, leader and account, venue); builder terms; effective fee = min; pagination; any nonce works once; invalidation; deadlines; commitment epochs |
| Invariants | `test/invariant/*` | I1–I6, 256 runs × depth 100 = 25,600 calls, `fail_on_revert = true` | §12 |
| Upgrade | `test/upgrade/Upgrade.t.sol` | 11 | `proxiableUUID`; the implementation cannot be upgraded or used; upgrade to a V2 that adds a field keeps **all** state (digest of every view before and after); upgrade without a call; only the owner can upgrade; non-UUPS and code-less targets rejected; no re-initialisation of the proxy or either implementation; signatures survive an upgrade; a domain bump invalidates them; the 48 h timelock flow; the V2 mock fits EIP-170 |
| Storage layout | `test/upgrade/StorageLayout.t.sol` | 5 | ERC-7201 roots; raw slots and packing of every member; OpenZeppelin namespaces; no sequential storage; every enum ordinal pinned (SEC-01) |
| EIP-712 spec | `test/spec/EIP712Spec.t.sol` | 7 | Canonical type strings; all eight message types against Foundry's JSON encoder; the published vectors; wallet JSON accepted by the live proxy |
| Gas | `test/gas/Gas.t.sol` | 26 | §11 table with regression bounds; kill switch identical with 200 subscriptions |
| Deploy wiring | `test/script/DeployWiring.t.sol` | 2 | `run()` always reverts; the timelock/proxy wiring in a local EVM |
| Cross-check | `test/CrossCheckVectors.t.sol` (generated by `packages/copy-contract`) | 8 | The TypeScript SDK against the contract: every digest, the contract's own ERC-1271 digest, signers, a 42-step scenario (logs, return data, reverts), 92 views, 63 invalid-terms cases, commitments, the timelock flow |
| Audit: security | `test/audit/security/*.t.sol` | 10 | Regression tests of SEC-01 (enum renumbering), SEC-02 (timelock self-call monitoring), SEC-03 (nonce ambiguity and the corrected relayer rule), SEC-04 (withheld Subscribe after a stop, retries, re-subscribe, kill switch, binding is signed) |
| Audit: DoS and tests | `test/audit/dos/*.t.sol` | 30 | Leader spam cost and pagination, O(1) cost of 14 entry points and 9 views on large vs small state (`ComplexityGuards`), mutation-gap tests for the signed paths, indexed topics and paging, gas accounting |

Results:

- **`forge test`: 235 tests, 235 passed, 0 failed, 0 skipped** (23 suites; the invariant contract counts as one test
  with six invariants; 256 runs, 25,600 calls, `fail_on_revert = true`).
- **`forge coverage --ir-minimum`** (without the invariant campaign) on `src/ValuescanCopyTrading.sol`:
  - lines 98.39 % (366/372);
  - statements 98.48 % (390/396);
  - branches 100 % (29/29);
  - functions 100 % (85/85).

  The six lines reported as uncovered are instrumentation artefacts of the coverage build: the `$.slot` assembly
  assignment, the constructor's `_disableInitializers()`, the empty `__Ownable2Step_init()` and `__Pausable_init()`,
  and the `_pause()` / `_unpause()` wrappers. All of them run in the tests.
- **Storage guard:** `node tools/storage-layout.mjs check` passes (9 structs, 4 enums), and `selftest` passes (19
  cases and the enum-parser check).
- **`forge fmt --check`:** clean.
- **`forge build --sizes`:** implementation 22,531 bytes (2,045 bytes free); V2 mock 22,897.
- **`forge lint`:** 0 findings.
- **TypeScript SDK:** 95/95 tests, typecheck clean, ABI and vectors up to date.

## 15. What the executor, UI and indexer must know about upgrades

- Treat `Upgraded(newImpl)` as a schema checkpoint. Read `VERSION()`. Continue with the event ABI of that version.
- Watch **every** `CallScheduled` of the timelock, not only those for the proxy, and alert followers at once; calls on
  the timelock itself count as upgrade-level (§10.2, audit SEC-02).
- Watch for `EIP712DomainChanged`. After it, re-read `eip712Domain()`, and tell followers to re-sign pending messages
  and emergency stops.

## 16. Open questions for the owner

1. **Uniqueness guard (§5.3).** Keep the rule "one live subscription per (follower, SoDEX account, venue, leader)"? It
   is a correctness guard (double exposure; SoDEX nets positions per account and symbol), not a limit. Dropping it
   would require the executor to aggregate several subscriptions into one position, with ambiguous stop, PnL and
   `closePositions` semantics.
2. **Self-copy on SoDEX.** `leader == follower` is rejected on SoDEX only, to prevent a feedback loop. It is allowed
   from Hyperliquid. Confirm. Relatedly: the executor skips leader fills produced by ValueDesk's own copy orders
   (cycle protection, §8.3), so copying an address that is itself a ValueDesk follower copies only its own decisions.
   Is that the wanted behaviour?
3. **Instant actions.** With the timelock as owner, pause, executor removal and fee changes also wait 48 h. Acceptable
   (the recommendation, since stops never depend on the owner)? The alternative is a separate guardian role that can
   only pause instantly, which is a small code change.
4. **Multisig and timelock:** signers, threshold, and the exact delay (48 h recommended).
5. **Licence.** The files are `UNLICENSED` as a placeholder. MIT or BUSL-1.1?
6. **Fees at launch:** `perpsFee` / `spotFee`, and the default consent the UI requests (report 06 suggests 50 = 5 bp
   on perps opens, 0 on spot).
7. **Privacy.** Is it acceptable that allocations, stop levels and consents are public (§12)?
8. **Removed conveniences.** The `hash*` digest views, `getSubscriptions`, `verifyExecution` and the enumerable
   executor list were dropped to keep 2 KB of bytecode headroom for upgrades (§11). Are any of them wanted back? They
   can come back in an upgrade if bytecode allows.
9. **SoDEX, to verify or ask:**
   - mask-14 enforcement on mainnet;
   - whether on-chain `revokeAPIKey` removes REST-registered keys, and the reverse;
   - key-propagation latency;
   - the real per-account key limit;
   - an on-chain builder approval for contract-owned accounts (without it, ERC-1271 followers cannot pay builder fees);
   - sub-accounts (per-leader isolation; today several leaders net in one account per symbol).
10. **ValueChain:**
    - consensus and finality (how many blocks can reorg);
    - whether a WebSocket RPC with `eth_subscribe` exists;
    - EIP-170 enforcement (assumed; not probed);
    - whether SoDEX's allowlisted Transaction Relayer could sponsor our relayer's gas.
11. **Per-trade take profit.** v1 has a total take profit only (plus a per-trade stop loss). Add a per-trade TP?
12. **Compiler.** Move to solc 0.8.37 (released 2026-09-10) once it has aged?
13. **Regulation.** Report 03 notes that ESMA treats automated copy trading as portfolio management. The contract does
    not change that analysis; legal review is outside this spec.
14. **Timelock delay floor (audit SEC-02, low).** Deploy a TimelockController subclass whose `updateDelay` reverts
    below 48 h, so the notice period is enforced on-chain rather than only by monitoring? A small change to the
    deployment wiring, not to this contract.
15. **Message identity in `NonceUsed` (audit SEC-03, low).** Add the EIP-712 digest to `NonceUsed`, so that anyone can
    tell from the log which message consumed a nonce? It changes an event signature (indexers, SDK); today the relayer
    reads the transaction's calldata instead.
16. **Spam validity checks (audit, leader spam).** Optionally require on-chain that `sodexAccountId` belongs to the
    follower (a read of ClobGateway `getAccountsByAddress` in `subscribe`, never on a stop path), and that symbols
    follow SoDEX's symbol grammar and maximum length? Both are validity rules, not limits; both add an external
    dependency or bytecode. The recommendation is to keep the off-chain admission control of §8.3 instead.

## Audit log (2026-09-25)

Two reviews ran on this revision: a security review and a denial-of-service, gas and test-quality review. Each proved
its findings with Foundry tests under `contracts/test/audit/`. Every finding was then checked against the code: the
medium ones are fixed, the low and info ones are listed as leftovers (with the documentation corrected where it was
wrong), and every proving test is kept as a regression test. All of them now pass. Nothing was deployed or broadcast.

| ID | Severity | Finding | Verdict | Resolution | Regression tests |
|---|---|---|---|---|---|
| SEC-04 | Medium | A withheld signed `Subscribe` could restart copying after the follower unsubscribed from that leader: only the kill switch voided pending Subscribes, and the untrusted relayer chooses when a signature lands | Confirmed | **Fixed in the contract.** `Subscribe` carries `expectedLastId`, the key's `lastSubscriptionFor` when signed; `_stop` no longer clears `liveByKey`; new error `LastSubscriptionMismatch(expected, actual)` and new view `lastSubscriptionFor` (§6.6). The `Subscribe` type hash changed (§6.2, §6.8). The SDK, ABI, vectors and cross-check were regenerated; the scenario now includes the auditor's attack | `test/audit/security/SEC04_WithheldSubscribeAfterStop.t.sol` (5 tests); `CrossCheckVectors.t.sol` scenario steps 40–42 |
| SEC-01 | Medium | The storage-layout guard could not see enum ordinals, so an upgrade it approved could revive STOPPED subscriptions or turn DENY lists into ALLOW lists | Confirmed; reproduced on the auditor's scratch copy | **Fixed in the guard.** `tools/storage-layout.mjs` records the member list of every stored enum and accepts only appends (6 new selftest cases and a parser self-check); `test_enumOrdinalsArePinned` pins every ordinal; §10.3 rule 4. The auditor's exact edit now fails `check` with exit 1 | `test/audit/security/SEC01_EnumOrdinalUpgrade.t.sol` (2); `StorageLayout.t.sol::test_enumOrdinalsArePinned`; `selftest` |
| DOS-1 | Medium | Anyone can attach unlimited, never-expiring, "copyable" fake subscriptions to any leader for about 0.7 µSOSO each, and the spec's executor did work for each one | Confirmed. On-chain cost stays flat; the impact is off-chain | **Fixed in the spec, not with an on-chain limit** (the owner decided "no limits"): normative admission control, backoff and a separate stop path for the executor (§8.3); relayer key and account checks (§6.7); §12 now says "on-chain". Optional on-chain validity checks are Q16 | `test/audit/dos/LeaderSpam.t.sol` (documents the cost); `ComplexityGuards.t.sol` |
| SEC-02 | Low | The 48 h upgrade notice can drop to zero through a timelock self-call (`updateDelay`) that a proxy-only monitor does not see | Confirmed | **Leftover on-chain** (Q14: a delay floor). §10.2, §12, §15 and INTEGRATION.md now require monitoring every `CallScheduled`; the SDK flags calls on the timelock itself as critical | `SEC02_TimelockNoticeBypass.t.sol` (proves a monitor of every `CallScheduled` still gets 48 h) |
| SEC-03 | Low | `NonceUsed` does not say which message used the nonce, so the old §6.7 rule could report a stop as landed while copying had been resumed | Confirmed | **Leftover on-chain** (Q15: the digest in `NonceUsed`). §6.5 and §6.7 corrected: concurrently pending messages never share a nonce, stops use random nonces, and idempotency is checked against the landed transaction's digest or the target's status | `SEC03_NonceUsedAmbiguity.t.sol` (2) |
| DOS-2 | Low | Uncapped symbol lists let anyone push about 127 KB per block into the event stream the executor reads | Confirmed | **Leftover.** §8.3: stops on their own topic-filtered path, symbol lists parsed lazily within a byte budget; a symbol-grammar validity rule is Q16 | `LeaderSpam.t.sol` |
| DOS-3 | Low | Only the kill switch was tested for constant cost as lists grow | Confirmed | Resolved by the auditor's tests, kept in the suite and added to the upgrade procedure (§10.5) | `ComplexityGuards.t.sol` (15) |
| DOS-4 | Low | 15 non-equivalent mutants in the signed paths, the indexed event topics and live-set paging survived the suite | Confirmed | Resolved by the auditor's tests, kept in the suite. Checking indexed topics in `EventIndexer` is a leftover | `MutationGaps.t.sol` (9) |
| DOS-5 | Low | The invariant campaign never produces stale or invalid signatures, predicts duplicates from the contract's own view, and asserts no coverage | Confirmed | **Leftover** (handler improvements). The §12 I6 wording is corrected; unit, signature and audit tests cover these paths | — |
| DOS-6 | Info | The §11 figures are transaction gas labelled as call-frame gas, and the cost column counted 21k twice | Confirmed | §11 relabelled and recomputed (the figures had to be refreshed after the fixes anyway) | `GasAccounting.t.sol` (2) |
| — | Note | Signed stops are not version-bound, so a held `Unsubscribe` with `closePositions` lets its holder choose when to flatten | By design | Unchanged: a stop must always land. Keep stop deadlines short and treat pre-signed emergency stops as bearer instruments (§6.6) | — |

**Residual of the SEC-04 fix.** A `Subscribe` signed while its key's last subscription is still live carries that
id, so it becomes valid the moment that subscription stops. UIs never need to sign one (terms change with an update):
§6.6 forbids it, and the SDK's `subscriptionProblems` reports it as `DUPLICATE`. A Subscribe for a key with no subscription yet is voided only by its
deadline, by nonce invalidation or by the kill switch; that is the ordinary life of any signed message.

**Spec-conformance self-check** against the owner's decisions of 2026-09-25:

- No leader opt-out and no leader role: no such function, event, state or executor rule in the contract or the SDK.
- ValueDesk-only executors: an owner-managed executor set (`setExecutor`); no permissionless operator registry and no
  per-subscription operator.
- No limits: the only bounds are SoDEX's builder-fee caps (200 / 2000) and key-name rule, plus validity checks
  (bps ≤ 10,000). Every loop runs over the caller's own input.
- O(1) kill switch through the stop epoch: 73,987 gas with 1 or 200 live subscriptions.
- UUPS behind an ERC1967Proxy, ERC-7201 storage, locked implementation, owner-only upgrades, and the storage-layout
  guard (now including enums).
- Builder fee = min(current, consent): `effectiveBuilderFee`, fuzzed.
- No funds: only `upgradeToAndCall` is payable, and it rejects value; no receive, fallback or token call.
- TypeScript bindings, ABI and vectors match the contract: `CrossCheckVectors.t.sol` 8/8, `abi:check` and
  `vectors:check` up to date.

**Verification runs** (Foundry 1.8.3, solc 0.8.36 via-IR, EVM prague, 2026-09-25, local only):

- `forge build`: passes; implementation 22,531 bytes runtime (2,045 bytes under EIP-170).
- `forge test`: 235 passed, 0 failed, 0 skipped in 23 suites, including the invariant campaign (256 runs × depth 100 = 25,600 calls, `fail_on_revert = true`, I1–I6 pass).
- `forge coverage --ir-minimum` (without the invariant campaign), `src/ValuescanCopyTrading.sol`: lines 98.39 % (366/372), statements 98.48 % (390/396), branches 100 % (29/29), functions 100 % (85/85). The 6 uncovered lines are the coverage build's instrumentation artefacts listed in §14.
- `forge snapshot`: 235 passed; `.gas-snapshot` and `snapshots/ValuescanCopyTrading.json` rewritten (the §11 figures).
- `forge fmt --check`: clean. `forge lint`: 0 findings (three reviewed exclusions in `foundry.toml`).
- `node tools/storage-layout.mjs check`: OK (9 structs, 4 enums); `selftest`: 19 cases and the enum parser pass.
- `packages/copy-contract`: `npx tsx --test test/*.test.ts` 95/95 pass; `tsc` typecheck clean; `abi:check` and
  `vectors:check` up to date (26 signed vectors, 42 steps, 92 views, 63 terms cases, 8 governance steps).

## Appendix A: SoDEX facts used

| Fact | Source |
|---|---|
| ValueChain: chain id 286623, RPC `https://rpc.valuechain.xyz`, gas token SOSO, ~2 s blocks, Prague rules, base fee 0.001 gwei, gas price 0.002 gwei | reports 01 §3, 07; `contracts/README.md` (probed read-only) |
| ClobGateway `0x0101010101010101010101010101010101010101`, upgradeable, admin a 1-of-2 Safe | report 01 §3 |
| `addAPIKey(uint256 engine, string name, bytes publicKey)` `0x8b53c6b9` and `revokeAPIKey(uint256 engine, string name)` `0x54ed5933`; the caller must be the account owner; keys added on-chain have no mask and no expiry | report 07 G1 |
| Builder codes: builder id = account id; fees in tenths of a bp; caps perps 200, spot 2000; `ApproveBuilderFee` (universal domain, master signature) or `AddAPIKeyWithBuilder`; ≤ 10 approvals per user; orders carry `builder{id, fee}` | SoDEX builder-codes docs; reports 01 §7, 06 |
| Builder fees are additive and charged on maker fills (spot, verified) | report 08 G6 |
| The permission mask is a disable mask (TRADE 1, CANCEL 2, WITHDRAW 4, TRANSFER 8); 14 = trade-only per the docs, not observed; `builder` and `permissions` are mutually exclusive | report 07 G2 |
| Withdrawals pay the owner only; INTERNAL transfers unsupported | report 07 G5 |
| API-key name rule `^[0-9a-zA-Z_-]{1,36}$`; `default` is the master key | SoDEX API docs (api-keys and nonces) |
| The firehose is complete; `accountTrade` ≈ firehose (+5 ms p50); the origin is in Japan; executor in Tokyo | report 07 G7, report 08 G8 |
| Key revoke via REST `DELETE /api/v1/{spot,perps}/accounts/api-keys` with an engine-domain master signature | report 01 §5 (documented) |

## Appendix B: changes from the previous draft

| Previous draft | Now | Reason |
|---|---|---|
| Leader opt-out (`setLeaderProfile`, `LeaderOptedOut`, leader profiles, `SetLeaderProfile` signatures) | Removed; leaders have no role | Owner decision 1 |
| Permissionless operator registry; operator chosen per subscription; operator fee share | Owner-managed executor set; the subscription records the delegated key | Owner decision 2 |
| 20 live subscriptions per follower; 32 symbols of ≤ 32 bytes, stored; 366-day expiry cap; key names ≤ 32 bytes; 10x ratio cap; 100x leverage cap; 10 % slippage cap; TP cap; page caps | Removed. Symbols are stored as a commitment, the full list is in events; expiry 0 = never; SoDEX's 36-byte key names; only SoDEX and validity bounds | Owner decision 3 |
| `unsubscribeAll` loops over live subscriptions and emits one event each | O(1) stop epoch; one `KillSwitchTriggered`; statuses computed | No caps ⇒ no unbounded loops |
| `closeExpired` by anyone; lazy expiry in `subscribe` | Removed; expired subscriptions keep their status, are not copyable, and are renewed or stopped by the follower | Only the follower changes a subscription; no loops |
| Immutable contract; migration by redeploy | UUPS proxy, ERC-7201 storage, timelock-owned upgrades, storage guard, stable domain | Owner decision 4 |
| `hash*` views, `getSubscriptions`, `verifyExecution`, `limits()` | Removed (off-chain equivalents; §6.8, §7.2, §11) | EIP-170 headroom for upgrades |
| — | `Subscribe` binds `stopEpoch`; `FundsNotAccepted`; `InvalidateNonces` has a signed variant; `stopDetails`, `killSwitchInfo`, `stopEpochOf` | Kill switch voids pending subscribes; no funds even through the upgrade path; gasless cancellation |
