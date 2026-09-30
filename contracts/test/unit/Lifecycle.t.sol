// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IValuescanCopyTrading as I, CopyTradingConstants as C} from "../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingBase} from "../utils/CopyTradingBase.sol";
import {CopyTradingEIP712 as E} from "../utils/CopyTradingEIP712.sol";

/// @notice update, pause, resume, unsubscribe (direct calls), and the subscription views.
contract LifecycleTest is CopyTradingBase {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        id = _subscribeAs(alice, leader);
    }

    // ------------------------------------------------------------------------------------------------ update

    function test_update_replacesTermsKeepsTargetAndStatus() public {
        vm.warp(T0 + 100);
        I.Terms memory t = _termsAllow();
        t.marketScope = I.MarketScope.PERPS_AND_SPOT;
        t.sizingMode = I.SizingMode.FIXED_NOTIONAL;
        t.sizingValue = 100_000_000;
        t.delegatedKey = makeAddr("newKey");
        t.keyName = "vs-new";
        t.expiry = uint40(T0 + 7 days);
        t.maxBuilderFeePerps = 0;

        I.Subscription memory before = c.getSubscription(id);
        I.Subscription memory expected = before;
        expected.marketScope = t.marketScope;
        expected.sizingMode = t.sizingMode;
        expected.symbolMode = t.symbolMode;
        expected.sizingValue = t.sizingValue;
        expected.delegatedKey = t.delegatedKey;
        expected.keyName = t.keyName;
        expected.expiry = t.expiry;
        expected.maxBuilderFeePerps = 0;
        expected.symbolsHash = E.hashStrings(t.symbols);
        expected.version = 2;
        expected.updatedAt = uint40(T0 + 100);

        vm.expectEmit(address(c));
        emit I.SubscriptionUpdated(id, alice, expected, t.symbols);
        vm.prank(alice);
        c.updateSubscription(id, t);

        I.Subscription memory s = c.getSubscription(id);
        assertEq(keccak256(abi.encode(s)), keccak256(abi.encode(expected)));
        assertEq(s.createdAt, before.createdAt);
        assertEq(s.leader, leader);
        assertEq(s.sodexAccountId, ACCOUNT);
    }

    function test_update_keepsPausedStatus() public {
        vm.prank(alice);
        c.pauseSubscription(id);
        vm.prank(alice);
        c.updateSubscription(id, _terms());
        _assertStatus(id, I.Status.PAUSED);
        assertEq(c.getSubscription(id).version, 3);
    }

    function test_update_renewsExpired() public {
        I.Terms memory t = _terms();
        t.expiry = uint40(T0 + 1 days);
        vm.prank(alice);
        c.updateSubscription(id, t);
        vm.warp(T0 + 1 days);
        assertFalse(c.isCopyable(id));
        _assertStatus(id, I.Status.ACTIVE);
        t.expiry = uint40(T0 + 2 days);
        vm.prank(alice);
        c.updateSubscription(id, t);
        assertTrue(c.isCopyable(id));
    }

    function test_update_ignoresVenueEnablement() public {
        vm.prank(owner);
        c.setVenue(C.VENUE_SODEX, false, "SoDEX");
        vm.prank(alice);
        c.updateSubscription(id, _terms());
    }

    function test_update_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(I.UnknownSubscription.selector, 99));
        c.updateSubscription(99, _terms());

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(I.NotFollower.selector, id, bob));
        c.updateSubscription(id, _terms());

        I.Terms memory bad = _terms();
        bad.slippageBps = 0;
        vm.prank(alice);
        _expectInvalidTerms(I.TermsField.SLIPPAGE);
        c.updateSubscription(id, bad);

        vm.prank(owner);
        c.pause();
        vm.prank(alice);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        c.updateSubscription(id, _terms());
        vm.prank(owner);
        c.unpause();

        vm.prank(alice);
        c.unsubscribe(id, false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidStatus.selector, id, I.Status.STOPPED));
        c.updateSubscription(id, _terms());
    }

    function test_update_revertsAfterKillSwitch() public {
        vm.prank(alice);
        c.unsubscribeAll(false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidStatus.selector, id, I.Status.STOPPED));
        c.updateSubscription(id, _terms());
    }

    // ------------------------------------------------------------------------------------------------ pause/resume

    function test_pauseResume() public {
        vm.warp(T0 + 10);
        vm.expectEmit(address(c));
        emit I.SubscriptionPaused(id, alice, 2, uint40(T0 + 10));
        vm.prank(alice);
        c.pauseSubscription(id);
        _assertStatus(id, I.Status.PAUSED);
        assertFalse(c.isCopyable(id));
        assertEq(c.liveSubscriptionFor(alice, ACCOUNT, C.VENUE_SODEX, leader), id);

        vm.warp(T0 + 20);
        vm.expectEmit(address(c));
        emit I.SubscriptionResumed(id, alice, 3, uint40(T0 + 20));
        vm.prank(alice);
        c.resumeSubscription(id);
        _assertStatus(id, I.Status.ACTIVE);
        assertTrue(c.isCopyable(id));
        assertEq(c.getSubscription(id).updatedAt, T0 + 20);
    }

    function test_pause_reverts() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(I.NotFollower.selector, id, bob));
        c.pauseSubscription(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(I.UnknownSubscription.selector, 7));
        c.pauseSubscription(7);

        vm.prank(alice);
        c.pauseSubscription(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidStatus.selector, id, I.Status.PAUSED));
        c.pauseSubscription(id);
    }

    function test_pause_worksWhileContractPaused() public {
        vm.prank(owner);
        c.pause();
        vm.prank(alice);
        c.pauseSubscription(id);
        _assertStatus(id, I.Status.PAUSED);
    }

    function test_resume_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidStatus.selector, id, I.Status.ACTIVE));
        c.resumeSubscription(id);

        vm.prank(alice);
        c.pauseSubscription(id);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(I.NotFollower.selector, id, bob));
        c.resumeSubscription(id);

        vm.prank(owner);
        c.pause();
        vm.prank(alice);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        c.resumeSubscription(id);
    }

    function test_resume_revertsWhenExpired_thenRenew() public {
        I.Terms memory t = _terms();
        t.expiry = uint40(T0 + 1 days);
        vm.prank(alice);
        c.updateSubscription(id, t);
        vm.prank(alice);
        c.pauseSubscription(id);
        vm.warp(T0 + 1 days);
        vm.prank(alice);
        _expectInvalidTerms(I.TermsField.EXPIRY);
        c.resumeSubscription(id);

        t.expiry = 0;
        vm.prank(alice);
        c.updateSubscription(id, t);
        vm.prank(alice);
        c.resumeSubscription(id);
        assertTrue(c.isCopyable(id));
    }

    // ------------------------------------------------------------------------------------------------ unsubscribe

    function test_unsubscribe() public {
        vm.warp(T0 + 5);
        vm.expectEmit(address(c));
        emit I.SubscriptionStopped(id, alice, true, 2, uint40(T0 + 5));
        vm.prank(alice);
        c.unsubscribe(id, true);

        I.Subscription memory s = c.getSubscription(id);
        assertEq(uint8(s.status), uint8(I.Status.STOPPED));
        assertTrue(s.closePositions);
        assertEq(s.version, 2);
        assertFalse(c.isCopyable(id));
        assertEq(c.liveSubscriptionFor(alice, ACCOUNT, C.VENUE_SODEX, leader), 0);
        (, uint256 live) = c.liveSubscriptionsOfFollower(alice, 0, 10);
        assertEq(live, 0);
        (, uint256 all) = c.subscriptionsOfFollower(alice, 0, 10);
        assertEq(all, 1);

        (I.StopReason reason, bool close, uint40 stoppedAt) = c.stopDetails(id);
        assertEq(uint8(reason), uint8(I.StopReason.FOLLOWER));
        assertTrue(close);
        assertEq(stoppedAt, T0 + 5);
    }

    function test_unsubscribe_fromPaused_andWhileContractPaused() public {
        vm.prank(alice);
        c.pauseSubscription(id);
        vm.prank(owner);
        c.pause();
        vm.prank(alice);
        c.unsubscribe(id, false);
        _assertStatus(id, I.Status.STOPPED);
    }

    function test_unsubscribe_reverts() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(I.NotFollower.selector, id, bob));
        c.unsubscribe(id, false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(I.UnknownSubscription.selector, 0));
        c.unsubscribe(0, false);
        vm.prank(alice);
        c.unsubscribe(id, false);
        // STOPPED is terminal.
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidStatus.selector, id, I.Status.STOPPED));
        c.unsubscribe(id, true);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidStatus.selector, id, I.Status.STOPPED));
        c.pauseSubscription(id);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidStatus.selector, id, I.Status.STOPPED));
        c.resumeSubscription(id);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------------ views

    function test_views_unknownIds() public {
        assertEq(uint8(c.statusOf(0)), uint8(I.Status.NONE));
        assertEq(uint8(c.statusOf(42)), uint8(I.Status.NONE));
        assertFalse(c.isCopyable(42));
        vm.expectRevert(abi.encodeWithSelector(I.UnknownSubscription.selector, 42));
        c.getSubscription(42);
        vm.expectRevert(abi.encodeWithSelector(I.UnknownSubscription.selector, 42));
        c.effectiveBuilderFee(42);
        vm.expectRevert(abi.encodeWithSelector(I.UnknownSubscription.selector, 42));
        c.stopDetails(42);
    }

    function test_stopDetails_revertsForLiveSubscription() public {
        vm.expectRevert(abi.encodeWithSelector(I.InvalidStatus.selector, id, I.Status.ACTIVE));
        c.stopDetails(id);
        vm.prank(alice);
        c.pauseSubscription(id);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidStatus.selector, id, I.Status.PAUSED));
        c.stopDetails(id);
    }

    function test_effectiveBuilderFee_isMinOfCurrentAndConsent() public {
        (uint64 builderId, uint16 perps, uint16 spot) = c.effectiveBuilderFee(id);
        assertEq(builderId, BUILDER_ID);
        assertEq(perps, 50); // min(50, 50)
        assertEq(spot, 100); // min(100, 100)

        vm.prank(owner);
        c.setBuilderTerms(BUILDER_ID + 1, C.PERPS_BUILDER_FEE_CAP, C.SPOT_BUILDER_FEE_CAP);
        (builderId, perps, spot) = c.effectiveBuilderFee(id);
        assertEq(builderId, BUILDER_ID + 1);
        assertEq(perps, 50); // raising the fee never raises consent
        assertEq(spot, 100);

        vm.prank(owner);
        c.setBuilderTerms(BUILDER_ID, 10, 0);
        (, perps, spot) = c.effectiveBuilderFee(id);
        assertEq(perps, 10); // lowering applies at once
        assertEq(spot, 0);
    }

    function test_isCopyable_ignoresContractPauseAndVenue() public {
        vm.startPrank(owner);
        c.pause();
        c.setVenue(C.VENUE_SODEX, false, "SoDEX");
        vm.stopPrank();
        assertTrue(c.isCopyable(id));
    }

    function test_isCopyable_expiryBoundary() public {
        I.Terms memory t = _terms();
        t.expiry = uint40(T0 + 100);
        vm.prank(alice);
        c.updateSubscription(id, t);
        vm.warp(T0 + 99);
        assertTrue(c.isCopyable(id));
        vm.warp(T0 + 100);
        assertFalse(c.isCopyable(id));
    }

    function test_pagination() public {
        for (uint64 i = 1; i <= 4; ++i) {
            _subscribeAs(alice, C.VENUE_SODEX, leader, ACCOUNT + i, _terms());
        } // ids 2..5
        (uint256[] memory ids, uint256 total) = c.subscriptionsOfFollower(alice, 1, 2);
        assertEq(total, 5);
        assertEq(ids.length, 2);
        assertEq(ids[0], 2);
        assertEq(ids[1], 3);
        (ids, total) = c.subscriptionsOfFollower(alice, 3, type(uint256).max);
        assertEq(ids.length, 2);
        assertEq(ids[1], 5);
        (ids, total) = c.subscriptionsOfFollower(alice, 5, 1);
        assertEq(ids.length, 0);
        assertEq(total, 5);
        (ids,) = c.subscriptionsOfFollower(alice, type(uint256).max, type(uint256).max);
        assertEq(ids.length, 0);
        (ids,) = c.subscriptionsOfFollower(alice, 0, 0);
        assertEq(ids.length, 0);

        (ids, total) = c.subscriptionsOfLeader(C.VENUE_SODEX, leader, 4, 10);
        assertEq(total, 5);
        assertEq(ids.length, 1);
        assertEq(ids[0], 5);

        vm.prank(alice);
        c.unsubscribe(2, false); // swap-and-pop: the last live id moves into the gap
        (ids, total) = c.liveSubscriptionsOfFollower(alice, 0, 10);
        assertEq(total, 4);
        assertEq(ids.length, 4);
        (ids, total) = c.liveSubscriptionsOfFollower(alice, 3, 10);
        assertEq(ids.length, 1);
        (ids,) = c.liveSubscriptionsOfFollower(alice, 4, 10);
        assertEq(ids.length, 0);
        (ids,) = c.liveSubscriptionsOfFollower(alice, 1, type(uint256).max);
        assertEq(ids.length, 3);
    }
}
