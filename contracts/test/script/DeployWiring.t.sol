// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ValuescanCopyTrading} from "../../src/ValuescanCopyTrading.sol";
import {DeployValuescanCopyTrading} from "../../script/DeployValuescanCopyTrading.s.sol";

/// @dev Exposes the internal wiring to the local test EVM only.
contract DeployHarness is DeployValuescanCopyTrading {
    function deployForTest(Config memory cfg) external returns (Deployment memory) {
        return _deploy(cfg);
    }
}

/// @notice The documented deployment wiring works in a local EVM, and the script itself cannot be run.
contract DeployWiringTest is Test {
    function test_run_alwaysReverts() public {
        DeployValuescanCopyTrading s = new DeployValuescanCopyTrading();
        vm.expectRevert(bytes("DO NOT RUN: deployment requires the owner's explicit go"));
        s.run();
    }

    function test_wiring() public {
        address multisig = makeAddr("multisig");
        address[] memory xs = new address[](1);
        xs[0] = makeAddr("executor");
        DeployHarness h = new DeployHarness();
        DeployValuescanCopyTrading.Deployment memory d =
            h.deployForTest(DeployValuescanCopyTrading.Config(multisig, 224_000, 50, 100, xs));

        assertEq(d.proxy.owner(), address(d.timelock));
        assertEq(d.timelock.getMinDelay(), 48 hours);
        assertTrue(d.timelock.hasRole(d.timelock.PROPOSER_ROLE(), multisig));
        assertTrue(d.timelock.hasRole(d.timelock.EXECUTOR_ROLE(), multisig));
        assertTrue(d.timelock.hasRole(d.timelock.CANCELLER_ROLE(), multisig));
        assertFalse(d.timelock.hasRole(d.timelock.DEFAULT_ADMIN_ROLE(), multisig));
        assertFalse(d.timelock.hasRole(d.timelock.DEFAULT_ADMIN_ROLE(), address(h)));
        assertTrue(d.timelock.hasRole(d.timelock.DEFAULT_ADMIN_ROLE(), address(d.timelock)));
        assertEq(
            address(uint160(uint256(vm.load(address(d.proxy), ERC1967Utils.IMPLEMENTATION_SLOT)))),
            address(d.implementation)
        );
        assertTrue(d.proxy.isExecutor(xs[0]));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        d.implementation.initialize(multisig, 1, 0, 0, new address[](0));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        d.proxy.initialize(multisig, 1, 0, 0, new address[](0));
    }
}
