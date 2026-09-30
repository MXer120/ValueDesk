// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ValuescanCopyTrading} from "../../src/ValuescanCopyTrading.sol";
import {IValuescanCopyTrading as I, CopyTradingConstants as C} from "../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingBase} from "../utils/CopyTradingBase.sol";
import {ForceSender, ValuescanCopyTradingV2Mock} from "../mocks/Mocks.sol";

/// @notice Nonce invalidation, and the no-funds guarantee: nothing can be paid in through any function.
contract NoncesAndFundsTest is CopyTradingBase {
    // ------------------------------------------------------------------------------------------------ nonces

    function test_invalidateNonces() public {
        vm.expectEmit(address(c));
        emit I.NoncesInvalidated(alice, 3, 0x0f);
        vm.prank(alice);
        c.invalidateNonces(3, 0x0f);
        assertEq(c.nonceBitmap(alice, 3), 0x0f);
        assertTrue(c.isNonceUsed(alice, 3 * 256 + 0));
        assertTrue(c.isNonceUsed(alice, 3 * 256 + 3));
        assertFalse(c.isNonceUsed(alice, 3 * 256 + 4));
        assertFalse(c.isNonceUsed(bob, 3 * 256));

        // Bits accumulate; invalidating twice is harmless.
        vm.prank(alice);
        c.invalidateNonces(3, 0xf0);
        assertEq(c.nonceBitmap(alice, 3), 0xff);
        vm.prank(alice);
        c.invalidateNonces(type(uint256).max >> 8, type(uint256).max);
        assertTrue(c.isNonceUsed(alice, type(uint256).max));
    }

    function test_invalidateNonces_worksWhilePaused() public {
        vm.prank(owner);
        c.pause();
        vm.prank(alice);
        c.invalidateNonces(0, 1);
        assertTrue(c.isNonceUsed(alice, 0));
    }

    // ------------------------------------------------------------------------------------------------ no funds

    function test_plainTransfer_reverts() public {
        vm.deal(stranger, 10 ether);
        vm.prank(stranger);
        (bool ok,) = address(c).call{value: 1}("");
        assertFalse(ok);
        vm.prank(stranger);
        (ok,) = address(impl).call{value: 1}("");
        assertFalse(ok);
        assertEq(address(c).balance, 0);
        assertEq(address(impl).balance, 0);
    }

    function test_unknownSelector_reverts_withAndWithoutValue() public {
        vm.deal(stranger, 1 ether);
        vm.startPrank(stranger);
        (bool ok,) = address(c).call(hex"deadbeef");
        assertFalse(ok);
        (ok,) = address(c).call{value: 1}(hex"deadbeef");
        assertFalse(ok);
        vm.stopPrank();
    }

    function test_everyFunction_rejectsValue() public {
        uint256 id = _subscribeAs(alice, leader);
        I.SignatureParams memory sig = I.SignatureParams(0, T0, "");
        bytes[] memory calls = new bytes[](33);
        calls[0] = abi.encodeCall(c.subscribe, (C.VENUE_SODEX, leader2, ACCOUNT, _terms()));
        calls[1] = abi.encodeCall(c.updateSubscription, (id, _terms()));
        calls[2] = abi.encodeCall(c.pauseSubscription, (id));
        calls[3] = abi.encodeCall(c.resumeSubscription, (id));
        calls[4] = abi.encodeCall(c.unsubscribe, (id, false));
        calls[5] = abi.encodeCall(c.unsubscribeAll, (false));
        calls[6] = abi.encodeCall(c.invalidateNonces, (0, 1));
        calls[7] = abi.encodeCall(
            c.subscribeWithSig,
            (alice, C.VENUE_SODEX, leader2, ACCOUNT, _terms(), 0, _lastId(alice, ACCOUNT, C.VENUE_SODEX, leader2), sig)
        );
        calls[8] = abi.encodeCall(c.updateSubscriptionWithSig, (id, 1, _terms(), sig));
        calls[9] = abi.encodeCall(c.pauseSubscriptionWithSig, (id, sig));
        calls[10] = abi.encodeCall(c.resumeSubscriptionWithSig, (id, 1, sig));
        calls[11] = abi.encodeCall(c.unsubscribeWithSig, (id, false, sig));
        calls[12] = abi.encodeCall(c.unsubscribeAllWithSig, (alice, false, sig));
        calls[13] = abi.encodeCall(c.invalidateNoncesWithSig, (alice, 0, 1, sig));
        calls[14] = abi.encodeCall(c.commitExecutions, (1, bytes32(0), 0, ""));
        calls[15] = abi.encodeCall(c.setBuilderTerms, (BUILDER_ID, 1, 1));
        calls[16] = abi.encodeCall(c.setVenue, (3, true, "X"));
        calls[17] = abi.encodeCall(c.setExecutor, (stranger, true));
        calls[18] = abi.encodeCall(c.pause, ());
        calls[19] = abi.encodeCall(c.unpause, ());
        calls[20] = abi.encodeCall(c.transferOwnership, (stranger));
        calls[21] = abi.encodeCall(c.acceptOwnership, ());
        calls[22] = abi.encodeCall(c.renounceOwnership, ());
        calls[23] = abi.encodeCall(c.getSubscription, (id));
        calls[24] = abi.encodeCall(c.statusOf, (id));
        calls[25] = abi.encodeCall(c.isCopyable, (id));
        calls[26] = abi.encodeCall(c.effectiveBuilderFee, (id));
        calls[27] = abi.encodeCall(c.builderTerms, ());
        calls[28] = abi.encodeCall(c.subscriptionsOfFollower, (alice, 0, 1));
        calls[29] = abi.encodeCall(c.nonceBitmap, (alice, 0));
        calls[30] = abi.encodeCall(c.DOMAIN_SEPARATOR, ());
        calls[31] = abi.encodeCall(c.proxiableUUID, ());
        calls[32] = abi.encodeCall(c.initialize, (alice, BUILDER_ID, 0, 0, new address[](0)));

        address[3] memory callers = [alice, owner, executor];
        for (uint256 k = 0; k < callers.length; ++k) {
            vm.deal(callers[k], 1 ether);
            for (uint256 i = 0; i < calls.length; ++i) {
                vm.prank(callers[k]);
                (bool ok,) = address(c).call{value: 1 wei}(calls[i]);
                assertFalse(ok, "a call with value succeeded");
            }
        }
        assertEq(address(c).balance, 0);
    }

    function test_upgradeToAndCall_rejectsValue() public {
        ValuescanCopyTradingV2Mock v2 = new ValuescanCopyTradingV2Mock();
        vm.deal(owner, 1 ether);
        vm.startPrank(owner);
        vm.expectRevert(I.FundsNotAccepted.selector);
        c.upgradeToAndCall{value: 1}(address(v2), "");
        vm.expectRevert(I.FundsNotAccepted.selector);
        c.upgradeToAndCall{value: 1}(address(v2), abi.encodeCall(v2.initializeV2, (1)));
        vm.stopPrank();
        assertEq(address(c).balance, 0);
    }

    function test_proxyDeployment_withValue_reverts() public {
        bytes memory init = abi.encodeCall(ValuescanCopyTrading.initialize, (owner, BUILDER_ID, 0, 0, new address[](0)));
        vm.deal(address(this), 1 ether);
        vm.expectRevert();
        new ERC1967Proxy{value: 1}(address(impl), init);
    }

    /// @dev SELFDESTRUCT (and block rewards) can force native tokens into ANY address; no contract can refuse them.
    ///      Documented, deliberate: they are then stuck, because no function of the contract sends value anywhere,
    ///      and nothing in the contract reads its balance.
    function test_forcedFunds_changeNothing_andCannotBeMoved() public {
        uint256 id = _subscribeAs(alice, leader);
        new ForceSender{value: 1 ether}(payable(address(c)));
        assertEq(address(c).balance, 1 ether);
        vm.prank(alice);
        c.unsubscribe(id, false);
        _assertStatus(id, I.Status.STOPPED);
        assertEq(address(c).balance, 1 ether);
    }
}
