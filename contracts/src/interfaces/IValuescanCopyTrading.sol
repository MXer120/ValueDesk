// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title Valuescan copy trading: protocol bounds, EIP-712 type strings and type hashes
/// @notice Shared by the implementation, the tests, the relayer and the UI. Every value here is part of the public
///         protocol. The only bounds are the ones SoDEX imposes (builder-fee caps, API-key name rule) and plain
///         validity checks (a percentage of a price or of capital cannot exceed 100 %). There are no product limits:
///         no cap on subscriptions per follower, on symbols per filter, on symbol length, on the subscription lifetime,
///         on sizing values, on leverage or on page sizes.
/// @dev Units used throughout:
///      - builder fees: tenths of a basis point (10 = 1 bp = 0.01 %), the unit SoDEX uses;
///      - bps: basis points (10_000 = 100 %);
///      - ppm: parts per million (1_000_000 = 1.0x);
///      - USD amounts: 6 decimals (1_000_000 = 1 USD);
///      - timestamps: unix seconds (uint40).
library CopyTradingConstants {
    /// @notice Venue id of SoDEX (the leader trades on SoDEX). Enabled by `initialize`.
    uint8 internal constant VENUE_SODEX = 1;
    /// @notice Venue id of Hyperliquid (the leader trades on Hyperliquid; copies are placed on SoDEX). Enabled by
    ///         `initialize`.
    uint8 internal constant VENUE_HYPERLIQUID = 2;

    /// @notice SoDEX hard cap on the per-order builder fee for perps, in tenths of a bp (200 = 0.2 %).
    uint16 internal constant PERPS_BUILDER_FEE_CAP = 200;
    /// @notice SoDEX hard cap on the per-order builder fee for spot, in tenths of a bp (2000 = 2 %).
    uint16 internal constant SPOT_BUILDER_FEE_CAP = 2000;

    /// @notice 100 % in bps. Validity bound of every bps value that cannot exceed 100 %: slippage, per-trade stop loss
    ///         and drawdown stop. Take profit has no upper bound.
    uint16 internal constant MAX_BPS = 10_000;

    /// @notice SoDEX's API-key name rule `^[0-9a-zA-Z_-]{1,36}$`: maximum length in bytes.
    uint256 internal constant MAX_KEY_NAME_LENGTH = 36;

    /// @notice EIP-712 domain name. Pinned in the implementation's code and stable across upgrades (spec §10.4).
    string internal constant EIP712_NAME = "ValuescanCopyTrading";
    /// @notice EIP-712 domain version. Stable across upgrades unless deliberately bumped; a bump invalidates every
    ///         outstanding signature, including pre-signed emergency stops (spec §10.4).
    string internal constant EIP712_VERSION = "1";

    /// @notice EIP-712 type of the subscription terms (referenced by Subscribe and UpdateSubscription).
    /// @dev Enums are encoded as uint8. `keyName` and each symbol are signed as strings, so wallets show them as text.
    string internal constant TERMS_TYPE =
        "Terms(address delegatedKey,string keyName,uint8 marketScope,uint8 sizingMode,uint64 sizingValue,uint64 allocationCap,uint64 maxPositionNotional,uint8 maxLeverage,uint16 tradeStopLossBps,uint16 maxDrawdownBps,uint32 takeProfitBps,uint16 slippageBps,uint8 symbolMode,string[] symbols,bool copyExisting,uint16 maxBuilderFeePerps,uint16 maxBuilderFeeSpot,uint40 expiry)";

    /// @notice EIP-712 primary type of `subscribeWithSig`. `stopEpoch` binds the message to the follower's current
    ///         kill-switch epoch, so a kill switch also voids every signed but unsubmitted Subscribe. `expectedLastId`
    ///         binds it to the history of its (follower, SoDEX account, venue, leader) key: the id of the last
    ///         subscription created for that key when the follower signed ({lastSubscriptionFor}; 0 for none). Any
    ///         subscription that lands for the key voids every Subscribe signed before it, and a later unsubscribe
    ///         never revives them (audit SEC-04).
    string internal constant SUBSCRIBE_TYPE =
        "Subscribe(address follower,uint8 venue,address leader,uint64 sodexAccountId,Terms terms,uint64 stopEpoch,uint256 expectedLastId,uint256 nonce,uint256 deadline)Terms(address delegatedKey,string keyName,uint8 marketScope,uint8 sizingMode,uint64 sizingValue,uint64 allocationCap,uint64 maxPositionNotional,uint8 maxLeverage,uint16 tradeStopLossBps,uint16 maxDrawdownBps,uint32 takeProfitBps,uint16 slippageBps,uint8 symbolMode,string[] symbols,bool copyExisting,uint16 maxBuilderFeePerps,uint16 maxBuilderFeeSpot,uint40 expiry)";

    /// @notice EIP-712 primary type of `updateSubscriptionWithSig`.
    string internal constant UPDATE_TYPE =
        "UpdateSubscription(address follower,uint256 subscriptionId,uint32 expectedVersion,Terms terms,uint256 nonce,uint256 deadline)Terms(address delegatedKey,string keyName,uint8 marketScope,uint8 sizingMode,uint64 sizingValue,uint64 allocationCap,uint64 maxPositionNotional,uint8 maxLeverage,uint16 tradeStopLossBps,uint16 maxDrawdownBps,uint32 takeProfitBps,uint16 slippageBps,uint8 symbolMode,string[] symbols,bool copyExisting,uint16 maxBuilderFeePerps,uint16 maxBuilderFeeSpot,uint40 expiry)";

    /// @notice EIP-712 primary type of `pauseSubscriptionWithSig`. Not version-bound (it is a stop).
    string internal constant PAUSE_TYPE =
        "PauseSubscription(address follower,uint256 subscriptionId,uint256 nonce,uint256 deadline)";

    /// @notice EIP-712 primary type of `resumeSubscriptionWithSig`. Version-bound.
    string internal constant RESUME_TYPE =
        "ResumeSubscription(address follower,uint256 subscriptionId,uint32 expectedVersion,uint256 nonce,uint256 deadline)";

    /// @notice EIP-712 primary type of `unsubscribeWithSig`. Not version-bound (it is a stop).
    string internal constant UNSUBSCRIBE_TYPE =
        "Unsubscribe(address follower,uint256 subscriptionId,bool closePositions,uint256 nonce,uint256 deadline)";

    /// @notice EIP-712 primary type of `unsubscribeAllWithSig`.
    string internal constant UNSUBSCRIBE_ALL_TYPE =
        "UnsubscribeAll(address follower,bool closePositions,uint256 nonce,uint256 deadline)";

    /// @notice EIP-712 primary type of `invalidateNoncesWithSig`.
    string internal constant INVALIDATE_NONCES_TYPE =
        "InvalidateNonces(address follower,uint256 word,uint256 mask,uint256 nonce,uint256 deadline)";

    /// @notice keccak256 of {TERMS_TYPE}.
    bytes32 internal constant TERMS_TYPEHASH = keccak256(bytes(TERMS_TYPE));
    /// @notice keccak256 of {SUBSCRIBE_TYPE}.
    bytes32 internal constant SUBSCRIBE_TYPEHASH = keccak256(bytes(SUBSCRIBE_TYPE));
    /// @notice keccak256 of {UPDATE_TYPE}.
    bytes32 internal constant UPDATE_TYPEHASH = keccak256(bytes(UPDATE_TYPE));
    /// @notice keccak256 of {PAUSE_TYPE}.
    bytes32 internal constant PAUSE_TYPEHASH = keccak256(bytes(PAUSE_TYPE));
    /// @notice keccak256 of {RESUME_TYPE}.
    bytes32 internal constant RESUME_TYPEHASH = keccak256(bytes(RESUME_TYPE));
    /// @notice keccak256 of {UNSUBSCRIBE_TYPE}.
    bytes32 internal constant UNSUBSCRIBE_TYPEHASH = keccak256(bytes(UNSUBSCRIBE_TYPE));
    /// @notice keccak256 of {UNSUBSCRIBE_ALL_TYPE}.
    bytes32 internal constant UNSUBSCRIBE_ALL_TYPEHASH = keccak256(bytes(UNSUBSCRIBE_ALL_TYPE));
    /// @notice keccak256 of {INVALIDATE_NONCES_TYPE}.
    bytes32 internal constant INVALIDATE_NONCES_TYPEHASH = keccak256(bytes(INVALIDATE_NONCES_TYPE));
}

