// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {ValuescanCopyTrading} from "../../src/ValuescanCopyTrading.sol";

/// @notice Not deployed anywhere. It exists only so that the compiler emits the storage layout of the ERC-7201
///         namespace struct (a namespaced struct is not a state variable, so the contract's own layout is empty).
///         `tools/storage-layout.mjs` reads this artifact's `storageLayout` and compares it with the committed
///         snapshot `storage-layout/ValuescanCopyTrading.json`. Member slots are relative to the namespace root
///         (`STORAGE_LOCATION`).
contract CopyTradingStorageLayoutHarness {
    ValuescanCopyTrading.CopyTradingStorage internal $;
}
