// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ValuescanCopyTrading} from "../../../src/ValuescanCopyTrading.sol";
import {CopyTradingConstants as C} from "../../../src/interfaces/IValuescanCopyTrading.sol";
import {DeployValuescanCopyTrading} from "../../../script/DeployValuescanCopyTrading.s.sol";
import {CopyTradingBase} from "../../utils/CopyTradingBase.sol";

/// @dev Exposes the documented wiring (script `_deploy`) to the local test EVM only. Nothing is broadcast.
contract SEC02DeployHarness is DeployValuescanCopyTrading {
    function deployForTest(Config memory cfg) external returns (Deployment memory) {
        return _deploy(cfg);
    }
}

/// @dev What a compromised multisig would install: every call reverts (stops included) and it can never be upgraded
///      again. It is a valid UUPS target, so `upgradeToAndCall` accepts it.
contract SEC02FrozenImplementation is UUPSUpgradeable {
    function _authorizeUpgrade(address) internal pure override {
        revert("frozen");
    }

    fallback() external {
        revert("stops disabled");
    }
}

/// @notice AUDIT SEC-02 (low, LEFTOVER on-chain; spec and SDK corrected), kept as a regression test. The timelock
///         administers itself, so a call whose TARGET IS THE TIMELOCK (`updateDelay(0)`) can lower the delay after
///         48 h; from then on an upgrade of the proxy is scheduled and executed in the same block. A monitor that
///         watches only CallScheduled "for the proxy" therefore gets zero notice. The corrected rule (spec §10.2 and
///         §15, INTEGRATION.md, the copy-contract SDK timelock helpers) is: alert on EVERY CallScheduled of the
///         timelock, and treat calls on the timelock itself (updateDelay, grantRole, revokeRole) like an upgrade.
///         This test proves that rule still gives followers the full 48 h. The on-chain delay floor (a
///         TimelockController whose updateDelay reverts below 48 h) is an open owner decision.
contract SEC02_TimelockNoticeBypassTest is CopyTradingBase {
    bytes32 internal constant CALL_SCHEDULED =
        keccak256("CallScheduled(bytes32,uint256,address,uint256,bytes,bytes32,uint256)");

    function _scheduledTarget(Vm.Log[] memory logs) internal pure returns (address target) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == CALL_SCHEDULED) {
                (target,,,,) = abi.decode(logs[i].data, (address, uint256, bytes, bytes32, uint256));
                return target;
            }
        }
    }

    function test_audit_SEC02_everyCallScheduledMonitor_stillGets48hNotice_ofATimelockSelfCallThenUpgrade() public {
        address multisig = makeAddr("multisig (compromised)");
        SEC02DeployHarness h = new SEC02DeployHarness();
        DeployValuescanCopyTrading.Deployment memory d = h.deployForTest(
            DeployValuescanCopyTrading.Config(multisig, BUILDER_ID, PERPS_FEE, SPOT_FEE, _one(executor))
        );
        TimelockController tl = d.timelock;
        ValuescanCopyTrading p = d.proxy;
        assertEq(tl.getMinDelay(), 48 hours);

        vm.prank(alice);
        uint256 id = p.subscribe(C.VENUE_SODEX, leader, ACCOUNT, _terms());

        // Step 1: lower the delay. The corrected monitor alerts here: ANY CallScheduled of the timelock, and this one
        // targets the timelock itself, which counts as upgrade-level.
        bytes memory lower = abi.encodeCall(tl.updateDelay, (0));
        vm.recordLogs();
        vm.prank(multisig);
        tl.schedule(address(tl), 0, lower, bytes32(0), bytes32("maintenance"), 48 hours);
        uint256 firstAlertAt = vm.getBlockTimestamp();
        assertEq(_scheduledTarget(vm.getRecordedLogs()), address(tl), "target is the timelock, not the proxy");
        vm.warp(T0 + 48 hours);
        vm.prank(multisig);
        tl.execute(address(tl), 0, lower, bytes32(0), bytes32("maintenance"));
        assertEq(tl.getMinDelay(), 0);

        // Step 2: the first proxy-targeted CallScheduled and the upgrade, in one block (still possible: leftover).
        SEC02FrozenImplementation evil = new SEC02FrozenImplementation();
        bytes memory up = abi.encodeCall(p.upgradeToAndCall, (address(evil), bytes("")));
        vm.recordLogs();
        vm.prank(multisig);
        tl.schedule(address(p), 0, up, bytes32(0), bytes32("v2"), 0);
        uint256 proxyAnnouncedAt = vm.getBlockTimestamp();
        assertEq(_scheduledTarget(vm.getRecordedLogs()), address(p));
        vm.prank(multisig);
        tl.execute(address(p), 0, up, bytes32(0), bytes32("v2"));
        uint256 effectiveAt = vm.getBlockTimestamp();

        vm.startPrank(alice);
        (bool ok,) = address(p).call(abi.encodeCall(p.unsubscribe, (id, true)));
        assertFalse(ok, "unsubscribe is gone");
        vm.stopPrank();

        console2.log("notice seen by a proxy-only monitor (s):", effectiveAt - proxyAnnouncedAt);
        console2.log("notice seen by an every-CallScheduled monitor (s):", effectiveAt - firstAlertAt);
        assertEq(effectiveAt - proxyAnnouncedAt, 0, "leftover: a proxy-only filter gets no notice");
        assertGe(effectiveAt - firstAlertAt, 48 hours, "SEC-02 rule: watching every CallScheduled gives 48 h");
    }
}