/// @title IValuescanCopyTrading
/// @author Valuescan
/// @notice The public, auditable record of copy trading on SoDEX.
///
///         It records which follower copies which leader address (on SoDEX or Hyperliquid, always executed on
///         SoDEX), under which sizing and risk rules, through which delegated SoDEX API key, at which maximum builder
///         fee the follower consented to, and when copying started, was paused or stopped. Valuescan's executors
///         publish commitments to what they executed.
///
///         The contract NEVER holds, receives, moves, escrows or accounts for funds. It has no receive or fallback
///         function, no payable function of its own (the UUPS `upgradeToAndCall` is payable by standard and rejects
///         any value), and makes no token calls. Funds, margin, deposits, withdrawals and settlement are entirely
///         SoDEX's job: every follower trades from their own SoDEX account. Execution happens off-chain: Valuescan's
///         executor watches the leader and places mirrored orders on the follower's SoDEX account with a delegated
///         API key the follower authorised on SoDEX, carrying Valuescan's builder code.
///
///         Leaders have no role here: any address can be copied, and nobody can opt an address out. Followers opt in
///         themselves and can always stop.
///
///         Every follower action exists twice: as a direct call (msg.sender is the follower) and as a `...WithSig`
///         variant that anyone (for example Valuescan's gas relayer) can submit with the follower's EIP-712 signature.
///         EOA (ECDSA, including EIP-7702-delegated EOAs) and ERC-1271 smart-wallet signatures are accepted. The
///         submitter gains no power: every parameter is bound by the signature.
///
///         Guarantees: only the follower (directly or by signature) changes its subscriptions; stopping is always
///         possible, even while the contract is paused, and the kill switch costs O(1) gas whatever the number of
///         subscriptions; signatures cannot be replayed (unordered nonce, deadline, chain id and contract address are
///         all bound, updates and resumes are bound to the subscription version, and subscribes to the stop epoch and
///         to the last subscription of their key); the whole state can be rebuilt
///         from the events alone. No function loops over a stored list: all work per call is O(1) in the stored state,
///         or proportional to the caller's own input (symbols, key name, page size).
/// @dev Deployed behind an ERC-1967 proxy (UUPS). Governance is `Ownable2Step`; the recommended owner is an
///      OpenZeppelin `TimelockController` (delay about 48 h) whose proposer is a multisig, so followers see an upgrade
///      before it takes effect. The owner can (a) set the builder terms within the SoDEX caps, (b) enable or disable
///      venues for NEW subscriptions, (c) authorise Valuescan's executor addresses, (d) pause NEW activity (subscribe,
///      update, resume) and (e) upgrade the implementation. Outside an upgrade the owner can never touch a
///      subscription, a stop epoch, a commitment or a nonce, and can never make a follower pay a builder fee above the
///      follower's consent. `renounceOwnership` is disabled.
///      Standard events not declared here: OpenZeppelin `Initialized(uint64)`, `Upgraded(address)`,
///      `Paused(address)`, `Unpaused(address)`, `OwnershipTransferStarted(address,address)`,
///      `OwnershipTransferred(address,address)`, and ERC-5267 `EIP712DomainChanged()` (emitted only by an upgrade
///      that bumps the domain; never by this version).
interface IValuescanCopyTrading {
    // ================================================================================================================
    //                                                    ENUMS
    // ================================================================================================================
    // UPGRADE RULE (audit SEC-01): Status, MarketScope, SizingMode and SymbolMode are stored in every Subscription as
    // their ordinal. Their members may only be APPENDED: never insert, remove, reorder or rename one, or every stored
    // record changes meaning. The storage-layout guard pins their member lists (the snapshot in storage-layout/ and
    // test/upgrade/StorageLayout.t.sol). StopReason and TermsField are not stored but are ABI: the same rule applies.

    /// @notice Lifecycle status of a subscription. `NONE` means the id does not exist.
    /// @dev ACTIVE: the executor mirrors the leader (opens, increases, reduces, closes).
    ///      PAUSED: reduce-only. The executor opens and increases nothing; it still mirrors the leader's reductions and
    ///      closes and still enforces stop loss, drawdown and take profit on positions it already opened.
    ///      STOPPED: terminal. The executor places no further orders except, if `closePositions` was requested, a
    ///      reduce-only flattening of the positions it opened.
    ///      Every view returns the EFFECTIVE status: a stored ACTIVE or PAUSED subscription whose `stopEpoch` is below
    ///      its follower's current stop epoch (a later kill switch) is STOPPED.
    enum Status {
        NONE,
        ACTIVE,
        PAUSED,
        STOPPED
    }

