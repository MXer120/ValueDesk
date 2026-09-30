// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {ValuescanCopyTrading} from "../../src/ValuescanCopyTrading.sol";
import {IValuescanCopyTrading as I, CopyTradingConstants as C} from "../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingEIP712 as E} from "../utils/CopyTradingEIP712.sol";
import {ValuescanCopyTradingV2Mock} from "../mocks/Mocks.sol";
import {EventIndexer} from "./EventIndexer.sol";
import {CopyTradingHandler} from "./Handler.sol";
import {AttackHandler} from "./AttackHandler.sol";

/// @notice Stateful invariants (spec §12). After every handler call:
///         I1 no funds: the proxy and the implementation hold no value and no call with value ever succeeded;
///         I2 the state rebuilt from events alone equals every on-chain view;
///         I3 only the follower changes its subscriptions (every subscription event was authorised by its follower,
///            and every unauthorised attempt failed);
///         I4 a follower can always stop: every live subscription can be unsubscribed and the kill switch works,
///            directly and by signature, even while the contract is paused;
///         I5 stop-epoch semantics: a kill switch stops exactly the subscriptions created before it;
///         I6 the handler's model of success and failure never disagrees with the contract (pause scope, validity,
///            versions, terminal STOPPED).
contract CopyTradingInvariantTest is Test {
    uint256 internal constant CHAIN_ID = 286_623;
    uint256 internal constant T0 = 1_790_000_000;

    ValuescanCopyTrading internal impl;
    ValuescanCopyTrading internal c;
    EventIndexer internal indexer;
    CopyTradingHandler internal handler;
    AttackHandler internal attacker;
    address internal owner = makeAddr("owner (timelock)");
    address[2] internal executors = [makeAddr("executor A"), makeAddr("executor B")];

    function setUp() public {
        vm.chainId(CHAIN_ID);
        vm.warp(T0);
        impl = new ValuescanCopyTrading();
        address[] memory xs = new address[](1);
        xs[0] = executors[0];
        vm.recordLogs();
        c = ValuescanCopyTrading(
            address(
                new ERC1967Proxy(
                    address(impl), abi.encodeCall(ValuescanCopyTrading.initialize, (owner, 224_000, 50, 100, xs))
                )
            )
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        indexer = new EventIndexer(address(c));
        indexer.ingest(logs, address(0), T0);
        handler = new CopyTradingHandler(c, indexer, owner, executors, address(new ValuescanCopyTradingV2Mock()));

        attacker = new AttackHandler(c, indexer, handler);

        bytes4[] memory selectors = new bytes4[](17);
        selectors[0] = handler.subscribe.selector;
        selectors[1] = handler.subscribe.selector; // weight: subscriptions drive everything else
        selectors[2] = handler.subscribe.selector;
        selectors[3] = handler.update.selector;
        selectors[4] = handler.pauseSubscription.selector;
        selectors[5] = handler.resumeSubscription.selector;
        selectors[6] = handler.resumeSubscription.selector;
        selectors[7] = handler.unsubscribe.selector;
        selectors[8] = handler.unsubscribeAll.selector;
        selectors[9] = handler.invalidateNonces.selector;
        selectors[10] = handler.ownerPause.selector;
        selectors[11] = handler.ownerSetBuilderTerms.selector;
        selectors[12] = handler.ownerSetVenue.selector;
        selectors[13] = handler.ownerSetExecutor.selector;
        selectors[14] = handler.executorCommit.selector;
        selectors[15] = handler.upgradeToV2.selector;
        selectors[16] = handler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
        bytes4[] memory attacks = new bytes4[](1);
        attacks[0] = attacker.attack.selector;
        targetSelector(FuzzSelector({addr: address(attacker), selectors: attacks}));
        targetContract(address(attacker));
    }

    // ------------------------------------------------------------------------------------------------ I1

    function invariant_I1_noFunds() public view {
        assertEq(address(c).balance, 0, "proxy holds value");
        assertEq(address(impl).balance, 0, "implementation holds value");
        if (handler.upgraded()) assertEq(handler.v2().balance, 0, "v2 implementation holds value");
        assertEq(attacker.valueAccepted(), 0, "a call with value succeeded");
    }

    // ------------------------------------------------------------------------------------------------ I2

    function invariant_I2_eventsRebuildState() public view {
        assertEq(indexer.unknownEvents(), 0, "unknown event");
        assertEq(indexer.symbolCommitmentMismatches(), 0, "symbols list does not match its commitment");
        uint256 n = c.subscriptionCount();
        assertEq(indexer.count(), n, "subscriptionCount");
        for (uint256 id = 1; id <= n; ++id) {
            assertEq(abi.encode(c.getSubscription(id)), abi.encode(indexer.subscription(id)), "subscription record");
        }
        for (uint256 i = 0; i < 4; ++i) {
            address f = handler.followers(i);
            (uint256[] memory all,) = c.subscriptionsOfFollower(f, 0, type(uint256).max);
            assertEq(all, indexer.followerIds(f), "follower history");
            (uint256[] memory live, uint256 liveTotal) = c.liveSubscriptionsOfFollower(f, 0, type(uint256).max);
            assertEq(liveTotal, live.length);
            assertEq(_sorted(live), indexer.liveIds(f), "live set");
            uint64 epoch = c.stopEpochOf(f);
            assertEq(epoch, indexer.epochOf(f), "stop epoch");
            for (uint64 e = 0; e <= epoch + 1; ++e) {
                assertEq(abi.encode(c.killSwitchInfo(f, e)), abi.encode(indexer.killSwitch(f, e)), "kill switch");
            }
            uint256 lastWord = handler.nextNonce(f) >> 8;
            for (uint256 w = 0; w < 4; ++w) {
                assertEq(c.nonceBitmap(f, w), indexer.bitmap(f, w), "nonce bitmap (invalidation words)");
            }
            for (uint256 w = (1 << 20) >> 8; w <= lastWord; ++w) {
                assertEq(c.nonceBitmap(f, w), indexer.bitmap(f, w), "nonce bitmap (signature words)");
            }
        }
        for (uint8 v = 1; v <= 3; ++v) {
            assertEq(abi.encode(c.venueInfo(v)), abi.encode(indexer.venue(v)), "venue");
            for (uint256 l = 0; l < 3; ++l) {
                (uint256[] memory ids,) = c.subscriptionsOfLeader(v, handler.leaders(l), 0, type(uint256).max);
                assertEq(ids, indexer.leaderIds(v, handler.leaders(l)), "leader history");
            }
        }
        assertEq(abi.encode(c.builderTerms()), abi.encode(indexer.builderTerms()), "builder terms");
        for (uint256 i = 0; i < 2; ++i) {
            address x = executors[i];
            assertEq(abi.encode(c.executorInfo(x)), abi.encode(indexer.executor(x)), "executor");
            assertEq(c.isExecutor(x), indexer.executor(x).authorised);
            uint64 last = c.executorInfo(x).lastEpoch;
            assertEq(abi.encode(c.commitment(x, last)), abi.encode(indexer.commitment(x, last)), "commitment");
        }
        assertEq(c.paused(), indexer.paused(), "paused");
        assertEq(c.owner(), indexer.owner(), "owner");
        assertEq(c.pendingOwner(), indexer.pendingOwner(), "pending owner");
        address implNow = address(uint160(uint256(vm.load(address(c), ERC1967Utils.IMPLEMENTATION_SLOT))));
        assertEq(implNow, indexer.implementation(), "implementation");
        if (handler.upgraded()) {
            assertEq(ValuescanCopyTradingV2Mock(address(c)).newField(), indexer.v2NewField(), "v2 field");
            assertEq(indexer.initializedVersion(), 2);
        }
    }

    // ------------------------------------------------------------------------------------------------ I3

    function invariant_I3_onlyTheFollowerChangesItsSubscriptions() public view {
        assertEq(indexer.unauthorisedChanges(), 0, "a subscription changed without its follower");
        assertEq(attacker.unexpectedSuccesses(), 0, "an attack succeeded");
    }

    // ------------------------------------------------------------------------------------------------ I4

    function invariant_I4_aFollowerCanAlwaysStop() public {
        uint256 snap = vm.snapshotState();
        if (!c.paused()) {
            vm.prank(c.owner());
            c.pause(); // stopping must work even while the contract is paused
        }
        for (uint256 i = 0; i < 4; ++i) {
            address f = handler.followers(i);
            (uint256[] memory live,) = c.liveSubscriptionsOfFollower(f, 0, type(uint256).max);
            uint256 inner = vm.snapshotState();
            for (uint256 k = 0; k < live.length; ++k) {
                _asFollower(f, abi.encodeCall(c.unsubscribe, (live[k], true)));
                assertEq(uint8(c.statusOf(live[k])), uint8(I.Status.STOPPED));
            }
            vm.revertToState(inner);
            // Signed kill switch, submitted by anyone.
            uint256 nonce = type(uint256).max - i;
            uint256 deadline = vm.getBlockTimestamp();
            bytes32 digest =
                E.digest(E.domainSeparator(block.chainid, address(c)), E.unsubscribeAllHash(f, true, nonce, deadline));
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(handler.keyOf(f), digest);
            vm.prank(makeAddr("anyone"));
            c.unsubscribeAllWithSig(f, true, I.SignatureParams(nonce, deadline, abi.encodePacked(r, s, v)));
            for (uint256 k = 0; k < live.length; ++k) {
                assertEq(uint8(c.statusOf(live[k])), uint8(I.Status.STOPPED));
            }
            (, uint256 remaining) = c.liveSubscriptionsOfFollower(f, 0, 0);
            assertEq(remaining, 0);
            // And the direct kill switch still works afterwards.
            _asFollower(f, abi.encodeCall(c.unsubscribeAll, (false)));
        }
        vm.revertToState(snap);
        assertEq(handler.stopFailures(), 0, "a stop that must work failed");
    }

    function _asFollower(address f, bytes memory data) internal {
        bool ok;
        address wallet = address(handler.wallet());
        if (f == wallet) {
            address walletOwner = handler.walletOwnerAddress(); // read before the prank: a prank binds the next call
            vm.prank(walletOwner);
            (ok,) = wallet.call(abi.encodeWithSignature("execute(address,bytes)", address(c), data));
        } else {
            vm.prank(f);
            (ok,) = address(c).call(data);
        }
        assertTrue(ok, "stop reverted");
    }

    // ------------------------------------------------------------------------------------------------ I5

    function invariant_I5_stopEpochSemantics() public view {
        uint256 n = c.subscriptionCount();
        for (uint256 id = 1; id <= n; ++id) {
            I.Subscription memory s = c.getSubscription(id);
            uint64 epoch = c.stopEpochOf(s.follower);
            I.Status stored = indexer.storedStatus(id);
            bool killed = (stored == I.Status.ACTIVE || stored == I.Status.PAUSED) && s.stopEpoch < epoch;
            if (killed) {
                assertEq(uint8(c.statusOf(id)), uint8(I.Status.STOPPED), "older epoch must be STOPPED");
                assertFalse(c.isCopyable(id));
                (I.StopReason reason, bool close, uint40 stoppedAt) = c.stopDetails(id);
                I.KillSwitch memory k = c.killSwitchInfo(s.follower, s.stopEpoch + 1);
                assertEq(uint8(reason), uint8(I.StopReason.KILL_SWITCH));
                assertEq(close, k.closePositions);
                assertEq(stoppedAt, k.triggeredAt);
                assertGt(k.triggeredAt, 0);
            }
            assertLe(s.stopEpoch, epoch, "created in a future epoch");
        }
        for (uint256 i = 0; i < 4; ++i) {
            address f = handler.followers(i);
            uint64 epoch = c.stopEpochOf(f);
            assertEq(epoch, handler.killCount(f), "one epoch per kill switch");
            (uint256[] memory live,) = c.liveSubscriptionsOfFollower(f, 0, type(uint256).max);
            for (uint256 k = 0; k < live.length; ++k) {
                assertEq(c.getSubscription(live[k]).stopEpoch, epoch, "live set holds only current-epoch ids");
            }
            for (uint256 a = 0; a < 2; ++a) {
                for (uint8 v = 1; v <= 2; ++v) {
                    for (uint256 l = 0; l < 3; ++l) {
                        uint256 id = c.liveSubscriptionFor(f, handler.accounts(a), v, handler.leaders(l));
                        if (id != 0) {
                            I.Status st = c.statusOf(id);
                            assertTrue(st == I.Status.ACTIVE || st == I.Status.PAUSED, "stale live key");
                            assertEq(c.getSubscription(id).stopEpoch, epoch);
                        }
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------------------------------------ I6

    function invariant_I6_modelAgreesWithContract() public view {
        assertEq(handler.unexpectedFailures(), 0, "a valid, authorised call failed");
        assertEq(handler.unexpectedSuccesses(), 0, "an invalid or blocked call succeeded");
        assertEq(indexer.nonMonotonicChanges(), 0, "version skipped, STOPPED revived, or fixed field changed");
    }

    function afterInvariant() external {
        // Keep the campaign honest: it must actually exercise the contract.
        assertGt(handler.actions(), 0);
        bytes32[9] memory keys = [
            bytes32("subscribe"),
            "subscribeWithSig",
            "update",
            "pause",
            "resume",
            "unsubscribe",
            "unsubscribeAll",
            "commit",
            "upgrade"
        ];
        for (uint256 i = 0; i < keys.length; ++i) {
            emit log_named_string(
                string(abi.encodePacked(keys[i])),
                string.concat(
                    vm.toString(handler.succeeded(keys[i])), " ok / ", vm.toString(handler.failed(keys[i])), " failed"
                )
            );
        }
        emit log_named_uint("subscriptions", c.subscriptionCount());
        emit log_named_uint("attacks (all failed)", attacker.attempts());
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _sorted(uint256[] memory a) internal pure returns (uint256[] memory) {
        for (uint256 i = 1; i < a.length; ++i) {
            uint256 x = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > x) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = x;
        }
        return a;
    }
}
