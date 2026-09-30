// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {IValuescanCopyTrading, CopyTradingConstants as C} from "../../src/interfaces/IValuescanCopyTrading.sol";

/// @notice Reference EIP-712 encoder for the Valuescan copy trading messages, written from the spec
///         (docs/contracts/COPY-TRADING.md §6), independently of the implementation. Tests sign with it, so every
///         accepted signature proves the contract hashes exactly what the spec says. `EIP712Spec.t.sol` checks this
///         encoder against Foundry's own EIP-712 implementation (`vm.eip712HashTypedData`).
library CopyTradingEIP712 {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function domainSeparator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return domainSeparator(C.EIP712_NAME, C.EIP712_VERSION, chainId, verifyingContract);
    }

    function domainSeparator(string memory name, string memory version, uint256 chainId, address verifyingContract)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), chainId, verifyingContract)
        );
    }

    function digest(bytes32 domain, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    /// @dev string[]: keccak256 of the concatenated keccak256 of each element; empty list = keccak256("").
    function hashStrings(string[] memory items) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](items.length);
        for (uint256 i = 0; i < items.length; ++i) {
            hashes[i] = keccak256(bytes(items[i]));
        }
        return keccak256(abi.encodePacked(hashes));
    }

    /// @dev Two abi.encode calls (every field is one 32-byte word, so the concatenation equals one abi.encode).
    function hashTerms(IValuescanCopyTrading.Terms memory t) internal pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                abi.encode(
                    C.TERMS_TYPEHASH,
                    t.delegatedKey,
                    keccak256(bytes(t.keyName)),
                    uint8(t.marketScope),
                    uint8(t.sizingMode),
                    t.sizingValue,
                    t.allocationCap,
                    t.maxPositionNotional,
                    t.maxLeverage,
                    t.tradeStopLossBps
                ),
                abi.encode(
                    t.maxDrawdownBps,
                    t.takeProfitBps,
                    t.slippageBps,
                    uint8(t.symbolMode),
                    hashStrings(t.symbols),
                    t.copyExisting,
                    t.maxBuilderFeePerps,
                    t.maxBuilderFeeSpot,
                    t.expiry
                )
            )
        );
    }

    function subscribeHash(
        address follower,
        uint8 venue,
        address leader,
        uint64 sodexAccountId,
        IValuescanCopyTrading.Terms memory terms,
        uint64 stopEpoch,
        uint256 expectedLastId,
        uint256 nonce,
        uint256 deadline
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                C.SUBSCRIBE_TYPEHASH,
                follower,
                venue,
                leader,
                sodexAccountId,
                hashTerms(terms),
                stopEpoch,
                expectedLastId,
                nonce,
                deadline
            )
        );
    }

    function updateHash(
        address follower,
        uint256 subscriptionId,
        uint32 expectedVersion,
        IValuescanCopyTrading.Terms memory terms,
        uint256 nonce,
        uint256 deadline
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(C.UPDATE_TYPEHASH, follower, subscriptionId, expectedVersion, hashTerms(terms), nonce, deadline)
        );
    }

    function pauseHash(address follower, uint256 subscriptionId, uint256 nonce, uint256 deadline)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(C.PAUSE_TYPEHASH, follower, subscriptionId, nonce, deadline));
    }

    function resumeHash(
        address follower,
        uint256 subscriptionId,
        uint32 expectedVersion,
        uint256 nonce,
        uint256 deadline
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(C.RESUME_TYPEHASH, follower, subscriptionId, expectedVersion, nonce, deadline));
    }

    function unsubscribeHash(
        address follower,
        uint256 subscriptionId,
        bool closePositions,
        uint256 nonce,
        uint256 deadline
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(C.UNSUBSCRIBE_TYPEHASH, follower, subscriptionId, closePositions, nonce, deadline));
    }

    function unsubscribeAllHash(address follower, bool closePositions, uint256 nonce, uint256 deadline)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(C.UNSUBSCRIBE_ALL_TYPEHASH, follower, closePositions, nonce, deadline));
    }

    function invalidateNoncesHash(address follower, uint256 word, uint256 mask, uint256 nonce, uint256 deadline)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(C.INVALIDATE_NONCES_TYPEHASH, follower, word, mask, nonce, deadline));
    }
}