    /// @notice Which SoDEX engines the executor may trade for this subscription. `NONE` is invalid.
    enum MarketScope {
        NONE,
        PERPS,
        SPOT,
        PERPS_AND_SPOT
    }

    /// @notice How the executor sizes the follower's orders. `NONE` is invalid.
    /// @dev PROPORTIONAL: follower target position = leader position notional x (allocationCap / leader equity) x
    ///      sizingValue / 1e6. The allocation cap, not the follower's whole account, is the equity basis.
    ///      FIXED_RATIO: follower order quantity = leader fill quantity x sizingValue / 1e6.
    ///      FIXED_NOTIONAL: when the leader opens a position from flat, the follower opens `sizingValue` USD (6 dec) of
    ///      notional; later leader increases and reductions are mirrored in proportion to the leader's position size.
    enum SizingMode {
        NONE,
        PROPORTIONAL,
        FIXED_RATIO,
        FIXED_NOTIONAL
    }

    /// @notice How the subscription's symbol list is applied to the SoDEX symbol the executor would trade.
    /// @dev ALL: no filter, and the list must be empty. ALLOW: trade only listed symbols. DENY: never trade listed
    ///      symbols.
    enum SymbolMode {
        ALL,
        ALLOW,
        DENY
    }

    /// @notice Why a subscription is STOPPED.
    /// @dev FOLLOWER: `unsubscribe` (direct or by signature), which wrote the record. KILL_SWITCH: `unsubscribeAll`
    ///      (direct or by signature), which raised the follower's stop epoch and wrote no record.
    enum StopReason {
        FOLLOWER,
        KILL_SWITCH
    }

    /// @notice Identifies the invalid field in an {InvalidTerms} revert.
    /// @dev LEADER: zero address, or equal to the follower on VENUE_SODEX. SODEX_ACCOUNT: zero. EXPIRY: neither 0 nor
    ///      in the future (or, on resume, already passed). Other fields: see {Terms}. Unknown or disabled venues revert
    ///      with {VenueDisabled}.
    enum TermsField {
        LEADER,
        SODEX_ACCOUNT,
        DELEGATED_KEY,
        KEY_NAME,
        MARKET_SCOPE,
        SIZING_MODE,
        SIZING_VALUE,
        ALLOCATION_CAP,
        MAX_POSITION_NOTIONAL,
        MAX_LEVERAGE,
        TRADE_STOP_LOSS,
        MAX_DRAWDOWN,
        SLIPPAGE,
        SYMBOL_MODE,
        SYMBOLS,
        BUILDER_FEE_PERPS,
        BUILDER_FEE_SPOT,
        EXPIRY
    }

    // ================================================================================================================
    //                                                   STRUCTS
    // ================================================================================================================

    /// @notice The follower-chosen rules of a subscription, as submitted and as signed (EIP-712 type `Terms`).
    /// @dev The contract validates every field (see {InvalidTerms}) and stores it, except `symbols`: it stores only
    ///      their commitment `symbolsHash` and emits the full list in {Subscribed} and {SubscriptionUpdated}.
    /// @param delegatedKey Address (EVM public key) of the SoDEX API key the follower authorised for Valuescan's
    ///        executor. Must be non-zero and must not be the follower itself (the master key is never delegated).
    /// @param keyName Name under which that key is registered on SoDEX: SoDEX's rule `^[0-9a-zA-Z_-]{1,36}$`, and not
    ///        "default" (SoDEX's reserved name for the master key).
    /// @param marketScope Engines the executor may trade. SPOT forces `maxLeverage == 1`.
    /// @param sizingMode See {SizingMode}.
    /// @param sizingValue > 0. PROPORTIONAL and FIXED_RATIO: ppm. FIXED_NOTIONAL: USD 6 dec, at most
    ///        `maxPositionNotional`.
    /// @param allocationCap Maximum capital (USD, 6 dec) the executor may commit for this subscription: the sum of
    ///        initial margin of open copied perps positions plus the notional of open copied spot positions. > 0.
    /// @param maxPositionNotional Maximum notional (USD, 6 dec) of any single copied position,
    ///        1..allocationCap x maxLeverage.
    /// @param maxLeverage Maximum leverage in whole multiples, >= 1; exactly 1 for SPOT scope. The executor also
    ///        clamps it to the venue's maximum for the symbol.
    /// @param tradeStopLossBps Per-position stop loss: close a copied position when the price has moved this many bps
    ///        against its entry price. 0 = off, else 1..MAX_BPS.
    /// @param maxDrawdownBps Total drawdown stop: when realised plus unrealised PnL of copied positions since the
    ///        subscription was last armed falls to -maxDrawdownBps x allocationCap / 10_000, flatten and halt.
    ///        0 = off, else 1..MAX_BPS.
    /// @param takeProfitBps Total take profit: when that PnL reaches +takeProfitBps x allocationCap / 10_000, flatten
    ///        and halt. 0 = off. No upper bound.
    /// @param slippageBps Maximum price deviation of a copy order from the reference price, used as the IOC limit.
    ///        1..MAX_BPS.
    /// @param symbolMode See {SymbolMode}.
    /// @param symbols SoDEX symbol names exactly as SoDEX lists them (for example "BTC-USD"). Empty for ALL; at least
    ///        one entry for ALLOW and DENY; each entry non-empty printable ASCII (0x21..0x7E). No count or length
    ///        limit. Order and duplicates are the follower's choice; the commitment covers the list as signed.
    /// @param copyExisting If true, on activation the executor also opens the leader's already open positions
    ///        (sized and bounded as usual). If false, only leader position changes after activation are mirrored.
    /// @param maxBuilderFeePerps Highest builder fee on perps orders the follower consents to, in tenths of a bp,
    ///        0..PERPS_BUILDER_FEE_CAP.
    /// @param maxBuilderFeeSpot Highest builder fee on spot orders the follower consents to, in tenths of a bp,
    ///        0..SPOT_BUILDER_FEE_CAP.
    /// @param expiry Unix time from which the subscription is no longer copyable, or 0 for never. If non-zero it must
    ///        be in the future when the terms are stored.
    struct Terms {
        address delegatedKey;
        string keyName;
        MarketScope marketScope;
        SizingMode sizingMode;
        uint64 sizingValue;
        uint64 allocationCap;
        uint64 maxPositionNotional;
        uint8 maxLeverage;
        uint16 tradeStopLossBps;
        uint16 maxDrawdownBps;
        uint32 takeProfitBps;
        uint16 slippageBps;
        SymbolMode symbolMode;
        string[] symbols;
        bool copyExisting;
        uint16 maxBuilderFeePerps;
        uint16 maxBuilderFeeSpot;
        uint40 expiry;
    }

