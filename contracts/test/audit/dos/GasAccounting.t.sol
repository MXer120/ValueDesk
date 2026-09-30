// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {ValuescanCopyTrading} from "../../../src/ValuescanCopyTrading.sol";
import {CopyTradingBase} from "../../utils/CopyTradingBase.sol";

/// @dev Measures the gas of ONE inner call frame with gasleft(), as the EVM charges it (no intrinsic gas, no calldata).
contract FrameMeter {
    function measure(address target, bytes calldata data) external returns (uint256 used) {
        uint256 g0 = gasleft();
        (bool ok,) = target.call(data);
        used = g0 - gasleft();
        require(ok, "inner call failed");
    }
}

/// @notice AUDIT (gas lens): what the suite's gas numbers actually measure.
///
///         test/gas/Gas.t.sol and spec section 11 say the numbers are "call frame only (no 21,000 intrinsic cost, no
///         calldata cost)". Under Foundry 1.8.3 a top-level CALL from a test runs as its own transaction and
///         `lastCallGas()` / `snapshotGasLastCall` report TRANSACTION gas: 21,000 + calldata (EIP-7623 rules) +
///         execution. Consequences:
///         - every number in the section 11 table is transaction gas, not frame gas;
///         - the section 11 cost column adds "about 21k intrinsic gas" on top again (385,517 + 21,000 -> 0.81 microSOSO),
///           so every cost is double-counted by 21,000 gas;
///         - "each extra symbol ~3,700 (execution; calldata adds about 1.6k)": the 3,700 already includes calldata.
contract GasAccountingTest is CopyTradingBase {
    FrameMeter internal meter;

    function setUp() public override {
        _skipUnderCoverage();
        super.setUp();
        meter = new FrameMeter();
    }

    function _calldataGas(bytes memory data) internal pure returns (uint256 g) {
        for (uint256 i = 0; i < data.length; ++i) {
            g += data[i] == 0 ? 4 : 16;
        }
    }

    /// The same view, by CALL and by STATICCALL: the CALL figure is exactly 21,000 + calldata higher.
    function test_topLevelCallGas_includesIntrinsicAndCalldata() public {
        bytes memory data = abi.encodeCall(ValuescanCopyTrading.statusOf, (1));
        (bool ok,) = address(c).staticcall(data);
        assertTrue(ok);
        uint256 frame = vm.lastCallGas().gasTotalUsed;
        (ok,) = address(c).call(data);
        assertTrue(ok);
        uint256 asTx = vm.lastCallGas().gasTotalUsed;
        emit log_named_uint("statusOf by STATICCALL (frame)", frame);
        emit log_named_uint("statusOf by CALL (reported)", asTx);
        assertEq(asTx - frame, 21_000 + _calldataGas(data), "CALL figure = frame + 21,000 + calldata");
    }

    /// The kill switch as Gas.t.sol measures it (73,987 in the spec table) versus its real call frame.
    function test_specTableKillSwitchFigure_isTransactionGas() public {
        _subscribeAs(alice, leader);
        vm.prank(alice);
        c.unsubscribeAll(true); // exactly as test_gas_unsubscribeAll_1live
        uint256 reported = vm.lastCallGas().gasTotalUsed;

        // Same state change (a first kill switch: stop epoch 0 -> 1, new kill-switch record) for the meter address,
        // measured on the frame itself. The meter's frame also pays 2,600 for the cold proxy account.
        uint256 frame = meter.measure(address(c), abi.encodeCall(ValuescanCopyTrading.unsubscribeAll, (true))) - 2600;
        emit log_named_uint("unsubscribeAll as reported by the suite", reported);
        emit log_named_uint("unsubscribeAll call frame (gasleft, cold proxy access removed)", frame);
        emit log_named_uint("difference", reported - frame);
        assertGt(reported - frame, 20_000, "the reported figure contains the 21,000 intrinsic gas");
        // On 2026-09-25 `reported` was 73,987, the spec table's figure. Spec section 11 cost column:
        // (73,987 + 21,000) * 0.002 gwei = 0.19 microSOSO; the transaction really costs 73,987 * 0.002 gwei = 0.148.
        emit log_named_uint("transaction cost in wei at 0.002 gwei", reported * 2_000_000);
    }
}
