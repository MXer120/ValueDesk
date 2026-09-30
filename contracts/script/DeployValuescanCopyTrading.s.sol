// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

// =====================================================================================================================
//   DO NOT RUN: deployment requires the owner's explicit go.
//
//   This file only documents the intended wiring (implementation + ERC1967Proxy + TimelockController owned by a
//   multisig). `run()` always reverts, there is no other external entry point, and the file holds no key, no RPC URL
//   and no address. The wiring is exercised only inside a local test EVM by test/script/DeployWiring.t.sol.
//   Deploying needs: the owner's written go, an external audit, the multisig address, the builder id and fees, and the
//   executor addresses (spec §13, "Deployment checklist").
// =====================================================================================================================

import {Script} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ValuescanCopyTrading} from "../src/ValuescanCopyTrading.sol";

contract DeployValuescanCopyTrading is Script {
    /// @notice Recommended upgrade delay: followers see a scheduled upgrade 48 hours before it can run.
    uint256 public constant TIMELOCK_DELAY = 48 hours;

    struct Config {
        address multisig; // the Safe that proposes, executes and can cancel timelock operations
        uint64 builderId; // Valuescan's SoDEX account id (builder id)
        uint16 perpsFee; // tenths of a bp, <= 200
        uint16 spotFee; // tenths of a bp, <= 2000
        address[] executors; // Valuescan's executor addresses
    }

    struct Deployment {
        TimelockController timelock;
        ValuescanCopyTrading implementation;
        ValuescanCopyTrading proxy;
    }

    /// @notice DO NOT RUN. Always reverts.
    function run() external pure {
        revert("DO NOT RUN: deployment requires the owner's explicit go");
    }

    /// @dev The wiring, in order. Internal: reachable only from a test harness, never from `forge script`.
    ///      1. TimelockController(48 h): the multisig is the only proposer and executor (proposers are also
    ///         cancellers); no admin, so the timelock administers itself and its delay can only change through itself.
    ///      2. The implementation; its constructor locks it (`_disableInitializers`).
    ///      3. The ERC1967Proxy, initialised atomically in its constructor with the timelock as owner, so nobody can
    ///         front-run `initialize` and no ownership transfer is needed.
    function _deploy(Config memory cfg) internal returns (Deployment memory d) {
        require(cfg.multisig != address(0), "multisig");
        address[] memory roles = new address[](1);
        roles[0] = cfg.multisig;
        d.timelock = new TimelockController(TIMELOCK_DELAY, roles, roles, address(0));
        d.implementation = new ValuescanCopyTrading();
        d.proxy = ValuescanCopyTrading(
            address(
                new ERC1967Proxy(
                    address(d.implementation),
                    abi.encodeCall(
                        ValuescanCopyTrading.initialize,
                        (address(d.timelock), cfg.builderId, cfg.perpsFee, cfg.spotFee, cfg.executors)
                    )
                )
            )
        );
        require(d.proxy.owner() == address(d.timelock), "owner");
    }
}