    /// @notice A stored subscription.
    /// @dev Field order is the storage packing order and must be kept by the implementation and by every upgrade
    ///      (new fields may only be appended; see the storage-layout guard). `follower`, `venue`, `leader`,
    ///      `sodexAccountId`, `createdAt` and `stopEpoch` never change after creation.
    /// @param follower Master wallet that owns the SoDEX account being traded, and the only party that can change
    ///        this subscription.
    /// @param status Stored status; views return the effective status (see {Status}).
    /// @param venue Venue id of the leader (see {venueInfo}).
    /// @param marketScope See {Terms-marketScope}.
    /// @param sizingMode See {Terms-sizingMode}.
    /// @param symbolMode See {Terms-symbolMode}.
    /// @param copyExisting See {Terms-copyExisting}.
    /// @param maxLeverage See {Terms-maxLeverage}.
    /// @param closePositions Set by `unsubscribe`: whether the follower asked the executor to flatten the positions it
    ///        opened. False otherwise; for a kill switch see {killSwitchInfo} and {stopDetails}.
    /// @param version Starts at 1 and increases by exactly 1 on every change of this record (update, pause, resume,
    ///        unsubscribe). A kill switch changes no record and so no version.
    /// @param leader Address of the copied trader on `venue`.
    /// @param createdAt Timestamp of creation.
    /// @param updatedAt Timestamp of the last change of this record. When the status became ACTIVE at this time, it is
    ///        also the moment the drawdown and take-profit counters were (re)armed.
    /// @param slippageBps See {Terms-slippageBps}.
    /// @param delegatedKey See {Terms-delegatedKey}.
    /// @param expiry See {Terms-expiry}.
    /// @param takeProfitBps See {Terms-takeProfitBps}.
    /// @param tradeStopLossBps See {Terms-tradeStopLossBps}.
    /// @param sodexAccountId SoDEX account id (primary account or, once SoDEX offers them, a sub-account) of the
    ///        follower that the executor trades. The executor must check off-chain that `follower` owns it.
    /// @param stopEpoch The follower's stop epoch when the subscription was created. A later kill switch raises the
    ///        follower's epoch above it, which makes the subscription STOPPED.
    /// @param sizingValue See {Terms-sizingValue}.
    /// @param maxDrawdownBps See {Terms-maxDrawdownBps}.
    /// @param maxBuilderFeePerps See {Terms-maxBuilderFeePerps}.
    /// @param maxBuilderFeeSpot See {Terms-maxBuilderFeeSpot}.
    /// @param allocationCap See {Terms-allocationCap}.
    /// @param maxPositionNotional See {Terms-maxPositionNotional}.
    /// @param symbolsHash Commitment to {Terms-symbols}: keccak256 of the concatenated keccak256 of each symbol (the
    ///        EIP-712 encoding of `string[]`); keccak256("") for an empty list. The list itself is in the events.
    /// @param keyName See {Terms-keyName}.
    struct Subscription {
        // slot 0: 20 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 4 = 32 bytes
        address follower;
        Status status;
        uint8 venue;
        MarketScope marketScope;
        SizingMode sizingMode;
        SymbolMode symbolMode;
        bool copyExisting;
        uint8 maxLeverage;
        bool closePositions;
        uint32 version;
        // slot 1: 20 + 5 + 5 + 2 = 32 bytes
        address leader;
        uint40 createdAt;
        uint40 updatedAt;
        uint16 slippageBps;
        // slot 2: 20 + 5 + 4 + 2 = 31 bytes
        address delegatedKey;
        uint40 expiry;
        uint32 takeProfitBps;
        uint16 tradeStopLossBps;
        // slot 3: 8 + 8 + 8 + 2 + 2 + 2 = 30 bytes
        uint64 sodexAccountId;
        uint64 stopEpoch;
        uint64 sizingValue;
        uint16 maxDrawdownBps;
        uint16 maxBuilderFeePerps;
        uint16 maxBuilderFeeSpot;
        // slot 4: 8 + 8 = 16 bytes
        uint64 allocationCap;
        uint64 maxPositionNotional;
        // slot 5
        bytes32 symbolsHash;
        // slot 6 (+ data slots when longer than 31 bytes)
        string keyName;
    }

    /// @notice Nonce, deadline and signature of a `...WithSig` call.
    /// @param nonce Unordered nonce chosen by the signer: any value not yet used or invalidated by that signer.
    ///        Bit `nonce & 0xff` of word `nonce >> 8` is set when used.
    /// @param deadline Last unix second at which the signature is accepted (inclusive).
    /// @param signature 65-byte (r,s,v) ECDSA signature (EIP-2098 64-byte signatures are not accepted as ECDSA), or
    ///        any bytes the signer's ERC-1271 `isValidSignature` accepts.
    struct SignatureParams {
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    /// @notice A follower's kill switch, recorded per stop epoch.
    /// @param triggeredAt Timestamp of the `unsubscribeAll` that raised the follower's stop epoch to this value; 0 if
    ///        the epoch was never reached.
    /// @param closePositions Whether the follower asked the executor to flatten the positions of every subscription
    ///        this kill switch stopped.
    struct KillSwitch {
        uint40 triggeredAt;
        bool closePositions;
    }

    /// @notice An executor address's record.
    /// @param authorised Whether the address is currently one of Valuescan's executors (owner-managed).
    /// @param updatedAt Timestamp of the last {setExecutor} for this address; 0 if never set.
    /// @param lastEpoch Highest epoch committed so far with {commitExecutions}; 0 if none. Kept when de-authorised.
    struct Executor {
        bool authorised;
        uint40 updatedAt;
        uint64 lastEpoch;
    }

    /// @notice Valuescan's SoDEX builder code terms.
    /// @param builderId Valuescan's SoDEX account id, used as `builder.id` on orders. Non-zero.
    /// @param perpsFee Current builder fee on perps orders, tenths of a bp, <= PERPS_BUILDER_FEE_CAP.
    /// @param spotFee Current builder fee on spot orders, tenths of a bp, <= SPOT_BUILDER_FEE_CAP.
    /// @param updatedAt Timestamp of the last change.
    struct BuilderTerms {
        uint64 builderId;
        uint16 perpsFee;
        uint16 spotFee;
        uint40 updatedAt;
    }

    /// @notice A venue id's registry entry.
    /// @param enabled Whether NEW subscriptions may copy leaders on this venue.
    /// @param name Human-readable name, for example "SoDEX" or "Hyperliquid".
    struct Venue {
        bool enabled;
        string name;
    }

