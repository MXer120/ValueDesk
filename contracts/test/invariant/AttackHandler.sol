// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {CommonBase} from "forge-std/Base.sol";
import {Vm} from "forge-std/Vm.sol";
import {ValuescanCopyTrading} from "../../src/ValuescanCopyTrading.sol";
import {IValuescanCopyTrading as I} from "../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingEIP712 as E} from "../utils/CopyTradingEIP712.sol";
import {EventIndexer} from "./EventIndexer.sol";
import {CopyTradingHandler} from "./Handler.sol";

/// @notice Invariant handler for attacks, interleaved with the followers' actions: strangers, the owner and executors
///         touching someone else's subscription, forged and replayed signatures, value transfers and calls with
///         value, and unauthorised governance. Every attack must fail and change nothing; the indexer is told that no
///         follower authorised the call, so any subscription event it sees counts as a violation.
contract AttackHandler is CommonBase {
    ValuescanCopyTrading public immutable c;
    EventIndexer public immutable indexer;
    CopyTradingHandler public immutable handler;
    address public immutable attacker;
    uint256 internal constant ATTACKER_KEY = 0xBAD;

    uint256 public unexpectedSuccesses; // an attack succeeded
    uint256 public valueAccepted; // a call carrying value succeeded
    uint256 public attempts;

    constructor(ValuescanCopyTrading c_, EventIndexer indexer_, CopyTradingHandler handler_) {
        c = c_;
        indexer = indexer_;
        handler = handler_;
        attacker = vm.addr(ATTACKER_KEY);
        vm.deal(attacker, 100 ether);
        vm.deal(handler_.followers(0), 100 ether);
    }

    function attack(uint256 idSeed, uint8 kind) external {
        uint256 n = indexer.count();
        uint256 id = n == 0 ? 0 : 1 + idSeed % n;
        address f = n == 0 ? address(0) : indexer.subscription(id).follower;
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        kind = kind % 9;
        bytes memory data;
        address from = attacker;
        uint256 value;
        if (kind == 0) {
            data = abi.encodeCall(c.unsubscribe, (id, true));
        } else if (kind == 1) {
            data = abi.encodeCall(c.pauseSubscription, (id));
            from = handler.owner();
        } else if (kind == 2) {
            I.Terms memory t;
            if (n != 0) t = _termsOf(id);
            data = abi.encodeCall(c.updateSubscription, (id, t));
            from = handler.executors(0);
        } else if (kind == 3) {
            // A signature by the attacker's key, claimed for the follower.
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(
                ATTACKER_KEY,
                E.digest(E.domainSeparator(block.chainid, address(c)), E.unsubscribeHash(f, id, true, 7, deadline))
            );
            data = abi.encodeCall(
                c.unsubscribeWithSig, (id, true, I.SignatureParams(7, deadline, abi.encodePacked(r, s, v)))
            );
            from = handler.relayer();
        } else if (kind == 4) {
            data = handler.lastSigned(); // replay of a signature that already landed
            if (data.length == 0) return;
            from = handler.relayer();
        } else if (kind == 5) {
            value = 1; // plain value transfer, empty calldata
        } else if (kind == 6) {
            data = abi.encodeCall(c.unsubscribeAll, (false)); // a legitimate call, but with value
            from = handler.followers(0);
            value = 1;
        } else if (kind == 7) {
            data = abi.encodeCall(c.setBuilderTerms, (1, 200, 2000));
        } else {
            data = abi.encodeCall(c.upgradeToAndCall, (handler.v2(), ""));
        }
        ++attempts;
        vm.recordLogs();
        vm.prank(from);
        (bool ok,) = address(c).call{value: value}(data);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        indexer.ingest(logs, address(0), vm.getBlockTimestamp());
        if (ok) ++unexpectedSuccesses;
        if (ok && value != 0) ++valueAccepted;
    }

    /// @dev Valid-looking terms copied from the stored record (the executor must still be refused).
    function _termsOf(uint256 id) internal view returns (I.Terms memory t) {
        I.Subscription memory s = indexer.subscription(id);
        t.delegatedKey = s.delegatedKey;
        t.keyName = s.keyName;
        t.marketScope = s.marketScope;
        t.sizingMode = s.sizingMode;
        t.sizingValue = s.sizingValue;
        t.allocationCap = s.allocationCap;
        t.maxPositionNotional = s.maxPositionNotional;
        t.maxLeverage = s.maxLeverage;
        t.slippageBps = s.slippageBps;
        t.maxBuilderFeePerps = s.maxBuilderFeePerps;
        t.maxBuilderFeeSpot = s.maxBuilderFeeSpot;
    }
}
