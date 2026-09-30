// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IValuescanCopyTrading, CopyTradingConstants as C} from "./interfaces/IValuescanCopyTrading.sol";

/// @title ValuescanCopyTrading
/// @author Valuescan
/// @notice The public, auditable record of copy trading on SoDEX: who copies which leader, under which rules, through
///         which delegated SoDEX API key, at which maximum builder fee, and when copying started, paused or stopped.
///         Behaviour is specified in docs/contracts/COPY-TRADING.md; names and types in the interface.
///
///         THIS CONTRACT NEVER HOLDS OR MOVES FUNDS. It has no receive or fallback function, no payable function of
///         its own, no token call and no balance read. The UUPS `upgradeToAndCall` is payable by standard; it is
///         owner-only and reverts on any value. Every trade happens on SoDEX, from the follower's own SoDEX account,
///         placed off-chain by Valuescan's executor with a key the follower authorised on SoDEX.
///
/// @dev UUPS implementation behind an ERC-1967 proxy. All state lives in the ERC-7201 namespace
///      `valuescan.storage.CopyTrading` ({CopyTradingStorage}); OpenZeppelin's parents use their own namespaces, so the
///      contract has no sequential storage at all. The constructor disables initializers on the implementation.
///      Conventions used throughout:
///      - "live" means effective status ACTIVE or PAUSED. The effective status of a stored ACTIVE or PAUSED record is
///        STOPPED when its `stopEpoch` is below its follower's current stop epoch (a later kill switch).
///      - "expired" means `expiry != 0 && block.timestamp >= expiry`. New terms need `expiry == 0 || expiry > now`,
///        the exact complement, so terms that were valid when stored are never already expired.
///      - Every follower action exists as a direct call and as a `...WithSig` call. Both run the same checks in the same
///        order: existence, authority (direct: msg.sender; signed: nothing yet), status, version (signed update and
///        resume), field validation, uniqueness, then the signature (stop epoch for Subscribe, deadline, nonce, ECDSA
///        then ERC-1271), then effects, then events. `NonceUsed` is therefore always the first event of a signed call.
///      - No loop over a stored list. The loops that exist run over the caller's own input (symbols, key name, page
///        limit, initial executors), so every call's work is O(1) in the stored state.
///      - External calls: the ERC-1271 STATICCALL to the signer's own wallet, made before any state write; and, in an
///        owner-only upgrade, OpenZeppelin's `proxiableUUID` STATICCALL and optional DELEGATECALL of the new
///        implementation. No other call, no self-destruct.
///      - Inline assembly only in {_s} (the ERC-7201 slot, as in OpenZeppelin).
///      - solc 0.8.36 known-bug rules (see contracts/README.md): no named arguments in require-with-custom-error (this
///        contract uses `if (...) revert` only), no `delete` of bytes-memory elements, and no recursion of any kind,
///        which rules out the via-IR spill-slot bug.
contract ValuescanCopyTrading is
    IValuescanCopyTrading,
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable
{
    using EnumerableSet for EnumerableSet.UintSet;

    /// @dev Bytes allowed in a SoDEX API-key name, [0-9A-Za-z_-], as a bitmap indexed by byte value.
    uint256 private constant _KEY_NAME_CHARSET = (((1 << 10) - 1) << 0x30) // '0'..'9'
        | (((1 << 26) - 1) << 0x41) // 'A'..'Z'
        | (((1 << 26) - 1) << 0x61) // 'a'..'z'
        | (1 << 0x5f) // '_'
        | (1 << 0x2d); // '-'
    /// @dev Bytes allowed in a symbol: printable ASCII 0x21..0x7E, as a bitmap indexed by byte value.
    uint256 private constant _SYMBOL_CHARSET = ((1 << 94) - 1) << 0x21;
    /// @dev keccak256("default"): SoDEX's reserved name of the master key.
    bytes32 private constant _DEFAULT_KEY_NAME_HASH = keccak256("default");

    // ================================================================================================================
    //                                                   STORAGE
    // ================================================================================================================

    /// @notice The whole state of the contract (ERC-7201 namespace `valuescan.storage.CopyTrading`).
    /// @dev UPGRADE RULE: members may only be APPENDED. Never remove, reorder, retype or rename a member, and never
    ///      change the members of a struct stored inline here (BuilderTerms) unless it is the last member; structs
    ///      stored in mappings may only have members appended. Members of the stored enums (Status, MarketScope,
    ///      SizingMode, SymbolMode) may only be appended too (SEC-01). `storage-layout/ValuescanCopyTrading.json` is
    ///      the committed snapshot; `node tools/storage-layout.mjs check` and `test/upgrade/StorageLayout.t.sol` fail
    ///      on any incompatible change.
    /// @custom:storage-location erc7201:valuescan.storage.CopyTrading
    struct CopyTradingStorage {
        /// Highest subscription id handed out so far; ids start at 1.
        uint256 subscriptionCount;
        /// Subscription records.
        mapping(uint256 subscriptionId => Subscription) subscriptions;
        /// Every id a follower ever created, oldest first (append-only).
        mapping(address follower => uint256[]) followerHistory;
        /// Every id ever created per (venue, leader), oldest first (append-only).
        mapping(uint8 venue => mapping(address leader => uint256[])) leaderHistory;
        /// Live ids per (follower, stop epoch). Only the set of the follower's current epoch is meaningful: a kill
        /// switch moves the follower to a new, empty set in O(1) and the old set is never read again.
        mapping(address follower => mapping(uint64 stopEpoch => EnumerableSet.UintSet)) followerLive;
        /// keccak256(follower, sodexAccountId, venue, leader) => the last id created for that key, never cleared. It
        /// is the live id if that subscription is still live, else stale (ignored by the uniqueness guard). A signed
        /// Subscribe is bound to it ({lastSubscriptionFor}).
        mapping(bytes32 liveKey => uint256 subscriptionId) liveByKey;
        /// Each follower's stop epoch: raised by 1 by every kill switch.
        mapping(address follower => uint64) stopEpoch;
        /// The kill switch that raised a follower's stop epoch to the key.
        mapping(address follower => mapping(uint64 stopEpoch => KillSwitch)) killSwitches;
        /// Executor records (owner-managed flag, last change, last committed epoch).
        mapping(address executor => Executor) executors;
        /// Published execution commitments per (executor, epoch). Written once, never changed.
        mapping(address executor => mapping(uint64 epoch => Commitment)) commitments;
        /// Venue registry, set by the owner. Only gates NEW subscriptions.
        mapping(uint8 venue => Venue) venues;
        /// Unordered nonces: bit (nonce & 0xff) of word (nonce >> 8), per signer.
        mapping(address signer => mapping(uint256 word => uint256 bitmap)) nonceBitmap;
        /// Valuescan's builder terms, set by the owner within the SoDEX caps. Last member, so it may grow.
        BuilderTerms builderTerms;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("valuescan.storage.CopyTrading")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_LOCATION = 0xc3b2bc2cf6fc6db46d2b311dd8531e2120cf7207f8eeaaf9015bcf1d32c6bf00;

    /// @dev The ERC-7201 namespace. The only inline assembly in the contract.
    function _s() internal pure returns (CopyTradingStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    // ================================================================================================================
    //                                          CONSTRUCTOR AND INITIALIZER
    // ================================================================================================================

    /// @notice Locks the implementation: it can never be initialised, so it never has an owner and can only be used
    ///         through a proxy.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialises the proxy's state: owner, venues SoDEX (1) and Hyperliquid (2) enabled, builder terms and
    ///         the initial executors. Must be called atomically by the ERC1967Proxy constructor (its `_data`), so it
    ///         cannot be front-run.
    /// @dev Emits, in order: OwnershipTransferred, VenueUpdated(1), VenueUpdated(2), BuilderTermsUpdated, one
    ///      ExecutorSet per initial executor, Initialized(1). An indexer starting at the proxy's deployment block
    ///      therefore needs no call at all. The EIP-712 domain needs no initialisation: its name and version are
    ///      pinned in code ({_EIP712Name}, {_EIP712Version}).
    /// @param initialOwner Governance owner: the TimelockController in front of the multisig (see the spec). Non-zero.
    /// @param builderId Valuescan's SoDEX account id used as builder id. Non-zero.
    /// @param perpsFee Initial perps builder fee, tenths of a bp, <= PERPS_BUILDER_FEE_CAP.
    /// @param spotFee Initial spot builder fee, tenths of a bp, <= SPOT_BUILDER_FEE_CAP.
    /// @param initialExecutors Valuescan's executor addresses to authorise at once (may be empty). Non-zero.
    function initialize(
        address initialOwner,
        uint64 builderId,
        uint16 perpsFee,
        uint16 spotFee,
        address[] calldata initialExecutors
    ) external initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __Pausable_init();
        _setVenue(C.VENUE_SODEX, true, "SoDEX");
        _setVenue(C.VENUE_HYPERLIQUID, true, "Hyperliquid");
        _setBuilderTerms(builderId, perpsFee, spotFee);
        uint256 n = initialExecutors.length;
        for (uint256 i; i < n; ++i) {
            _setExecutor(initialExecutors[i], true);
        }
    }

    // ================================================================================================================
    //                                          FOLLOWER ACTIONS (DIRECT)
    // ================================================================================================================

    /// @inheritdoc IValuescanCopyTrading
    function subscribe(uint8 venue, address leader, uint64 sodexAccountId, Terms calldata terms)
        external
        whenNotPaused
        returns (uint256 subscriptionId)
    {
        (bytes32 symbolsHash,) = _checkSubscribe(msg.sender, venue, leader, sodexAccountId, terms);
        subscriptionId = _subscribe(msg.sender, venue, leader, sodexAccountId, terms, symbolsHash);
    }

    /// @inheritdoc IValuescanCopyTrading
    function updateSubscription(uint256 subscriptionId, Terms calldata terms) external whenNotPaused {
        Subscription storage s = _existingOf(subscriptionId, msg.sender);
        _requireLive(subscriptionId, s);
        bytes32 symbolsHash = _validateTerms(msg.sender, terms);
        _update(subscriptionId, s, terms, symbolsHash);
    }

    /// @inheritdoc IValuescanCopyTrading
    function pauseSubscription(uint256 subscriptionId) external {
        Subscription storage s = _existingOf(subscriptionId, msg.sender);
        _requireStatus(subscriptionId, s, Status.ACTIVE);
        _pauseSubscription(subscriptionId, s);
    }

    /// @inheritdoc IValuescanCopyTrading
    function resumeSubscription(uint256 subscriptionId) external whenNotPaused {
        Subscription storage s = _existingOf(subscriptionId, msg.sender);
        _requireStatus(subscriptionId, s, Status.PAUSED);
        _requireNotExpired(s);
        _resumeSubscription(subscriptionId, s);
    }

    /// @inheritdoc IValuescanCopyTrading
    function unsubscribe(uint256 subscriptionId, bool closePositions) external {
        Subscription storage s = _existingOf(subscriptionId, msg.sender);
        _requireLive(subscriptionId, s);
        _stop(subscriptionId, s, closePositions);
    }

    /// @inheritdoc IValuescanCopyTrading
    function unsubscribeAll(bool closePositions) external returns (uint64 stopEpoch) {
        stopEpoch = _unsubscribeAll(msg.sender, closePositions);
    }

    /// @inheritdoc IValuescanCopyTrading
    function invalidateNonces(uint256 word, uint256 mask) external {
        _invalidateNonces(msg.sender, word, mask);
    }

    // ================================================================================================================
    //                                   FOLLOWER ACTIONS (EIP-712, SUBMITTED BY ANYONE)
    // ================================================================================================================

    /// @inheritdoc IValuescanCopyTrading
    function subscribeWithSig(
        address follower,
        uint8 venue,
        address leader,
        uint64 sodexAccountId,
        Terms calldata terms,
        uint64 stopEpoch,
        uint256 expectedLastId,
        SignatureParams calldata sig
    ) external whenNotPaused returns (uint256 subscriptionId) {
        (bytes32 symbolsHash, uint256 lastId) = _checkSubscribe(follower, venue, leader, sodexAccountId, terms);
        uint64 current = _s().stopEpoch[follower];
        if (stopEpoch != current) revert StopEpochMismatch(follower, stopEpoch, current);
        // SEC-04: bound to the key's history, so a withheld Subscribe cannot land after a later subscribe or stop.
        if (expectedLastId != lastId) revert LastSubscriptionMismatch(expectedLastId, lastId);
        _useSignature(
            follower,
            keccak256(
                abi.encode(
                    C.SUBSCRIBE_TYPEHASH,
                    follower,
                    venue,
                    leader,
                    sodexAccountId,
                    _hashTerms(terms, symbolsHash),
                    stopEpoch,
                    expectedLastId,
                    sig.nonce,
                    sig.deadline
                )
            ),
            sig
        );
        subscriptionId = _subscribe(follower, venue, leader, sodexAccountId, terms, symbolsHash);
    }

    /// @inheritdoc IValuescanCopyTrading
    function updateSubscriptionWithSig(
        uint256 subscriptionId,
        uint32 expectedVersion,
        Terms calldata terms,
        SignatureParams calldata sig
    ) external whenNotPaused {
        Subscription storage s = _existing(subscriptionId);
        _requireLive(subscriptionId, s);
        _requireVersion(subscriptionId, s, expectedVersion);
        address follower = s.follower;
        bytes32 symbolsHash = _validateTerms(follower, terms);
        _useSignature(
            follower,
            keccak256(
                abi.encode(
                    C.UPDATE_TYPEHASH,
                    follower,
                    subscriptionId,
                    expectedVersion,
                    _hashTerms(terms, symbolsHash),
                    sig.nonce,
                    sig.deadline
                )
            ),
            sig
        );
        _update(subscriptionId, s, terms, symbolsHash);
    }

    /// @inheritdoc IValuescanCopyTrading
    function pauseSubscriptionWithSig(uint256 subscriptionId, SignatureParams calldata sig) external {
        Subscription storage s = _existing(subscriptionId);
        _requireStatus(subscriptionId, s, Status.ACTIVE);
        address follower = s.follower;
        _useSignature(
            follower, keccak256(abi.encode(C.PAUSE_TYPEHASH, follower, subscriptionId, sig.nonce, sig.deadline)), sig
        );
        _pauseSubscription(subscriptionId, s);
    }

    /// @inheritdoc IValuescanCopyTrading
    function resumeSubscriptionWithSig(uint256 subscriptionId, uint32 expectedVersion, SignatureParams calldata sig)
        external
        whenNotPaused
    {
        Subscription storage s = _existing(subscriptionId);
        _requireStatus(subscriptionId, s, Status.PAUSED);
        _requireVersion(subscriptionId, s, expectedVersion);
        _requireNotExpired(s);
        address follower = s.follower;
        _useSignature(
            follower,
            keccak256(
                abi.encode(C.RESUME_TYPEHASH, follower, subscriptionId, expectedVersion, sig.nonce, sig.deadline)
            ),
            sig
        );
        _resumeSubscription(subscriptionId, s);
    }

    /// @inheritdoc IValuescanCopyTrading
    function unsubscribeWithSig(uint256 subscriptionId, bool closePositions, SignatureParams calldata sig) external {
        Subscription storage s = _existing(subscriptionId);
        _requireLive(subscriptionId, s);
        address follower = s.follower;
        _useSignature(
            follower,
            keccak256(
                abi.encode(C.UNSUBSCRIBE_TYPEHASH, follower, subscriptionId, closePositions, sig.nonce, sig.deadline)
            ),
            sig
        );
        _stop(subscriptionId, s, closePositions);
    }

    /// @inheritdoc IValuescanCopyTrading
    function unsubscribeAllWithSig(address follower, bool closePositions, SignatureParams calldata sig)
        external
        returns (uint64 stopEpoch)
    {
        _useSignature(
            follower,
            keccak256(abi.encode(C.UNSUBSCRIBE_ALL_TYPEHASH, follower, closePositions, sig.nonce, sig.deadline)),
            sig
        );
        stopEpoch = _unsubscribeAll(follower, closePositions);
    }

    /// @inheritdoc IValuescanCopyTrading
    function invalidateNoncesWithSig(address follower, uint256 word, uint256 mask, SignatureParams calldata sig)
        external
    {
        _useSignature(
            follower,
            keccak256(abi.encode(C.INVALIDATE_NONCES_TYPEHASH, follower, word, mask, sig.nonce, sig.deadline)),
            sig
        );
        _invalidateNonces(follower, word, mask);
    }

    // ================================================================================================================
    //                                                 EXECUTORS
    // ================================================================================================================

    /// @inheritdoc IValuescanCopyTrading
    function commitExecutions(uint64 epoch, bytes32 merkleRoot, uint32 count, string calldata uri) external {
        CopyTradingStorage storage $ = _s();
        Executor storage x = $.executors[msg.sender];
        if (!x.authorised) revert NotExecutor(msg.sender);
        uint64 lastEpoch = x.lastEpoch;
        if (epoch <= lastEpoch) revert EpochNotIncreasing(lastEpoch, epoch);
        x.lastEpoch = epoch;
        $.commitments[msg.sender][epoch] = Commitment(merkleRoot, count, _now());
        emit ExecutionsCommitted(msg.sender, epoch, merkleRoot, count, uri);
    }

    // ================================================================================================================
    //                                                 GOVERNANCE
    // ================================================================================================================

    /// @inheritdoc IValuescanCopyTrading
    function setBuilderTerms(uint64 builderId, uint16 perpsFee, uint16 spotFee) external onlyOwner {
        _setBuilderTerms(builderId, perpsFee, spotFee);
    }

    /// @inheritdoc IValuescanCopyTrading
    function setVenue(uint8 venue, bool enabled, string calldata name) external onlyOwner {
        _setVenue(venue, enabled, name);
    }

    /// @inheritdoc IValuescanCopyTrading
    function setExecutor(address executor, bool authorised) external onlyOwner {
        _setExecutor(executor, authorised);
    }

    /// @inheritdoc IValuescanCopyTrading
    function pause() external onlyOwner {
        _pause();
    }

    /// @inheritdoc IValuescanCopyTrading
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Disabled: the contract must never be left without fee, venue, executor and upgrade governance by
    ///         accident.
    /// @dev Reverts with {OwnableUnauthorizedAccount} for anyone but the owner and {RenounceDisabled} for the owner.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// @notice UUPS upgrade (owner only, through the proxy only). Payable by the ERC-1822/UUPS standard, but this
    ///         contract never accepts funds: any value reverts with {FundsNotAccepted}.
    /// @dev OpenZeppelin checks the new implementation's `proxiableUUID`, sets it, emits `Upgraded` and, if `data` is
    ///      non-empty, delegatecalls it (for a `reinitializer`).
    /// @param newImplementation The new implementation.
    /// @param data Optional call into the new implementation, for example its `reinitializer`.
    function upgradeToAndCall(address newImplementation, bytes memory data) public payable override {
        if (msg.value != 0) revert FundsNotAccepted();
        super.upgradeToAndCall(newImplementation, data);
    }

    /// @dev UUPS: only the owner (the timelock) may upgrade.
    function _authorizeUpgrade(address) internal view override onlyOwner {}

    /// @dev The EIP-712 domain name, pinned in code rather than in storage, so it survives every upgrade unchanged
    ///      unless a new implementation deliberately changes it (spec §10.4).
    function _EIP712Name() internal pure virtual override returns (string memory) {
        return C.EIP712_NAME;
    }

    /// @dev The EIP-712 domain version, pinned in code; see {_EIP712Name}.
    function _EIP712Version() internal pure virtual override returns (string memory) {
        return C.EIP712_VERSION;
    }

    // ================================================================================================================
    //                                                   VIEWS
    // ================================================================================================================

    /// @inheritdoc IValuescanCopyTrading
    function VERSION() public pure virtual returns (string memory) {
        return "1.0.0";
    }

    /// @inheritdoc IValuescanCopyTrading
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @inheritdoc IValuescanCopyTrading
    function getSubscription(uint256 subscriptionId) external view returns (Subscription memory) {
        _existing(subscriptionId);
        return _load(subscriptionId);
    }

    /// @inheritdoc IValuescanCopyTrading
    function statusOf(uint256 subscriptionId) external view returns (Status) {
        return _statusOf(_s().subscriptions[subscriptionId]);
    }

    /// @inheritdoc IValuescanCopyTrading
    function stopDetails(uint256 subscriptionId)
        external
        view
        returns (StopReason reason, bool closePositions, uint40 stoppedAt)
    {
        Subscription storage s = _existing(subscriptionId);
        Status stored = s.status;
        if (stored == Status.STOPPED) return (StopReason.FOLLOWER, s.closePositions, s.updatedAt);
        address follower = s.follower;
        uint64 epoch = s.stopEpoch;
        CopyTradingStorage storage $ = _s();
        if (epoch >= $.stopEpoch[follower]) revert InvalidStatus(subscriptionId, stored);
        // The first kill switch after creation is the one that stopped it.
        KillSwitch storage k = $.killSwitches[follower][epoch + 1];
        return (StopReason.KILL_SWITCH, k.closePositions, k.triggeredAt);
    }

    /// @inheritdoc IValuescanCopyTrading
    function subscriptionCount() external view returns (uint256) {
        return _s().subscriptionCount;
    }

    /// @inheritdoc IValuescanCopyTrading
    function subscriptionsOfFollower(address follower, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, uint256 total)
    {
        return _page(_s().followerHistory[follower], offset, limit);
    }

    /// @inheritdoc IValuescanCopyTrading
    function liveSubscriptionsOfFollower(address follower, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, uint256 total)
    {
        CopyTradingStorage storage $ = _s();
        EnumerableSet.UintSet storage set = $.followerLive[follower][$.stopEpoch[follower]];
        total = set.length();
        uint256 n = _pageLength(total, offset, limit);
        if (n != 0) ids = set.values(offset, offset + n);
    }

    /// @inheritdoc IValuescanCopyTrading
    function subscriptionsOfLeader(uint8 venue, address leader, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, uint256 total)
    {
        return _page(_s().leaderHistory[venue][leader], offset, limit);
    }

    /// @inheritdoc IValuescanCopyTrading
    function liveSubscriptionFor(address follower, uint64 sodexAccountId, uint8 venue, address leader)
        external
        view
        returns (uint256 subscriptionId)
    {
        CopyTradingStorage storage $ = _s();
        subscriptionId = $.liveByKey[_liveKey(follower, sodexAccountId, venue, leader)];
        if (subscriptionId != 0 && !_isLive(_statusOf($.subscriptions[subscriptionId]))) subscriptionId = 0;
    }

    /// @inheritdoc IValuescanCopyTrading
    function lastSubscriptionFor(address follower, uint64 sodexAccountId, uint8 venue, address leader)
        external
        view
        returns (uint256)
    {
        return _s().liveByKey[_liveKey(follower, sodexAccountId, venue, leader)];
    }

    /// @inheritdoc IValuescanCopyTrading
    function isCopyable(uint256 subscriptionId) external view returns (bool) {
        Subscription storage s = _s().subscriptions[subscriptionId];
        return _statusOf(s) == Status.ACTIVE && !_isExpired(s.expiry);
    }

    /// @inheritdoc IValuescanCopyTrading
    function stopEpochOf(address follower) external view returns (uint64) {
        return _s().stopEpoch[follower];
    }

    /// @inheritdoc IValuescanCopyTrading
    function killSwitchInfo(address follower, uint64 stopEpoch) external view returns (KillSwitch memory) {
        return _s().killSwitches[follower][stopEpoch];
    }

    /// @inheritdoc IValuescanCopyTrading
    function effectiveBuilderFee(uint256 subscriptionId)
        external
        view
        returns (uint64 builderId, uint16 perpsFee, uint16 spotFee)
    {
        Subscription storage s = _existing(subscriptionId);
        BuilderTerms storage b = _s().builderTerms;
        builderId = b.builderId;
        perpsFee = _min(b.perpsFee, s.maxBuilderFeePerps);
        spotFee = _min(b.spotFee, s.maxBuilderFeeSpot);
    }

    /// @inheritdoc IValuescanCopyTrading
    function builderTerms() external view returns (BuilderTerms memory) {
        return _s().builderTerms;
    }

    /// @inheritdoc IValuescanCopyTrading
    function isExecutor(address account) external view returns (bool) {
        return _s().executors[account].authorised;
    }

    /// @inheritdoc IValuescanCopyTrading
    function executorInfo(address executor) external view returns (Executor memory) {
        return _s().executors[executor];
    }

    /// @inheritdoc IValuescanCopyTrading
    function commitment(address executor, uint64 epoch) external view returns (Commitment memory) {
        return _s().commitments[executor][epoch];
    }

    /// @inheritdoc IValuescanCopyTrading
    function venueInfo(uint8 venue) external view returns (Venue memory) {
        return _s().venues[venue];
    }

    /// @inheritdoc IValuescanCopyTrading
    function isNonceUsed(address signer, uint256 nonce) external view returns (bool) {
        return _s().nonceBitmap[signer][nonce >> 8] & (1 << (nonce & 0xff)) != 0;
    }

    /// @inheritdoc IValuescanCopyTrading
    function nonceBitmap(address signer, uint256 word) external view returns (uint256) {
        return _s().nonceBitmap[signer][word];
    }

    // ================================================================================================================
    //                                    INTERNAL: SUBSCRIPTION CHECKS (NO WRITES)
    // ================================================================================================================

    /// @dev Target, terms and uniqueness checks of a new subscription. Returns the symbols commitment and the key's
    ///      last subscription id (0 for none), which a signed Subscribe is bound to.
    function _checkSubscribe(address follower, uint8 venue, address leader, uint64 sodexAccountId, Terms calldata terms)
        private
        view
        returns (bytes32 symbolsHash, uint256 lastId)
    {
        CopyTradingStorage storage $ = _s();
        if (!$.venues[venue].enabled) revert VenueDisabled(venue);
        // Copying yourself on SoDEX would feed the copies back as leader trades; from Hyperliquid it is allowed
        // (mirror your own HL trading into your SoDEX account).
        _check(leader != address(0) && (venue != C.VENUE_SODEX || leader != follower), TermsField.LEADER);
        _check(sodexAccountId != 0, TermsField.SODEX_ACCOUNT);
        symbolsHash = _validateTerms(follower, terms);
        // Correctness guard, not a limit: two live copies of one leader into one SoDEX account would double the
        // exposure, and SoDEX nets them into one position per symbol, so the executor could not tell them apart.
        lastId = $.liveByKey[_liveKey(follower, sodexAccountId, venue, leader)];
        if (lastId != 0 && _isLive(_statusOf($.subscriptions[lastId]))) revert DuplicateSubscription(lastId);
    }

    /// @dev A resume needs an unexpired subscription (renew with an update first); otherwise the follower would resume
    ///      something that still cannot be copied.
    function _requireNotExpired(Subscription storage s) private view {
        _check(!_isExpired(s.expiry), TermsField.EXPIRY);
    }

    /// @dev Validates every field of `t` for `follower` (see the interface's {Terms} and spec §4.2) and returns the
    ///      symbols commitment. Only SoDEX's rules and validity bounds are enforced; there are no product limits.
    ///      Fields that bound other fields are checked first, so the reported field is the root cause: allocation cap
    ///      and leverage before max position notional, and max position notional before a FIXED_NOTIONAL sizing value.
    function _validateTerms(address follower, Terms calldata t) private view returns (bytes32 symbolsHash) {
        // The follower's master key is never delegated.
        address delegatedKey = t.delegatedKey;
        _check(delegatedKey != address(0) && delegatedKey != follower, TermsField.DELEGATED_KEY);
        bytes calldata name = bytes(t.keyName);
        uint256 len = name.length;
        _check(
            len != 0 && len <= C.MAX_KEY_NAME_LENGTH && _onlyChars(name, _KEY_NAME_CHARSET)
                && keccak256(name) != _DEFAULT_KEY_NAME_HASH,
            TermsField.KEY_NAME
        );

        MarketScope scope = t.marketScope;
        _check(scope != MarketScope.NONE, TermsField.MARKET_SCOPE);
        SizingMode mode = t.sizingMode;
        _check(mode != SizingMode.NONE, TermsField.SIZING_MODE);

        uint64 cap = t.allocationCap;
        _check(cap != 0, TermsField.ALLOCATION_CAP);
        uint8 leverage = t.maxLeverage;
        _check(leverage != 0 && (scope != MarketScope.SPOT || leverage == 1), TermsField.MAX_LEVERAGE);
        uint64 maxPosition = t.maxPositionNotional;
        _check(maxPosition != 0 && maxPosition <= uint256(cap) * leverage, TermsField.MAX_POSITION_NOTIONAL);
        uint64 sizing = t.sizingValue;
        _check(sizing != 0 && (mode != SizingMode.FIXED_NOTIONAL || sizing <= maxPosition), TermsField.SIZING_VALUE);

        _check(t.tradeStopLossBps <= C.MAX_BPS, TermsField.TRADE_STOP_LOSS);
        _check(t.maxDrawdownBps <= C.MAX_BPS, TermsField.MAX_DRAWDOWN);
        uint16 slippage = t.slippageBps;
        _check(slippage != 0 && slippage <= C.MAX_BPS, TermsField.SLIPPAGE);

        symbolsHash = _checkSymbols(t.symbolMode, t.symbols);

        _check(t.maxBuilderFeePerps <= C.PERPS_BUILDER_FEE_CAP, TermsField.BUILDER_FEE_PERPS);
        _check(t.maxBuilderFeeSpot <= C.SPOT_BUILDER_FEE_CAP, TermsField.BUILDER_FEE_SPOT);

        uint40 expiry = t.expiry;
        _check(expiry == 0 || expiry > block.timestamp, TermsField.EXPIRY);
    }

    /// @dev ALL: the list must be empty (else SYMBOL_MODE: the mode contradicts the list). ALLOW and DENY: at least one
    ///      entry (else SYMBOLS), each non-empty printable ASCII (else SYMBOLS). No count or length limit: the work is
    ///      proportional to the caller's own calldata, and nothing is stored but the commitment, which is the EIP-712
    ///      encoding of `string[]` (keccak256 of the concatenated keccak256 of each entry).
    function _checkSymbols(SymbolMode mode, string[] calldata list) private pure returns (bytes32) {
        uint256 n = list.length;
        if (mode == SymbolMode.ALL) _check(n == 0, TermsField.SYMBOL_MODE);
        else _check(n != 0, TermsField.SYMBOLS);
        bytes32[] memory hashes = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            bytes calldata symbol = bytes(list[i]);
            _check(symbol.length != 0 && _onlyChars(symbol, _SYMBOL_CHARSET), TermsField.SYMBOLS);
            hashes[i] = keccak256(symbol);
        }
        return keccak256(abi.encodePacked(hashes));
    }

    /// @dev Whether every byte of `b` is in `charset` (a bitmap indexed by byte value). Loops over caller input only.
    function _onlyChars(bytes calldata b, uint256 charset) private pure returns (bool) {
        uint256 len = b.length;
        for (uint256 i; i < len; ++i) {
            if ((charset >> uint8(b[i])) & 1 == 0) return false;
        }
        return true;
    }

    /// @dev Reverts with {InvalidTerms} naming `field` unless `ok`.
    function _check(bool ok, TermsField field) private pure {
        if (!ok) revert InvalidTerms(field);
    }

    // ================================================================================================================
    //                                   INTERNAL: SUBSCRIPTION EFFECTS (AFTER ALL CHECKS)
    // ================================================================================================================

    /// @dev Creates the record and its O(1) index entries. Emits Subscribed.
    function _subscribe(
        address follower,
        uint8 venue,
        address leader,
        uint64 sodexAccountId,
        Terms calldata terms,
        bytes32 symbolsHash
    ) private returns (uint256 subscriptionId) {
        CopyTradingStorage storage $ = _s();
        subscriptionId = ++$.subscriptionCount;
        uint64 epoch = $.stopEpoch[follower];
        Subscription storage s = $.subscriptions[subscriptionId];
        s.follower = follower;
        s.venue = venue;
        s.leader = leader;
        s.createdAt = _now();
        s.sodexAccountId = sodexAccountId;
        s.stopEpoch = epoch;
        _writeTerms(s, terms, symbolsHash);
        _transition(s, Status.ACTIVE); // version 0 -> 1, updatedAt = createdAt

        $.followerHistory[follower].push(subscriptionId);
        $.leaderHistory[venue][leader].push(subscriptionId);
        $.followerLive[follower][epoch].add(subscriptionId);
        $.liveByKey[_liveKey(follower, sodexAccountId, venue, leader)] = subscriptionId;

        emit Subscribed(subscriptionId, follower, leader, _load(subscriptionId), terms.symbols);
    }

    /// @dev Replaces the terms of a live subscription. Status, target (venue, leader, account, follower), createdAt and
    ///      stopEpoch are unchanged; version + 1 and updatedAt = now.
    function _update(uint256 id, Subscription storage s, Terms calldata terms, bytes32 symbolsHash) private {
        _writeTerms(s, terms, symbolsHash);
        _transition(s, s.status); // live, so the stored status is the effective one
        emit SubscriptionUpdated(id, s.follower, _load(id), terms.symbols);
    }

    /// @dev ACTIVE -> PAUSED.
    function _pauseSubscription(uint256 id, Subscription storage s) private {
        (uint32 version, uint40 updatedAt) = _transition(s, Status.PAUSED);
        emit SubscriptionPaused(id, s.follower, version, updatedAt);
    }

    /// @dev PAUSED -> ACTIVE.
    function _resumeSubscription(uint256 id, Subscription storage s) private {
        (uint32 version, uint40 updatedAt) = _transition(s, Status.ACTIVE);
        emit SubscriptionResumed(id, s.follower, version, updatedAt);
    }

    /// @dev Live -> STOPPED (terminal). Leaves the follower's live set. The key's `liveByKey` entry keeps this id (the
    ///      last one created for the key): the uniqueness guard ignores it once it is not live, and a signed Subscribe
    ///      signed before this subscription existed stays void (SEC-04).
    function _stop(uint256 id, Subscription storage s, bool closePositions) private {
        address follower = s.follower;
        _s().followerLive[follower][s.stopEpoch].remove(id);
        s.closePositions = closePositions;
        (uint32 version, uint40 updatedAt) = _transition(s, Status.STOPPED);
        emit SubscriptionStopped(id, follower, closePositions, version, updatedAt);
    }

    /// @dev Kill switch in O(1): raising the follower's stop epoch makes every subscription created before it STOPPED
    ///      (see {_statusOf}) and moves the follower to a new, empty live set. Never reverts (a uint64 epoch cannot
    ///      overflow in practice: 2^64 transactions).
    function _unsubscribeAll(address follower, bool closePositions) private returns (uint64 epoch) {
        CopyTradingStorage storage $ = _s();
        epoch = $.stopEpoch[follower] + 1;
        $.stopEpoch[follower] = epoch;
        $.killSwitches[follower][epoch] = KillSwitch(_now(), closePositions);
        emit KillSwitchTriggered(follower, epoch, closePositions);
    }

    /// @dev Status change bookkeeping shared by every change of a record: version + 1 and updatedAt = now.
    function _transition(Subscription storage s, Status to) private returns (uint32 version, uint40 updatedAt) {
        // Checked arithmetic: 2^32 - 1 changes of one subscription, each a follower transaction, are far beyond any
        // realistic use; and the kill switch, which touches no version, stops it regardless.
        version = s.version + 1;
        updatedAt = _now();
        s.status = to;
        s.version = version;
        s.updatedAt = updatedAt;
    }

    /// @dev Writes the follower-chosen fields of validated terms `t` into a record.
    function _writeTerms(Subscription storage s, Terms calldata t, bytes32 symbolsHash) private {
        s.marketScope = t.marketScope;
        s.sizingMode = t.sizingMode;
        s.symbolMode = t.symbolMode;
        s.copyExisting = t.copyExisting;
        s.maxLeverage = t.maxLeverage;
        s.slippageBps = t.slippageBps;
        s.delegatedKey = t.delegatedKey;
        s.expiry = t.expiry;
        s.takeProfitBps = t.takeProfitBps;
        s.tradeStopLossBps = t.tradeStopLossBps;
        s.sizingValue = t.sizingValue;
        s.maxDrawdownBps = t.maxDrawdownBps;
        s.maxBuilderFeePerps = t.maxBuilderFeePerps;
        s.maxBuilderFeeSpot = t.maxBuilderFeeSpot;
        s.allocationCap = t.allocationCap;
        s.maxPositionNotional = t.maxPositionNotional;
        s.symbolsHash = symbolsHash;
        s.keyName = t.keyName;
    }

    /// @dev Marks the bits of `mask` used in `signer`'s word `word`.
    function _invalidateNonces(address signer, uint256 word, uint256 mask) private {
        _s().nonceBitmap[signer][word] |= mask;
        emit NoncesInvalidated(signer, word, mask);
    }

    // ================================================================================================================
    //                                        INTERNAL: LOOKUPS AND GUARDS
    // ================================================================================================================

    /// @dev Effective status: a stored ACTIVE or PAUSED record created before its follower's latest kill switch is
    ///      STOPPED. Unknown ids stay NONE (NONE is not live).
    function _statusOf(Subscription storage s) private view returns (Status status) {
        status = s.status;
        if (_isLive(status) && s.stopEpoch < _s().stopEpoch[s.follower]) status = Status.STOPPED;
    }

    /// @dev A memory copy of a record with its effective status (zeroed for an unknown id).
    function _load(uint256 id) private view returns (Subscription memory subscription) {
        Subscription storage s = _s().subscriptions[id];
        subscription = s;
        subscription.status = _statusOf(s);
    }

    /// @dev The subscription, or revert {UnknownSubscription}.
    function _existing(uint256 id) private view returns (Subscription storage s) {
        s = _s().subscriptions[id];
        if (s.status == Status.NONE) revert UnknownSubscription(id);
    }

    /// @dev The subscription if `caller` is its follower, else revert ({UnknownSubscription} or {NotFollower}).
    function _existingOf(uint256 id, address caller) private view returns (Subscription storage s) {
        s = _existing(id);
        if (s.follower != caller) revert NotFollower(id, caller);
    }

    function _requireStatus(uint256 id, Subscription storage s, Status expected) private view {
        Status status = _statusOf(s);
        if (status != expected) revert InvalidStatus(id, status);
    }

    function _requireLive(uint256 id, Subscription storage s) private view {
        Status status = _statusOf(s);
        if (!_isLive(status)) revert InvalidStatus(id, status);
    }

    function _requireVersion(uint256 id, Subscription storage s, uint32 expected) private view {
        uint32 actual = s.version;
        if (actual != expected) revert VersionMismatch(id, expected, actual);
    }

    function _isLive(Status status) private pure returns (bool) {
        return status == Status.ACTIVE || status == Status.PAUSED;
    }

    function _isExpired(uint40 expiry) private view returns (bool) {
        return expiry != 0 && block.timestamp >= expiry;
    }

    function _liveKey(address follower, uint64 sodexAccountId, uint8 venue, address leader)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(follower, sodexAccountId, venue, leader));
    }

    /// @dev One page of an append-only id list. The loop runs over the caller's `limit`, clamped to the list's end.
    function _page(uint256[] storage list, uint256 offset, uint256 limit)
        private
        view
        returns (uint256[] memory ids, uint256 total)
    {
        total = list.length;
        uint256 n = _pageLength(total, offset, limit);
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = list[offset + i];
        }
    }

    /// @dev min(limit, total - offset), or 0 if offset >= total. Never overflows, whatever `limit` is.
    function _pageLength(uint256 total, uint256 offset, uint256 limit) private pure returns (uint256) {
        if (offset >= total) return 0;
        uint256 remaining = total - offset;
        return limit < remaining ? limit : remaining;
    }

    /// @dev The block time as stored in records. uint40 holds unix seconds until the year 36812.
    function _now() private view returns (uint40) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint40(block.timestamp);
    }

    function _min(uint16 a, uint16 b) private pure returns (uint16) {
        return a < b ? a : b;
    }

    // ================================================================================================================
    //                                    INTERNAL: EXECUTORS AND GOVERNANCE
    // ================================================================================================================

    function _setExecutor(address executor, bool authorised) private {
        if (executor == address(0)) revert InvalidExecutor();
        Executor storage x = _s().executors[executor];
        x.authorised = authorised;
        x.updatedAt = _now();
        emit ExecutorSet(executor, authorised);
    }

    function _setBuilderTerms(uint64 builderId, uint16 perpsFee, uint16 spotFee) private {
        if (builderId == 0 || perpsFee > C.PERPS_BUILDER_FEE_CAP || spotFee > C.SPOT_BUILDER_FEE_CAP) {
            revert InvalidBuilderTerms();
        }
        _s().builderTerms = BuilderTerms(builderId, perpsFee, spotFee, _now());
        emit BuilderTermsUpdated(builderId, perpsFee, spotFee);
    }

    function _setVenue(uint8 venue, bool enabled, string memory name) private {
        if (venue == 0 || bytes(name).length == 0) revert InvalidVenue(venue);
        Venue storage v = _s().venues[venue];
        v.enabled = enabled;
        v.name = name;
        emit VenueUpdated(venue, enabled, name);
    }

    // ================================================================================================================
    //                                           INTERNAL: SIGNATURES
    // ================================================================================================================

    /// @dev Spec §6.4: deadline, unused nonce, ECDSA by `signer` or else ERC-1271 approval by `signer`; only then the
    ///      nonce is consumed and {NonceUsed} emitted. The ERC-1271 STATICCALL precedes every state write of the
    ///      transaction.
    function _useSignature(address signer, bytes32 structHash, SignatureParams calldata sig) private {
        uint256 deadline = sig.deadline;
        if (block.timestamp > deadline) revert SignatureExpired(deadline);
        uint256 nonce = sig.nonce;
        uint256 word = nonce >> 8;
        uint256 bit = 1 << (nonce & 0xff);
        mapping(uint256 => uint256) storage bitmaps = _s().nonceBitmap[signer];
        uint256 bitmap = bitmaps[word];
        if (bitmap & bit != 0) revert NonceAlreadyUsed(signer, nonce);
        if (!_isValidSignature(signer, _hashTypedDataV4(structHash), sig.signature)) revert InvalidSignature(signer);
        bitmaps[word] = bitmap | bit;
        emit NonceUsed(signer, nonce);
    }

    /// @dev ECDSA first so EIP-7702-delegated EOAs (which have code) keep working with their own key; a contract
    ///      wallet cannot produce an ECDSA signature for its own address, so the order is safe. OpenZeppelin rejects
    ///      high-s and non-65-byte signatures on the ECDSA path, and never recovers the zero address.
    function _isValidSignature(address signer, bytes32 digest, bytes calldata signature) private view returns (bool) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) return true;
        return signer.code.length != 0 && SignatureChecker.isValidERC1271SignatureNowCalldata(signer, digest, signature);
    }

    /// @dev hashStruct(Terms) = keccak256(TERMS_TYPEHASH || encodeData(t)), per EIP-712 and spec §6.3: every member is
    ///      one 32-byte word (enums as uint8, `keyName` and `symbols` replaced by their hashes). Every word is static,
    ///      so a 10-word and a 9-word abi.encode concatenate to exactly one 19-word abi.encode.
    ///      `symbolsHash` is the EIP-712 `string[]` hash of `t.symbols`, from {_checkSymbols}.
    function _hashTerms(Terms calldata t, bytes32 symbolsHash) private pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                abi.encode(
                    C.TERMS_TYPEHASH,
                    t.delegatedKey,
                    keccak256(bytes(t.keyName)),
                    t.marketScope,
                    t.sizingMode,
                    t.sizingValue,
                    t.allocationCap,
                    t.maxPositionNotional,
                    t.maxLeverage,
                    t.tradeStopLossBps
                ),
                abi.encode(
                    t.maxDrawdownBps,
                    t.takeProfitBps,
                    t.slippageBps,
                    t.symbolMode,
                    symbolsHash,
                    t.copyExisting,
                    t.maxBuilderFeePerps,
                    t.maxBuilderFeeSpot,
                    t.expiry
                )
            )
        );
    }
}
