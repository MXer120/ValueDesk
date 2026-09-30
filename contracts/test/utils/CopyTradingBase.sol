// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ValuescanCopyTrading} from "../../src/ValuescanCopyTrading.sol";
import {IValuescanCopyTrading, CopyTradingConstants as C} from "../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingEIP712 as E} from "./CopyTradingEIP712.sol";

/// @notice Shared fixture: the implementation behind an ERC1967Proxy on ValueChain's chain id, actors, valid default
///         terms and signing helpers built on the independent reference encoder. Keys come from Foundry only.
abstract contract CopyTradingBase is Test {
    uint256 internal constant CHAIN_ID = 286_623;
    uint256 internal constant T0 = 1_790_000_000;
    uint64 internal constant BUILDER_ID = 224_000;
    uint16 internal constant PERPS_FEE = 50;
    uint16 internal constant SPOT_FEE = 100;
    uint64 internal constant ACCOUNT = 224_678;

    address internal owner = makeAddr("owner (timelock)");
    address internal executor = makeAddr("executor");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");
    address internal leader = makeAddr("leader");
    address internal leader2 = makeAddr("leader2");
    address internal delegatedKey = makeAddr("delegatedKey");

    address internal alice;
    uint256 internal aliceKey;
    address internal bob;
    uint256 internal bobKey;

    ValuescanCopyTrading internal impl;
    ValuescanCopyTrading internal c;

    function setUp() public virtual {
        vm.chainId(CHAIN_ID);
        vm.warp(T0);
        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");
        impl = new ValuescanCopyTrading();
        c = _deployProxy(address(impl), owner, _one(executor));
    }

    /// @dev `forge coverage` compiles without the optimizer: sizes and gas are meaningless there, so tests that
    ///      measure them are skipped (and gas snapshots are not overwritten with unoptimised numbers).
    function _skipUnderCoverage() internal {
        if (vm.isContext(VmSafe.ForgeContext.Coverage)) vm.skip(true, "size and gas are measured on optimised builds");
    }

    // ------------------------------------------------------------------------------------------------ deployment

    function _deployProxy(address implementation, address owner_, address[] memory executors_)
        internal
        returns (ValuescanCopyTrading)
    {
        bytes memory init = abi.encodeCall(
            ValuescanCopyTrading.initialize, (owner_, BUILDER_ID, PERPS_FEE, SPOT_FEE, executors_)
        );
        return ValuescanCopyTrading(address(new ERC1967Proxy(implementation, init)));
    }

    function _one(address a) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = a;
    }

    // ------------------------------------------------------------------------------------------------ terms

    /// @dev Valid terms: PERPS, PROPORTIONAL 1.0x, 1,000 USD allocation, 5x, ALL symbols, fees 50/100, no expiry.
    function _terms() internal view returns (IValuescanCopyTrading.Terms memory t) {
        t = IValuescanCopyTrading.Terms({
            delegatedKey: delegatedKey,
            keyName: "vs-3f9a1c07",
            marketScope: IValuescanCopyTrading.MarketScope.PERPS,
            sizingMode: IValuescanCopyTrading.SizingMode.PROPORTIONAL,
            sizingValue: 1_000_000,
            allocationCap: 1_000_000_000,
            maxPositionNotional: 2_500_000_000,
            maxLeverage: 5,
            tradeStopLossBps: 500,
            maxDrawdownBps: 2000,
            takeProfitBps: 5000,
            slippageBps: 50,
            symbolMode: IValuescanCopyTrading.SymbolMode.ALL,
            symbols: new string[](0),
            copyExisting: false,
            maxBuilderFeePerps: 50,
            maxBuilderFeeSpot: 100,
            expiry: 0
        });
    }

    function _symbols2() internal pure returns (string[] memory s) {
        s = new string[](2);
        s[0] = "BTC-USD";
        s[1] = "ETH-USD";
    }

    function _termsAllow() internal view returns (IValuescanCopyTrading.Terms memory t) {
        t = _terms();
        t.symbolMode = IValuescanCopyTrading.SymbolMode.ALLOW;
        t.symbols = _symbols2();
    }

    // ------------------------------------------------------------------------------------------------ actions

    function _subscribeAs(address follower, address leader_) internal returns (uint256 id) {
        return _subscribeAs(follower, C.VENUE_SODEX, leader_, ACCOUNT, _terms());
    }

    function _subscribeAs(
        address follower,
        uint8 venue,
        address leader_,
        uint64 account,
        IValuescanCopyTrading.Terms memory t
    ) internal returns (uint256 id) {
        vm.prank(follower);
        id = c.subscribe(venue, leader_, account, t);
    }

    // ------------------------------------------------------------------------------------------------ signatures

    function _domain() internal view returns (bytes32) {
        return E.domainSeparator(block.chainid, address(c));
    }

    function _signDigest(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sign(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        return _signDigest(pk, E.digest(_domain(), structHash));
    }

    function _params(uint256 pk, bytes32 structHash, uint256 nonce, uint256 deadline)
        internal
        view
        returns (IValuescanCopyTrading.SignatureParams memory)
    {
        return IValuescanCopyTrading.SignatureParams(nonce, deadline, _sign(pk, structHash));
    }

    function _subscribeSig(
        uint256 pk,
        address follower,
        uint8 venue,
        address leader_,
        uint64 account,
        IValuescanCopyTrading.Terms memory t,
        uint64 stopEpoch,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (IValuescanCopyTrading.SignatureParams memory) {
        // Signed for the key's history as it is now (what a UI reads from lastSubscriptionFor when signing).
        return _subscribeSigFor(
            pk,
            follower,
            venue,
            leader_,
            account,
            t,
            stopEpoch,
            _lastId(follower, account, venue, leader_),
            nonce,
            deadline
        );
    }

    /// @dev A Subscribe signature for an explicit `expectedLastId` (spec §6.6, audit SEC-04).
    function _subscribeSigFor(
        uint256 pk,
        address follower,
        uint8 venue,
        address leader_,
        uint64 account,
        IValuescanCopyTrading.Terms memory t,
        uint64 stopEpoch,
        uint256 expectedLastId,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (IValuescanCopyTrading.SignatureParams memory) {
        return _params(
            pk,
            E.subscribeHash(follower, venue, leader_, account, t, stopEpoch, expectedLastId, nonce, deadline),
            nonce,
            deadline
        );
    }

    /// @dev `lastSubscriptionFor` of the key, read from raw storage (namespace member 5, `liveByKey`) so that it can
    ///      be used as an argument right after `vm.prank` or `vm.expectRevert` without consuming them.
    function _lastId(address follower, uint64 account, uint8 venue, address leader_) internal view returns (uint256) {
        bytes32 key = keccak256(abi.encode(follower, account, venue, leader_));
        bytes32 root = 0xc3b2bc2cf6fc6db46d2b311dd8531e2120cf7207f8eeaaf9015bcf1d32c6bf00;
        return uint256(vm.load(address(c), keccak256(abi.encode(key, uint256(root) + 5))));
    }

    function _updateSig(
        uint256 pk,
        address follower,
        uint256 id,
        uint32 version,
        IValuescanCopyTrading.Terms memory t,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (IValuescanCopyTrading.SignatureParams memory) {
        return _params(pk, E.updateHash(follower, id, version, t, nonce, deadline), nonce, deadline);
    }

    function _pauseSig(uint256 pk, address follower, uint256 id, uint256 nonce, uint256 deadline)
        internal
        view
        returns (IValuescanCopyTrading.SignatureParams memory)
    {
        return _params(pk, E.pauseHash(follower, id, nonce, deadline), nonce, deadline);
    }

    function _resumeSig(uint256 pk, address follower, uint256 id, uint32 version, uint256 nonce, uint256 deadline)
        internal
        view
        returns (IValuescanCopyTrading.SignatureParams memory)
    {
        return _params(pk, E.resumeHash(follower, id, version, nonce, deadline), nonce, deadline);
    }

    function _unsubscribeSig(uint256 pk, address follower, uint256 id, bool close, uint256 nonce, uint256 deadline)
        internal
        view
        returns (IValuescanCopyTrading.SignatureParams memory)
    {
        return _params(pk, E.unsubscribeHash(follower, id, close, nonce, deadline), nonce, deadline);
    }

    function _unsubscribeAllSig(uint256 pk, address follower, bool close, uint256 nonce, uint256 deadline)
        internal
        view
        returns (IValuescanCopyTrading.SignatureParams memory)
    {
        return _params(pk, E.unsubscribeAllHash(follower, close, nonce, deadline), nonce, deadline);
    }

    function _invalidateSig(uint256 pk, address follower, uint256 word, uint256 mask, uint256 nonce, uint256 deadline)
        internal
        view
        returns (IValuescanCopyTrading.SignatureParams memory)
    {
        return _params(pk, E.invalidateNoncesHash(follower, word, mask, nonce, deadline), nonce, deadline);
    }

    // ------------------------------------------------------------------------------------------------ assertions

    function _assertStatus(uint256 id, IValuescanCopyTrading.Status expected) internal view {
        assertEq(uint8(c.statusOf(id)), uint8(expected), "status");
    }

    function _expectInvalidTerms(IValuescanCopyTrading.TermsField field) internal {
        vm.expectRevert(abi.encodeWithSelector(IValuescanCopyTrading.InvalidTerms.selector, field));
    }
}
