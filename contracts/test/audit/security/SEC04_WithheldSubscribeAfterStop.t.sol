// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {IValuescanCopyTrading as I, CopyTradingConstants as C} from "../../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingBase} from "../../utils/CopyTradingBase.sol";

/// @notice AUDIT SEC-04 (medium, FIXED), kept as a regression test. Before the fix a signed Subscribe was bound only to
///         the follower's kill-switch epoch, so a per-leader `unsubscribe` did not void a Subscribe for that leader that
///         was signed earlier and never landed (withheld by the untrusted relayer, or a second copy from a UI retry):
///         landing it after the stop restarted copying against the follower's latest wish.
///         Fix: Subscribe carries `expectedLastId`, the key's last subscription id when the follower signed
///         (`lastSubscriptionFor`), and `_stop` no longer clears that entry. Any subscription that lands for the key
///         voids every Subscribe signed before it, and a later stop keeps them void.
contract SEC04_WithheldSubscribeAfterStopTest is CopyTradingBase {
    uint256 internal constant DEADLINE = T0 + 1 days;

    /// The auditor's exact scenario: the withheld Subscribe now reverts and copying stays stopped.
    function test_audit_SEC04_withheldSubscribe_cannotRestartCopying_afterFollowerUnsubscribed() public {
        I.Terms memory t = _terms();

        // 1. Alice signs "copy `leader`" (no subscription for the key yet: expectedLastId 0); the relayer withholds it.
        assertEq(c.lastSubscriptionFor(alice, ACCOUNT, C.VENUE_SODEX, leader), 0);
        I.SignatureParams memory withheld =
            _subscribeSigFor(aliceKey, alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, 0, 1, DEADLINE);

        // 2. She subscribes directly, and also copies leader2.
        uint256 first = _subscribeAs(alice, leader);
        _subscribeAs(alice, leader2);
        assertEq(c.lastSubscriptionFor(alice, ACCOUNT, C.VENUE_SODEX, leader), first);

        // 3. Her latest wish: stop copying `leader`, and flatten. The key keeps pointing at the stopped id.
        vm.warp(T0 + 2 hours);
        vm.prank(alice);
        c.unsubscribe(first, true);
        assertEq(c.liveSubscriptionFor(alice, ACCOUNT, C.VENUE_SODEX, leader), 0, "stopped");
        assertEq(c.lastSubscriptionFor(alice, ACCOUNT, C.VENUE_SODEX, leader), first, "last id kept after a stop");

        // 4. The relayer lands the withheld Subscribe: it is bound to an older history of the key and reverts.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.LastSubscriptionMismatch.selector, 0, first));
        c.subscribeWithSig(alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, 0, withheld);

        assertEq(c.liveSubscriptionFor(alice, ACCOUNT, C.VENUE_SODEX, leader), 0, "copying stays stopped");
        assertFalse(c.isNonceUsed(alice, 1), "the withheld signature consumed nothing");
    }

    /// A UI retry: two Subscribes signed for the same key and history. The first lands; the second can never land,
    /// neither while the first is live (duplicate) nor after the follower stopped it (history moved on).
    function test_audit_SEC04_secondCopyOfARetriedSubscribe_neverLands() public {
        I.Terms memory t = _terms();
        I.SignatureParams memory a =
            _subscribeSigFor(aliceKey, alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, 0, 1, DEADLINE);
        I.SignatureParams memory b =
            _subscribeSigFor(aliceKey, alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, 0, 2, DEADLINE);

        vm.prank(relayer);
        uint256 id = c.subscribeWithSig(alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, 0, a);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.DuplicateSubscription.selector, id));
        c.subscribeWithSig(alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, 0, b);

        vm.prank(alice);
        c.unsubscribe(id, false);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.LastSubscriptionMismatch.selector, 0, id));
        c.subscribeWithSig(alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, 0, b);
    }

    /// Subscribing again after a stop works when signed for the current history, and each key's history is
    /// independent: landing a Subscribe for one leader does not void a pending Subscribe for another.
    function test_audit_SEC04_resubscribeAfterStop_andIndependentKeys() public {
        I.Terms memory t = _terms();
        uint256 first = _subscribeAs(alice, leader);
        vm.prank(alice);
        c.unsubscribe(first, false);

        I.SignatureParams memory again =
            _subscribeSigFor(aliceKey, alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, first, 1, DEADLINE);
        I.SignatureParams memory other =
            _subscribeSigFor(aliceKey, alice, C.VENUE_SODEX, leader2, ACCOUNT, t, 0, 0, 2, DEADLINE);

        vm.prank(relayer);
        uint256 second = c.subscribeWithSig(alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, first, again);
        assertEq(c.lastSubscriptionFor(alice, ACCOUNT, C.VENUE_SODEX, leader), second);
        assertEq(c.liveSubscriptionFor(alice, ACCOUNT, C.VENUE_SODEX, leader), second);

        vm.prank(relayer);
        uint256 third = c.subscribeWithSig(alice, C.VENUE_SODEX, leader2, ACCOUNT, t, 0, 0, other);
        assertTrue(c.isCopyable(third));
    }

    /// The kill switch leaves `liveByKey` untouched (O(1)); a Subscribe signed after it carries the new stop epoch and
    /// the killed id, and lands. One signed before it fails on the stop epoch, as before.
    function test_audit_SEC04_killSwitch_keepsTheKeyHistory() public {
        I.Terms memory t = _terms();
        uint256 first = _subscribeAs(alice, leader);
        I.SignatureParams memory before =
            _subscribeSigFor(aliceKey, alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, first, 1, DEADLINE);
        vm.prank(alice);
        c.unsubscribeAll(false);
        assertEq(c.lastSubscriptionFor(alice, ACCOUNT, C.VENUE_SODEX, leader), first);
        assertEq(c.liveSubscriptionFor(alice, ACCOUNT, C.VENUE_SODEX, leader), 0);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.StopEpochMismatch.selector, alice, 0, 1));
        c.subscribeWithSig(alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, first, before);

        I.SignatureParams memory afterKill =
            _subscribeSigFor(aliceKey, alice, C.VENUE_SODEX, leader, ACCOUNT, t, 1, first, 2, DEADLINE);
        vm.prank(relayer);
        uint256 second = c.subscribeWithSig(alice, C.VENUE_SODEX, leader, ACCOUNT, t, 1, first, afterKill);
        assertTrue(c.isCopyable(second));
    }

    /// The binding is part of the signed message: a relayer cannot pass another expectedLastId with the same
    /// signature.
    function test_audit_SEC04_expectedLastIdIsSigned() public {
        I.Terms memory t = _terms();
        uint256 first = _subscribeAs(alice, leader);
        vm.prank(alice);
        c.unsubscribe(first, false);
        I.SignatureParams memory old =
            _subscribeSigFor(aliceKey, alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, 0, 1, DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.subscribeWithSig(alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, first, old);
    }
}
