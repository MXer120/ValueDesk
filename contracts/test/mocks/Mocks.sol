// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ValuescanCopyTrading} from "../../src/ValuescanCopyTrading.sol";

/// @notice Minimal ERC-1271 smart wallet: accepts a signature iff its owner key signed the digest. It can also make
///         direct calls (as msg.sender), like a Safe executing a transaction.
contract ERC1271WalletMock is IERC1271 {
    address public immutable walletOwner;
    bool public acceptAll;

    constructor(address walletOwner_) {
        walletOwner = walletOwner_;
    }

    function setAcceptAll(bool acceptAll_) external {
        acceptAll = acceptAll_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (acceptAll) return IERC1271.isValidSignature.selector;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        return err == ECDSA.RecoverError.NoError && recovered == walletOwner
            ? IERC1271.isValidSignature.selector
            : bytes4(0xffffffff);
    }

    function execute(address target, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == walletOwner, "not owner");
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }
}

/// @notice An ERC-1271 wallet whose `isValidSignature` always reverts.
contract RevertingERC1271Mock {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        revert("nope");
    }
}

/// @notice An upgrade target that adds one field in its own ERC-7201 namespace and keeps everything else. It stands
///         for any V2: all V1 state must survive, the EIP-712 domain must stay the same, and it must fit EIP-170.
contract ValuescanCopyTradingV2Mock is ValuescanCopyTrading {
    /// @custom:storage-location erc7201:valuescan.storage.CopyTradingV2Mock
    struct V2Storage {
        uint256 newField;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("valuescan.storage.CopyTradingV2Mock")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant V2_LOCATION = 0x80f19a04a56bf90840c63579c05fab4cffdfb13e017a612f20aba77528f12500;

    event NewFieldSet(uint256 value);

    function initializeV2(uint256 value) external reinitializer(2) {
        _v2().newField = value;
        emit NewFieldSet(value);
    }

    function newField() external view returns (uint256) {
        return _v2().newField;
    }

    function VERSION() public pure override returns (string memory) {
        return "2.0.0-mock";
    }

    function _v2() private pure returns (V2Storage storage $) {
        assembly ("memory-safe") {
            $.slot := V2_LOCATION
        }
    }
}

/// @notice An upgrade that deliberately bumps the EIP-712 domain version to "2" (spec §10.4). Every signature made for
///         version "1" stops working.
contract ValuescanCopyTradingDomainBumpMock is ValuescanCopyTrading {
    function initializeDomainBump() external reinitializer(2) {
        emit EIP712DomainChanged();
    }

    function _EIP712Version() internal pure override returns (string memory) {
        return "2";
    }
}

/// @notice Not UUPS: no `proxiableUUID`. Upgrading to it must fail.
contract NotUUPSMock {
    function hello() external pure returns (uint256) {
        return 1;
    }
}

/// @notice Forces native tokens into an address with SELFDESTRUCT, the only way to push value into a contract that
///         rejects it.
contract ForceSender {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}
