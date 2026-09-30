// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {IValuescanCopyTrading as I, CopyTradingConstants as C} from "../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingBase} from "../utils/CopyTradingBase.sol";

/// @notice The O(1) kill switch: stop epochs, effective status, records, and what it voids.
contract KillSwitchTest is CopyTradingBase {
    function test_unsubscribeAll_stopsEveryLiveSubscription_inO1() public {
        uint256 a1 = _subscribeAs(alice, leader);
        uint256 a2 = _subscribeAs(alice, leader2);
        uint256 b1 = _subscribeAs(bob, leader);
        vm.prank(alice);
        c.pauseSubscription(a2);
        uint256 a3 = _subscribeAs(alice, C.VENUE_HYPERLIQUID, leader, ACCOUNT, _terms());
        vm.prank(alice);
        c.unsubscribe(a3, true);

        vm.warp(T0 + 60);
        vm.expectEmit(address(c));
        emit I.KillSwitchTriggered(alice, 1, true);
        vm.prank(alice);
        uint64 epoch = c.unsubscribeAll(true);
        assertEq(epoch, 1);
        assertEq(c.stopEpochOf(alice), 1);
        assertEq(c.stopEpochOf(bob), 0);

        _assertStatus(a1, I.Status.STOPPED);
        _assertStatus(a2, I.Status.STOPPED);
        _assertStatus(a3, I.Status.STOPPED);
        _assertStatus(b1, I.Status.ACTIVE);
        assertFalse(c.isCopyable(a1));
        assertEq(uint8(c.getSubscription(a1).status), uint8(I.Status.STOPPED));
        // The records themselves were not written: versions are unchanged.
        assertEq(c.getSubscription(a1).version, 1);
        assertEq(c.getSubscription(a2).version, 2);

        I.KillSwitch memory k = c.killSwitchInfo(alice, 1);
        assertEq(k.triggeredAt, T0 + 60);
        assertTrue(k.closePositions);
        assertEq(c.killSwitchInfo(alice, 2).triggeredAt, 0);

        (I.StopReason reason, bool close, uint40 stoppedAt) = c.stopDetails(a1);
        assertEq(uint8(reason), uint8(I.StopReason.KILL_SWITCH));
        assertTrue(close);
        assertEq(stoppedAt, T0 + 60);
        // a3 was stopped by the follower before the kill switch: its own record wins.
        (reason, close, stoppedAt) = c.stopDetails(a3);
        assertEq(uint8(reason), uint8(I.StopReason.FOLLOWER));
        assertTrue(close);
        assertEq(stoppedAt, T0);

        (uint256[] memory ids, uint256 total) = c.liveSubscriptionsOfFollower(alice, 0, 10);
        assertEq(total, 0);
        assertEq(ids.length, 0);
        (, total) = c.subscriptionsOfFollower(alice, 0, 10);
        assertEq(total, 3);
        assertEq(c.liveSubscriptionFor(alice, ACCOUNT, C.VENUE_SODEX, leader), 0);
    }

    function test_unsubscribeAll_neverReverts_evenWithNothingLive_andWhilePaused() public {
        vm.prank(owner);
        c.pause();
        vm.startPrank(alice);
        assertEq(c.unsubscribeAll(false), 1);
        assertEq(c.unsubscribeAll(false), 2);
        vm.stopPrank();
        vm.prank(stranger);
        assertEq(c.unsubscribeAll(true), 1);
    }

    function test_killSwitchedSubscriptions_areTerminal() public {
        uint256 id = _subscribeAs(alice, leader);
        vm.prank(alice);
        c.unsubscribeAll(false);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidStatus.selector, id, I.Status.STOPPED));
        c.unsubscribe(id, true);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidStatus.selector, id, I.Status.STOPPED));
        c.pauseSubscription(id);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidStatus.selector, id, I.Status.STOPPED));
        c.resumeSubscription(id);
        vm.stopPrank();
    }

    function test_killSwitch_ofPausedSubscription_blocksResume() public {
        uint256 id = _subscribeAs(alice, leader);
        vm.prank(alice);
        c.pauseSubscription(id);
        vm.prank(alice);
        c.unsubscribeAll(false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidStatus.selector, id, I.Status.STOPPED));
        c.resumeSubscription(id);
    }

    function test_newSubscriptionsAfterKillSwitch_areLive_andSecondKillSwitchStopsThem() public {
        uint256 old = _subscribeAs(alice, leader);
        vm.prank(alice);
        c.unsubscribeAll(false);
        uint256 fresh = _subscribeAs(alice, leader);
        _assertStatus(fresh, I.Status.ACTIVE);
        assertEq(c.getSubscription(fresh).stopEpoch, 1);
        (uint256[] memory ids, uint256 total) = c.liveSubscriptionsOfFollower(alice, 0, 10);
        assertEq(total, 1);
        assertEq(ids[0], fresh);

        vm.warp(T0 + 9);
        vm.prank(alice);
        c.unsubscribeAll(false);
        _assertStatus(fresh, I.Status.STOPPED);
        _assertStatus(old, I.Status.STOPPED);
        // Each subscription reports the kill switch that stopped it.
        (, bool close, uint40 stoppedAt) = c.stopDetails(fresh);
        assertEq(stoppedAt, T0 + 9);
        assertFalse(close);
        (,, stoppedAt) = c.stopDetails(old);
        assertEq(stoppedAt, T0);
    }

    function test_gas_isIndependentOfTheNumberOfSubscriptions() public {
        for (uint64 i = 1; i <= 100; ++i) {
            _subscribeAs(alice, C.VENUE_SODEX, leader, i, _terms());
        }
        _subscribeAs(bob, leader);
        vm.prank(bob);
        c.unsubscribeAll(false);
        uint256 gasOne = vm.lastCallGas().gasTotalUsed;
        vm.prank(alice);
        c.unsubscribeAll(false);
        uint256 gasHundred = vm.lastCallGas().gasTotalUsed;
        assertEq(gasHundred, gasOne, "kill switch is O(1)");
        assertLt(gasHundred, 80_000);
    }
}
