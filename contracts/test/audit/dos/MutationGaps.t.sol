// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Vm} from "forge-std/Vm.sol";
import {IValuescanCopyTrading as I, CopyTradingConstants as C} from "../../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingBase} from "../../utils/CopyTradingBase.sol";

/// @notice AUDIT (test quality): behaviour that no existing test pins, found by mutation testing a scratch copy of
///         src/ValuescanCopyTrading.sol (the real file was never modified). Each test names the mutants that survive
///         the existing non-invariant suite and that this test kills. Details and the mutation table: the audit report.
contract MutationGapsTest is CopyTradingBase {
    uint256 internal constant DEADLINE = T0 + 2 days;

    // ------------------------------------------------------------------------------------------------ views

    /// Kills M07 (`liveSubscriptionsOfFollower` returns the page at offset 0 for every offset). The executor's hourly
    /// reconciliation pages through this view; the suite only ever checked page LENGTHS at offsets > 0.
    function test_livePage_contentsAtEveryOffset() public {
        uint256[] memory ids = new uint256[](6);
        for (uint64 i = 0; i < 6; ++i) {
            ids[i] = _subscribeAs(alice, C.VENUE_SODEX, leader, ACCOUNT + i, _terms());
        }
        vm.prank(alice);
        c.unsubscribe(ids[1], false); // swap-and-pop reorders the set
        (uint256[] memory all, uint256 total) = c.liveSubscriptionsOfFollower(alice, 0, type(uint256).max);
        assertEq(total, 5);
        uint256 seen;
        for (uint256 off = 0; off < total; ++off) {
            (uint256[] memory page,) = c.liveSubscriptionsOfFollower(alice, off, 2);
            assertEq(page[0], all[off], "wrong id at this offset");
            if (off + 1 < total) assertEq(page[1], all[off + 1], "wrong second id at this offset");
            seen |= 1 << page[0];
        }
        assertEq(
            seen, (1 << ids[0]) | (1 << ids[2]) | (1 << ids[3]) | (1 << ids[4]) | (1 << ids[5]), "not the live set"
        );
    }

    // ------------------------------------------------------------------------------------------------ signed paths: follower, not msg.sender

    /// Kills M09 (self-copy check compares the leader with msg.sender instead of the follower). The self-copy rule was
    /// only tested on the direct path, where msg.sender == follower.
    function test_signedSubscribe_selfCopyOnSodex_isRejected() public {
        I.Terms memory t = _terms();
        I.SignatureParams memory sig = _subscribeSig(aliceKey, alice, C.VENUE_SODEX, alice, ACCOUNT, t, 0, 1, DEADLINE);
        vm.prank(relayer);
        _expectInvalidTerms(I.TermsField.LEADER);
        c.subscribeWithSig(
            alice, C.VENUE_SODEX, alice, ACCOUNT, t, 0, _lastId(alice, ACCOUNT, C.VENUE_SODEX, alice), sig
        );
        // Allowed from Hyperliquid, as on the direct path.
        sig = _subscribeSig(aliceKey, alice, C.VENUE_HYPERLIQUID, alice, ACCOUNT, t, 0, 2, DEADLINE);
        vm.prank(relayer);
        c.subscribeWithSig(
            alice, C.VENUE_HYPERLIQUID, alice, ACCOUNT, t, 0, _lastId(alice, ACCOUNT, C.VENUE_HYPERLIQUID, alice), sig
        );
    }

    /// Kills M10 and M10b (the master-key check compares the delegated key with msg.sender instead of the follower).
    /// "The follower's master key is never delegated" was only tested on the direct path.
    function test_signedPaths_rejectTheMasterKeyAsDelegatedKey() public {
        I.Terms memory t = _terms();
        t.delegatedKey = alice;
        I.SignatureParams memory sig = _subscribeSig(aliceKey, alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, 1, DEADLINE);
        vm.prank(relayer);
        _expectInvalidTerms(I.TermsField.DELEGATED_KEY);
        c.subscribeWithSig(
            alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, _lastId(alice, ACCOUNT, C.VENUE_SODEX, leader), sig
        );

        uint256 id = _subscribeAs(alice, leader);
        vm.prank(relayer);
        _expectInvalidTerms(I.TermsField.DELEGATED_KEY);
        c.updateSubscriptionWithSig(id, 1, t, _updateSig(aliceKey, alice, id, 1, t, 2, DEADLINE));
    }

    /// Kills M25 (subscribeWithSig runs the target/terms/uniqueness checks for msg.sender): a signed duplicate.
    function test_signedSubscribe_liveDuplicateIsRejected() public {
        uint256 id = _subscribeAs(alice, leader);
        I.Terms memory t = _terms();
        I.SignatureParams memory sig = _subscribeSig(aliceKey, alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, 1, DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.DuplicateSubscription.selector, id));
        c.subscribeWithSig(
            alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, _lastId(alice, ACCOUNT, C.VENUE_SODEX, leader), sig
        );
    }

    // ------------------------------------------------------------------------------------------------ signed paths: status guards

    /// Kills M20 (pauseSubscriptionWithSig without its ACTIVE check).
    function test_signedPause_ofAPausedSubscription_isRejected() public {
        uint256 id = _subscribeAs(alice, leader);
        vm.prank(alice);
        c.pauseSubscription(id);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidStatus.selector, id, I.Status.PAUSED));
        c.pauseSubscriptionWithSig(id, _pauseSig(aliceKey, alice, id, 1, DEADLINE));
    }

    /// Kills M21 (unsubscribeWithSig without its live check). Without the check, a signed Unsubscribe of an old,
    /// kill-switched subscription deletes the uniqueness key of the follower's NEW live subscription with the same
    /// (account, venue, leader), and a second live copy of the same leader can then be created: double exposure.
    function test_signedUnsubscribe_ofAKilledSubscription_cannotFreeItsSuccessorsKey() public {
        uint256 old = _subscribeAs(alice, leader);
        vm.prank(alice);
        c.unsubscribeAll(false);
        uint256 fresh = _subscribeAs(alice, leader);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidStatus.selector, old, I.Status.STOPPED));
        c.unsubscribeWithSig(old, false, _unsubscribeSig(aliceKey, alice, old, false, 1, DEADLINE));
        assertEq(c.liveSubscriptionFor(alice, ACCOUNT, C.VENUE_SODEX, leader), fresh);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(I.DuplicateSubscription.selector, fresh));
        c.subscribe(C.VENUE_SODEX, leader, ACCOUNT, _terms());
    }

    /// Kills M19 (resumeSubscriptionWithSig without its expiry check). The deadline outlives the expiry, so the mutant
    /// would resume an expired subscription.
    function test_signedResume_ofAnExpiredSubscription_isRejected() public {
        uint256 id = _subscribeAs(alice, leader);
        I.Terms memory t = _terms();
        t.expiry = uint40(T0 + 1 days);
        vm.startPrank(alice);
        c.updateSubscription(id, t); // v2
        c.pauseSubscription(id); // v3
        vm.stopPrank();
        vm.warp(T0 + 1 days);
        vm.prank(relayer);
        _expectInvalidTerms(I.TermsField.EXPIRY);
        c.resumeSubscriptionWithSig(id, 3, _resumeSig(aliceKey, alice, id, 3, 1, DEADLINE));
    }

    // ------------------------------------------------------------------------------------------------ events

    function _topic(Vm.Log[] memory logs, bytes32 sig, uint256 index) internal pure returns (address) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig) return address(uint160(uint256(logs[i].topics[index])));
        }
        revert("event not emitted");
    }

    /// Kills M11, M13, M14, M15, M16 (the indexed `follower` of Subscribed, SubscriptionUpdated, SubscriptionPaused,
    /// SubscriptionResumed and SubscriptionStopped set to msg.sender). On a signed call msg.sender is the relayer, so
    /// every log filter by follower (`eth_getLogs` topic 2) would miss the follower's gasless actions. The suite checks
    /// these topics only on direct calls, and the invariant indexer never reads them.
    function test_signedPaths_indexTheFollower_notTheRelayer() public {
        I.Terms memory t = _terms();
        vm.recordLogs();
        vm.startPrank(relayer);
        uint256 id = c.subscribeWithSig(
            alice,
            C.VENUE_SODEX,
            leader,
            ACCOUNT,
            t,
            0,
            _lastId(alice, ACCOUNT, C.VENUE_SODEX, leader),
            _subscribeSig(aliceKey, alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, 1, DEADLINE)
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_topic(logs, I.Subscribed.selector, 2), alice, "Subscribed.follower");
        assertEq(_topic(logs, I.Subscribed.selector, 3), leader, "Subscribed.leader");

        t.slippageBps = 99;
        c.updateSubscriptionWithSig(id, 1, t, _updateSig(aliceKey, alice, id, 1, t, 2, DEADLINE));
        assertEq(_topic(vm.getRecordedLogs(), I.SubscriptionUpdated.selector, 2), alice, "SubscriptionUpdated.follower");
        c.pauseSubscriptionWithSig(id, _pauseSig(aliceKey, alice, id, 3, DEADLINE));
        assertEq(_topic(vm.getRecordedLogs(), I.SubscriptionPaused.selector, 2), alice, "SubscriptionPaused.follower");
        c.resumeSubscriptionWithSig(id, 3, _resumeSig(aliceKey, alice, id, 3, 4, DEADLINE));
        assertEq(_topic(vm.getRecordedLogs(), I.SubscriptionResumed.selector, 2), alice, "SubscriptionResumed.follower");
        c.unsubscribeWithSig(id, true, _unsubscribeSig(aliceKey, alice, id, true, 5, DEADLINE));
        assertEq(_topic(vm.getRecordedLogs(), I.SubscriptionStopped.selector, 2), alice, "SubscriptionStopped.follower");
        c.unsubscribeAllWithSig(alice, true, _unsubscribeAllSig(aliceKey, alice, true, 6, DEADLINE));
        assertEq(_topic(vm.getRecordedLogs(), I.KillSwitchTriggered.selector, 1), alice, "KillSwitchTriggered.follower");
        vm.stopPrank();
    }

    /// Kills M18 (NoncesInvalidated carries the resulting bitmap instead of the mask). The only emit check used a fresh
    /// word, where both are equal, and the invariant indexer ORs the value in, so it cannot tell them apart either.
    function test_noncesInvalidated_carriesTheMask() public {
        vm.prank(alice);
        c.invalidateNonces(3, 0x0f);
        vm.expectEmit(address(c));
        emit I.NoncesInvalidated(alice, 3, 0xf0);
        vm.prank(alice);
        c.invalidateNonces(3, 0xf0);
    }
}
