// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Vm} from "forge-std/Vm.sol";
import {ValuescanCopyTrading} from "../../../src/ValuescanCopyTrading.sol";
import {IValuescanCopyTrading as I, CopyTradingConstants as C} from "../../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingBase} from "../../utils/CopyTradingBase.sol";
import {CopyTradingEIP712 as E} from "../../utils/CopyTradingEIP712.sol";

/// @notice AUDIT (DoS lens): griefing a leader's followers with spam subscriptions, and what it costs on ValueChain.
///
///         On-chain, spam is harmless: no call iterates over a stored list (see ComplexityGuards.t.sol), so nobody
///         else's transaction gets more expensive. The cost lands OFF-chain, on ValueDesk's executor, relayer and
///         indexer, which the spec (section 8.3) makes consume every subscription of a leader:
///         - "Per leader event. For each subscription of that (venue, leader) in the model that is copyable ... or
///           PAUSED" -> the fan-out per leader fill is O(all subscriptions of that leader), spam included;
///         - preflight fails for a fake SoDEX account, and the spec says to "re-check at most every 60 s" -> a
///           recurring SoDEX/ValueChain lookup per spam subscription, forever (spam never expires: expiry 0 = never);
///         - the executor must hash every `Subscribed` symbol list against `symbolsHash`;
///         - the hourly reconciliation reads every subscription through views.
///         The contract gives the executor no on-chain way to tell spam from a real follower: anyone can copy any
///         address, from any number of free addresses, into any number of arbitrary (fake) `sodexAccountId`s, and a
///         key-only attacker can have ValueDesk's own relayer pay the gas.
///
///         Numbers use the README's ValueChain probe: eth_gasPrice 2,000,000 wei (0.002 gwei), block gas limit 30M.
///         Sustained rates use the EIP-1559 gas TARGET (15M, geth's default elasticity 2): above it the base fee rises
///         12.5 % per block, so an attacker who wants the price to stay at 0.002 gwei stays at or below the target.
///         Gas figures are TRANSACTION gas: Foundry 1.8.3 runs every top-level CALL from a test as its own transaction
///         and `lastCallGas().gasTotalUsed` reports 21,000 + calldata (EIP-7623 floor-priced when data-heavy, as on
///         Prague) + execution. GasAccounting.t.sol proves this.
contract LeaderSpamTest is CopyTradingBase {
    uint256 internal constant GAS_PRICE_WEI = 2_000_000;
    uint256 internal constant BLOCK_GAS = 30_000_000;
    uint256 internal constant TARGET_GAS = 15_000_000; // EIP-1559 target: sustainable without raising the base fee
    uint256 internal constant BLOCKS_PER_DAY = 43_200; // ~2 s blocks
    uint256 internal constant RPC_GAS_CAP = 50_000_000; // geth's default eth_call gas cap
    uint256 internal constant SOSO = 1e18;

    address internal attacker = makeAddr("attacker (holds no SOSO)");

    function setUp() public override {
        _skipUnderCoverage();
        super.setUp();
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _fakeTerms(uint256 i) internal pure returns (I.Terms memory t) {
        // Valid on-chain, meaningless off-chain: a key nobody registered on SoDEX, any name, huge caps.
        t.delegatedKey = address(uint160(uint256(keccak256(abi.encode("fake key", i)))));
        t.keyName = "x";
        t.marketScope = I.MarketScope.PERPS_AND_SPOT;
        t.sizingMode = I.SizingMode.FIXED_RATIO;
        t.sizingValue = type(uint64).max;
        t.allocationCap = type(uint64).max;
        t.maxPositionNotional = type(uint64).max;
        t.maxLeverage = 1;
        t.slippageBps = C.MAX_BPS;
        t.maxBuilderFeePerps = 0; // no builder fee consent: nothing for ValueDesk to earn, only work
        t.maxBuilderFeeSpot = 0;
        t.expiry = 0; // never expires: the executor keeps re-checking it forever
    }

    // ------------------------------------------------------------------------------------------------ proofs

    /// One address, zero stake: N copyable subscriptions to one leader, with fake SoDEX account ids 1..N.
    function test_oneAddress_attachesUnlimitedCopyableSubscriptionsToAnyLeader() public {
        uint256 real = _subscribeAs(alice, leader); // a genuine follower of the leader
        uint64 n = 500;
        uint256 txTotal;
        for (uint64 i = 1; i <= n; ++i) {
            vm.prank(attacker);
            c.subscribe(C.VENUE_SODEX, leader, i, _fakeTerms(i));
            txTotal += vm.lastCallGas().gasTotalUsed; // transaction gas (see the contract comment)
        }
        (, uint256 total) = c.subscriptionsOfLeader(C.VENUE_SODEX, leader, 0, 0);
        assertEq(total, n + 1, "every spam subscription is indexed under the leader");
        (, uint256 attackerLive) = c.liveSubscriptionsOfFollower(attacker, 0, 0);
        assertEq(attackerLive, n);
        // Indistinguishable from the real follower on-chain: every one is ACTIVE and copyable, for ever.
        for (uint256 id = 2; id <= n + 1; ++id) {
            assertTrue(c.isCopyable(id));
        }
        assertTrue(c.isCopyable(real));
        vm.warp(T0 + 3650 days);
        assertTrue(c.isCopyable(n + 1), "expiry 0: still copyable ten years later");

        uint256 perTx = txTotal / n;
        emit log_named_uint("transaction gas per spam subscription", perTx);
        emit log_named_uint("spam subscriptions per block (30M limit, burst)", BLOCK_GAS / perTx);
        emit log_named_uint("spam subscriptions per block at the 15M target (sustained)", TARGET_GAS / perTx);
        emit log_named_uint("spam subscriptions per day at the target", BLOCKS_PER_DAY * (TARGET_GAS / perTx));
        emit log_named_uint("wei per day at the target", BLOCKS_PER_DAY * (TARGET_GAS / perTx) * perTx * GAS_PRICE_WEI);
        emit log_named_uint("spam subscriptions per 1 SOSO", SOSO / (perTx * GAS_PRICE_WEI));
        // Bounds that make the finding hold: under 1 microSOSO each, and >= 40 per block at the target.
        assertLt(perTx * GAS_PRICE_WEI, 1e12, "cost per spam subscription >= 1 microSOSO");
        assertGe(TARGET_GAS / perTx, 40);
    }

    /// The attacker needs no SOSO at all: signatures are free, ValueDesk's relayer pays, and nothing on-chain lets the
    /// relayer tell spam from a real follower. Fresh addresses are free too, so per-address relayer limits do not help.
    function test_keyOnlyAttacker_hasValueDesksRelayerPayForTheSpam() public {
        uint256 n = 50;
        for (uint256 i = 1; i <= n; ++i) {
            (address sybil, uint256 key) = makeAddrAndKey(string.concat("sybil", vm.toString(i)));
            assertEq(sybil.balance, 0);
            I.Terms memory t = _fakeTerms(i);
            uint64 account = uint64(i); // fake SoDEX account; nothing on-chain checks ownership
            bytes32 digest = E.digest(
                E.domainSeparator(block.chainid, address(c)),
                E.subscribeHash(sybil, C.VENUE_HYPERLIQUID, leader, account, t, 0, 0, 0, T0 + 1 hours)
            );
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
            vm.prank(relayer); // ValueDesk's relayer submits and pays
            c.subscribeWithSig(
                sybil,
                C.VENUE_HYPERLIQUID,
                leader,
                account,
                t,
                0,
                0,
                I.SignatureParams(0, T0 + 1 hours, abi.encodePacked(r, s, v))
            );
        }
        (, uint256 total) = c.subscriptionsOfLeader(C.VENUE_HYPERLIQUID, leader, 0, 0);
        assertEq(total, n);
        assertTrue(c.isCopyable(n));
    }

    /// One `subscribe` can push an arbitrarily large symbol payload into the event stream the executor must fetch
    /// (eth_getLogs) and hash-check against `symbolsHash`. Symbol count and length are uncapped.
    function test_oneSubscribe_carriesAHugeSymbolPayloadIntoTheEventStream() public {
        bytes memory junk = new bytes(100_000);
        for (uint256 i = 0; i < junk.length; ++i) {
            junk[i] = bytes1(uint8(0x21 + (i % 94))); // printable ASCII: a valid "symbol"
        }
        I.Terms memory t = _fakeTerms(1);
        t.symbolMode = I.SymbolMode.DENY;
        t.symbols = new string[](1);
        t.symbols[0] = string(junk);

        vm.recordLogs();
        vm.prank(attacker);
        c.subscribe(C.VENUE_SODEX, leader, 1, t);
        uint256 txGas = vm.lastCallGas().gasTotalUsed; // transaction gas, calldata floor included
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], I.Subscribed.selector);
        assertGt(logs[0].data.length, 100_000, "the whole payload is in the Subscribed event");

        uint256 bytesPerBlock = logs[0].data.length * TARGET_GAS / txGas;
        emit log_named_uint("event data bytes", logs[0].data.length);
        emit log_named_uint("transaction gas", txGas);
        emit log_named_uint("junk event bytes per block at the 15M target (sustained)", bytesPerBlock);
        emit log_named_uint("junk event bytes per day at the target", bytesPerBlock * BLOCKS_PER_DAY);
        emit log_named_uint("wei per day at the target", TARGET_GAS * GAS_PRICE_WEI * BLOCKS_PER_DAY);
        assertGt(bytesPerBlock, 100_000, "less than 100 KB of junk event data per block at the target");
    }

    /// The paginated views stay usable only when the caller paginates: an unpaginated read (limit = max, as the
    /// invariant test does) of a spammed leader exceeds geth's eth_call gas cap. The per-id cost is linear.
    function test_unpaginatedLeaderRead_exceedsTheRpcGasCap_paginatedReadsWork() public {
        uint64 n = 400;
        for (uint64 i = 1; i <= n; ++i) {
            vm.prank(attacker);
            c.subscribe(C.VENUE_SODEX, leader, i, _fakeTerms(i));
        }
        vm.cool(address(c));
        c.subscriptionsOfLeader(C.VENUE_SODEX, leader, 0, type(uint256).max);
        uint256 perId = vm.lastCallGas().gasTotalUsed / n;
        emit log_named_uint("view gas per leader id (cold)", perId);
        emit log_named_uint("ids per unpaginated eth_call under a 50M cap (approx.)", RPC_GAS_CAP / perId);

        // Grow the list to 30,000 entries by writing its length slot (a stand-in for 30,000 more spam subscriptions,
        // ~0.03 SOSO at 0.002 gwei; the view's cost does not depend on the stored values).
        bytes32 root = 0xc3b2bc2cf6fc6db46d2b311dd8531e2120cf7207f8eeaaf9015bcf1d32c6bf00;
        bytes32 lengthSlot =
            keccak256(abi.encode(leader, keccak256(abi.encode(uint256(C.VENUE_SODEX), uint256(root) + 3))));
        assertEq(uint256(vm.load(address(c), lengthSlot)), n, "slot of leaderHistory[1][leader]");
        vm.store(address(c), lengthSlot, bytes32(uint256(30_000)));
        vm.cool(address(c));

        (bool ok,) = address(c).staticcall{gas: RPC_GAS_CAP}(
            abi.encodeCall(c.subscriptionsOfLeader, (C.VENUE_SODEX, leader, 0, type(uint256).max))
        );
        assertFalse(ok, "unpaginated read of a spammed leader fits in one eth_call");
        (ok,) = address(c).staticcall{gas: RPC_GAS_CAP}(
            abi.encodeCall(c.subscriptionsOfLeader, (C.VENUE_SODEX, leader, 29_000, 1000))
        );
        assertTrue(ok, "a page of 1,000 works");
    }
}
