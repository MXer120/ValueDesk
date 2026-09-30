// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Vm} from "forge-std/Vm.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ValuescanCopyTrading} from "../../src/ValuescanCopyTrading.sol";
import {IValuescanCopyTrading as I, CopyTradingConstants as C} from "../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingBase} from "../utils/CopyTradingBase.sol";
import {CopyTradingEIP712 as E} from "../utils/CopyTradingEIP712.sol";
import {ERC1271WalletMock, RevertingERC1271Mock} from "../mocks/Mocks.sol";

/// @notice Every `...WithSig` action: EOA and ERC-1271 signers, wrong signer, expiry, replay, wrong chain or contract,
///         cross-type use, version and stop-epoch binding, nonce invalidation, malleability and EIP-7702 accounts.
contract SignaturesTest is CopyTradingBase {
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    ERC1271WalletMock internal wallet;
    uint256 internal deadline;

    function setUp() public override {
        super.setUp();
        wallet = new ERC1271WalletMock(bob); // bob's key controls the smart wallet
        deadline = T0 + 1 hours;
    }

    function _signedSubscribe(uint256 pk, address follower, uint256 nonce) internal returns (uint256 id) {
        I.Terms memory t = _termsAllow();
        I.SignatureParams memory sig =
            _subscribeSig(pk, follower, C.VENUE_SODEX, leader, ACCOUNT, t, c.stopEpochOf(follower), nonce, deadline);
        vm.prank(relayer);
        id = c.subscribeWithSig(
            follower,
            C.VENUE_SODEX,
            leader,
            ACCOUNT,
            t,
            c.stopEpochOf(follower),
            _lastId(follower, ACCOUNT, C.VENUE_SODEX, leader),
            sig
        );
    }

    // ------------------------------------------------------------------------------------------------ happy paths

    function test_subscribeWithSig_eoa() public {
        I.Terms memory t = _termsAllow();
        I.SignatureParams memory sig = _subscribeSig(aliceKey, alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, 7, deadline);
        vm.recordLogs();
        vm.prank(relayer);
        uint256 id = c.subscribeWithSig(
            alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, _lastId(alice, ACCOUNT, C.VENUE_SODEX, leader), sig
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2);
        // NonceUsed is always the first event of a signed call.
        assertEq(logs[0].topics[0], I.NonceUsed.selector);
        assertEq(address(uint160(uint256(logs[0].topics[1]))), alice);
        assertEq(uint256(logs[0].topics[2]), 7);
        assertEq(logs[1].topics[0], I.Subscribed.selector);

        I.Subscription memory s = c.getSubscription(id);
        assertEq(s.follower, alice); // the follower, never the relayer
        assertTrue(c.isNonceUsed(alice, 7));
        assertFalse(c.isNonceUsed(relayer, 7));
    }

    function test_subscribeWithSig_erc1271() public {
        uint256 id = _signedSubscribe(bobKey, address(wallet), 0);
        assertEq(c.getSubscription(id).follower, address(wallet));
        assertTrue(c.isNonceUsed(address(wallet), 0));
    }

    function test_allFollowerActionsBySignature_eoa() public {
        uint256 id = _signedSubscribe(aliceKey, alice, 1);
        _runLifecycleBySignature(aliceKey, alice, id);
    }

    function test_allFollowerActionsBySignature_erc1271() public {
        uint256 id = _signedSubscribe(bobKey, address(wallet), 1);
        _runLifecycleBySignature(bobKey, address(wallet), id);
    }

    function test_erc1271Wallet_canAlsoActDirectly() public {
        vm.prank(bob);
        bytes memory ret =
            wallet.execute(address(c), abi.encodeCall(c.subscribe, (C.VENUE_SODEX, leader, ACCOUNT, _terms())));
        uint256 id = abi.decode(ret, (uint256));
        assertEq(c.getSubscription(id).follower, address(wallet));
        vm.prank(bob);
        wallet.execute(address(c), abi.encodeCall(c.unsubscribe, (id, true)));
        _assertStatus(id, I.Status.STOPPED);
    }

    function _runLifecycleBySignature(uint256 pk, address follower, uint256 id) internal {
        I.Terms memory t = _terms();
        t.slippageBps = 77;
        vm.startPrank(relayer);
        c.updateSubscriptionWithSig(id, 1, t, _updateSig(pk, follower, id, 1, t, 2, deadline));
        assertEq(c.getSubscription(id).slippageBps, 77);
        assertEq(c.getSubscription(id).version, 2);

        c.pauseSubscriptionWithSig(id, _pauseSig(pk, follower, id, 3, deadline));
        _assertStatus(id, I.Status.PAUSED);

        c.resumeSubscriptionWithSig(id, 3, _resumeSig(pk, follower, id, 3, 4, deadline));
        _assertStatus(id, I.Status.ACTIVE);

        c.unsubscribeWithSig(id, true, _unsubscribeSig(pk, follower, id, true, 5, deadline));
        _assertStatus(id, I.Status.STOPPED);
        assertTrue(c.getSubscription(id).closePositions);

        assertEq(c.unsubscribeAllWithSig(follower, true, _unsubscribeAllSig(pk, follower, true, 6, deadline)), 1);
        assertEq(c.stopEpochOf(follower), 1);
        assertTrue(c.killSwitchInfo(follower, 1).closePositions);

        c.invalidateNoncesWithSig(follower, 1, 0xff, _invalidateSig(pk, follower, 1, 0xff, 7, deadline));
        assertEq(c.nonceBitmap(follower, 1), 0xff);
        assertEq(c.nonceBitmap(follower, 0), 0xfe); // nonces 1..7 used
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------------ wrong signer

    function test_wrongSigner_isRejected_forEveryAction() public {
        uint256 id = _subscribeAs(alice, leader);
        I.Terms memory t = _terms();
        vm.startPrank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.subscribeWithSig(
            alice,
            C.VENUE_SODEX,
            leader2,
            ACCOUNT,
            t,
            0,
            _lastId(alice, ACCOUNT, C.VENUE_SODEX, leader2),
            _subscribeSig(bobKey, alice, C.VENUE_SODEX, leader2, ACCOUNT, t, 0, 1, deadline)
        );
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.updateSubscriptionWithSig(id, 1, t, _updateSig(bobKey, alice, id, 1, t, 1, deadline));
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.pauseSubscriptionWithSig(id, _pauseSig(bobKey, alice, id, 1, deadline));
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.unsubscribeWithSig(id, false, _unsubscribeSig(bobKey, alice, id, false, 1, deadline));
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.unsubscribeAllWithSig(alice, false, _unsubscribeAllSig(bobKey, alice, false, 1, deadline));
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.invalidateNoncesWithSig(alice, 0, 1, _invalidateSig(bobKey, alice, 0, 1, 1, deadline));
        vm.stopPrank();

        vm.prank(alice);
        c.pauseSubscription(id);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.resumeSubscriptionWithSig(id, 2, _resumeSig(bobKey, alice, id, 2, 1, deadline));
        assertFalse(c.isNonceUsed(alice, 1));
    }

    function test_signatureOfAnotherFollower_cannotActOnYourSubscription() public {
        uint256 id = _subscribeAs(alice, leader);
        // Bob signs a perfectly valid Unsubscribe naming himself as follower: the contract binds alice (the stored
        // follower) into the digest, so it does not match.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.unsubscribeWithSig(id, true, _unsubscribeSig(bobKey, bob, id, true, 1, deadline));
        _assertStatus(id, I.Status.ACTIVE);
    }

    function test_relayerCannotAlterSignedParameters() public {
        uint256 id = _subscribeAs(alice, leader);
        I.SignatureParams memory sig = _unsubscribeSig(aliceKey, alice, id, false, 1, deadline);
        vm.startPrank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.unsubscribeWithSig(id, true, sig); // flip closePositions
        I.SignatureParams memory tampered = sig;
        tampered.deadline = deadline + 1;
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.unsubscribeWithSig(id, false, tampered);
        tampered = sig;
        tampered.nonce = 2;
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.unsubscribeWithSig(id, false, tampered);

        I.Terms memory t = _terms();
        I.SignatureParams memory up = _updateSig(aliceKey, alice, id, 1, t, 3, deadline);
        t.allocationCap += 1;
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.updateSubscriptionWithSig(id, 1, t, up);
        t = _termsAllow(); // symbols are covered too
        up = _updateSig(aliceKey, alice, id, 1, t, 4, deadline);
        t.symbols[1] = "SOL-USD";
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.updateSubscriptionWithSig(id, 1, t, up);

        I.SignatureParams memory sub =
            _subscribeSig(aliceKey, alice, C.VENUE_SODEX, leader2, ACCOUNT, _terms(), 0, 5, deadline);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.subscribeWithSig(
            alice,
            C.VENUE_HYPERLIQUID,
            leader2,
            ACCOUNT,
            _terms(),
            0,
            _lastId(alice, ACCOUNT, C.VENUE_HYPERLIQUID, leader2),
            sub
        );
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.subscribeWithSig(
            alice,
            C.VENUE_SODEX,
            leader2,
            ACCOUNT + 1,
            _terms(),
            0,
            _lastId(alice, ACCOUNT + 1, C.VENUE_SODEX, leader2),
            sub
        );
        vm.stopPrank();
    }

    function test_zeroFollower_cannotBeImpersonated() public {
        I.Terms memory t = _terms();
        I.SignatureParams memory sig = I.SignatureParams(0, deadline, new bytes(65));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, address(0)));
        c.subscribeWithSig(
            address(0), C.VENUE_SODEX, leader, ACCOUNT, t, 0, _lastId(address(0), ACCOUNT, C.VENUE_SODEX, leader), sig
        );
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, address(0)));
        c.unsubscribeAllWithSig(address(0), false, sig);
    }

    // ------------------------------------------------------------------------------------------------ deadline

    function test_deadline_isInclusive_thenExpired() public {
        uint256 id = _subscribeAs(alice, leader);
        I.SignatureParams memory sig = _pauseSig(aliceKey, alice, id, 1, T0);
        uint256 snap = vm.snapshotState();
        vm.prank(relayer);
        c.pauseSubscriptionWithSig(id, sig); // deadline == now: accepted
        vm.revertToState(snap);
        vm.warp(T0 + 1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.SignatureExpired.selector, sig.deadline));
        c.pauseSubscriptionWithSig(id, sig);
    }

    function test_expired_forEveryAction() public {
        uint256 id = _subscribeAs(alice, leader);
        uint256 past = T0 - 1;
        I.Terms memory t = _terms();
        vm.startPrank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.SignatureExpired.selector, past));
        c.subscribeWithSig(
            alice,
            C.VENUE_SODEX,
            leader2,
            ACCOUNT,
            t,
            0,
            _lastId(alice, ACCOUNT, C.VENUE_SODEX, leader2),
            _subscribeSig(aliceKey, alice, C.VENUE_SODEX, leader2, ACCOUNT, t, 0, 1, past)
        );
        vm.expectRevert(abi.encodeWithSelector(I.SignatureExpired.selector, past));
        c.updateSubscriptionWithSig(id, 1, t, _updateSig(aliceKey, alice, id, 1, t, 1, past));
        vm.expectRevert(abi.encodeWithSelector(I.SignatureExpired.selector, past));
        c.unsubscribeWithSig(id, false, _unsubscribeSig(aliceKey, alice, id, false, 1, past));
        vm.expectRevert(abi.encodeWithSelector(I.SignatureExpired.selector, past));
        c.unsubscribeAllWithSig(alice, false, _unsubscribeAllSig(aliceKey, alice, false, 1, past));
        vm.expectRevert(abi.encodeWithSelector(I.SignatureExpired.selector, past));
        c.invalidateNoncesWithSig(alice, 0, 1, _invalidateSig(aliceKey, alice, 0, 1, 1, past));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------------ replay

    function test_replay_isRejected() public {
        uint256 id = _signedSubscribe(aliceKey, alice, 9);
        vm.prank(alice);
        c.unsubscribe(id, false);
        // Same Subscribe signature again (the old subscription is stopped, so only the nonce stops it).
        I.Terms memory t = _termsAllow();
        I.SignatureParams memory sig = _subscribeSig(aliceKey, alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, 9, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.NonceAlreadyUsed.selector, alice, 9));
        c.subscribeWithSig(
            alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, _lastId(alice, ACCOUNT, C.VENUE_SODEX, leader), sig
        );

        uint256 id2 = _subscribeAs(alice, leader2);
        I.SignatureParams memory p = _pauseSig(aliceKey, alice, id2, 10, deadline);
        vm.prank(relayer);
        c.pauseSubscriptionWithSig(id2, p);
        vm.prank(alice);
        c.resumeSubscription(id2);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.NonceAlreadyUsed.selector, alice, 10));
        c.pauseSubscriptionWithSig(id2, p);

        I.SignatureParams memory all = _unsubscribeAllSig(aliceKey, alice, false, 11, deadline);
        vm.prank(relayer);
        c.unsubscribeAllWithSig(alice, false, all);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.NonceAlreadyUsed.selector, alice, 11));
        c.unsubscribeAllWithSig(alice, false, all);
    }

    function test_nonceIsSharedAcrossActionTypes() public {
        uint256 id = _subscribeAs(alice, leader);
        vm.prank(relayer);
        c.pauseSubscriptionWithSig(id, _pauseSig(aliceKey, alice, id, 5, deadline));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.NonceAlreadyUsed.selector, alice, 5));
        c.unsubscribeWithSig(id, false, _unsubscribeSig(aliceKey, alice, id, false, 5, deadline));
    }

    function test_invalidatedNonce_cancelsASignedMessage() public {
        uint256 id = _subscribeAs(alice, leader);
        I.SignatureParams memory sig = _unsubscribeSig(aliceKey, alice, id, true, 300, deadline);
        vm.prank(alice);
        c.invalidateNonces(300 >> 8, 1 << (300 & 0xff));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.NonceAlreadyUsed.selector, alice, 300));
        c.unsubscribeWithSig(id, true, sig);
    }

    function test_invalidateNoncesWithSig_ownNonceInsideMask() public {
        vm.prank(relayer);
        c.invalidateNoncesWithSig(alice, 0, 0x0f, _invalidateSig(aliceKey, alice, 0, 0x0f, 2, deadline));
        assertEq(c.nonceBitmap(alice, 0), 0x0f);
    }

    // ------------------------------------------------------------------------------------------------ domain binding

    function test_wrongChain_isRejected() public {
        uint256 id = _subscribeAs(alice, leader);
        bytes32 foreignDomain = E.domainSeparator(1, address(c));
        bytes memory signature =
            _signDigest(aliceKey, E.digest(foreignDomain, E.unsubscribeHash(alice, id, false, 1, deadline)));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.unsubscribeWithSig(id, false, I.SignatureParams(1, deadline, signature));

        // A signature for this chain stops working if the chain id changes (fork protection).
        I.SignatureParams memory good = _unsubscribeSig(aliceKey, alice, id, false, 2, deadline);
        vm.chainId(1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.unsubscribeWithSig(id, false, good);
        vm.chainId(CHAIN_ID);
        vm.prank(relayer);
        c.unsubscribeWithSig(id, false, good);
    }

    function test_wrongContract_isRejected() public {
        ValuescanCopyTrading other = _deployProxy(address(impl), owner, new address[](0));
        vm.prank(alice);
        uint256 idOther = other.subscribe(C.VENUE_SODEX, leader, ACCOUNT, _terms());
        uint256 id = _subscribeAs(alice, leader);
        assertEq(id, idOther); // same id, same follower, same nonce: only the contract address differs
        I.SignatureParams memory sig = _unsubscribeSig(aliceKey, alice, id, false, 1, deadline); // for `c`
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        other.unsubscribeWithSig(idOther, false, sig);
        vm.prank(relayer);
        c.unsubscribeWithSig(id, false, sig);
    }

    function test_crossType_isRejected() public {
        uint256 id = _subscribeAs(alice, leader);
        // A Pause signature presented as an Unsubscribe, and an UnsubscribeAll one as an InvalidateNonces.
        I.SignatureParams memory pauseSig = _pauseSig(aliceKey, alice, id, 1, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.unsubscribeWithSig(id, false, pauseSig);
        I.SignatureParams memory allSig = _unsubscribeAllSig(aliceKey, alice, false, 2, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.invalidateNoncesWithSig(alice, 0, 0, allSig);
    }

    // ------------------------------------------------------------------------------------------------ version binding

    function test_update_isVersionBound() public {
        uint256 id = _subscribeAs(alice, leader);
        I.Terms memory t = _terms();
        t.slippageBps = 999;
        I.SignatureParams memory sig = _updateSig(aliceKey, alice, id, 1, t, 1, deadline);
        // The follower changes the subscription after signing; the withheld update can no longer land.
        vm.prank(alice);
        c.pauseSubscription(id);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.VersionMismatch.selector, id, uint32(1), uint32(2)));
        c.updateSubscriptionWithSig(id, 1, t, sig);
        // Even claiming the current version does not help: the version is part of the signed message.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.updateSubscriptionWithSig(id, 2, t, sig);
    }

    function test_resume_isVersionBound_replayAfterPauseResumeCycle() public {
        uint256 id = _subscribeAs(alice, leader);
        vm.prank(alice);
        c.pauseSubscription(id); // v2
        I.SignatureParams memory resume = _resumeSig(aliceKey, alice, id, 2, 1, deadline);
        vm.prank(alice);
        c.resumeSubscription(id); // v3
        vm.prank(alice);
        c.pauseSubscription(id); // v4: the follower wants it paused
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.VersionMismatch.selector, id, uint32(2), uint32(4)));
        c.resumeSubscriptionWithSig(id, 2, resume);
        _assertStatus(id, I.Status.PAUSED);
    }

    function test_stops_areNotVersionBound() public {
        uint256 id = _subscribeAs(alice, leader);
        I.SignatureParams memory stop = _unsubscribeSig(aliceKey, alice, id, true, 1, deadline);
        I.Terms memory t = _terms();
        t.slippageBps = 1;
        vm.startPrank(alice);
        c.updateSubscription(id, t);
        c.pauseSubscription(id);
        c.resumeSubscription(id);
        vm.stopPrank();
        vm.prank(relayer);
        c.unsubscribeWithSig(id, true, stop);
        _assertStatus(id, I.Status.STOPPED);
    }

    function test_subscribe_isStopEpochBound() public {
        I.Terms memory t = _terms();
        I.SignatureParams memory sig = _subscribeSig(aliceKey, alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, 1, deadline);
        vm.prank(alice);
        c.unsubscribeAll(false); // the kill switch voids every signed but unsubmitted Subscribe
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.StopEpochMismatch.selector, alice, uint64(0), uint64(1)));
        c.subscribeWithSig(
            alice, C.VENUE_SODEX, leader, ACCOUNT, t, 0, _lastId(alice, ACCOUNT, C.VENUE_SODEX, leader), sig
        );
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.subscribeWithSig(
            alice, C.VENUE_SODEX, leader, ACCOUNT, t, 1, _lastId(alice, ACCOUNT, C.VENUE_SODEX, leader), sig
        );
    }

    function test_preSignedEmergencyStop_stopsWhatIsLiveWhenItLands() public {
        I.SignatureParams memory emergency = _unsubscribeAllSig(aliceKey, alice, true, 1_000_000, type(uint256).max);
        vm.warp(T0 + 365 days);
        uint256 id = _subscribeAs(alice, leader); // created after signing
        vm.prank(owner);
        c.pause();
        vm.prank(stranger); // anyone may submit it
        c.unsubscribeAllWithSig(alice, true, emergency);
        _assertStatus(id, I.Status.STOPPED);
    }

    // ------------------------------------------------------------------------------------------------ pause scope

    function test_pause_blocksOnlyNewActivityBySignature() public {
        uint256 id = _subscribeAs(alice, leader);
        uint256 id2 = _subscribeAs(alice, leader2);
        vm.prank(alice);
        c.pauseSubscription(id2);
        vm.prank(owner);
        c.pause();
        I.Terms memory t = _terms();
        vm.startPrank(relayer);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        c.subscribeWithSig(
            alice,
            C.VENUE_HYPERLIQUID,
            leader,
            ACCOUNT,
            t,
            0,
            _lastId(alice, ACCOUNT, C.VENUE_HYPERLIQUID, leader),
            _subscribeSig(aliceKey, alice, C.VENUE_HYPERLIQUID, leader, ACCOUNT, t, 0, 1, deadline)
        );
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        c.updateSubscriptionWithSig(id, 1, t, _updateSig(aliceKey, alice, id, 1, t, 1, deadline));
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        c.resumeSubscriptionWithSig(id2, 2, _resumeSig(aliceKey, alice, id2, 2, 1, deadline));

        c.pauseSubscriptionWithSig(id, _pauseSig(aliceKey, alice, id, 1, deadline));
        c.unsubscribeWithSig(id, false, _unsubscribeSig(aliceKey, alice, id, false, 2, deadline));
        c.invalidateNoncesWithSig(alice, 1, 1, _invalidateSig(aliceKey, alice, 1, 1, 3, deadline));
        c.unsubscribeAllWithSig(alice, false, _unsubscribeAllSig(aliceKey, alice, false, 4, deadline));
        vm.stopPrank();
        _assertStatus(id2, I.Status.STOPPED);
    }

    // ------------------------------------------------------------------------------------------------ signature forms

    function test_highS_isRejected() public {
        uint256 id = _subscribeAs(alice, leader);
        bytes32 digest = E.digest(_domain(), E.unsubscribeHash(alice, id, false, 1, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, digest);
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.unsubscribeWithSig(id, false, I.SignatureParams(1, deadline, abi.encodePacked(r, highS, flippedV)));
    }

    function test_compact64ByteSignature_isRejectedForEoa() public {
        uint256 id = _subscribeAs(alice, leader);
        bytes32 digest = E.digest(_domain(), E.unsubscribeHash(alice, id, false, 1, deadline));
        (bytes32 r, bytes32 vs) = vm.signCompact(aliceKey, digest);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
        c.unsubscribeWithSig(id, false, I.SignatureParams(1, deadline, abi.encodePacked(r, vs)));
    }

    function test_garbageSignatures_areRejected() public {
        uint256 id = _subscribeAs(alice, leader);
        bytes[4] memory junk = [bytes(""), new bytes(65), hex"01", new bytes(200)];
        for (uint256 i = 0; i < junk.length; ++i) {
            vm.prank(relayer);
            vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, alice));
            c.unsubscribeWithSig(id, false, I.SignatureParams(1, deadline, junk[i]));
        }
    }

    function test_erc1271_rejectingAndRevertingWallets() public {
        uint256 id = _signedSubscribe(bobKey, address(wallet), 0);
        // Signed by a key the wallet does not accept.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, address(wallet)));
        c.unsubscribeWithSig(id, false, _unsubscribeSig(aliceKey, address(wallet), id, false, 1, deadline));

        RevertingERC1271Mock bad = new RevertingERC1271Mock();
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(I.InvalidSignature.selector, address(bad)));
        c.unsubscribeAllWithSig(address(bad), false, _unsubscribeAllSig(aliceKey, address(bad), false, 1, deadline));
    }

    function test_erc1271_walletDecidesAlone() public {
        // A wallet that accepts anything only exposes itself: a submitter can then act for that wallet only.
        ERC1271WalletMock permissive = new ERC1271WalletMock(bob);
        permissive.setAcceptAll(true);
        vm.prank(relayer);
        c.unsubscribeAllWithSig(address(permissive), false, I.SignatureParams(1, deadline, hex"00"));
        assertEq(c.stopEpochOf(address(permissive)), 1);
        assertEq(c.stopEpochOf(bob), 0);
    }

    function test_eip7702DelegatedEoa_signsWithItsOwnKey() public {
        // An EIP-7702 account has code (0xef0100 || delegate). ECDSA is tried first, so its key still works even if
        // the delegate implements no ERC-1271 (here: the delegate rejects everything).
        ERC1271WalletMock delegate = new ERC1271WalletMock(address(0xdead));
        vm.etch(alice, abi.encodePacked(hex"ef0100", address(delegate)));
        assertGt(alice.code.length, 0);
        uint256 id = _signedSubscribe(aliceKey, alice, 1);
        vm.prank(relayer);
        c.unsubscribeWithSig(id, true, _unsubscribeSig(aliceKey, alice, id, true, 2, deadline));
        _assertStatus(id, I.Status.STOPPED);
    }
}
