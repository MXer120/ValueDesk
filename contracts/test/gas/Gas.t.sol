// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {IValuescanCopyTrading as I, CopyTradingConstants as C} from "../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingBase} from "../utils/CopyTradingBase.sol";
import {ERC1271WalletMock, ValuescanCopyTradingV2Mock} from "../mocks/Mocks.sol";

/// @notice Gas per action, measured on the call frame only (no 21,000 intrinsic cost, no calldata cost) with the
///         proxy's storage cold (`vm.cool`), as the first touch in a transaction would be. Each measurement is written
///         to `snapshots/ValuescanCopyTrading.json` (`forge test --match-path test/gas/Gas.t.sol`) and bounded by an
///         assertion, so a regression fails the build. Spec §11 quotes these numbers.
contract GasTest is CopyTradingBase {
    string internal constant G = "ValuescanCopyTrading";
    uint256 internal deadline;
    ERC1271WalletMock internal wallet;
    uint256 internal id; // alice -> leader, ACTIVE

    function setUp() public override {
        _skipUnderCoverage();
        super.setUp();
        deadline = T0 + 1 days;
        wallet = new ERC1271WalletMock(bob);
        id = _subscribeAs(alice, leader);
    }

    function _cold() internal {
        vm.cool(address(c));
    }

    function _snap(string memory name, uint256 bound_) internal {
        uint256 used = vm.snapshotGasLastCall(G, name);
        assertLe(used, bound_, name);
    }

    function _symbols(uint256 n) internal pure returns (string[] memory s) {
        s = new string[](n);
        for (uint256 i = 0; i < n; ++i) {
            s[i] = string.concat("SYMBOL", vm.toString(i), "-USD");
        }
    }

    // ------------------------------------------------------------------------------------------------ subscribe

    function test_gas_subscribe_allSymbols() public {
        _cold();
        vm.prank(bob);
        c.subscribe(C.VENUE_SODEX, leader, ACCOUNT, _terms());
        _snap("subscribe (ALL symbols)", 420_000);
    }

    function test_gas_subscribe_2symbols() public {
        _cold();
        vm.prank(bob);
        c.subscribe(C.VENUE_SODEX, leader, ACCOUNT, _termsAllow());
        _snap("subscribe (2 symbols)", 430_000);
    }

    function test_gas_subscribe_50symbols() public {
        I.Terms memory t = _terms();
        t.symbolMode = I.SymbolMode.DENY;
        t.symbols = _symbols(50);
        _cold();
        vm.prank(bob);
        c.subscribe(C.VENUE_SODEX, leader, ACCOUNT, t);
        _snap("subscribe (50 symbols)", 700_000);
    }

    function test_gas_subscribe_secondSubscriptionOfAFollower() public {
        _cold();
        vm.prank(alice);
        c.subscribe(C.VENUE_SODEX, leader2, ACCOUNT, _terms());
        _snap("subscribe (follower's 2nd)", 400_000);
    }

    function test_gas_subscribeWithSig_eoa() public {
        I.Terms memory t = _terms();
        I.SignatureParams memory sig = _subscribeSig(bobKey, bob, C.VENUE_SODEX, leader, ACCOUNT, t, 0, 0, deadline);
        _cold();
        vm.prank(relayer);
        c.subscribeWithSig(bob, C.VENUE_SODEX, leader, ACCOUNT, t, 0, _lastId(bob, ACCOUNT, C.VENUE_SODEX, leader), sig);
        _snap("subscribeWithSig (EOA)", 460_000);
    }

    function test_gas_subscribeWithSig_erc1271() public {
        I.Terms memory t = _terms();
        address w = address(wallet);
        I.SignatureParams memory sig = _subscribeSig(bobKey, w, C.VENUE_SODEX, leader, ACCOUNT, t, 0, 0, deadline);
        _cold();
        vm.prank(relayer);
        c.subscribeWithSig(w, C.VENUE_SODEX, leader, ACCOUNT, t, 0, _lastId(w, ACCOUNT, C.VENUE_SODEX, leader), sig);
        _snap("subscribeWithSig (ERC-1271)", 480_000);
    }

    // ------------------------------------------------------------------------------------------------ changes

    function test_gas_update() public {
        I.Terms memory t = _termsAllow();
        t.slippageBps = 99;
        _cold();
        vm.prank(alice);
        c.updateSubscription(id, t);
        _snap("updateSubscription", 150_000);
    }

    function test_gas_updateWithSig() public {
        I.Terms memory t = _terms();
        t.slippageBps = 99;
        I.SignatureParams memory sig = _updateSig(aliceKey, alice, id, 1, t, 1, deadline);
        _cold();
        vm.prank(relayer);
        c.updateSubscriptionWithSig(id, 1, t, sig);
        _snap("updateSubscriptionWithSig", 170_000);
    }

    function test_gas_pause() public {
        _cold();
        vm.prank(alice);
        c.pauseSubscription(id);
        _snap("pauseSubscription", 55_000);
    }

    function test_gas_pauseWithSig() public {
        I.SignatureParams memory sig = _pauseSig(aliceKey, alice, id, 1, deadline);
        _cold();
        vm.prank(relayer);
        c.pauseSubscriptionWithSig(id, sig);
        _snap("pauseSubscriptionWithSig", 95_000);
    }

    function test_gas_resume() public {
        vm.prank(alice);
        c.pauseSubscription(id);
        _cold();
        vm.prank(alice);
        c.resumeSubscription(id);
        _snap("resumeSubscription", 60_000);
    }

    function test_gas_resumeWithSig() public {
        vm.prank(alice);
        c.pauseSubscription(id);
        I.SignatureParams memory sig = _resumeSig(aliceKey, alice, id, 2, 1, deadline);
        _cold();
        vm.prank(relayer);
        c.resumeSubscriptionWithSig(id, 2, sig);
        _snap("resumeSubscriptionWithSig", 100_000);
    }

    function test_gas_unsubscribe() public {
        _cold();
        vm.prank(alice);
        c.unsubscribe(id, true);
        _snap("unsubscribe", 70_000);
    }

    function test_gas_unsubscribeWithSig() public {
        I.SignatureParams memory sig = _unsubscribeSig(aliceKey, alice, id, true, 1, deadline);
        _cold();
        vm.prank(relayer);
        c.unsubscribeWithSig(id, true, sig);
        _snap("unsubscribeWithSig", 100_000);
    }

    // ------------------------------------------------------------------------------------------------ kill switch

    function test_gas_unsubscribeAll_1live() public {
        _cold();
        vm.prank(alice);
        c.unsubscribeAll(true);
        _snap("unsubscribeAll (1 live)", 95_000);
    }

    function test_gas_unsubscribeAll_200live() public {
        for (uint64 i = 1; i <= 200; ++i) {
            _subscribeAs(bob, C.VENUE_SODEX, leader, i, _terms());
        }
        _cold();
        vm.prank(bob);
        c.unsubscribeAll(true);
        uint256 used = vm.snapshotGasLastCall(G, "unsubscribeAll (200 live)");
        _cold();
        vm.prank(alice);
        c.unsubscribeAll(true);
        assertEq(used, vm.lastCallGas().gasTotalUsed, "kill switch cost depends on the number of subscriptions");
        assertLe(used, 95_000);
    }

    function test_gas_unsubscribeAllWithSig() public {
        I.SignatureParams memory sig = _unsubscribeAllSig(aliceKey, alice, true, 1, deadline);
        _cold();
        vm.prank(relayer);
        c.unsubscribeAllWithSig(alice, true, sig);
        _snap("unsubscribeAllWithSig", 130_000);
    }

    function test_gas_invalidateNonces() public {
        _cold();
        vm.prank(alice);
        c.invalidateNonces(0, type(uint256).max);
        _snap("invalidateNonces", 65_000);
    }

    // ------------------------------------------------------------------------------------------------ executors, owner

    function test_gas_commitExecutions() public {
        _cold();
        vm.prank(executor);
        c.commitExecutions(
            497_223, keccak256("root"), 1200, "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
        );
        _snap("commitExecutions", 100_000);
    }

    function test_gas_setBuilderTerms() public {
        _cold();
        vm.prank(owner);
        c.setBuilderTerms(BUILDER_ID, 40, 80);
        _snap("setBuilderTerms", 50_000);
    }

    function test_gas_setVenue() public {
        _cold();
        vm.prank(owner);
        c.setVenue(3, true, "NewVenue");
        _snap("setVenue (new)", 100_000);
    }

    function test_gas_setExecutor() public {
        _cold();
        vm.prank(owner);
        c.setExecutor(makeAddr("x2"), true);
        _snap("setExecutor", 70_000);
    }

    function test_gas_pauseContract() public {
        _cold();
        vm.prank(owner);
        c.pause();
        _snap("pause (owner)", 65_000);
    }

    function test_gas_upgradeToAndCall() public {
        ValuescanCopyTradingV2Mock v2 = new ValuescanCopyTradingV2Mock();
        _cold();
        vm.prank(owner);
        c.upgradeToAndCall(address(v2), abi.encodeCall(v2.initializeV2, (1)));
        _snap("upgradeToAndCall (with reinitializer)", 100_000);
    }

    // ------------------------------------------------------------------------------------------------ views

    function test_gas_views() public {
        _cold();
        c.getSubscription(id);
        _snap("view getSubscription", 40_000);
        _cold();
        c.isCopyable(id);
        _snap("view isCopyable", 20_000);
        _cold();
        c.effectiveBuilderFee(id);
        _snap("view effectiveBuilderFee", 20_000);
    }

    function test_gas_livePageOf100() public {
        for (uint64 i = 1; i <= 100; ++i) {
            _subscribeAs(bob, C.VENUE_SODEX, leader, i, _terms());
        }
        _cold();
        c.liveSubscriptionsOfFollower(bob, 0, 100);
        _snap("view liveSubscriptionsOfFollower (page of 100)", 300_000);
    }
}
