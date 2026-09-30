// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IValuescanCopyTrading as I, CopyTradingConstants as C} from "../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingBase} from "../utils/CopyTradingBase.sol";
import {CopyTradingEIP712 as E} from "../utils/CopyTradingEIP712.sol";

/// @notice `subscribe`: stored record, indexes, events, every validation revert and the absence of product limits.
contract SubscribeTest is CopyTradingBase {
    function test_subscribe_storesRecordAndIndexes() public {
        I.Terms memory t = _termsAllow();
        t.copyExisting = true;
        t.expiry = uint40(T0 + 30 days);
        vm.prank(alice);
        uint256 id = c.subscribe(C.VENUE_HYPERLIQUID, leader, ACCOUNT, t);
        assertEq(id, 1);
        assertEq(c.subscriptionCount(), 1);

        I.Subscription memory s = c.getSubscription(id);
        assertEq(s.follower, alice);
        assertEq(uint8(s.status), uint8(I.Status.ACTIVE));
        assertEq(s.venue, C.VENUE_HYPERLIQUID);
        assertEq(uint8(s.marketScope), uint8(t.marketScope));
        assertEq(uint8(s.sizingMode), uint8(t.sizingMode));
        assertEq(uint8(s.symbolMode), uint8(I.SymbolMode.ALLOW));
        assertTrue(s.copyExisting);
        assertEq(s.maxLeverage, t.maxLeverage);
        assertFalse(s.closePositions);
        assertEq(s.version, 1);
        assertEq(s.leader, leader);
        assertEq(s.createdAt, T0);
        assertEq(s.updatedAt, T0);
        assertEq(s.slippageBps, t.slippageBps);
        assertEq(s.delegatedKey, delegatedKey);
        assertEq(s.expiry, T0 + 30 days);
        assertEq(s.takeProfitBps, t.takeProfitBps);
        assertEq(s.tradeStopLossBps, t.tradeStopLossBps);
        assertEq(s.sodexAccountId, ACCOUNT);
        assertEq(s.stopEpoch, 0);
        assertEq(s.sizingValue, t.sizingValue);
        assertEq(s.maxDrawdownBps, t.maxDrawdownBps);
        assertEq(s.maxBuilderFeePerps, t.maxBuilderFeePerps);
        assertEq(s.maxBuilderFeeSpot, t.maxBuilderFeeSpot);
        assertEq(s.allocationCap, t.allocationCap);
        assertEq(s.maxPositionNotional, t.maxPositionNotional);
        assertEq(s.symbolsHash, E.hashStrings(t.symbols));
        assertEq(s.keyName, t.keyName);

        (uint256[] memory ids, uint256 total) = c.subscriptionsOfFollower(alice, 0, 10);
        assertEq(total, 1);
        assertEq(ids[0], id);
        (ids, total) = c.liveSubscriptionsOfFollower(alice, 0, 10);
        assertEq(total, 1);
        assertEq(ids[0], id);
        (ids, total) = c.subscriptionsOfLeader(C.VENUE_HYPERLIQUID, leader, 0, 10);
        assertEq(total, 1);
        assertEq(ids[0], id);
        (, total) = c.subscriptionsOfLeader(C.VENUE_SODEX, leader, 0, 10);
        assertEq(total, 0);
        assertEq(c.liveSubscriptionFor(alice, ACCOUNT, C.VENUE_HYPERLIQUID, leader), id);
        assertEq(c.liveSubscriptionFor(alice, ACCOUNT, C.VENUE_SODEX, leader), 0);
        assertTrue(c.isCopyable(id));
    }

    function test_subscribe_emitsFullRecordAndSymbols() public {
        I.Terms memory t = _termsAllow();
        I.Subscription memory expected = I.Subscription({
            follower: alice,
            status: I.Status.ACTIVE,
            venue: C.VENUE_SODEX,
            marketScope: t.marketScope,
            sizingMode: t.sizingMode,
            symbolMode: t.symbolMode,
            copyExisting: t.copyExisting,
            maxLeverage: t.maxLeverage,
            closePositions: false,
            version: 1,
            leader: leader,
            createdAt: uint40(T0),
            updatedAt: uint40(T0),
            slippageBps: t.slippageBps,
            delegatedKey: t.delegatedKey,
            expiry: t.expiry,
            takeProfitBps: t.takeProfitBps,
            tradeStopLossBps: t.tradeStopLossBps,
            sodexAccountId: ACCOUNT,
            stopEpoch: 0,
            sizingValue: t.sizingValue,
            maxDrawdownBps: t.maxDrawdownBps,
            maxBuilderFeePerps: t.maxBuilderFeePerps,
            maxBuilderFeeSpot: t.maxBuilderFeeSpot,
            allocationCap: t.allocationCap,
            maxPositionNotional: t.maxPositionNotional,
            symbolsHash: E.hashStrings(t.symbols),
            keyName: t.keyName
        });
        vm.expectEmit(address(c));
        emit I.Subscribed(1, alice, leader, expected, t.symbols);
        _subscribeAs(alice, C.VENUE_SODEX, leader, ACCOUNT, t);
    }

    function test_subscribe_idsAreSequential() public {
        assertEq(_subscribeAs(alice, leader), 1);
        assertEq(_subscribeAs(bob, leader), 2);
        assertEq(_subscribeAs(alice, leader2), 3);
        (uint256[] memory ids, uint256 total) = c.subscriptionsOfLeader(C.VENUE_SODEX, leader, 0, 10);
        assertEq(total, 2);
        assertEq(ids[0], 1);
        assertEq(ids[1], 2);
    }

    // ------------------------------------------------------------------------------------------------ targets

    function test_subscribe_revertsWhenPaused() public {
        vm.prank(owner);
        c.pause();
        vm.prank(alice);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        c.subscribe(C.VENUE_SODEX, leader, ACCOUNT, _terms());
    }

    function test_subscribe_revertsOnUnknownOrDisabledVenue() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(I.VenueDisabled.selector, uint8(0)));
        c.subscribe(0, leader, ACCOUNT, _terms());
        vm.expectRevert(abi.encodeWithSelector(I.VenueDisabled.selector, uint8(3)));
        c.subscribe(3, leader, ACCOUNT, _terms());
        vm.stopPrank();

        vm.prank(owner);
        c.setVenue(C.VENUE_HYPERLIQUID, false, "Hyperliquid");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(I.VenueDisabled.selector, C.VENUE_HYPERLIQUID));
        c.subscribe(C.VENUE_HYPERLIQUID, leader, ACCOUNT, _terms());

        // A venue added later works without an upgrade.
        vm.prank(owner);
        c.setVenue(3, true, "NewVenue");
        assertEq(_subscribeAs(alice, 3, leader, ACCOUNT, _terms()), 1);
    }

    function test_subscribe_revertsOnZeroLeader() public {
        vm.prank(alice);
        _expectInvalidTerms(I.TermsField.LEADER);
        c.subscribe(C.VENUE_SODEX, address(0), ACCOUNT, _terms());
    }

    function test_subscribe_selfCopy_forbiddenOnSodex_allowedFromHyperliquid() public {
        vm.prank(alice);
        _expectInvalidTerms(I.TermsField.LEADER);
        c.subscribe(C.VENUE_SODEX, alice, ACCOUNT, _terms());
        assertEq(_subscribeAs(alice, C.VENUE_HYPERLIQUID, alice, ACCOUNT, _terms()), 1);
    }

    function test_subscribe_revertsOnZeroAccount() public {
        vm.prank(alice);
        _expectInvalidTerms(I.TermsField.SODEX_ACCOUNT);
        c.subscribe(C.VENUE_SODEX, leader, 0, _terms());
    }

    function test_subscribe_anyAddressCanBeCopied_noLeaderRole() public {
        // Contracts, precompiles and addresses that never did anything are all valid leaders.
        _subscribeAs(alice, C.VENUE_SODEX, address(c), ACCOUNT, _terms());
        _subscribeAs(alice, C.VENUE_SODEX, address(1), ACCOUNT, _terms());
        _subscribeAs(alice, C.VENUE_HYPERLIQUID, address(type(uint160).max), ACCOUNT, _terms());
        assertEq(c.subscriptionCount(), 3);
    }

    // ------------------------------------------------------------------------------------------------ uniqueness

    function test_subscribe_revertsOnLiveDuplicate() public {
        uint256 id = _subscribeAs(alice, leader);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(I.DuplicateSubscription.selector, id));
        c.subscribe(C.VENUE_SODEX, leader, ACCOUNT, _terms());

        // Paused still counts as live.
        vm.prank(alice);
        c.pauseSubscription(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(I.DuplicateSubscription.selector, id));
        c.subscribe(C.VENUE_SODEX, leader, ACCOUNT, _terms());
    }

    function test_subscribe_sameLeaderOtherAccountVenueOrFollower_isNotADuplicate() public {
        _subscribeAs(alice, leader);
        _subscribeAs(alice, C.VENUE_SODEX, leader, ACCOUNT + 1, _terms());
        _subscribeAs(alice, C.VENUE_HYPERLIQUID, leader, ACCOUNT, _terms());
        _subscribeAs(bob, leader);
        assertEq(c.subscriptionCount(), 4);
    }

    function test_subscribe_afterUnsubscribe_isAllowed() public {
        uint256 id = _subscribeAs(alice, leader);
        vm.prank(alice);
        c.unsubscribe(id, false);
        assertEq(c.liveSubscriptionFor(alice, ACCOUNT, C.VENUE_SODEX, leader), 0);
        uint256 id2 = _subscribeAs(alice, leader);
        assertEq(c.liveSubscriptionFor(alice, ACCOUNT, C.VENUE_SODEX, leader), id2);
    }

    function test_subscribe_afterKillSwitch_isAllowed() public {
        uint256 id = _subscribeAs(alice, leader);
        vm.prank(alice);
        c.unsubscribeAll(false);
        _assertStatus(id, I.Status.STOPPED);
        assertEq(c.liveSubscriptionFor(alice, ACCOUNT, C.VENUE_SODEX, leader), 0);
        uint256 id2 = _subscribeAs(alice, leader);
        assertEq(c.getSubscription(id2).stopEpoch, 1);
        assertEq(c.liveSubscriptionFor(alice, ACCOUNT, C.VENUE_SODEX, leader), id2);
    }

    // ------------------------------------------------------------------------------------------------ terms

    function _expectSubscribeInvalid(I.Terms memory t, I.TermsField field) internal {
        vm.prank(alice);
        _expectInvalidTerms(field);
        c.subscribe(C.VENUE_SODEX, leader, ACCOUNT, t);
    }

    function test_terms_delegatedKey() public {
        I.Terms memory t = _terms();
        t.delegatedKey = address(0);
        _expectSubscribeInvalid(t, I.TermsField.DELEGATED_KEY);
        t.delegatedKey = alice; // the master key is never delegated
        _expectSubscribeInvalid(t, I.TermsField.DELEGATED_KEY);
    }

    function test_terms_keyName() public {
        I.Terms memory t = _terms();
        t.keyName = "";
        _expectSubscribeInvalid(t, I.TermsField.KEY_NAME);
        t.keyName = "default";
        _expectSubscribeInvalid(t, I.TermsField.KEY_NAME);
        t.keyName = "vs 1";
        _expectSubscribeInvalid(t, I.TermsField.KEY_NAME);
        t.keyName = "vs.1";
        _expectSubscribeInvalid(t, I.TermsField.KEY_NAME);
        t.keyName = unicode"vs-é";
        _expectSubscribeInvalid(t, I.TermsField.KEY_NAME);
        t.keyName = "abcdefghijklmnopqrstuvwxyz0123456789X"; // 37
        _expectSubscribeInvalid(t, I.TermsField.KEY_NAME);

        t.keyName = "abcdefghijklmnopqrstuvwxyz0123456789"; // 36: SoDEX's maximum
        _subscribeAs(alice, C.VENUE_SODEX, leader, 1, t);
        t.keyName = "Default"; // only the exact reserved name is rejected
        _subscribeAs(alice, C.VENUE_SODEX, leader, 2, t);
        t.keyName = "_-AZaz09";
        _subscribeAs(alice, C.VENUE_SODEX, leader, 3, t);
        t.keyName = "x";
        _subscribeAs(alice, C.VENUE_SODEX, leader, 4, t);
        assertEq(c.getSubscription(1).keyName, "abcdefghijklmnopqrstuvwxyz0123456789");
    }

    function test_terms_marketScopeAndSizingMode() public {
        I.Terms memory t = _terms();
        t.marketScope = I.MarketScope.NONE;
        _expectSubscribeInvalid(t, I.TermsField.MARKET_SCOPE);
        t = _terms();
        t.sizingMode = I.SizingMode.NONE;
        _expectSubscribeInvalid(t, I.TermsField.SIZING_MODE);
    }

    function test_terms_enumOutOfRange_revertsInDecoding() public {
        // An enum value past the last member is rejected by the ABI decoder before any check.
        bytes memory data = abi.encodeCall(c.subscribe, (C.VENUE_SODEX, leader, ACCOUNT, _terms()));
        // Terms is the 4th argument (a dynamic tuple): head offset at 4 + 3*32; marketScope is its 3rd word.
        uint256 termsStart = 4 + uint256(bytes32(_slice(data, 4 + 96)));
        _setWord(data, termsStart + 64, 4); // MarketScope has 4 members: 0..3
        vm.prank(alice);
        (bool ok,) = address(c).call(data);
        assertFalse(ok);
    }

    function test_terms_allocationLeverageAndNotional() public {
        I.Terms memory t = _terms();
        t.allocationCap = 0;
        _expectSubscribeInvalid(t, I.TermsField.ALLOCATION_CAP);

        t = _terms();
        t.maxLeverage = 0;
        _expectSubscribeInvalid(t, I.TermsField.MAX_LEVERAGE);
        t.marketScope = I.MarketScope.SPOT;
        t.maxLeverage = 2;
        t.maxPositionNotional = t.allocationCap;
        _expectSubscribeInvalid(t, I.TermsField.MAX_LEVERAGE);
        t.maxLeverage = 1;
        _subscribeAs(alice, C.VENUE_SODEX, leader, 1, t);

        t = _terms();
        t.maxPositionNotional = 0;
        _expectSubscribeInvalid(t, I.TermsField.MAX_POSITION_NOTIONAL);
        t.maxPositionNotional = t.allocationCap * t.maxLeverage + 1;
        _expectSubscribeInvalid(t, I.TermsField.MAX_POSITION_NOTIONAL);
        t.maxPositionNotional = t.allocationCap * t.maxLeverage;
        _subscribeAs(alice, C.VENUE_SODEX, leader, 2, t);
    }

    function test_terms_sizingValue() public {
        I.Terms memory t = _terms();
        t.sizingValue = 0;
        _expectSubscribeInvalid(t, I.TermsField.SIZING_VALUE);
        t.sizingMode = I.SizingMode.FIXED_NOTIONAL;
        t.sizingValue = t.maxPositionNotional + 1;
        _expectSubscribeInvalid(t, I.TermsField.SIZING_VALUE);
        t.sizingValue = t.maxPositionNotional;
        _subscribeAs(alice, C.VENUE_SODEX, leader, 1, t);
        // Ratio modes have no upper bound.
        t.sizingMode = I.SizingMode.FIXED_RATIO;
        t.sizingValue = type(uint64).max;
        _subscribeAs(alice, C.VENUE_SODEX, leader, 2, t);
    }

    function test_terms_bpsBounds() public {
        I.Terms memory t = _terms();
        t.tradeStopLossBps = C.MAX_BPS + 1;
        _expectSubscribeInvalid(t, I.TermsField.TRADE_STOP_LOSS);
        t = _terms();
        t.maxDrawdownBps = C.MAX_BPS + 1;
        _expectSubscribeInvalid(t, I.TermsField.MAX_DRAWDOWN);
        t = _terms();
        t.slippageBps = 0;
        _expectSubscribeInvalid(t, I.TermsField.SLIPPAGE);
        t.slippageBps = C.MAX_BPS + 1;
        _expectSubscribeInvalid(t, I.TermsField.SLIPPAGE);

        t = _terms();
        t.tradeStopLossBps = 0; // off
        t.maxDrawdownBps = 0; // off
        t.takeProfitBps = 0; // off
        t.slippageBps = 1;
        _subscribeAs(alice, C.VENUE_SODEX, leader, 1, t);
        t.tradeStopLossBps = C.MAX_BPS;
        t.maxDrawdownBps = C.MAX_BPS;
        t.takeProfitBps = type(uint32).max; // no upper bound
        t.slippageBps = C.MAX_BPS;
        _subscribeAs(alice, C.VENUE_SODEX, leader, 2, t);
    }

    function test_terms_symbols() public {
        I.Terms memory t = _terms();
        t.symbols = _symbols2(); // ALL with a list
        _expectSubscribeInvalid(t, I.TermsField.SYMBOL_MODE);

        t = _terms();
        t.symbolMode = I.SymbolMode.ALLOW; // ALLOW with no list
        _expectSubscribeInvalid(t, I.TermsField.SYMBOLS);
        t.symbolMode = I.SymbolMode.DENY;
        _expectSubscribeInvalid(t, I.TermsField.SYMBOLS);

        string[] memory bad = new string[](2);
        bad[0] = "BTC-USD";
        bad[1] = "";
        t.symbols = bad;
        _expectSubscribeInvalid(t, I.TermsField.SYMBOLS);
        bad[1] = "ETH USD"; // space (0x20) is not printable ASCII 0x21..0x7E
        _expectSubscribeInvalid(t, I.TermsField.SYMBOLS);
        bad[1] = "ETH\x7fUSD";
        _expectSubscribeInvalid(t, I.TermsField.SYMBOLS);
        bad[1] = unicode"ÉTH";
        _expectSubscribeInvalid(t, I.TermsField.SYMBOLS);

        bad[1] = "!~"; // both ends of the range
        _subscribeAs(alice, C.VENUE_SODEX, leader, 1, t);
        assertEq(c.getSubscription(1).symbolsHash, E.hashStrings(bad));
    }

    function test_terms_builderFeeCaps() public {
        I.Terms memory t = _terms();
        t.maxBuilderFeePerps = C.PERPS_BUILDER_FEE_CAP + 1;
        _expectSubscribeInvalid(t, I.TermsField.BUILDER_FEE_PERPS);
        t = _terms();
        t.maxBuilderFeeSpot = C.SPOT_BUILDER_FEE_CAP + 1;
        _expectSubscribeInvalid(t, I.TermsField.BUILDER_FEE_SPOT);
        t = _terms();
        t.maxBuilderFeePerps = C.PERPS_BUILDER_FEE_CAP;
        t.maxBuilderFeeSpot = C.SPOT_BUILDER_FEE_CAP;
        _subscribeAs(alice, C.VENUE_SODEX, leader, 1, t);
        t.maxBuilderFeePerps = 0;
        t.maxBuilderFeeSpot = 0;
        _subscribeAs(alice, C.VENUE_SODEX, leader, 2, t);
    }

    function test_terms_expiry() public {
        I.Terms memory t = _terms();
        t.expiry = uint40(T0);
        _expectSubscribeInvalid(t, I.TermsField.EXPIRY);
        t.expiry = uint40(T0 - 1);
        _expectSubscribeInvalid(t, I.TermsField.EXPIRY);
        t.expiry = uint40(T0 + 1);
        _subscribeAs(alice, C.VENUE_SODEX, leader, 1, t);
        // No lifetime cap: never, or any future time.
        t.expiry = 0;
        _subscribeAs(alice, C.VENUE_SODEX, leader, 2, t);
        t.expiry = type(uint40).max;
        _subscribeAs(alice, C.VENUE_SODEX, leader, 3, t);
    }

    // ------------------------------------------------------------------------------------------------ no limits

    function test_noLimit_subscriptionsPerFollower() public {
        for (uint64 i = 1; i <= 60; ++i) {
            _subscribeAs(alice, C.VENUE_SODEX, leader, i, _terms());
        }
        (, uint256 total) = c.liveSubscriptionsOfFollower(alice, 0, 0);
        assertEq(total, 60);
    }

    function test_noLimit_symbolsCountAndLength() public {
        I.Terms memory t = _terms();
        t.symbolMode = I.SymbolMode.DENY;
        t.symbols = new string[](300);
        for (uint256 i = 0; i < 300; ++i) {
            t.symbols[i] = string.concat("SYM", vm.toString(i), "-USD");
        }
        t.symbols[299] = "A-VERY-LONG-SYMBOL-NAME-THAT-IS-FAR-LONGER-THAN-THIRTY-TWO-BYTES-USD";
        uint256 id = _subscribeAs(alice, C.VENUE_SODEX, leader, ACCOUNT, t);
        assertEq(c.getSubscription(id).symbolsHash, E.hashStrings(t.symbols));
    }

    function test_noLimit_leverage() public {
        I.Terms memory t = _terms();
        t.maxLeverage = type(uint8).max;
        t.maxPositionNotional = t.allocationCap * 255;
        _subscribeAs(alice, C.VENUE_SODEX, leader, ACCOUNT, t);
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _slice(bytes memory data, uint256 pos) internal pure returns (bytes32 word) {
        assembly ("memory-safe") {
            word := mload(add(add(data, 32), pos))
        }
    }

    function _setWord(bytes memory data, uint256 pos, uint256 value) internal pure {
        assembly ("memory-safe") {
            mstore(add(add(data, 32), pos), value)
        }
    }
}
