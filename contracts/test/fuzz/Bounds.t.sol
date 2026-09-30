// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {IValuescanCopyTrading as I, CopyTradingConstants as C} from "../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingBase} from "../utils/CopyTradingBase.sol";
import {CopyTradingEIP712 as E} from "../utils/CopyTradingEIP712.sol";

/// @notice Fuzz tests on every bound: each Terms field is fuzzed on its own (the others valid) and the contract must
///         accept exactly the values the spec allows and report exactly that field otherwise. Plus builder terms,
///         effective fees, pagination, nonces, deadlines and commitment epochs.
contract BoundsFuzzTest is CopyTradingBase {
    uint64 internal account = 1;

    /// @dev Subscribes as alice into a fresh account (so uniqueness never interferes). Returns success and revert data.
    function _try(I.Terms memory t) internal returns (bool ok, bytes memory err) {
        vm.prank(alice);
        (ok, err) = address(c).call(abi.encodeCall(c.subscribe, (C.VENUE_SODEX, leader, account++, t)));
    }

    function _check(I.Terms memory t, bool valid, I.TermsField field) internal {
        (bool ok, bytes memory err) = _try(t);
        if (valid) {
            assertTrue(ok, "valid terms rejected");
        } else {
            assertFalse(ok, "invalid terms accepted");
            assertEq(err, abi.encodeWithSelector(I.InvalidTerms.selector, field), "wrong field reported");
        }
    }

    // ------------------------------------------------------------------------------------------------ terms fields

    function testFuzz_keyName_randomBytes(bytes memory name) public {
        vm.assume(name.length <= 64);
        bool valid = name.length >= 1 && name.length <= 36 && keccak256(name) != keccak256("default");
        for (uint256 i = 0; i < name.length && valid; ++i) {
            bytes1 b = name[i];
            valid = (b >= "0" && b <= "9") || (b >= "A" && b <= "Z") || (b >= "a" && b <= "z") || b == "_" || b == "-";
        }
        I.Terms memory t = _terms();
        t.keyName = string(name);
        _check(t, valid, I.TermsField.KEY_NAME);
    }

    function testFuzz_keyName_fromCharset(uint256 seed, uint8 len) public {
        bytes memory charset = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-";
        len = uint8(bound(len, 0, 45));
        bytes memory name = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            name[i] = charset[uint256(keccak256(abi.encode(seed, i))) % charset.length];
        }
        I.Terms memory t = _terms();
        t.keyName = string(name);
        _check(t, len >= 1 && len <= 36, I.TermsField.KEY_NAME);
    }

    function testFuzz_delegatedKey(address key) public {
        I.Terms memory t = _terms();
        t.delegatedKey = key;
        _check(t, key != address(0) && key != alice, I.TermsField.DELEGATED_KEY);
    }

    function testFuzz_allocationLeverageNotional(uint64 cap, uint8 leverage, uint64 maxPosition, bool spot) public {
        I.Terms memory t = _terms();
        t.marketScope = spot ? I.MarketScope.SPOT : I.MarketScope.PERPS;
        t.allocationCap = cap;
        t.maxLeverage = leverage;
        t.maxPositionNotional = maxPosition;
        t.sizingValue = 1; // PROPORTIONAL: any positive value
        if (cap == 0) return _check(t, false, I.TermsField.ALLOCATION_CAP);
        if (leverage == 0 || (spot && leverage != 1)) return _check(t, false, I.TermsField.MAX_LEVERAGE);
        bool okPosition = maxPosition != 0 && uint256(maxPosition) <= uint256(cap) * leverage;
        _check(t, okPosition, I.TermsField.MAX_POSITION_NOTIONAL);
    }

    function testFuzz_sizing(uint8 modeSeed, uint64 value, uint64 maxPosition) public {
        I.SizingMode mode = I.SizingMode(bound(modeSeed, 1, 3));
        maxPosition = uint64(bound(maxPosition, 1, 5_000_000_000)); // within cap x leverage of _terms()
        I.Terms memory t = _terms();
        t.sizingMode = mode;
        t.sizingValue = value;
        t.maxPositionNotional = maxPosition;
        bool valid = value != 0 && (mode != I.SizingMode.FIXED_NOTIONAL || value <= maxPosition);
        _check(t, valid, I.TermsField.SIZING_VALUE);
    }

    function testFuzz_stopLoss(uint16 v) public {
        I.Terms memory t = _terms();
        t.tradeStopLossBps = v;
        _check(t, v <= C.MAX_BPS, I.TermsField.TRADE_STOP_LOSS);
    }

    function testFuzz_drawdown(uint16 v) public {
        I.Terms memory t = _terms();
        t.maxDrawdownBps = v;
        _check(t, v <= C.MAX_BPS, I.TermsField.MAX_DRAWDOWN);
    }

    function testFuzz_takeProfit_unbounded(uint32 v) public {
        I.Terms memory t = _terms();
        t.takeProfitBps = v;
        _check(t, true, I.TermsField.TRADE_STOP_LOSS);
    }

    function testFuzz_slippage(uint16 v) public {
        I.Terms memory t = _terms();
        t.slippageBps = v;
        _check(t, v != 0 && v <= C.MAX_BPS, I.TermsField.SLIPPAGE);
    }

    function testFuzz_symbolModeAndCount(uint8 modeSeed, uint8 count) public {
        I.SymbolMode mode = I.SymbolMode(bound(modeSeed, 0, 2));
        count = uint8(bound(count, 0, 40));
        I.Terms memory t = _terms();
        t.symbolMode = mode;
        t.symbols = new string[](count);
        for (uint256 i = 0; i < count; ++i) {
            t.symbols[i] = string.concat("S", vm.toString(i));
        }
        if (mode == I.SymbolMode.ALL) return _check(t, count == 0, I.TermsField.SYMBOL_MODE);
        _check(t, count != 0, I.TermsField.SYMBOLS);
    }

    function testFuzz_symbolContent(bytes memory symbol) public {
        vm.assume(symbol.length <= 80);
        bool valid = symbol.length != 0;
        for (uint256 i = 0; i < symbol.length && valid; ++i) {
            valid = uint8(symbol[i]) >= 0x21 && uint8(symbol[i]) <= 0x7e;
        }
        I.Terms memory t = _terms();
        t.symbolMode = I.SymbolMode.DENY;
        t.symbols = new string[](2);
        t.symbols[0] = "BTC-USD";
        t.symbols[1] = string(symbol);
        (bool ok, bytes memory err) = _try(t);
        if (valid) {
            assertTrue(ok);
            assertEq(c.getSubscription(c.subscriptionCount()).symbolsHash, E.hashStrings(t.symbols));
        } else {
            assertFalse(ok);
            assertEq(err, abi.encodeWithSelector(I.InvalidTerms.selector, I.TermsField.SYMBOLS));
        }
    }

    function testFuzz_builderFeeConsent(uint16 perps, uint16 spot) public {
        I.Terms memory t = _terms();
        t.maxBuilderFeePerps = perps;
        t.maxBuilderFeeSpot = spot;
        if (perps > C.PERPS_BUILDER_FEE_CAP) return _check(t, false, I.TermsField.BUILDER_FEE_PERPS);
        _check(t, spot <= C.SPOT_BUILDER_FEE_CAP, I.TermsField.BUILDER_FEE_SPOT);
    }

    function testFuzz_expiry(uint40 expiry, uint32 elapsed) public {
        vm.warp(T0 + elapsed);
        I.Terms memory t = _terms();
        t.expiry = expiry;
        _check(t, expiry == 0 || expiry > T0 + elapsed, I.TermsField.EXPIRY);
    }

    function testFuzz_leaderAndAccount(address leader_, uint64 acct, bool hyperliquid) public {
        uint8 venue = hyperliquid ? C.VENUE_HYPERLIQUID : C.VENUE_SODEX;
        vm.prank(alice);
        (bool ok, bytes memory err) = address(c).call(abi.encodeCall(c.subscribe, (venue, leader_, acct, _terms())));
        if (leader_ == address(0) || (!hyperliquid && leader_ == alice)) {
            assertEq(err, abi.encodeWithSelector(I.InvalidTerms.selector, I.TermsField.LEADER));
        } else if (acct == 0) {
            assertEq(err, abi.encodeWithSelector(I.InvalidTerms.selector, I.TermsField.SODEX_ACCOUNT));
        } else {
            assertTrue(ok);
        }
    }

    function testFuzz_venue(uint8 venue, bool enabled) public {
        vm.assume(venue != 0);
        vm.prank(owner);
        c.setVenue(venue, enabled, "V");
        vm.prank(alice);
        (bool ok, bytes memory err) = address(c).call(abi.encodeCall(c.subscribe, (venue, leader, ACCOUNT, _terms())));
        if (enabled) assertTrue(ok);
        else assertEq(err, abi.encodeWithSelector(I.VenueDisabled.selector, venue));
    }

    // ------------------------------------------------------------------------------------------------ fees

    function testFuzz_setBuilderTerms(uint64 builderId, uint16 perps, uint16 spot) public {
        bool valid = builderId != 0 && perps <= C.PERPS_BUILDER_FEE_CAP && spot <= C.SPOT_BUILDER_FEE_CAP;
        vm.prank(owner);
        (bool ok, bytes memory err) = address(c).call(abi.encodeCall(c.setBuilderTerms, (builderId, perps, spot)));
        assertEq(ok, valid);
        if (!valid) assertEq(err, abi.encodeWithSelector(I.InvalidBuilderTerms.selector));
        else assertEq(c.builderTerms().builderId, builderId);
    }

    /// @dev Whatever the owner does, no follower's effective fee ever exceeds its consent or the current fee.
    function testFuzz_effectiveFee_isMinOfConsentAndCurrent(
        uint16 consentPerps,
        uint16 consentSpot,
        uint16 feePerps,
        uint16 feeSpot
    ) public {
        consentPerps = uint16(bound(consentPerps, 0, C.PERPS_BUILDER_FEE_CAP));
        consentSpot = uint16(bound(consentSpot, 0, C.SPOT_BUILDER_FEE_CAP));
        feePerps = uint16(bound(feePerps, 0, C.PERPS_BUILDER_FEE_CAP));
        feeSpot = uint16(bound(feeSpot, 0, C.SPOT_BUILDER_FEE_CAP));
        I.Terms memory t = _terms();
        t.maxBuilderFeePerps = consentPerps;
        t.maxBuilderFeeSpot = consentSpot;
        uint256 id = _subscribeAs(alice, C.VENUE_SODEX, leader, ACCOUNT, t);
        vm.prank(owner);
        c.setBuilderTerms(BUILDER_ID, feePerps, feeSpot);
        (, uint16 perps, uint16 spot) = c.effectiveBuilderFee(id);
        assertEq(perps, consentPerps < feePerps ? consentPerps : feePerps);
        assertEq(spot, consentSpot < feeSpot ? consentSpot : feeSpot);
        assertLe(perps, consentPerps);
        assertLe(spot, consentSpot);
    }

    // ------------------------------------------------------------------------------------------------ pagination

    function testFuzz_pagination(uint8 n, uint256 offset, uint256 limit) public {
        n = uint8(bound(n, 0, 25));
        for (uint64 i = 1; i <= n; ++i) {
            _subscribeAs(alice, C.VENUE_SODEX, leader, i, _terms());
        }
        (uint256[] memory ids, uint256 total) = c.subscriptionsOfFollower(alice, offset, limit);
        assertEq(total, n);
        uint256 expectedLen = offset >= n ? 0 : (limit < n - offset ? limit : n - offset);
        assertEq(ids.length, expectedLen);
        for (uint256 i = 0; i < ids.length; ++i) {
            assertEq(ids[i], offset + i + 1);
        }
        (ids, total) = c.liveSubscriptionsOfFollower(alice, offset, limit);
        assertEq(total, n);
        assertEq(ids.length, expectedLen);
        (ids, total) = c.subscriptionsOfLeader(C.VENUE_SODEX, leader, offset, limit);
        assertEq(total, n);
        assertEq(ids.length, expectedLen);
    }

    // ------------------------------------------------------------------------------------------------ nonces etc.

    function testFuzz_anyNonce_worksExactlyOnce(uint256 nonce) public {
        uint256 deadline = T0 + 1;
        I.SignatureParams memory sig = _unsubscribeAllSig(aliceKey, alice, false, nonce, deadline);
        assertFalse(c.isNonceUsed(alice, nonce));
        vm.prank(relayer);
        c.unsubscribeAllWithSig(alice, false, sig);
        assertTrue(c.isNonceUsed(alice, nonce));
        assertEq(c.nonceBitmap(alice, nonce >> 8), 1 << (nonce & 0xff));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.NonceAlreadyUsed.selector, alice, nonce));
        c.unsubscribeAllWithSig(alice, false, sig);
    }

    function testFuzz_invalidateNonces(uint256 word, uint256 mask, uint8 bit) public {
        vm.prank(alice);
        c.invalidateNonces(word, mask);
        assertEq(c.nonceBitmap(alice, word), mask);
        uint256 nonce = (word << 8) | bit;
        if (word <= type(uint256).max >> 8) assertEq(c.isNonceUsed(alice, nonce), (mask >> bit) & 1 == 1);
    }

    function testFuzz_deadline(uint256 deadline, uint32 elapsed) public {
        vm.warp(T0 + elapsed);
        I.SignatureParams memory sig = _unsubscribeAllSig(aliceKey, alice, false, 1, deadline);
        vm.prank(relayer);
        (bool ok, bytes memory err) = address(c).call(abi.encodeCall(c.unsubscribeAllWithSig, (alice, false, sig)));
        assertEq(ok, T0 + elapsed <= deadline);
        if (!ok) assertEq(err, abi.encodeWithSelector(I.SignatureExpired.selector, deadline));
    }

    function testFuzz_commitEpochs_strictlyIncrease(uint64 first, uint64 second) public {
        vm.assume(first != 0);
        vm.prank(executor);
        c.commitExecutions(first, bytes32(uint256(1)), 1, "a");
        vm.prank(executor);
        (bool ok,) = address(c).call(abi.encodeCall(c.commitExecutions, (second, bytes32(uint256(2)), 2, "b")));
        assertEq(ok, second > first);
        assertEq(c.commitment(executor, first).merkleRoot, bytes32(uint256(1))); // commitments are immutable
        assertEq(c.executorInfo(executor).lastEpoch, ok ? second : first);
    }
}
