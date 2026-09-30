// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {console2} from "forge-std/console2.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IValuescanCopyTrading as I, CopyTradingConstants as C} from "../../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingBase} from "../../utils/CopyTradingBase.sol";

/// @notice Stands for a plausible V2: "V1 plus one new status" (for example moving the
///         spec's off-chain drawdown HALT on-chain) and a reordered SymbolMode. Everything the storage-layout guard
///         compares is IDENTICAL to V1: the ERC-7201 namespace and location, every member's name, slot, offset and
///         width, every struct. Only enum ORDINALS change: `Status` gains HALTED before STOPPED, and `SymbolMode` lists
///         DENY before ALLOW. The compiler's storage layout describes an enum only by its label and size (1 byte), so
///         neither `node tools/storage-layout.mjs check` nor test/upgrade/StorageLayout.t.sol can see this. Verified on
///         a scratch copy of the project in which the interface's own `Status` and `SymbolMode` were edited exactly
///         like this: `storage-layout.mjs check` printed "storage layout OK" and StorageLayout.t.sol passed 4/4.
/// @dev Types are declared here (not in the interface) only because V1 and this V2 must coexist in one test build.
contract EnumShiftV2Mock is UUPSUpgradeable, OwnableUpgradeable {
    using EnumerableSet for EnumerableSet.UintSet;

    enum Status {
        NONE,
        ACTIVE,
        PAUSED,
        HALTED, // inserted: a live, reduce-only state
        STOPPED
    }

    enum MarketScope {
        NONE,
        PERPS,
        SPOT,
        PERPS_AND_SPOT
    }

    enum SizingMode {
        NONE,
        PROPORTIONAL,
        FIXED_RATIO,
        FIXED_NOTIONAL
    }

    enum SymbolMode {
        ALL,
        DENY, // reordered
        ALLOW
    }

    /// @dev Same members, same order, same widths as IValuescanCopyTrading.Subscription.
    struct Subscription {
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
        address leader;
        uint40 createdAt;
        uint40 updatedAt;
        uint16 slippageBps;
        address delegatedKey;
        uint40 expiry;
        uint32 takeProfitBps;
        uint16 tradeStopLossBps;
        uint64 sodexAccountId;
        uint64 stopEpoch;
        uint64 sizingValue;
        uint16 maxDrawdownBps;
        uint16 maxBuilderFeePerps;
        uint16 maxBuilderFeeSpot;
        uint64 allocationCap;
        uint64 maxPositionNotional;
        bytes32 symbolsHash;
        string keyName;
    }

    struct KillSwitch {
        uint40 triggeredAt;
        bool closePositions;
    }

    struct Executor {
        bool authorised;
        uint40 updatedAt;
        uint64 lastEpoch;
    }

    struct Commitment {
        bytes32 merkleRoot;
        uint32 count;
        uint40 committedAt;
    }

    struct Venue {
        bool enabled;
        string name;
    }

    struct BuilderTerms {
        uint64 builderId;
        uint16 perpsFee;
        uint16 spotFee;
        uint40 updatedAt;
    }

    /// @dev Same members, same order as ValuescanCopyTrading.CopyTradingStorage.
    /// @custom:storage-location erc7201:valuescan.storage.CopyTrading
    struct CopyTradingStorage {
        uint256 subscriptionCount;
        mapping(uint256 subscriptionId => Subscription) subscriptions;
        mapping(address follower => uint256[]) followerHistory;
        mapping(uint8 venue => mapping(address leader => uint256[])) leaderHistory;
        mapping(address follower => mapping(uint64 stopEpoch => EnumerableSet.UintSet)) followerLive;
        mapping(bytes32 liveKey => uint256 subscriptionId) liveByKey;
        mapping(address follower => uint64) stopEpoch;
        mapping(address follower => mapping(uint64 stopEpoch => KillSwitch)) killSwitches;
        mapping(address executor => Executor) executors;
        mapping(address executor => mapping(uint64 epoch => Commitment)) commitments;
        mapping(uint8 venue => Venue) venues;
        mapping(address signer => mapping(uint256 word => uint256 bitmap)) nonceBitmap;
        BuilderTerms builderTerms;
    }

    bytes32 internal constant STORAGE_LOCATION = 0xc3b2bc2cf6fc6db46d2b311dd8531e2120cf7207f8eeaaf9015bcf1d32c6bf00;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function _s() internal pure returns (CopyTradingStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    /// @dev V1's rule, with V2's live set (ACTIVE, PAUSED, HALTED).
    function statusOf(uint256 id) public view returns (Status status) {
        Subscription storage s = _s().subscriptions[id];
        status = s.status;
        if (_isLive(status) && s.stopEpoch < _s().stopEpoch[s.follower]) status = Status.STOPPED;
    }

    function isLive(uint256 id) external view returns (bool) {
        return _isLive(statusOf(id));
    }

    function symbolModeOf(uint256 id) external view returns (SymbolMode) {
        return _s().subscriptions[id].symbolMode;
    }

    function _isLive(Status status) private pure returns (bool) {
        return status == Status.ACTIVE || status == Status.PAUSED || status == Status.HALTED;
    }

    function _authorizeUpgrade(address) internal view override onlyOwner {}
}

/// @notice AUDIT SEC-01 (medium, FIXED in the guard), kept as a regression test. Before the fix, both storage-layout
///         guards accepted this V2 because only enum ORDINALS change. Fix: `tools/storage-layout.mjs` snapshots the
///         member list of every stored enum and rejects anything but an append (selftest cases "insert an enum
///         member", "reorder enum members", ...; re-run on the auditor's scratch copy with exactly these edits, it
///         now prints "INCOMPATIBLE storage layout change" and exits 1), and test/upgrade/StorageLayout.t.sol pins
///         every ordinal (test_enumOrdinalsArePinned). These tests keep the consequence on record, which is WHY the
///         pins exist: an upgrade can never be checked on-chain for this, only by the guard before it is proposed.
contract SEC01_EnumOrdinalUpgradeTest is CopyTradingBase {
    function _recordWord0(uint256 id) internal view returns (bytes32) {
        // subscriptions is member 1 of the namespace; word 0 of a record packs follower, status, venue, the three
        // mode enums, copyExisting, maxLeverage, closePositions and version.
        bytes32 slot =
            keccak256(abi.encode(id, uint256(0xc3b2bc2cf6fc6db46d2b311dd8531e2120cf7207f8eeaaf9015bcf1d32c6bf00) + 1));
        return vm.load(address(c), slot);
    }

    function _upgradeToEnumShift() internal returns (EnumShiftV2Mock p) {
        EnumShiftV2Mock v2 = new EnumShiftV2Mock();
        vm.prank(owner);
        c.upgradeToAndCall(address(v2), "");
        p = EnumShiftV2Mock(address(c));
        assertEq(p.owner(), owner, "owner namespace untouched");
    }

    /// The V2's Status breaks the pinned ordinal of STOPPED, so the guard rejects it; had it been deployed, a stored
    /// STOPPED (3) would read back as HALTED, a live status.
    function test_audit_SEC01_statusRenumbering_breaksThePins_andWouldResurrectStoppedSubscriptions() public {
        uint256 id = _subscribeAs(alice, leader);
        vm.prank(alice);
        c.unsubscribe(id, true);
        _assertStatus(id, I.Status.STOPPED);
        bytes32 before = _recordWord0(id);
        assertEq(uint8(uint256(before) >> 160), 3, "V1 stores STOPPED as its pinned ordinal 3");
        assertTrue(
            uint8(EnumShiftV2Mock.Status.STOPPED) != uint8(I.Status.STOPPED),
            "this V2 renumbers STOPPED: test_enumOrdinalsArePinned and storage-layout.mjs reject it"
        );

        EnumShiftV2Mock p = _upgradeToEnumShift();
        assertEq(_recordWord0(id), before, "no stored byte moved: slot, offset and width are unchanged");
        assertEq(uint8(p.statusOf(id)), uint8(EnumShiftV2Mock.Status.HALTED), "why the pin exists");
        assertTrue(p.isLive(id), "why the pin exists: the stopped copy would be live again");
    }

    /// The V2's SymbolMode swaps ALLOW and DENY, which breaks the pins; had it been deployed, "never trade X" would
    /// read back as "trade only X".
    function test_audit_SEC01_symbolModeReorder_breaksThePins_andWouldTurnDenyIntoAllow() public {
        I.Terms memory t = _terms();
        t.symbolMode = I.SymbolMode.DENY;
        t.symbols = _symbols2();
        uint256 id = _subscribeAs(alice, C.VENUE_HYPERLIQUID, leader, ACCOUNT, t);
        bytes32 before = _recordWord0(id);
        assertTrue(
            uint8(EnumShiftV2Mock.SymbolMode.DENY) != uint8(I.SymbolMode.DENY),
            "this V2 renumbers DENY: test_enumOrdinalsArePinned and storage-layout.mjs reject it"
        );

        EnumShiftV2Mock p = _upgradeToEnumShift();
        assertEq(_recordWord0(id), before, "no stored byte moved");
        assertEq(uint8(p.symbolModeOf(id)), uint8(EnumShiftV2Mock.SymbolMode.ALLOW), "why the pin exists");
    }
}
