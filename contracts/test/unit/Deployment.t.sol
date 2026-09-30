// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Vm} from "forge-std/Vm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ValuescanCopyTrading} from "../../src/ValuescanCopyTrading.sol";
import {IValuescanCopyTrading, CopyTradingConstants as C} from "../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingBase} from "../utils/CopyTradingBase.sol";
import {CopyTradingEIP712 as E} from "../utils/CopyTradingEIP712.sol";

/// @notice Deployment through the proxy, `initialize`, the locked implementation, ownership and the EIP-712 domain.
contract DeploymentTest is CopyTradingBase {
    function test_initialize_setsState() public view {
        assertEq(c.owner(), owner);
        assertEq(c.pendingOwner(), address(0));
        assertFalse(c.paused());
        assertEq(c.VERSION(), "1.0.0");
        assertEq(c.subscriptionCount(), 0);

        IValuescanCopyTrading.BuilderTerms memory b = c.builderTerms();
        assertEq(b.builderId, BUILDER_ID);
        assertEq(b.perpsFee, PERPS_FEE);
        assertEq(b.spotFee, SPOT_FEE);
        assertEq(b.updatedAt, T0);

        IValuescanCopyTrading.Venue memory v1 = c.venueInfo(C.VENUE_SODEX);
        assertTrue(v1.enabled);
        assertEq(v1.name, "SoDEX");
        IValuescanCopyTrading.Venue memory v2 = c.venueInfo(C.VENUE_HYPERLIQUID);
        assertTrue(v2.enabled);
        assertEq(v2.name, "Hyperliquid");
        IValuescanCopyTrading.Venue memory v3 = c.venueInfo(3);
        assertFalse(v3.enabled);
        assertEq(bytes(v3.name).length, 0);

        assertTrue(c.isExecutor(executor));
        IValuescanCopyTrading.Executor memory x = c.executorInfo(executor);
        assertTrue(x.authorised);
        assertEq(x.updatedAt, T0);
        assertEq(x.lastEpoch, 0);
        assertFalse(c.isExecutor(stranger));

        // The proxy points at the implementation.
        bytes32 implSlot = vm.load(address(c), ERC1967Utils.IMPLEMENTATION_SLOT);
        assertEq(address(uint160(uint256(implSlot))), address(impl));
    }

    function test_initialize_emitsEverythingAnIndexerNeeds_inOrder() public {
        address x2 = makeAddr("executor2");
        address[] memory xs = new address[](2);
        xs[0] = executor;
        xs[1] = x2;
        vm.recordLogs();
        ValuescanCopyTrading p = _deployProxy(address(impl), owner, xs);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // Upgraded (proxy), OwnershipTransferred, VenueUpdated x2, BuilderTermsUpdated, ExecutorSet x2, Initialized.
        assertEq(logs.length, 8);
        assertEq(logs[0].topics[0], keccak256("Upgraded(address)"));
        assertEq(logs[1].topics[0], keccak256("OwnershipTransferred(address,address)"));
        assertEq(logs[2].topics[0], IValuescanCopyTrading.VenueUpdated.selector);
        assertEq(uint256(logs[2].topics[1]), C.VENUE_SODEX);
        assertEq(logs[3].topics[0], IValuescanCopyTrading.VenueUpdated.selector);
        assertEq(uint256(logs[3].topics[1]), C.VENUE_HYPERLIQUID);
        assertEq(logs[4].topics[0], IValuescanCopyTrading.BuilderTermsUpdated.selector);
        assertEq(logs[4].data, abi.encode(BUILDER_ID, PERPS_FEE, SPOT_FEE));
        assertEq(logs[5].topics[0], IValuescanCopyTrading.ExecutorSet.selector);
        assertEq(logs[6].topics[0], IValuescanCopyTrading.ExecutorSet.selector);
        assertEq(address(uint160(uint256(logs[6].topics[1]))), x2);
        assertEq(logs[7].topics[0], keccak256("Initialized(uint64)"));
        assertEq(logs[7].data, abi.encode(uint64(1)));
        for (uint256 i = 1; i < logs.length; ++i) {
            assertEq(logs[i].emitter, address(p));
        }
    }

    function test_initialize_withoutExecutors() public {
        ValuescanCopyTrading p = _deployProxy(address(impl), owner, new address[](0));
        assertFalse(p.isExecutor(executor));
    }

    function test_initialize_revertsOnZeroOwner() public {
        bytes memory init = abi.encodeCall(
            ValuescanCopyTrading.initialize, (address(0), BUILDER_ID, PERPS_FEE, SPOT_FEE, new address[](0))
        );
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableInvalidOwner.selector, address(0)));
        new ERC1967Proxy(address(impl), init);
    }

    function test_initialize_revertsOnInvalidBuilderTerms() public {
        bytes memory init =
            abi.encodeCall(ValuescanCopyTrading.initialize, (owner, 0, PERPS_FEE, SPOT_FEE, new address[](0)));
        vm.expectRevert(IValuescanCopyTrading.InvalidBuilderTerms.selector);
        new ERC1967Proxy(address(impl), init);
    }

    function test_initialize_revertsOnZeroExecutor() public {
        bytes memory init =
            abi.encodeCall(ValuescanCopyTrading.initialize, (owner, BUILDER_ID, PERPS_FEE, SPOT_FEE, _one(address(0))));
        vm.expectRevert(IValuescanCopyTrading.InvalidExecutor.selector);
        new ERC1967Proxy(address(impl), init);
    }

    function test_proxy_cannotBeReinitialised() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        c.initialize(stranger, BUILDER_ID, 0, 0, new address[](0));
        vm.prank(owner);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        c.initialize(owner, BUILDER_ID, 0, 0, new address[](0));
    }

    function test_implementation_isLocked() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(stranger, BUILDER_ID, 0, 0, new address[](0));
        assertEq(impl.owner(), address(0));
        // The implementation's own storage is untouched and it has no owner who could do anything with it.
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        impl.pause();
    }

    function test_domain_isPinnedAndMatchesReference() public view {
        assertEq(c.DOMAIN_SEPARATOR(), E.domainSeparator(CHAIN_ID, address(c)));
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        ) = c.eip712Domain();
        assertEq(fields, hex"0f");
        assertEq(name, "ValuescanCopyTrading");
        assertEq(version, "1");
        assertEq(chainId, CHAIN_ID);
        assertEq(verifyingContract, address(c));
        assertEq(salt, bytes32(0));
        assertEq(extensions.length, 0);
    }

    function test_domain_followsChainId() public {
        bytes32 before = c.DOMAIN_SEPARATOR();
        vm.chainId(1);
        assertTrue(c.DOMAIN_SEPARATOR() != before);
        assertEq(c.DOMAIN_SEPARATOR(), E.domainSeparator(1, address(c)));
    }

    function test_ownership_twoStep() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger));
        c.transferOwnership(newOwner);

        vm.prank(owner);
        c.transferOwnership(newOwner);
        assertEq(c.owner(), owner);
        assertEq(c.pendingOwner(), newOwner);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger));
        c.acceptOwnership();

        vm.prank(newOwner);
        c.acceptOwnership();
        assertEq(c.owner(), newOwner);
        assertEq(c.pendingOwner(), address(0));
    }

    function test_renounceOwnership_isDisabled() public {
        vm.prank(owner);
        vm.expectRevert(IValuescanCopyTrading.RenounceDisabled.selector);
        c.renounceOwnership();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger));
        c.renounceOwnership();
        assertEq(c.owner(), owner);
    }

    function test_runtimeSize_fitsEip170WithHeadroom() public {
        _skipUnderCoverage();
        // EIP-170: 24,576 bytes. Keep at least 1.5 KB free so an upgrade can add features.
        assertLt(address(impl).code.length, 24_576 - 1536, "implementation too close to EIP-170");
    }
}