    /// @notice A published execution commitment.
    /// @param merkleRoot Root of the executor's execution records for the epoch (leaf format: spec §7.2).
    /// @param count Number of leaves under the root.
    /// @param committedAt Timestamp of publication.
    struct Commitment {
        bytes32 merkleRoot;
        uint32 count;
        uint40 committedAt;
    }

    // ================================================================================================================
    //                                                   EVENTS
    // ================================================================================================================

    /// @notice A subscription was created. Carries the complete stored record and the symbol list, so an indexer
    ///         needs nothing else.
    /// @param subscriptionId New id (sequential, starting at 1).
    /// @param follower The follower.
    /// @param leader The copied address.
    /// @param subscription The stored record (status ACTIVE, version 1).
    /// @param symbols The symbol list exactly as submitted; its commitment is `subscription.symbolsHash`.
    event Subscribed(
        uint256 indexed subscriptionId,
        address indexed follower,
        address indexed leader,
        Subscription subscription,
        string[] symbols
    );

    /// @notice A subscription's terms were replaced. Carries the complete new record, which replaces the old one.
    /// @param subscriptionId The subscription.
    /// @param follower The follower.
    /// @param subscription The stored record after the update.
    /// @param symbols The symbol list after the update.
    event SubscriptionUpdated(
        uint256 indexed subscriptionId, address indexed follower, Subscription subscription, string[] symbols
    );

    /// @notice A subscription moved from ACTIVE to PAUSED (reduce-only).
    /// @param subscriptionId The subscription.
    /// @param follower The follower.
    /// @param version The new version.
    /// @param updatedAt The block timestamp of the change.
    event SubscriptionPaused(
        uint256 indexed subscriptionId, address indexed follower, uint32 version, uint40 updatedAt
    );

    /// @notice A subscription moved from PAUSED to ACTIVE. Drawdown and take-profit counters re-arm at `updatedAt`.
    /// @param subscriptionId The subscription.
    /// @param follower The follower.
    /// @param version The new version.
    /// @param updatedAt The block timestamp of the change.
    event SubscriptionResumed(
        uint256 indexed subscriptionId, address indexed follower, uint32 version, uint40 updatedAt
    );

    /// @notice A subscription became STOPPED (terminal) by `unsubscribe`. The executor must stop within the SLA in the
    ///         spec (§8.3).
    /// @param subscriptionId The subscription.
    /// @param follower The follower.
    /// @param closePositions Whether the follower asked the executor to flatten the positions it opened (reduce-only).
    /// @param version The new version.
    /// @param updatedAt The block timestamp of the change.
    event SubscriptionStopped(
        uint256 indexed subscriptionId, address indexed follower, bool closePositions, uint32 version, uint40 updatedAt
    );

    /// @notice A follower triggered the kill switch: every subscription of `follower` created before this event (its
    ///         `stopEpoch` is below `stopEpoch`) that was ACTIVE or PAUSED is now STOPPED, with reason KILL_SWITCH.
    ///         No per-subscription event is emitted; the rule above is the whole effect.
    /// @param follower The follower.
    /// @param stopEpoch The follower's new stop epoch (the previous one plus 1).
    /// @param closePositions Whether positions are to be flattened.
    event KillSwitchTriggered(address indexed follower, uint64 indexed stopEpoch, bool closePositions);

    /// @notice A signature nonce was consumed by a `...WithSig` call.
    /// @param signer The follower that signed.
    /// @param nonce The nonce.
    event NonceUsed(address indexed signer, uint256 indexed nonce);

    /// @notice A signer invalidated unused nonces: every bit set in `mask` is now used in `word`.
    /// @param signer The signer.
    /// @param word The bitmap word index (`nonce >> 8`).
    /// @param mask The bits invalidated.
    event NoncesInvalidated(address indexed signer, uint256 indexed word, uint256 mask);

    /// @notice The owner authorised or de-authorised an executor address. The set of authorised executors is rebuilt
    ///         from these events; {isExecutor} and {executorInfo} answer for one address.
    /// @param executor The executor address.
    /// @param authorised The new flag.
    event ExecutorSet(address indexed executor, bool authorised);

    /// @notice An executor published a commitment to its executions for an epoch.
    /// @param executor The executor.
    /// @param epoch Executor-defined epoch number (for example the unix hour); strictly increasing per executor.
    /// @param merkleRoot Root of the execution records.
    /// @param count Number of leaves.
    /// @param uri Where the full records and proofs are published.
    event ExecutionsCommitted(
        address indexed executor, uint64 indexed epoch, bytes32 merkleRoot, uint32 count, string uri
    );

    /// @notice The owner changed Valuescan's builder terms. Emitted by `initialize` too.
    /// @param builderId Valuescan's SoDEX builder (account) id.
    /// @param perpsFee Current perps fee, tenths of a bp.
    /// @param spotFee Current spot fee, tenths of a bp.
    event BuilderTermsUpdated(uint64 builderId, uint16 perpsFee, uint16 spotFee);

    /// @notice The owner set a venue's registry entry. Emitted by `initialize` for SoDEX and Hyperliquid.
    /// @param venue The venue id.
    /// @param enabled Whether new subscriptions may use it.
    /// @param name Its name.
    event VenueUpdated(uint8 indexed venue, bool enabled, string name);

    // ================================================================================================================
    //                                                   ERRORS
    // ================================================================================================================

