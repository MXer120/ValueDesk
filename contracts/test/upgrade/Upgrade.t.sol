// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Vm} from "forge-std/Vm.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IERC5267} from "@openzeppelin/contracts/interfaces/IERC5267.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ValuescanCopyTrading} from "../../src/ValuescanCopyTrading.sol";
import {IValuescanCopyTrading as I, CopyTradingConstants as C} from "../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingBase} from "../utils/CopyTradingBase.sol";
import {CopyTradingEIP712 as E} from "../utils/CopyTradingEIP712.sol";
import {ValuescanCopyTradingV2Mock, ValuescanCopyTradingDomainBumpMock, NotUUPSMock} from "../mocks/Mocks.sol";

/// @notice UUPS upgrades: V1 through ERC1967Proxy, upgrade to a V2 that adds a field and keeps all state, access
///         control, re-initialisation, signatures across upgrades, a deliberate domain bump, and the recommended
///         TimelockController (48 h) wiring.
contract UpgradeTest is CopyTradingBase {
    ValuescanCopyTradingV2Mock internal v2;
    uint256 internal deadline;
    address internal executor2 = makeAddr("executor2");

    // Ids created by _richState.
    uint256 internal sActive;
    uint256 internal sPaused;
    uint256 internal sStopped;
    uint256 internal sKilled;
    uint256 internal sBob;

    function setUp() public override {
        super.setUp();
        v2 = new ValuescanCopyTradingV2Mock();
        deadline = T0 + 30 days;
    }

    /// @dev Every kind of state the contract holds.
    function _richState() internal {
        sKilled = _subscribeAs(alice, leader2);
        vm.prank(alice);
        c.unsubscribeAll(true); // epoch 1: sKilled STOPPED by kill switch
        sActive = _subscribeAs(alice, leader);
        sPaused = _subscribeAs(alice, C.VENUE_HYPERLIQUID, leader, ACCOUNT, _termsAllow());
        vm.prank(alice);
        c.pauseSubscription(sPaused);
        sStopped = _subscribeAs(alice, C.VENUE_SODEX, leader, ACCOUNT + 1, _terms());
        vm.prank(alice);
        c.unsubscribe(sStopped, false);
        sBob = _subscribeAs(bob, leader);
        vm.prank(bob);
        c.invalidateNonces(0, 0xf0);
        vm.prank(relayer);
        c.pauseSubscriptionWithSig(sBob, _pauseSig(bobKey, bob, sBob, 1, deadline));
        vm.startPrank(owner);
        c.setBuilderTerms(BUILDER_ID + 1, 60, 70);
        c.setVenue(7, true, "Venue7");
        c.setExecutor(executor2, true);
        c.setExecutor(executor2, false);
        vm.stopPrank();
        vm.prank(executor);
        c.commitExecutions(123, bytes32(uint256(0xbeef)), 9, "ipfs://c");
    }

    /// @dev A digest of everything observable through the views.
    function _stateDigest() internal view returns (bytes32 h) {
        uint256 n = c.subscriptionCount();
        h = keccak256(abi.encode(n, c.owner(), c.pendingOwner(), c.paused(), c.DOMAIN_SEPARATOR()));
        for (uint256 id = 1; id <= n; ++id) {
            h = keccak256(abi.encode(h, c.getSubscription(id), c.statusOf(id), c.isCopyable(id)));
            (uint64 builderId, uint16 perps, uint16 spot) = c.effectiveBuilderFee(id);
            h = keccak256(abi.encode(h, builderId, perps, spot));
            if (c.statusOf(id) == I.Status.STOPPED) {
                (I.StopReason reason, bool close, uint40 stoppedAt) = c.stopDetails(id);
                h = keccak256(abi.encode(h, reason, close, stoppedAt));
            }
        }
        address[2] memory fs = [alice, bob];
        for (uint256 i = 0; i < 2; ++i) {
            (uint256[] memory all, uint256 total) = c.subscriptionsOfFollower(fs[i], 0, 100);
            (uint256[] memory live, uint256 liveTotal) = c.liveSubscriptionsOfFollower(fs[i], 0, 100);
            h = keccak256(abi.encode(h, all, total, live, liveTotal, c.stopEpochOf(fs[i])));
            h = keccak256(abi.encode(h, c.killSwitchInfo(fs[i], 1), c.nonceBitmap(fs[i], 0)));
        }
        (uint256[] memory l1,) = c.subscriptionsOfLeader(C.VENUE_SODEX, leader, 0, 100);
        (uint256[] memory l2,) = c.subscriptionsOfLeader(C.VENUE_HYPERLIQUID, leader, 0, 100);
        h = keccak256(abi.encode(h, l1, l2, c.liveSubscriptionFor(alice, ACCOUNT, C.VENUE_SODEX, leader)));
        h = keccak256(abi.encode(h, c.builderTerms(), c.venueInfo(1), c.venueInfo(2), c.venueInfo(7)));
        h = keccak256(abi.encode(h, c.executorInfo(executor), c.executorInfo(executor2)));
        h = keccak256(abi.encode(h, c.commitment(executor, 123)));
    }

    // ------------------------------------------------------------------------------------------------ proxy basics

    function test_proxiableUUID_onlyOnImplementation() public {
        assertEq(impl.proxiableUUID(), ERC1967Utils.IMPLEMENTATION_SLOT);
        vm.expectRevert(UUPSUpgradeable.UUPSUnauthorizedCallContext.selector);
        c.proxiableUUID();
    }

    function test_implementation_cannotBeUpgradedOrUsed() public {
        vm.prank(owner);
        vm.expectRevert(UUPSUpgradeable.UUPSUnauthorizedCallContext.selector);
        impl.upgradeToAndCall(address(v2), "");
        // Never initialised: no venue is enabled, so nothing can be subscribed on the bare implementation.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(I.VenueDisabled.selector, C.VENUE_SODEX));
        impl.subscribe(C.VENUE_SODEX, leader, ACCOUNT, _terms());
    }

    // ------------------------------------------------------------------------------------------------ upgrade

    function test_upgradeToV2_keepsAllState_andAddsAField() public {
        _richState();
        vm.prank(owner);
        c.pause();
        vm.prank(owner);
        c.transferOwnership(stranger); // a pending owner survives too
        bytes32 before = _stateDigest();

        vm.recordLogs();
        vm.prank(owner);
        c.upgradeToAndCall(address(v2), abi.encodeCall(v2.initializeV2, (42)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs[0].topics[0], keccak256("Upgraded(address)"));
        assertEq(address(uint160(uint256(logs[0].topics[1]))), address(v2));
        assertEq(logs[1].topics[0], ValuescanCopyTradingV2Mock.NewFieldSet.selector);
        assertEq(logs[2].topics[0], keccak256("Initialized(uint64)"));
        assertEq(logs[2].data, abi.encode(uint64(2)));

        assertEq(address(uint160(uint256(vm.load(address(c), ERC1967Utils.IMPLEMENTATION_SLOT)))), address(v2));
        ValuescanCopyTradingV2Mock p = ValuescanCopyTradingV2Mock(address(c));
        assertEq(p.VERSION(), "2.0.0-mock");
        assertEq(p.newField(), 42);
        assertEq(_stateDigest(), before, "state changed across the upgrade");

        // Everything keeps working on V2.
        vm.prank(alice);
        c.unsubscribe(sActive, true);
        vm.prank(owner);
        c.unpause();
        vm.prank(alice);
        c.resumeSubscription(sPaused);
        _subscribeAs(bob, leader2);
        assertEq(c.subscriptionCount(), 6);
    }

    function test_upgrade_withoutCall() public {
        vm.prank(owner);
        c.upgradeToAndCall(address(v2), "");
        assertEq(ValuescanCopyTradingV2Mock(address(c)).newField(), 0);
        assertEq(c.VERSION(), "2.0.0-mock");
    }

    function test_upgrade_onlyOwner() public {
        _richState();
        address[5] memory others = [stranger, executor, alice, relayer, address(impl)];
        for (uint256 i = 0; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, others[i]));
            c.upgradeToAndCall(address(v2), "");
        }
        // A pending owner is not the owner yet.
        vm.prank(owner);
        c.transferOwnership(stranger);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger));
        c.upgradeToAndCall(address(v2), "");
        assertEq(address(uint160(uint256(vm.load(address(c), ERC1967Utils.IMPLEMENTATION_SLOT)))), address(impl));
    }

    function test_upgrade_rejectsNonUupsTargets() public {
        NotUUPSMock notUups = new NotUUPSMock();
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(ERC1967Utils.ERC1967InvalidImplementation.selector, address(notUups)));
        c.upgradeToAndCall(address(notUups), "");
        vm.expectRevert(); // no code at all: Solidity's extcodesize check reverts before the try/catch
        c.upgradeToAndCall(stranger, "");
        vm.stopPrank();
    }

    function test_reinitialisation_isImpossible() public {
        vm.prank(owner);
        c.upgradeToAndCall(address(v2), abi.encodeCall(v2.initializeV2, (1)));
        ValuescanCopyTradingV2Mock p = ValuescanCopyTradingV2Mock(address(c));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        p.initializeV2(2);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        p.initialize(stranger, 1, 0, 0, new address[](0));
        // Neither implementation can be initialised either.
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        v2.initializeV2(3);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        v2.initialize(stranger, 1, 0, 0, new address[](0));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(stranger, 1, 0, 0, new address[](0));
        assertEq(c.owner(), owner);
    }

    function test_v2FitsEip170() public {
        _skipUnderCoverage();
        assertLt(address(v2).code.length, 24_576);
    }

    // ------------------------------------------------------------------------------------------------ signatures

    function test_signaturesStayValid_acrossAnUpgradeThatKeepsTheDomain() public {
        uint256 id = _subscribeAs(alice, leader);
        I.SignatureParams memory stop = _unsubscribeSig(aliceKey, alice, id, true, 1, deadline);
        I.Terms memory t = _terms();
        I.SignatureParams memory sub =
            _subscribeSig(aliceKey, alice, C.VENUE_SODEX, leader2, ACCOUNT, t, 0, 2, deadline);
        I.SignatureParams memory emergency = _unsubscribeAllSig(aliceKey, alice, false, 3, deadline);
        bytes32 domainBefore = c.DOMAIN_SEPARATOR();

        vm.prank(owner);
        c.upgradeToAndCall(address(v2), abi.encodeCall(v2.initializeV2, (1)));
        assertEq(c.DOMAIN_SEPARATOR(), domainBefore);

        vm.startPrank(relayer);
        c.unsubscribeWithSig(id, true, stop);
        c.subscribeWithSig(
            alice, C.VENUE_SODEX, leader2, ACCOUNT, t, 0, _lastId(alice, ACCOUNT, C.VENUE_SODEX, leader2), sub
        );
        c.unsubscribeAllWithSig(alice, false, emergency);
        vm.stopPrank();
        assertEq(c.stopEpochOf(alice), 1);
    }

    function test_domainBump_invalidatesOutstandingSignatures() public {
        uint256 id = _subscribeAs(alice, leader);
        I.SignatureParams memory stop = _unsubscribeSig(aliceKey, alice, id, true, 1, deadline);
        ValuescanCopyTradingDomainBumpMock bump = new ValuescanCopyTradingDomainBumpMock();

        vm.expectEmit(address(c));
        emit IERC5267.EIP712DomainChanged();
        vm.prank(owner);
        c.upgradeToAndCall(address(bump), abi.encodeCall(bump.initializeDomainBump, ()));
        (, string memory name, string memory version,,,,) = c.eip712Domain();
        assertEq(name, C.EIP712_NAME);
        assertEq(version, "2");
        assertEq(c.DOMAIN_SEPARATOR(), E.domainSeparator(C.EIP712_NAME, "2", CHAIN_ID, address(c)));

        // The pre-signed stop no longer works...
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.unsubscribeWithSig(id, true, stop);
        // ...but a new one for the new domain does, and the direct stop always does.
        bytes32 digest = E.digest(
            E.domainSeparator(C.EIP712_NAME, "2", CHAIN_ID, address(c)), E.unsubscribeHash(alice, id, true, 1, deadline)
        );
        vm.prank(relayer);
        c.unsubscribeWithSig(id, true, I.SignatureParams(1, deadline, _signDigest(aliceKey, digest)));
        _assertStatus(id, I.Status.STOPPED);
    }

    // ------------------------------------------------------------------------------------------------ timelock

    /// @dev The recommended governance: a TimelockController with a 48 h delay owns the proxy; a multisig is its only
    ///      proposer and executor. Followers see a scheduled upgrade (CallScheduled event) 48 h before it can run
    ///      and can stop copying (or revoke their SoDEX key) in that window.
    function test_upgrade_throughTimelock_withA48hDelay() public {
        address multisig = makeAddr("multisig (Safe)");
        address[] memory roles = _one(multisig);
        TimelockController timelock = new TimelockController(48 hours, roles, roles, address(0));

        // Hand ownership to the timelock (two steps; the timelock accepts through its own delay).
        vm.prank(owner);
        c.transferOwnership(address(timelock));
        bytes memory accept = abi.encodeCall(c.acceptOwnership, ());
        vm.prank(multisig);
        timelock.schedule(address(c), 0, accept, bytes32(0), bytes32("accept"), 48 hours);
        vm.warp(T0 + 48 hours); // (via-IR: never re-read block.timestamp after a warp; use constants)
        vm.prank(multisig);
        timelock.execute(address(c), 0, accept, bytes32(0), bytes32("accept"));
        assertEq(c.owner(), address(timelock));

        uint256 id = _subscribeAs(alice, leader);
        bytes memory upgrade = abi.encodeCall(c.upgradeToAndCall, (address(v2), abi.encodeCall(v2.initializeV2, (7))));
        vm.prank(multisig);
        timelock.schedule(address(c), 0, upgrade, bytes32(0), bytes32("v2"), 48 hours);
        bytes32 opId = timelock.hashOperation(address(c), 0, upgrade, bytes32(0), bytes32("v2"));
        assertTrue(timelock.isOperationPending(opId));

        // The multisig alone cannot skip the delay, and the multisig cannot upgrade directly.
        vm.warp(T0 + 96 hours - 1);
        vm.prank(multisig);
        vm.expectRevert();
        timelock.execute(address(c), 0, upgrade, bytes32(0), bytes32("v2"));
        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, multisig));
        c.upgradeToAndCall(address(v2), "");

        // During the window the follower reacts.
        vm.prank(alice);
        c.unsubscribe(id, true);

        vm.warp(T0 + 96 hours);
        vm.prank(multisig);
        timelock.execute(address(c), 0, upgrade, bytes32(0), bytes32("v2"));
        assertEq(c.VERSION(), "2.0.0-mock");
        assertEq(ValuescanCopyTradingV2Mock(address(c)).newField(), 7);
        _assertStatus(id, I.Status.STOPPED);
    }
}
