// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IValuescanCopyTrading as I, CopyTradingConstants as C} from "../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingBase} from "../utils/CopyTradingBase.sol";

/// @notice Owner functions, the executor set and execution commitments.
contract GovernanceTest is CopyTradingBase {
    function _expectNotOwner(address who) internal {
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, who));
    }

    function test_ownerFunctions_revertForEveryoneElse() public {
        address[4] memory others = [stranger, executor, alice, relayer];
        for (uint256 i = 0; i < others.length; ++i) {
            address who = others[i];
            vm.startPrank(who);
            _expectNotOwner(who);
            c.setBuilderTerms(BUILDER_ID, 1, 1);
            _expectNotOwner(who);
            c.setVenue(3, true, "X");
            _expectNotOwner(who);
            c.setExecutor(who, true);
            _expectNotOwner(who);
            c.pause();
            _expectNotOwner(who);
            c.unpause();
            _expectNotOwner(who);
            c.upgradeToAndCall(address(impl), "");
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------------------------------------ builder terms

    function test_setBuilderTerms() public {
        vm.warp(T0 + 1);
        vm.expectEmit(address(c));
        emit I.BuilderTermsUpdated(7, C.PERPS_BUILDER_FEE_CAP, C.SPOT_BUILDER_FEE_CAP);
        vm.prank(owner);
        c.setBuilderTerms(7, C.PERPS_BUILDER_FEE_CAP, C.SPOT_BUILDER_FEE_CAP);
        I.BuilderTerms memory b = c.builderTerms();
        assertEq(b.builderId, 7);
        assertEq(b.perpsFee, C.PERPS_BUILDER_FEE_CAP);
        assertEq(b.spotFee, C.SPOT_BUILDER_FEE_CAP);
        assertEq(b.updatedAt, T0 + 1);

        vm.prank(owner);
        c.setBuilderTerms(7, 0, 0);
        assertEq(c.builderTerms().perpsFee, 0);
    }

    function test_setBuilderTerms_reverts() public {
        vm.startPrank(owner);
        vm.expectRevert(I.InvalidBuilderTerms.selector);
        c.setBuilderTerms(0, 0, 0);
        vm.expectRevert(I.InvalidBuilderTerms.selector);
        c.setBuilderTerms(1, C.PERPS_BUILDER_FEE_CAP + 1, 0);
        vm.expectRevert(I.InvalidBuilderTerms.selector);
        c.setBuilderTerms(1, 0, C.SPOT_BUILDER_FEE_CAP + 1);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------------ venues

    function test_setVenue() public {
        vm.expectEmit(address(c));
        emit I.VenueUpdated(9, true, "Binance");
        vm.prank(owner);
        c.setVenue(9, true, "Binance");
        I.Venue memory v = c.venueInfo(9);
        assertTrue(v.enabled);
        assertEq(v.name, "Binance");

        // Disabling only blocks new subscriptions; existing ones are untouched.
        uint256 id = _subscribeAs(alice, 9, leader, ACCOUNT, _terms());
        vm.prank(owner);
        c.setVenue(9, false, "Binance");
        assertTrue(c.isCopyable(id));
        vm.prank(alice);
        c.unsubscribe(id, false);
    }

    function test_setVenue_reverts() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidVenue.selector, uint8(0)));
        c.setVenue(0, true, "Zero");
        vm.expectRevert(abi.encodeWithSelector(I.InvalidVenue.selector, uint8(4)));
        c.setVenue(4, true, "");
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------------ pause

    function test_pauseUnpause() public {
        vm.prank(owner);
        c.pause();
        assertTrue(c.paused());
        vm.prank(owner);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        c.pause();
        vm.prank(owner);
        c.unpause();
        assertFalse(c.paused());
        vm.prank(owner);
        vm.expectRevert(PausableUpgradeable.ExpectedPause.selector);
        c.unpause();
    }

    // ------------------------------------------------------------------------------------------------ executors

    function test_setExecutor() public {
        address x = makeAddr("x");
        vm.warp(T0 + 3);
        vm.expectEmit(address(c));
        emit I.ExecutorSet(x, true);
        vm.prank(owner);
        c.setExecutor(x, true);
        assertTrue(c.isExecutor(x));
        I.Executor memory info = c.executorInfo(x);
        assertTrue(info.authorised);
        assertEq(info.updatedAt, T0 + 3);

        vm.prank(owner);
        c.setExecutor(x, true); // idempotent
        assertTrue(c.isExecutor(x));

        vm.prank(owner);
        c.setExecutor(x, false);
        assertFalse(c.isExecutor(x));
        assertFalse(c.executorInfo(x).authorised);

        vm.prank(owner);
        vm.expectRevert(I.InvalidExecutor.selector);
        c.setExecutor(address(0), true);
    }

    function test_commitExecutions() public {
        vm.warp(T0 + 3600);
        vm.expectEmit(address(c));
        emit I.ExecutionsCommitted(executor, 497_223, bytes32(uint256(1)), 12, "ipfs://root-1");
        vm.prank(executor);
        c.commitExecutions(497_223, bytes32(uint256(1)), 12, "ipfs://root-1");

        I.Commitment memory cm = c.commitment(executor, 497_223);
        assertEq(cm.merkleRoot, bytes32(uint256(1)));
        assertEq(cm.count, 12);
        assertEq(cm.committedAt, T0 + 3600);
        assertEq(c.executorInfo(executor).lastEpoch, 497_223);
        assertEq(c.commitment(executor, 497_222).committedAt, 0);

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(I.EpochNotIncreasing.selector, uint64(497_223), uint64(497_223)));
        c.commitExecutions(497_223, bytes32(uint256(2)), 1, "");
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(I.EpochNotIncreasing.selector, uint64(497_223), uint64(1)));
        c.commitExecutions(1, bytes32(uint256(2)), 1, "");
        vm.prank(executor);
        c.commitExecutions(497_300, bytes32(0), 0, "");
    }

    function test_commitExecutions_onlyAuthorised_evenWhilePaused() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(I.NotExecutor.selector, stranger));
        c.commitExecutions(1, bytes32(0), 0, "");
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(I.NotExecutor.selector, owner));
        c.commitExecutions(1, bytes32(0), 0, "");

        vm.prank(owner);
        c.pause();
        vm.prank(executor);
        c.commitExecutions(5, bytes32(uint256(5)), 5, "u");

        // De-authorising keeps the record and the last epoch; commitments stay immutable.
        vm.prank(owner);
        c.setExecutor(executor, false);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(I.NotExecutor.selector, executor));
        c.commitExecutions(6, bytes32(0), 0, "");
        assertEq(c.executorInfo(executor).lastEpoch, 5);
        assertEq(c.commitment(executor, 5).merkleRoot, bytes32(uint256(5)));

        // Re-authorised, it continues above its last epoch.
        vm.prank(owner);
        c.setExecutor(executor, true);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(I.EpochNotIncreasing.selector, uint64(5), uint64(5)));
        c.commitExecutions(5, bytes32(0), 0, "");
    }

    function test_executorsAndOwner_cannotTouchSubscriptions() public {
        uint256 id = _subscribeAs(alice, leader);
        address[2] memory privileged = [owner, executor];
        for (uint256 i = 0; i < 2; ++i) {
            address who = privileged[i];
            vm.startPrank(who);
            vm.expectRevert(abi.encodeWithSelector(I.NotFollower.selector, id, who));
            c.pauseSubscription(id);
            vm.expectRevert(abi.encodeWithSelector(I.NotFollower.selector, id, who));
            c.unsubscribe(id, true);
            vm.expectRevert(abi.encodeWithSelector(I.NotFollower.selector, id, who));
            c.updateSubscription(id, _terms());
            // Their kill switch is their own and touches nobody else.
            c.unsubscribeAll(true);
            vm.stopPrank();
        }
        _assertStatus(id, I.Status.ACTIVE);
        assertEq(c.stopEpochOf(alice), 0);
    }
}