    /// @notice A terms or target field is invalid.
    /// @param field The offending field.
    error InvalidTerms(TermsField field);
    /// @notice The subscription id does not exist.
    error UnknownSubscription(uint256 subscriptionId);
    /// @notice The caller is not the subscription's follower.
    error NotFollower(uint256 subscriptionId, address caller);
    /// @notice The subscription's effective status does not allow this action.
    error InvalidStatus(uint256 subscriptionId, Status status);
    /// @notice A signed update or resume was made for another version of the subscription.
    error VersionMismatch(uint256 subscriptionId, uint32 expected, uint32 actual);
    /// @notice A signed Subscribe was made for another stop epoch of the follower (a kill switch happened since).
    error StopEpochMismatch(address follower, uint64 expected, uint64 actual);
    /// @notice A signed Subscribe was made for another history of its (follower, account, venue, leader) key: a
    ///         subscription for that key was created since the follower signed (see {lastSubscriptionFor}).
    error LastSubscriptionMismatch(uint256 expected, uint256 actual);
    /// @notice The follower already has a live subscription to this leader on this venue for this SoDEX account.
    error DuplicateSubscription(uint256 existingSubscriptionId);
    /// @notice The venue is unknown or disabled for new subscriptions.
    error VenueDisabled(uint8 venue);
    /// @notice msg.sender is not an authorised executor.
    error NotExecutor(address caller);
    /// @notice A commitment epoch is not greater than the executor's last one.
    error EpochNotIncreasing(uint64 lastEpoch, uint64 epoch);
    /// @notice The signature deadline has passed.
    error SignatureExpired(uint256 deadline);
    /// @notice The nonce was already used or invalidated by this signer.
    error NonceAlreadyUsed(address signer, uint256 nonce);
    /// @notice The signature is not valid for the expected signer (neither ECDSA nor ERC-1271).
    error InvalidSignature(address expectedSigner);
    /// @notice The builder id is zero or a fee exceeds its SoDEX cap.
    error InvalidBuilderTerms();
    /// @notice The venue id is 0 or the name is empty.
    error InvalidVenue(uint8 venue);
    /// @notice The executor address is zero.
    error InvalidExecutor();
    /// @notice `renounceOwnership` is disabled so the contract can never be left without governance by accident.
    error RenounceDisabled();
    /// @notice A call carried value. The contract never accepts funds; only `upgradeToAndCall` is payable (by the UUPS
    ///         standard) and it reverts with this error on any value.
    error FundsNotAccepted();

    // ================================================================================================================
    //                                          FOLLOWER ACTIONS (DIRECT)
    // ================================================================================================================

    /// @notice Start copying `leader` on `venue` into the caller's SoDEX account `sodexAccountId`.
    /// @dev Reverts when paused, when the venue is disabled, on any invalid field, or on a live duplicate (same
    ///      follower, account, venue and leader). For `venue == VENUE_SODEX`, `leader` must differ from the follower.
    ///      The new subscription records the follower's current stop epoch. Emits {Subscribed}.
    /// @param venue Venue id of the leader.
    /// @param leader Address of the leader on that venue (non-zero).
    /// @param sodexAccountId Follower's SoDEX account the executor trades (non-zero).
    /// @param terms The rules; see {Terms}.
    /// @return subscriptionId The new id.
    function subscribe(uint8 venue, address leader, uint64 sodexAccountId, Terms calldata terms)
        external
        returns (uint256 subscriptionId);

    /// @notice Replace all terms of one of the caller's live (ACTIVE or PAUSED) subscriptions. Status is unchanged.
    /// @dev Reverts when paused, if the caller is not the follower, if the subscription is not live, or on any invalid
    ///      field. Venue, leader and SoDEX account cannot change: stop and subscribe again instead. A live subscription
    ///      whose expiry has passed can be renewed this way. Venue enablement is not checked here.
    ///      Emits {SubscriptionUpdated}; the version increases by 1. If the status is ACTIVE, drawdown and
    ///      take-profit counters re-arm.
    /// @param subscriptionId The subscription.
    /// @param terms The new rules.
    function updateSubscription(uint256 subscriptionId, Terms calldata terms) external;

    /// @notice Pause (reduce-only) one of the caller's ACTIVE subscriptions. Works while the contract is paused.
    /// @dev Reverts if the caller is not the follower or the effective status is not ACTIVE. Emits
    ///      {SubscriptionPaused}.
    /// @param subscriptionId The subscription.
    function pauseSubscription(uint256 subscriptionId) external;

    /// @notice Resume one of the caller's PAUSED subscriptions.
    /// @dev Reverts when paused, if the caller is not the follower, if the effective status is not PAUSED, or if the
    ///      expiry has passed ({InvalidTerms} with EXPIRY; renew with an update first). Emits {SubscriptionResumed}.
    /// @param subscriptionId The subscription.
    function resumeSubscription(uint256 subscriptionId) external;

    /// @notice Stop one of the caller's live subscriptions for good. Works while the contract is paused.
    /// @dev Reverts only if the caller is not the follower or the subscription is not live. Emits
    ///      {SubscriptionStopped}.
    /// @param subscriptionId The subscription.
    /// @param closePositions Ask the executor to flatten the positions it opened for this subscription.
    function unsubscribe(uint256 subscriptionId, bool closePositions) external;

    /// @notice Kill switch: stop every live subscription of the caller, in O(1) gas whatever their number. Never
    ///         reverts and works while the contract is paused. Also voids every signed but unsubmitted Subscribe of
    ///         the caller (they are bound to the stop epoch).
    /// @dev Raises the caller's stop epoch by 1 and records {KillSwitch}. Emits {KillSwitchTriggered}.
    /// @param closePositions Ask the executor to flatten the positions it opened for every stopped subscription.
    /// @return stopEpoch The caller's new stop epoch.
    function unsubscribeAll(bool closePositions) external returns (uint64 stopEpoch);

    /// @notice Mark unused nonces of the caller as used, to cancel signed but unsubmitted messages. Works while the
    ///         contract is paused.
    /// @param word Bitmap word index (`nonce >> 8`).
    /// @param mask Bits to set in that word.
    function invalidateNonces(uint256 word, uint256 mask) external;

    // ================================================================================================================
    //                                   FOLLOWER ACTIONS (EIP-712, SUBMITTED BY ANYONE)
    // ================================================================================================================

    /// @notice {subscribe} for `follower`, authorised by the follower's EIP-712 `Subscribe` signature.
    /// @dev Same checks and effects as {subscribe}, plus: `stopEpoch` equals the follower's current stop epoch (else
    ///      {StopEpochMismatch}), `expectedLastId` equals {lastSubscriptionFor} of the key (else
    ///      {LastSubscriptionMismatch}), deadline not passed, nonce unused (then consumed, emitting {NonceUsed}), and a
    ///      valid ECDSA signature by `follower` or, failing that, ERC-1271 approval by `follower`.
    /// @param follower The follower (signer).
    /// @param venue Venue id of the leader.
    /// @param leader Leader address.
    /// @param sodexAccountId Follower's SoDEX account id.
    /// @param terms The rules.
    /// @param stopEpoch The follower's stop epoch the signature was made for (see {stopEpochOf}).
    /// @param expectedLastId The key's last subscription id the signature was made for (see {lastSubscriptionFor}).
    /// @param sig Nonce, deadline and signature.
    /// @return subscriptionId The new id.
    function subscribeWithSig(
        address follower,
        uint8 venue,
        address leader,
        uint64 sodexAccountId,
        Terms calldata terms,
        uint64 stopEpoch,
        uint256 expectedLastId,
        SignatureParams calldata sig
    ) external returns (uint256 subscriptionId);

