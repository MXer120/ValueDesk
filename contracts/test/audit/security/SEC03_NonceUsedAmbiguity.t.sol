// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Vm} from "forge-std/Vm.sol";
import {IValuescanCopyTrading as I} from "../../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingBase} from "../../utils/CopyTradingBase.sol";

/// @notice AUDIT SEC-03 (low, LEFTOVER on-chain; spec, relayer rule and SDK corrected), kept as a regression test.
///         `NonceUsed(signer, nonce)` does not identify WHICH message consumed the nonce, so the old §6.7 relayer rule
///         ("treat NonceAlreadyUsed as success when a matching NonceUsed event already exists") reported a stop as
///         landed while a resume that shared its nonce had turned copying back on. Corrected rule (spec §6.5 and
///         §6.7, INTEGRATION.md, the copy-contract SDK relay helpers): nonces are random 256-bit values, and
///         NonceAlreadyUsed counts as "landed" only if the transaction that consumed the nonce carried the relayer's
///         own message (same digest), or, for a stop, after re-reading the target's status. Adding the digest to
///         NonceUsed is an open owner decision (an event-signature change).
contract SEC03_NonceUsedAmbiguityTest is CopyTradingBase {
    function test_audit_SEC03_correctedRelayerRule_doesNotReportAStopAsLanded_whenAResumeTookItsNonce() public {
        uint256 deadline = T0 + 1 hours;
        uint256 id = _subscribeAs(alice, leader);
        vm.prank(alice);
        c.pauseSubscription(id); // version 2, PAUSED

        // Both messages are signed before either lands, so both take the first unused nonce.
        uint256 n = 0;
        assertFalse(c.isNonceUsed(alice, n));
        I.SignatureParams memory resume = _resumeSig(aliceKey, alice, id, 2, n, deadline);
        I.SignatureParams memory stop = _unsubscribeSig(aliceKey, alice, id, true, n, deadline);

        vm.recordLogs();
        vm.prank(relayer);
        c.resumeSubscriptionWithSig(id, 2, resume);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // The only trace of the consumed nonce: (signer, nonce) in topics, and nothing else.
        bool matchingNonceUsed = logs[0].topics[0] == I.NonceUsed.selector
            && address(uint160(uint256(logs[0].topics[1]))) == alice && uint256(logs[0].topics[2]) == n;
        assertTrue(matchingNonceUsed);
        assertEq(logs[0].data.length, 0, "NonceUsed carries no message identity");

        vm.prank(relayer);
        (bool ok, bytes memory ret) = address(c).call(abi.encodeCall(c.unsubscribeWithSig, (id, true, stop)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(I.NonceAlreadyUsed.selector, alice, n));

        // The OLD §6.7 rule, applied literally, would report the stop as landed (the leftover ambiguity) ...
        bool oldRuleSaysLanded = !ok && bytes4(ret) == I.NonceAlreadyUsed.selector && matchingNonceUsed;
        assertTrue(oldRuleSaysLanded);
        assertTrue(c.isCopyable(id), "reality: copying is back on");

        // ... the corrected rule re-reads the target: a stop counts as landed only if the subscription is STOPPED.
        bool newRuleSaysLanded = !ok && bytes4(ret) == I.NonceAlreadyUsed.selector && matchingNonceUsed
            && c.statusOf(id) == I.Status.STOPPED;
        assertFalse(newRuleSaysLanded, "SEC-03 rule: the relayer reports the stop as NOT landed and re-signs it");
    }

    /// With random nonces (the corrected §6.5 rule) the two messages do not collide, and both land in order.
    function test_audit_SEC03_randomNonces_bothMessagesLand() public {
        uint256 deadline = T0 + 1 hours;
        uint256 id = _subscribeAs(alice, leader);
        vm.prank(alice);
        c.pauseSubscription(id);
        uint256 n1 = uint256(keccak256("random nonce 1"));
        uint256 n2 = uint256(keccak256("random nonce 2"));
        I.SignatureParams memory resume = _resumeSig(aliceKey, alice, id, 2, n1, deadline);
        I.SignatureParams memory stop = _unsubscribeSig(aliceKey, alice, id, true, n2, deadline);
        vm.prank(relayer);
        c.resumeSubscriptionWithSig(id, 2, resume);
        vm.prank(relayer);
        c.unsubscribeWithSig(id, true, stop);
        assertEq(uint8(c.statusOf(id)), uint8(I.Status.STOPPED));
    }
}
