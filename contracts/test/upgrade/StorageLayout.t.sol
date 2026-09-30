// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {IValuescanCopyTrading as I, CopyTradingConstants as C} from "../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingBase} from "../utils/CopyTradingBase.sol";

/// @notice Storage-layout guard, part 1 (part 2 is `node tools/storage-layout.mjs check` against the committed
///         snapshot). Pins the ERC-7201 root and the raw slot and packing of every member of the namespace, and the
///         OpenZeppelin namespaces, by writing through the public API and reading raw storage. Reordering, retyping,
///         removing or inserting a member moves data and fails here; appending does not.
contract StorageLayoutTest is CopyTradingBase {
    bytes32 internal constant ROOT = 0xc3b2bc2cf6fc6db46d2b311dd8531e2120cf7207f8eeaaf9015bcf1d32c6bf00;
    bytes32 internal constant OZ_OWNABLE = 0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199300;
    bytes32 internal constant OZ_OWNABLE2STEP = 0x237e158222e3e6968b72b9db0d8043aacf074ad9f650f0d1606b4d82ee432c00;
    bytes32 internal constant OZ_PAUSABLE = 0xcd5ed15c6e187e77e9aee88184c21f4f2182ab5827cb3b7e07fbedcd63f03300;
    bytes32 internal constant OZ_INITIALIZABLE = 0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00;
    bytes32 internal constant OZ_EIP712 = 0xa16a46d94261c7517cc8ff89f61c0ce93598e3c849801011dee649a6a557d100;

    function _erc7201(string memory id) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint256(keccak256(bytes(id))) - 1)) & ~bytes32(uint256(0xff));
    }

    function _member(uint256 index) internal pure returns (bytes32) {
        return bytes32(uint256(ROOT) + index);
    }

    function _mapSlot(bytes32 key, bytes32 slot) internal pure returns (bytes32) {
        return keccak256(abi.encode(key, slot));
    }

    function _load(bytes32 slot) internal view returns (uint256) {
        return uint256(vm.load(address(c), slot));
    }

    function test_namespaceRoots() public pure {
        assertEq(_erc7201("valuescan.storage.CopyTrading"), ROOT);
        assertEq(_erc7201("openzeppelin.storage.Ownable"), OZ_OWNABLE);
        assertEq(_erc7201("openzeppelin.storage.Ownable2Step"), OZ_OWNABLE2STEP);
        assertEq(_erc7201("openzeppelin.storage.Pausable"), OZ_PAUSABLE);
        assertEq(_erc7201("openzeppelin.storage.Initializable"), OZ_INITIALIZABLE);
        assertEq(_erc7201("openzeppelin.storage.EIP712"), OZ_EIP712);
    }

    function test_openZeppelinNamespaces() public {
        assertEq(address(uint160(_load(OZ_OWNABLE))), owner);
        assertEq(_load(OZ_INITIALIZABLE), 1); // _initialized = 1, _initializing = false
        assertEq(_load(OZ_PAUSABLE), 0);
        vm.prank(owner);
        c.pause();
        assertEq(_load(OZ_PAUSABLE), 1);
        vm.prank(owner);
        c.transferOwnership(stranger);
        assertEq(address(uint160(_load(OZ_OWNABLE2STEP))), stranger);
        // The EIP-712 domain is pinned in code: its namespace stays empty.
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(_load(bytes32(uint256(OZ_EIP712) + i)), 0);
        }
        assertEq(address(uint160(_load(ERC1967Utils.IMPLEMENTATION_SLOT))), address(impl));
        // The implementation is locked: _initialized = type(uint64).max.
        assertEq(uint256(vm.load(address(impl), OZ_INITIALIZABLE)), type(uint64).max);
    }

    /// Audit SEC-01: the compiler's layout describes an enum only by its name and size, so the raw-slot test below
    /// cannot see a renumbering. Every member of every stored enum (and of the ABI enums) is pinned here; members may
    /// only be appended. `node tools/storage-layout.mjs check` enforces the same rule against the snapshot.
    function test_enumOrdinalsArePinned() public pure {
        assertEq(uint8(I.Status.NONE), 0);
        assertEq(uint8(I.Status.ACTIVE), 1);
        assertEq(uint8(I.Status.PAUSED), 2);
        assertEq(uint8(I.Status.STOPPED), 3);
        assertEq(uint8(type(I.Status).max), 3, "Status: append new members after STOPPED only");
        assertEq(uint8(I.MarketScope.NONE), 0);
        assertEq(uint8(I.MarketScope.PERPS), 1);
        assertEq(uint8(I.MarketScope.SPOT), 2);
        assertEq(uint8(I.MarketScope.PERPS_AND_SPOT), 3);
        assertEq(uint8(type(I.MarketScope).max), 3);
        assertEq(uint8(I.SizingMode.NONE), 0);
        assertEq(uint8(I.SizingMode.PROPORTIONAL), 1);
        assertEq(uint8(I.SizingMode.FIXED_RATIO), 2);
        assertEq(uint8(I.SizingMode.FIXED_NOTIONAL), 3);
        assertEq(uint8(type(I.SizingMode).max), 3);
        assertEq(uint8(I.SymbolMode.ALL), 0);
        assertEq(uint8(I.SymbolMode.ALLOW), 1);
        assertEq(uint8(I.SymbolMode.DENY), 2);
        assertEq(uint8(type(I.SymbolMode).max), 2);
        // Not stored, but ABI (events, errors, views) and mirrored by the TypeScript bindings.
        assertEq(uint8(I.StopReason.FOLLOWER), 0);
        assertEq(uint8(I.StopReason.KILL_SWITCH), 1);
        assertEq(uint8(I.TermsField.LEADER), 0);
        assertEq(uint8(I.TermsField.SYMBOLS), 14);
        assertEq(uint8(I.TermsField.EXPIRY), 17);
        assertEq(uint8(type(I.TermsField).max), 17);
    }

    function test_noSequentialStorage() public view {
        for (uint256 i = 0; i < 64; ++i) {
            assertEq(_load(bytes32(i)), 0);
        }
    }

    function test_memberSlotsAndPacking() public {
        vm.warp(T0 + 7);
        I.Terms memory t = _termsAllow();
        t.copyExisting = true;
        t.expiry = uint40(T0 + 100);
        uint256 id = _subscribeAs(alice, C.VENUE_HYPERLIQUID, leader, ACCOUNT, t);
        vm.prank(alice);
        c.pauseSubscription(id); // version 2, status PAUSED

        // 0: subscriptionCount
        assertEq(_load(_member(0)), 1);

        // 1: subscriptions[id], a 7-slot struct
        bytes32 s = _mapSlot(bytes32(id), _member(1));
        uint256 w0 = _load(s);
        assertEq(address(uint160(w0)), alice, "follower");
        assertEq(uint8(w0 >> 160), uint8(I.Status.PAUSED), "status");
        assertEq(uint8(w0 >> 168), C.VENUE_HYPERLIQUID, "venue");
        assertEq(uint8(w0 >> 176), uint8(I.MarketScope.PERPS), "marketScope");
        assertEq(uint8(w0 >> 184), uint8(I.SizingMode.PROPORTIONAL), "sizingMode");
        assertEq(uint8(w0 >> 192), uint8(I.SymbolMode.ALLOW), "symbolMode");
        assertEq(uint8(w0 >> 200), 1, "copyExisting");
        assertEq(uint8(w0 >> 208), t.maxLeverage, "maxLeverage");
        assertEq(uint8(w0 >> 216), 0, "closePositions");
        assertEq(uint32(w0 >> 224), 2, "version");
        uint256 w1 = _load(bytes32(uint256(s) + 1));
        assertEq(address(uint160(w1)), leader, "leader");
        assertEq(uint40(w1 >> 160), T0 + 7, "createdAt");
        assertEq(uint40(w1 >> 200), T0 + 7, "updatedAt");
        assertEq(uint16(w1 >> 240), t.slippageBps, "slippageBps");
        uint256 w2 = _load(bytes32(uint256(s) + 2));
        assertEq(address(uint160(w2)), delegatedKey, "delegatedKey");
        assertEq(uint40(w2 >> 160), T0 + 100, "expiry");
        assertEq(uint32(w2 >> 200), t.takeProfitBps, "takeProfitBps");
        assertEq(uint16(w2 >> 232), t.tradeStopLossBps, "tradeStopLossBps");
        uint256 w3 = _load(bytes32(uint256(s) + 3));
        assertEq(uint64(w3), ACCOUNT, "sodexAccountId");
        assertEq(uint64(w3 >> 64), 0, "stopEpoch");
        assertEq(uint64(w3 >> 128), t.sizingValue, "sizingValue");
        assertEq(uint16(w3 >> 192), t.maxDrawdownBps, "maxDrawdownBps");
        assertEq(uint16(w3 >> 208), t.maxBuilderFeePerps, "maxBuilderFeePerps");
        assertEq(uint16(w3 >> 224), t.maxBuilderFeeSpot, "maxBuilderFeeSpot");
        uint256 w4 = _load(bytes32(uint256(s) + 4));
        assertEq(uint64(w4), t.allocationCap, "allocationCap");
        assertEq(uint64(w4 >> 64), t.maxPositionNotional, "maxPositionNotional");
        assertEq(bytes32(_load(bytes32(uint256(s) + 5))), c.getSubscription(id).symbolsHash, "symbolsHash");
        // keyName: short string, data left-aligned and length * 2 in the lowest byte.
        uint256 w6 = _load(bytes32(uint256(s) + 6));
        assertEq(w6 & 0xff, bytes(t.keyName).length * 2, "keyName length");
        assertEq(bytes32(w6 & ~uint256(0xff)), bytes32(bytes(t.keyName)), "keyName data");
        assertEq(_load(bytes32(uint256(s) + 7)), 0, "nothing after keyName");

        // 2: followerHistory[alice] (uint256[])
        bytes32 fh = _mapSlot(bytes32(uint256(uint160(alice))), _member(2));
        assertEq(_load(fh), 1);
        assertEq(_load(keccak256(abi.encode(fh))), id);

        // 3: leaderHistory[venue][leader]
        bytes32 lh =
            _mapSlot(bytes32(uint256(uint160(leader))), _mapSlot(bytes32(uint256(C.VENUE_HYPERLIQUID)), _member(3)));
        assertEq(_load(lh), 1);
        assertEq(_load(keccak256(abi.encode(lh))), id);

        // 4: followerLive[alice][0] (EnumerableSet: _values array, then _positions mapping)
        bytes32 fl = _mapSlot(bytes32(uint256(0)), _mapSlot(bytes32(uint256(uint160(alice))), _member(4)));
        assertEq(_load(fl), 1);
        assertEq(_load(keccak256(abi.encode(fl))), id);
        assertEq(_load(_mapSlot(bytes32(id), bytes32(uint256(fl) + 1))), 1); // position = index + 1

        // 5: liveByKey[keccak(follower, account, venue, leader)]: the last id created for the key, never cleared
        bytes32 key = keccak256(abi.encode(alice, ACCOUNT, C.VENUE_HYPERLIQUID, leader));
        assertEq(_load(_mapSlot(key, _member(5))), id);
        assertEq(c.lastSubscriptionFor(alice, ACCOUNT, C.VENUE_HYPERLIQUID, leader), id);

        // 6: stopEpoch[alice] and 7: killSwitches[alice][1]
        vm.warp(T0 + 9);
        vm.prank(alice);
        c.unsubscribeAll(true);
        assertEq(_load(_mapSlot(bytes32(uint256(uint160(alice))), _member(6))), 1);
        uint256 k = _load(_mapSlot(bytes32(uint256(1)), _mapSlot(bytes32(uint256(uint160(alice))), _member(7))));
        assertEq(uint40(k), T0 + 9, "triggeredAt");
        assertEq(uint8(k >> 40), 1, "closePositions");

        // 8: executors[executor] and 9: commitments[executor][epoch]
        vm.prank(executor);
        c.commitExecutions(77, bytes32(uint256(0xabc)), 5, "u");
        uint256 x = _load(_mapSlot(bytes32(uint256(uint160(executor))), _member(8)));
        assertEq(uint8(x), 1, "authorised");
        assertEq(uint40(x >> 8), T0, "updatedAt");
        assertEq(uint64(x >> 48), 77, "lastEpoch");
        bytes32 cm = _mapSlot(bytes32(uint256(77)), _mapSlot(bytes32(uint256(uint160(executor))), _member(9)));
        assertEq(_load(cm), 0xabc, "merkleRoot");
        uint256 cm1 = _load(bytes32(uint256(cm) + 1));
        assertEq(uint32(cm1), 5, "count");
        assertEq(uint40(cm1 >> 32), T0 + 9, "committedAt");

        // 10: venues[1]
        bytes32 v = _mapSlot(bytes32(uint256(C.VENUE_SODEX)), _member(10));
        assertEq(_load(v), 1, "enabled");
        assertEq(_load(bytes32(uint256(v) + 1)), uint256(bytes32("SoDEX")) | (5 * 2), "name");

        // 11: nonceBitmap[alice][2]
        vm.prank(alice);
        c.invalidateNonces(2, 0x55);
        assertEq(_load(_mapSlot(bytes32(uint256(2)), _mapSlot(bytes32(uint256(uint160(alice))), _member(11)))), 0x55);

        // 12: builderTerms (inline, last member)
        uint256 b = _load(_member(12));
        assertEq(uint64(b), BUILDER_ID, "builderId");
        assertEq(uint16(b >> 64), PERPS_FEE, "perpsFee");
        assertEq(uint16(b >> 80), SPOT_FEE, "spotFee");
        assertEq(uint40(b >> 96), T0, "builder updatedAt");

        // The kill switch left the key's last id in place (SEC-04: it binds signed Subscribes).
        assertEq(_load(_mapSlot(key, _member(5))), id);

        // Nothing is stored past the last member.
        assertEq(_load(_member(13)), 0);
    }
}