    /// @notice {updateSubscription} authorised by the follower's EIP-712 `UpdateSubscription` signature.
    /// @dev Also reverts with {VersionMismatch} unless the subscription's current version equals `expectedVersion`,
    ///      so a withheld signature cannot be replayed over a newer state.
    /// @param subscriptionId The subscription.
    /// @param expectedVersion The version the follower saw when signing.
    /// @param terms The new rules.
    /// @param sig Nonce, deadline and signature.
    function updateSubscriptionWithSig(
        uint256 subscriptionId,
        uint32 expectedVersion,
        Terms calldata terms,
        SignatureParams calldata sig
    ) external;

    /// @notice {pauseSubscription} authorised by the follower's EIP-712 `PauseSubscription` signature. Works while
    ///         the contract is paused. Not version-bound.
    /// @param subscriptionId The subscription.
    /// @param sig Nonce, deadline and signature.
    function pauseSubscriptionWithSig(uint256 subscriptionId, SignatureParams calldata sig) external;

    /// @notice {resumeSubscription} authorised by the follower's EIP-712 `ResumeSubscription` signature.
    /// @dev Also reverts with {VersionMismatch} unless the current version equals `expectedVersion`.
    /// @param subscriptionId The subscription.
    /// @param expectedVersion The version the follower saw when signing.
    /// @param sig Nonce, deadline and signature.
    function resumeSubscriptionWithSig(uint256 subscriptionId, uint32 expectedVersion, SignatureParams calldata sig)
        external;

    /// @notice {unsubscribe} authorised by the follower's EIP-712 `Unsubscribe` signature. Works while the contract
    ///         is paused. Not bound to a version, so it stays valid whatever else happens before it lands.
    /// @param subscriptionId The subscription.
    /// @param closePositions Ask the executor to flatten the positions it opened.
    /// @param sig Nonce, deadline and signature.
    function unsubscribeWithSig(uint256 subscriptionId, bool closePositions, SignatureParams calldata sig) external;

    /// @notice {unsubscribeAll} for `follower`, authorised by an EIP-712 `UnsubscribeAll` signature. Works while the
    ///         contract is paused. A follower may pre-sign one with a long deadline and keep it as an emergency stop
    ///         that anyone can submit; it stops whatever is live when it lands.
    /// @param follower The follower (signer).
    /// @param closePositions Ask the executor to flatten the positions it opened.
    /// @param sig Nonce, deadline and signature.
    /// @return stopEpoch The follower's new stop epoch.
    function unsubscribeAllWithSig(address follower, bool closePositions, SignatureParams calldata sig)
        external
        returns (uint64 stopEpoch);

    /// @notice {invalidateNonces} for `follower`, authorised by an EIP-712 `InvalidateNonces` signature, so a
    ///         follower without gas can cancel signed messages too. The signature's own nonce is consumed first; it may
    ///         lie inside `mask`. Works while the contract is paused.
    /// @param follower The follower (signer).
    /// @param word Bitmap word index.
    /// @param mask Bits to set in that word.
    /// @param sig Nonce, deadline and signature.
    function invalidateNoncesWithSig(address follower, uint256 word, uint256 mask, SignatureParams calldata sig)
        external;

    // ================================================================================================================
    //                                                 EXECUTORS
    // ================================================================================================================

    /// @notice Publish a commitment to what msg.sender's executor did during `epoch`. The contract does not verify
    ///         trades; it makes the commitment public, timestamped and immutable.
    /// @dev Reverts with {NotExecutor} unless msg.sender is an authorised executor, and with {EpochNotIncreasing} if
    ///      `epoch` <= its last epoch. Allowed while paused. Emits {ExecutionsCommitted}.
    /// @param epoch Executor-defined epoch, strictly increasing.
    /// @param merkleRoot Root of the execution records (leaf format in the spec, §7.2).
    /// @param count Number of leaves.
    /// @param uri Where the records and proofs are published.
    function commitExecutions(uint64 epoch, bytes32 merkleRoot, uint32 count, string calldata uri) external;

    // ================================================================================================================
    //                                                 GOVERNANCE
    // ================================================================================================================

    /// @notice Owner: set Valuescan's builder id and current fees. A fee above a follower's consent is never charged
    ///         to that follower: the effective fee is min(current fee, consent), so raising the fee never raises consent.
    /// @dev Reverts if `builderId` is 0, `perpsFee` > PERPS_BUILDER_FEE_CAP or `spotFee` > SPOT_BUILDER_FEE_CAP.
    ///      Emits {BuilderTermsUpdated}.
    /// @param builderId Valuescan's SoDEX account id.
    /// @param perpsFee Perps fee in tenths of a bp.
    /// @param spotFee Spot fee in tenths of a bp.
    function setBuilderTerms(uint64 builderId, uint16 perpsFee, uint16 spotFee) external;

    /// @notice Owner: create or change a venue entry. Disabling a venue only blocks NEW subscriptions to it.
    /// @dev Reverts if `venue` is 0 or `name` is empty. Emits {VenueUpdated}.
    /// @param venue Venue id (1 = SoDEX, 2 = Hyperliquid; others as the owner defines).
    /// @param enabled Whether new subscriptions may use it.
    /// @param name Its name.
    function setVenue(uint8 venue, bool enabled, string calldata name) external;

    /// @notice Owner: authorise or de-authorise one of Valuescan's executor addresses. Executors can only publish
    ///         execution commitments; they can never change a subscription.
    /// @dev Reverts if `executor` is the zero address. Idempotent. Emits {ExecutorSet}.
    /// @param executor The executor address.
    /// @param authorised The new flag.
    function setExecutor(address executor, bool authorised) external;

    /// @notice Owner: block NEW activity (subscribe, update, resume and their signature variants). Never blocks
    ///         pause, unsubscribe, unsubscribeAll, their signature variants, nonce invalidation or commitments.
    function pause() external;

    /// @notice Owner: lift {pause}.
    function unpause() external;

    // ================================================================================================================
    //                                                   VIEWS
    // ================================================================================================================

    /// @notice Implementation version string, for example "1.0.0". Changes with every upgrade.
    /// @return The version.
    function VERSION() external view returns (string memory);

    /// @notice The EIP-712 domain separator for the current chain and this proxy.
    /// @return The separator.
    function DOMAIN_SEPARATOR() external view returns (bytes32);

    /// @notice One subscription, with its effective status.
    /// @dev Reverts with {UnknownSubscription} for an unknown id. To read many, batch `eth_call`s at one block.
    /// @param subscriptionId The subscription.
    /// @return The record.
    function getSubscription(uint256 subscriptionId) external view returns (Subscription memory);

