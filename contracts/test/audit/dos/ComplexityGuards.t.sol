// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {ValuescanCopyTrading} from "../../../src/ValuescanCopyTrading.sol";
import {IValuescanCopyTrading as I, CopyTradingConstants as C} from "../../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingBase} from "../../utils/CopyTradingBase.sol";
import {CopyTradingEIP712 as E} from "../../utils/CopyTradingEIP712.sol";

/// @notice AUDIT (DoS lens): the "no function loops over a stored list" guarantee, as a regression guard.
///
///         The existing suite only checks that `unsubscribeAll` costs the same with 1 or 200 live subscriptions.
///         Nothing checks the other entry points, so an O(n) regression in `subscribe`, `unsubscribe`, `pause`,
///         `resume`, `update`, their signed variants or the views (for example in a future UUPS upgrade) passes the
///         whole suite. With no caps, several of these lists are attacker-growable (anyone can append to any leader's
///         history, for ~1 microSOSO per entry).
///
///         Method: two proxies of the same implementation. SMALL holds only the victim's target subscription. LARGE
///         additionally holds, before the target is created, N entries in every list a call could iterate:
///         - the victim's history (N subscriptions, killed by a kill switch: one extra stop epoch);
///         - the victim's current live set (N live subscriptions);
///         - the target leader's history (N spam subscriptions by one attacker with fake SoDEX account ids);
///         - the executor's commitments (N epochs);
///         - the global subscription count (3N + 1).
///         Every action is measured on both, with the proxy's and the implementation's storage cold (`vm.cool`), in
///         its own test (one transaction), on disjoint storage. A call that is O(1) in the stored state costs the same
///         or less in LARGE (non-zero slots are cheaper to update than zero slots). Any loop over one of those lists
///         adds at least N * 100 gas (N * 2,100 cold), far above TOLERANCE.
contract ComplexityGuardsTest is CopyTradingBase {
    uint64 internal constant N = 256;
    uint256 internal constant TOLERANCE = 100; // gas
    uint256 internal constant DEADLINE = T0 + 1 days;

    ValuescanCopyTrading internal small;
    ValuescanCopyTrading internal large;
    address internal victim;
    uint256 internal victimKey;
    address internal attacker = makeAddr("attacker");
    uint256 internal tSmall; // the victim's target subscription (victim -> leader, ACCOUNT), created last
    uint256 internal tLarge;

    function setUp() public override {
        _skipUnderCoverage();
        super.setUp();
        (victim, victimKey) = makeAddrAndKey("victim");
        small = c;
        large = _deployProxy(address(impl), owner, _one(executor));

        for (uint64 i = 1; i <= N; ++i) {
            _sub(large, victim, leader2, 1_000_000 + i); // victim history ...
        }
        vm.prank(victim);
        large.unsubscribeAll(false); // ... all killed: victim stop epoch 1
        for (uint64 i = 1; i <= N; ++i) {
            _sub(large, victim, leader2, 2_000_000 + i); // victim live set of the current epoch
        }
        for (uint64 i = 1; i <= N; ++i) {
            _sub(large, attacker, leader, i); // leader history: spam with fake account ids
        }
        for (uint64 e = 1; e <= N; ++e) {
            vm.prank(executor);
            large.commitExecutions(e, bytes32(uint256(e)), 1, "u"); // executor history
        }
        tSmall = _sub(small, victim, leader, ACCOUNT);
        tLarge = _sub(large, victim, leader, ACCOUNT);

        (, uint256 leaderTotal) = large.subscriptionsOfLeader(C.VENUE_SODEX, leader, 0, 0);
        (, uint256 liveTotal) = large.liveSubscriptionsOfFollower(victim, 0, 0);
        (, uint256 historyTotal) = large.subscriptionsOfFollower(victim, 0, 0);
        assertEq(leaderTotal, N + 1);
        assertEq(liveTotal, N + 1);
        assertEq(historyTotal, 2 * N + 1);
        assertEq(large.subscriptionCount(), 3 * N + 1);
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _sub(ValuescanCopyTrading p, address f, address l, uint64 account) internal returns (uint256 id) {
        vm.prank(f);
        id = p.subscribe(C.VENUE_SODEX, l, account, _terms());
    }

    function _gas(ValuescanCopyTrading p, address from, bytes memory data) internal returns (uint256 used) {
        vm.cool(address(p));
        vm.cool(address(impl));
        vm.prank(from);
        (bool ok, bytes memory ret) = address(p).call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        used = vm.lastCallGas().gasTotalUsed;
    }

    function _sig(ValuescanCopyTrading p, bytes32 structHash, uint256 nonce)
        internal
        view
        returns (I.SignatureParams memory)
    {
        bytes32 digest = E.digest(E.domainSeparator(block.chainid, address(p)), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(victimKey, digest);
        return I.SignatureParams(nonce, DEADLINE, abi.encodePacked(r, s, v));
    }

    function _assertO1(string memory action, uint256 gasSmall, uint256 gasLarge) internal {
        emit log_named_uint(string.concat(action, " SMALL"), gasSmall);
        emit log_named_uint(string.concat(action, " LARGE"), gasLarge);
        assertLe(gasLarge, gasSmall + TOLERANCE, string.concat(action, ": cost grows with stored lists (O(n))"));
    }

    function _pausedTargets() internal {
        vm.prank(victim);
        small.pauseSubscription(tSmall);
        vm.prank(victim);
        large.pauseSubscription(tLarge);
    }

    // ------------------------------------------------------------------------------------------------ follower actions

    function test_O1_subscribe() public {
        bytes memory d = abi.encodeCall(ValuescanCopyTrading.subscribe, (C.VENUE_SODEX, leader, ACCOUNT + 1, _terms()));
        _assertO1("subscribe", _gas(small, victim, d), _gas(large, victim, d));
    }

    function test_O1_subscribeWithSig() public {
        I.Terms memory t = _terms();
        bytes memory dS = abi.encodeCall(
            ValuescanCopyTrading.subscribeWithSig,
            (
                victim,
                C.VENUE_SODEX,
                leader,
                ACCOUNT + 1,
                t,
                0,
                0,
                _sig(small, E.subscribeHash(victim, C.VENUE_SODEX, leader, ACCOUNT + 1, t, 0, 0, 1, DEADLINE), 1)
            )
        );
        bytes memory dL = abi.encodeCall(
            ValuescanCopyTrading.subscribeWithSig,
            (
                victim,
                C.VENUE_SODEX,
                leader,
                ACCOUNT + 1,
                t,
                1,
                0,
                _sig(large, E.subscribeHash(victim, C.VENUE_SODEX, leader, ACCOUNT + 1, t, 1, 0, 1, DEADLINE), 1)
            )
        );
        _assertO1("subscribeWithSig", _gas(small, relayer, dS), _gas(large, relayer, dL));
    }

    function test_O1_updateSubscription() public {
        I.Terms memory t = _terms();
        t.slippageBps = 77;
        _assertO1(
            "updateSubscription",
            _gas(small, victim, abi.encodeCall(ValuescanCopyTrading.updateSubscription, (tSmall, t))),
            _gas(large, victim, abi.encodeCall(ValuescanCopyTrading.updateSubscription, (tLarge, t)))
        );
    }

    function test_O1_updateSubscriptionWithSig() public {
        I.Terms memory t = _terms();
        t.slippageBps = 77;
        bytes memory dS = abi.encodeCall(
            ValuescanCopyTrading.updateSubscriptionWithSig,
            (tSmall, 1, t, _sig(small, E.updateHash(victim, tSmall, 1, t, 1, DEADLINE), 1))
        );
        bytes memory dL = abi.encodeCall(
            ValuescanCopyTrading.updateSubscriptionWithSig,
            (tLarge, 1, t, _sig(large, E.updateHash(victim, tLarge, 1, t, 1, DEADLINE), 1))
        );
        _assertO1("updateSubscriptionWithSig", _gas(small, relayer, dS), _gas(large, relayer, dL));
    }

    function test_O1_pauseSubscription() public {
        _assertO1(
            "pauseSubscription",
            _gas(small, victim, abi.encodeCall(ValuescanCopyTrading.pauseSubscription, (tSmall))),
            _gas(large, victim, abi.encodeCall(ValuescanCopyTrading.pauseSubscription, (tLarge)))
        );
    }

    function test_O1_pauseSubscriptionWithSig() public {
        bytes memory dS = abi.encodeCall(
            ValuescanCopyTrading.pauseSubscriptionWithSig,
            (tSmall, _sig(small, E.pauseHash(victim, tSmall, 1, DEADLINE), 1))
        );
        bytes memory dL = abi.encodeCall(
            ValuescanCopyTrading.pauseSubscriptionWithSig,
            (tLarge, _sig(large, E.pauseHash(victim, tLarge, 1, DEADLINE), 1))
        );
        _assertO1("pauseSubscriptionWithSig", _gas(small, relayer, dS), _gas(large, relayer, dL));
    }

    function test_O1_resumeSubscription() public {
        _pausedTargets();
        _assertO1(
            "resumeSubscription",
            _gas(small, victim, abi.encodeCall(ValuescanCopyTrading.resumeSubscription, (tSmall))),
            _gas(large, victim, abi.encodeCall(ValuescanCopyTrading.resumeSubscription, (tLarge)))
        );
    }

    function test_O1_resumeSubscriptionWithSig() public {
        _pausedTargets();
        bytes memory dS = abi.encodeCall(
            ValuescanCopyTrading.resumeSubscriptionWithSig,
            (tSmall, 2, _sig(small, E.resumeHash(victim, tSmall, 2, 1, DEADLINE), 1))
        );
        bytes memory dL = abi.encodeCall(
            ValuescanCopyTrading.resumeSubscriptionWithSig,
            (tLarge, 2, _sig(large, E.resumeHash(victim, tLarge, 2, 1, DEADLINE), 1))
        );
        _assertO1("resumeSubscriptionWithSig", _gas(small, relayer, dS), _gas(large, relayer, dL));
    }

    function test_O1_unsubscribe() public {
        _assertO1(
            "unsubscribe",
            _gas(small, victim, abi.encodeCall(ValuescanCopyTrading.unsubscribe, (tSmall, true))),
            _gas(large, victim, abi.encodeCall(ValuescanCopyTrading.unsubscribe, (tLarge, true)))
        );
    }

    function test_O1_unsubscribeWithSig() public {
        bytes memory dS = abi.encodeCall(
            ValuescanCopyTrading.unsubscribeWithSig,
            (tSmall, true, _sig(small, E.unsubscribeHash(victim, tSmall, true, 1, DEADLINE), 1))
        );
        bytes memory dL = abi.encodeCall(
            ValuescanCopyTrading.unsubscribeWithSig,
            (tLarge, true, _sig(large, E.unsubscribeHash(victim, tLarge, true, 1, DEADLINE), 1))
        );
        _assertO1("unsubscribeWithSig", _gas(small, relayer, dS), _gas(large, relayer, dL));
    }

    function test_O1_unsubscribeAll() public {
        bytes memory d = abi.encodeCall(ValuescanCopyTrading.unsubscribeAll, (true));
        _assertO1("unsubscribeAll", _gas(small, victim, d), _gas(large, victim, d));
    }

    function test_O1_unsubscribeAllWithSig() public {
        bytes memory dS = abi.encodeCall(
            ValuescanCopyTrading.unsubscribeAllWithSig,
            (victim, true, _sig(small, E.unsubscribeAllHash(victim, true, 1, DEADLINE), 1))
        );
        bytes memory dL = abi.encodeCall(
            ValuescanCopyTrading.unsubscribeAllWithSig,
            (victim, true, _sig(large, E.unsubscribeAllHash(victim, true, 1, DEADLINE), 1))
        );
        _assertO1("unsubscribeAllWithSig", _gas(small, relayer, dS), _gas(large, relayer, dL));
    }

    function test_O1_invalidateNonces() public {
        bytes memory d = abi.encodeCall(ValuescanCopyTrading.invalidateNonces, (0, 0xff));
        _assertO1("invalidateNonces", _gas(small, victim, d), _gas(large, victim, d));
    }

    function test_O1_commitExecutions() public {
        bytes memory d = abi.encodeCall(ValuescanCopyTrading.commitExecutions, (N + 1, bytes32(uint256(7)), 3, "u"));
        _assertO1("commitExecutions", _gas(small, executor, d), _gas(large, executor, d));
    }

    // ------------------------------------------------------------------------------------------------ views

    function test_O1_views() public {
        _assertO1(
            "getSubscription",
            _gas(small, stranger, abi.encodeCall(ValuescanCopyTrading.getSubscription, (tSmall))),
            _gas(large, stranger, abi.encodeCall(ValuescanCopyTrading.getSubscription, (tLarge)))
        );
        _assertO1(
            "isCopyable",
            _gas(small, stranger, abi.encodeCall(ValuescanCopyTrading.isCopyable, (tSmall))),
            _gas(large, stranger, abi.encodeCall(ValuescanCopyTrading.isCopyable, (tLarge)))
        );
        _assertO1(
            "liveSubscriptionFor",
            _gas(
                small, stranger, abi.encodeCall(ValuescanCopyTrading.liveSubscriptionFor, (victim, ACCOUNT, 1, leader))
            ),
            _gas(
                large, stranger, abi.encodeCall(ValuescanCopyTrading.liveSubscriptionFor, (victim, ACCOUNT, 1, leader))
            )
        );
        _assertO1(
            "effectiveBuilderFee",
            _gas(small, stranger, abi.encodeCall(ValuescanCopyTrading.effectiveBuilderFee, (tSmall))),
            _gas(large, stranger, abi.encodeCall(ValuescanCopyTrading.effectiveBuilderFee, (tLarge)))
        );
        // One-element pages at the END of each list: the page cost must not depend on the list length.
        _assertO1(
            "subscriptionsOfLeader (1 id)",
            _gas(small, stranger, abi.encodeCall(ValuescanCopyTrading.subscriptionsOfLeader, (1, leader, 0, 1))),
            _gas(large, stranger, abi.encodeCall(ValuescanCopyTrading.subscriptionsOfLeader, (1, leader, N, 1)))
        );
        _assertO1(
            "subscriptionsOfFollower (1 id)",
            _gas(small, stranger, abi.encodeCall(ValuescanCopyTrading.subscriptionsOfFollower, (victim, 0, 1))),
            _gas(large, stranger, abi.encodeCall(ValuescanCopyTrading.subscriptionsOfFollower, (victim, 2 * N, 1)))
        );
        _assertO1(
            "liveSubscriptionsOfFollower (1 id)",
            _gas(small, stranger, abi.encodeCall(ValuescanCopyTrading.liveSubscriptionsOfFollower, (victim, 0, 1))),
            _gas(large, stranger, abi.encodeCall(ValuescanCopyTrading.liveSubscriptionsOfFollower, (victim, N, 1)))
        );
        // stopDetails of a killed subscription (large) vs one stopped by the follower (small) are different branches;
        // compare killed vs killed instead.
        vm.prank(victim);
        small.unsubscribeAll(false);
        vm.prank(victim);
        large.unsubscribeAll(false);
        _assertO1(
            "stopDetails (kill switch)",
            _gas(small, stranger, abi.encodeCall(ValuescanCopyTrading.stopDetails, (tSmall))),
            _gas(large, stranger, abi.encodeCall(ValuescanCopyTrading.stopDetails, (tLarge)))
        );
        _assertO1(
            "statusOf",
            _gas(small, stranger, abi.encodeCall(ValuescanCopyTrading.statusOf, (tSmall))),
            _gas(large, stranger, abi.encodeCall(ValuescanCopyTrading.statusOf, (tLarge)))
        );
    }
}