    /// @notice Effective status of a subscription; NONE for an unknown id. Never reverts.
    /// @param subscriptionId The subscription.
    /// @return The status.
    function statusOf(uint256 subscriptionId) external view returns (Status);

    /// @notice How and when a STOPPED subscription was stopped.
    /// @dev Reverts with {UnknownSubscription} for an unknown id and {InvalidStatus} if it is not STOPPED.
    /// @param subscriptionId The subscription.
    /// @return reason FOLLOWER (`unsubscribe`) or KILL_SWITCH (`unsubscribeAll`).
    /// @return closePositions Whether the follower asked for its positions to be flattened.
    /// @return stoppedAt Timestamp of the stop.
    function stopDetails(uint256 subscriptionId)
        external
        view
        returns (StopReason reason, bool closePositions, uint40 stoppedAt);

    /// @notice Total number of subscriptions ever created (the highest id).
    /// @return The count.
    function subscriptionCount() external view returns (uint256);

    /// @notice All subscriptions ever created by `follower`, oldest first, paginated.
    /// @dev Stable order (append-only). An offset at or past the end returns an empty page. `limit` is not capped;
    ///      the page is clamped to the list's end, so the caller bounds the work.
    /// @param follower The follower.
    /// @param offset Index of the first id to return.
    /// @param limit Maximum number of ids.
    /// @return ids The page.
    /// @return total Total number of ids for this follower.
    function subscriptionsOfFollower(address follower, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, uint256 total);

    /// @notice The follower's live (ACTIVE or PAUSED) subscriptions, paginated.
    /// @dev Exactly the subscriptions created in the follower's current stop epoch and not unsubscribed. The order
    ///      changes when a subscription leaves the set (swap-and-pop), so a multi-call scan is only consistent at one
    ///      block.
    /// @param follower The follower.
    /// @param offset Index of the first id to return.
    /// @param limit Maximum number of ids.
    /// @return ids The page.
    /// @return total Number of live subscriptions of this follower.
    function liveSubscriptionsOfFollower(address follower, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, uint256 total);

    /// @notice Every subscription ever created to `leader` on `venue`, oldest first, paginated. Filter by status
    ///         with {statusOf}; executors follow the events.
    /// @param venue The venue id.
    /// @param leader The leader.
    /// @param offset Index of the first id to return.
    /// @param limit Maximum number of ids.
    /// @return ids The page.
    /// @return total Total number of subscriptions ever created to this leader on this venue.
    function subscriptionsOfLeader(uint8 venue, address leader, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, uint256 total);

    /// @notice The live subscription of `follower` for (`sodexAccountId`, `venue`, `leader`), or 0 if none.
    /// @param follower The follower.
    /// @param sodexAccountId The follower's SoDEX account.
    /// @param venue The venue id.
    /// @param leader The leader.
    /// @return subscriptionId The id, or 0.
    function liveSubscriptionFor(address follower, uint64 sodexAccountId, uint8 venue, address leader)
        external
        view
        returns (uint256 subscriptionId);

    /// @notice The id of the last subscription ever created for (`follower`, `sodexAccountId`, `venue`, `leader`),
    ///         live or not, or 0 if none. A signed Subscribe must carry it as `expectedLastId`.
    /// @param follower The follower.
    /// @param sodexAccountId The follower's SoDEX account.
    /// @param venue The venue id.
    /// @param leader The leader.
    /// @return subscriptionId The id, or 0.
    function lastSubscriptionFor(address follower, uint64 sodexAccountId, uint8 venue, address leader)
        external
        view
        returns (uint256 subscriptionId);

    /// @notice Whether an executor may open or increase positions for this subscription right now: effective status
    ///         ACTIVE and expiry 0 or not yet reached.
    /// @dev Returns false for unknown ids. Neither venue enablement nor the contract's pause is part of it: both only
    ///      gate NEW activity.
    /// @param subscriptionId The subscription.
    /// @return True if copyable.
    function isCopyable(uint256 subscriptionId) external view returns (bool);

    /// @notice A follower's current stop epoch (0 until its first kill switch). A signed Subscribe must carry it.
    /// @param follower The follower.
    /// @return The stop epoch.
    function stopEpochOf(address follower) external view returns (uint64);

    /// @notice The kill switch that raised `follower`'s stop epoch to `stopEpoch` (all-zero if none).
    /// @param follower The follower.
    /// @param stopEpoch The epoch.
    /// @return The record.
    function killSwitchInfo(address follower, uint64 stopEpoch) external view returns (KillSwitch memory);

    /// @notice Builder fee the executor may attach to this subscription's orders: min(current fee, consent) per engine.
    /// @dev Reverts with {UnknownSubscription} for an unknown id. Computed on read, so it follows fee changes at once.
    /// @param subscriptionId The subscription.
    /// @return builderId Valuescan's SoDEX builder id.
    /// @return perpsFee Effective perps fee, tenths of a bp.
    /// @return spotFee Effective spot fee, tenths of a bp.
    function effectiveBuilderFee(uint256 subscriptionId)
        external
        view
        returns (uint64 builderId, uint16 perpsFee, uint16 spotFee);

    /// @notice Valuescan's current builder terms.
    /// @return The terms.
    function builderTerms() external view returns (BuilderTerms memory);

    /// @notice Whether `account` is currently an authorised executor.
    /// @param account The address.
    /// @return True if authorised.
    function isExecutor(address account) external view returns (bool);

    /// @notice An executor address's record (all-zero if never set).
    /// @param executor The address.
    /// @return The record.
    function executorInfo(address executor) external view returns (Executor memory);

    /// @notice A published commitment (all-zero if none for that epoch). Inclusion proofs are checked off-chain
    ///         against `merkleRoot` (OpenZeppelin sorted-pair Merkle tree, spec §7.2).
    /// @param executor The executor.
    /// @param epoch The epoch.
    /// @return The commitment.
    function commitment(address executor, uint64 epoch) external view returns (Commitment memory);

    /// @notice A venue's registry entry (all-zero if never set).
    /// @param venue The venue id.
    /// @return The entry.
    function venueInfo(uint8 venue) external view returns (Venue memory);

    /// @notice Whether `signer` has used or invalidated `nonce`.
    /// @param signer The signer.
    /// @param nonce The nonce.
    /// @return True if used.
    function isNonceUsed(address signer, uint256 nonce) external view returns (bool);

    /// @notice A signer's nonce bitmap word.
    /// @param signer The signer.
    /// @param word The word index (`nonce >> 8`).
    /// @return The bitmap.
    function nonceBitmap(address signer, uint256 word) external view returns (uint256);
}
