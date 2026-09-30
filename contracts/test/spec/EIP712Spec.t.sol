// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {IValuescanCopyTrading as I, CopyTradingConstants as C} from "../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingBase} from "../utils/CopyTradingBase.sol";
import {CopyTradingEIP712 as E} from "../utils/CopyTradingEIP712.sol";

/// @notice Spec-level checks of the EIP-712 encoding (spec §6):
///         1. the published type strings are canonical EIP-712 (Foundry's `eip712HashType`);
///         2. the reference encoder used by every test equals Foundry's independent encoder on the JSON a wallet
///            receives through `eth_signTypedData_v4`, for every message type;
///         3. the deployed proxy accepts a signature over Foundry's digest (end to end, no shared code);
///         4. the published vectors (spec §6.8) are reproduced; run with -vv to print them.
contract EIP712SpecTest is CopyTradingBase {
    address internal constant VECTOR_CONTRACT = 0x00000000000000000000000000000000C0FFEE01;
    address internal constant V_FOLLOWER = 0x3333333333333333333333333333333333333333;
    address internal constant V_LEADER = 0x4444444444444444444444444444444444444444;
    uint256 internal constant V_DEADLINE = 1_790_000_000;

    string internal constant DOMAIN_TYPE_JSON =
        '"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}]';
    string internal constant TERMS_TYPE_JSON =
        '"Terms":[{"name":"delegatedKey","type":"address"},{"name":"keyName","type":"string"},{"name":"marketScope","type":"uint8"},{"name":"sizingMode","type":"uint8"},{"name":"sizingValue","type":"uint64"},{"name":"allocationCap","type":"uint64"},{"name":"maxPositionNotional","type":"uint64"},{"name":"maxLeverage","type":"uint8"},{"name":"tradeStopLossBps","type":"uint16"},{"name":"maxDrawdownBps","type":"uint16"},{"name":"takeProfitBps","type":"uint32"},{"name":"slippageBps","type":"uint16"},{"name":"symbolMode","type":"uint8"},{"name":"symbols","type":"string[]"},{"name":"copyExisting","type":"bool"},{"name":"maxBuilderFeePerps","type":"uint16"},{"name":"maxBuilderFeeSpot","type":"uint16"},{"name":"expiry","type":"uint40"}]';

    function test_typeStringsAreCanonical() public pure {
        assertEq(vm.eip712HashType(C.TERMS_TYPE), C.TERMS_TYPEHASH, "Terms");
        assertEq(vm.eip712HashType(C.SUBSCRIBE_TYPE), C.SUBSCRIBE_TYPEHASH, "Subscribe");
        assertEq(vm.eip712HashType(C.UPDATE_TYPE), C.UPDATE_TYPEHASH, "UpdateSubscription");
        assertEq(vm.eip712HashType(C.PAUSE_TYPE), C.PAUSE_TYPEHASH, "PauseSubscription");
        assertEq(vm.eip712HashType(C.RESUME_TYPE), C.RESUME_TYPEHASH, "ResumeSubscription");
        assertEq(vm.eip712HashType(C.UNSUBSCRIBE_TYPE), C.UNSUBSCRIBE_TYPEHASH, "Unsubscribe");
        assertEq(vm.eip712HashType(C.UNSUBSCRIBE_ALL_TYPE), C.UNSUBSCRIBE_ALL_TYPEHASH, "UnsubscribeAll");
        assertEq(vm.eip712HashType(C.INVALIDATE_NONCES_TYPE), C.INVALIDATE_NONCES_TYPEHASH, "InvalidateNonces");
    }

    function test_constantsMatchSoDexAndValidity() public pure {
        assertEq(C.PERPS_BUILDER_FEE_CAP, 200);
        assertEq(C.SPOT_BUILDER_FEE_CAP, 2000);
        assertEq(C.MAX_BPS, 10_000);
        assertEq(C.MAX_KEY_NAME_LENGTH, 36);
        assertEq(C.VENUE_SODEX, 1);
        assertEq(C.VENUE_HYPERLIQUID, 2);
    }

    // ------------------------------------------------------------------------------------------------ vectors

    function _vectorTerms() internal pure returns (I.Terms memory t) {
        string[] memory symbols = new string[](2);
        symbols[0] = "BTC-USD";
        symbols[1] = "ETH-USD";
        t = I.Terms({
            delegatedKey: 0x2222222222222222222222222222222222222222,
            keyName: "vs-000001",
            marketScope: I.MarketScope.PERPS,
            sizingMode: I.SizingMode.PROPORTIONAL,
            sizingValue: 1_000_000,
            allocationCap: 1_000_000_000,
            maxPositionNotional: 2_500_000_000,
            maxLeverage: 5,
            tradeStopLossBps: 500,
            maxDrawdownBps: 2000,
            takeProfitBps: 5000,
            slippageBps: 50,
            symbolMode: I.SymbolMode.ALLOW,
            symbols: symbols,
            copyExisting: false,
            maxBuilderFeePerps: 50,
            maxBuilderFeeSpot: 0,
            expiry: 1_806_000_000
        });
    }

    function _vectorTermsJson() internal pure returns (string memory) {
        return string.concat(
            '{"delegatedKey":"0x2222222222222222222222222222222222222222","keyName":"vs-000001",',
            '"marketScope":1,"sizingMode":1,"sizingValue":1000000,"allocationCap":1000000000,',
            '"maxPositionNotional":2500000000,"maxLeverage":5,"tradeStopLossBps":500,"maxDrawdownBps":2000,',
            '"takeProfitBps":5000,"slippageBps":50,"symbolMode":1,"symbols":["BTC-USD","ETH-USD"],',
            '"copyExisting":false,"maxBuilderFeePerps":50,"maxBuilderFeeSpot":0,"expiry":1806000000}'
        );
    }

    function _json(
        string memory types,
        string memory primaryType,
        uint256 chainId,
        address verifyingContract,
        string memory message
    ) internal pure returns (string memory) {
        return string.concat(
            '{"types":{',
            DOMAIN_TYPE_JSON,
            ",",
            types,
            '},"primaryType":"',
            primaryType,
            '","domain":{"name":"ValuescanCopyTrading","version":"1","chainId":',
            vm.toString(chainId),
            ',"verifyingContract":"',
            vm.toString(verifyingContract),
            '"},"message":',
            message,
            "}"
        );
    }

    function _subscribeJson(uint256 chainId, address verifyingContract, uint256 nonce)
        internal
        pure
        returns (string memory)
    {
        string memory types = string.concat(
            '"Subscribe":[{"name":"follower","type":"address"},{"name":"venue","type":"uint8"},',
            '{"name":"leader","type":"address"},{"name":"sodexAccountId","type":"uint64"},',
            '{"name":"terms","type":"Terms"},{"name":"stopEpoch","type":"uint64"},{"name":"expectedLastId","type":"uint256"},',
            '{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}],',
            TERMS_TYPE_JSON
        );
        string memory message = string.concat(
            '{"follower":"',
            vm.toString(V_FOLLOWER),
            '","venue":2,"leader":"',
            vm.toString(V_LEADER),
            '","sodexAccountId":224678,"terms":',
            _vectorTermsJson(),
            ',"stopEpoch":0,"expectedLastId":0,"nonce":',
            vm.toString(nonce),
            ',"deadline":1790000000}'
        );
        return _json(types, "Subscribe", chainId, verifyingContract, message);
    }

    function test_vector_subscribe() public {
        bytes32 domain = E.domainSeparator(CHAIN_ID, VECTOR_CONTRACT);
        bytes32 termsHash = E.hashTerms(_vectorTerms());
        bytes32 structHash =
            E.subscribeHash(V_FOLLOWER, C.VENUE_HYPERLIQUID, V_LEADER, 224_678, _vectorTerms(), 0, 0, 7, V_DEADLINE);
        bytes32 digest = E.digest(domain, structHash);
        assertEq(digest, vm.eip712HashTypedData(_subscribeJson(CHAIN_ID, VECTOR_CONTRACT, 7)), "Subscribe digest");
        emit log_named_bytes32("vector domainSeparator", domain);
        emit log_named_bytes32("vector Terms hashStruct", termsHash);
        emit log_named_bytes32("vector Subscribe hashStruct", structHash);
        emit log_named_bytes32("vector Subscribe digest", digest);
    }

    function test_vector_update() public {
        string memory types = string.concat(
            '"UpdateSubscription":[{"name":"follower","type":"address"},{"name":"subscriptionId","type":"uint256"},',
            '{"name":"expectedVersion","type":"uint32"},{"name":"terms","type":"Terms"},',
            '{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}],',
            TERMS_TYPE_JSON
        );
        string memory message = string.concat(
            '{"follower":"',
            vm.toString(V_FOLLOWER),
            '","subscriptionId":42,"expectedVersion":3,"terms":',
            _vectorTermsJson(),
            ',"nonce":8,"deadline":1790000000}'
        );
        bytes32 expected = E.digest(
            E.domainSeparator(CHAIN_ID, VECTOR_CONTRACT), E.updateHash(V_FOLLOWER, 42, 3, _vectorTerms(), 8, V_DEADLINE)
        );
        assertEq(
            expected, vm.eip712HashTypedData(_json(types, "UpdateSubscription", CHAIN_ID, VECTOR_CONTRACT, message))
        );
        emit log_named_bytes32("vector UpdateSubscription digest", expected);
    }

    function test_vector_simpleTypes() public {
        bytes32 domain = E.domainSeparator(CHAIN_ID, VECTOR_CONTRACT);
        string memory f = vm.toString(V_FOLLOWER);

        bytes32 d = E.digest(domain, E.pauseHash(V_FOLLOWER, 42, 9, V_DEADLINE));
        assertEq(
            d,
            vm.eip712HashTypedData(
                _json(
                    '"PauseSubscription":[{"name":"follower","type":"address"},{"name":"subscriptionId","type":"uint256"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}]',
                    "PauseSubscription",
                    CHAIN_ID,
                    VECTOR_CONTRACT,
                    string.concat('{"follower":"', f, '","subscriptionId":42,"nonce":9,"deadline":1790000000}')
                )
            ),
            "PauseSubscription"
        );
        emit log_named_bytes32("vector PauseSubscription digest", d);

        d = E.digest(domain, E.resumeHash(V_FOLLOWER, 42, 4, 10, V_DEADLINE));
        assertEq(
            d,
            vm.eip712HashTypedData(
                _json(
                    '"ResumeSubscription":[{"name":"follower","type":"address"},{"name":"subscriptionId","type":"uint256"},{"name":"expectedVersion","type":"uint32"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}]',
                    "ResumeSubscription",
                    CHAIN_ID,
                    VECTOR_CONTRACT,
                    string.concat(
                        '{"follower":"',
                        f,
                        '","subscriptionId":42,"expectedVersion":4,"nonce":10,"deadline":1790000000}'
                    )
                )
            ),
            "ResumeSubscription"
        );
        emit log_named_bytes32("vector ResumeSubscription digest", d);

        d = E.digest(domain, E.unsubscribeHash(V_FOLLOWER, 42, true, 11, V_DEADLINE));
        assertEq(
            d,
            vm.eip712HashTypedData(
                _json(
                    '"Unsubscribe":[{"name":"follower","type":"address"},{"name":"subscriptionId","type":"uint256"},{"name":"closePositions","type":"bool"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}]',
                    "Unsubscribe",
                    CHAIN_ID,
                    VECTOR_CONTRACT,
                    string.concat(
                        '{"follower":"',
                        f,
                        '","subscriptionId":42,"closePositions":true,"nonce":11,"deadline":1790000000}'
                    )
                )
            ),
            "Unsubscribe"
        );
        emit log_named_bytes32("vector Unsubscribe digest", d);

        d = E.digest(domain, E.unsubscribeAllHash(V_FOLLOWER, true, 12, V_DEADLINE));
        assertEq(
            d,
            vm.eip712HashTypedData(
                _json(
                    '"UnsubscribeAll":[{"name":"follower","type":"address"},{"name":"closePositions","type":"bool"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}]',
                    "UnsubscribeAll",
                    CHAIN_ID,
                    VECTOR_CONTRACT,
                    string.concat('{"follower":"', f, '","closePositions":true,"nonce":12,"deadline":1790000000}')
                )
            ),
            "UnsubscribeAll"
        );
        emit log_named_bytes32("vector UnsubscribeAll digest", d);

        d = E.digest(domain, E.invalidateNoncesHash(V_FOLLOWER, 0, 0xff, 13, V_DEADLINE));
        assertEq(
            d,
            vm.eip712HashTypedData(
                _json(
                    '"InvalidateNonces":[{"name":"follower","type":"address"},{"name":"word","type":"uint256"},{"name":"mask","type":"uint256"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}]',
                    "InvalidateNonces",
                    CHAIN_ID,
                    VECTOR_CONTRACT,
                    string.concat('{"follower":"', f, '","word":0,"mask":255,"nonce":13,"deadline":1790000000}')
                )
            ),
            "InvalidateNonces"
        );
        emit log_named_bytes32("vector InvalidateNonces digest", d);
    }

    function test_emptySymbolList_hashesToKeccakOfEmpty() public pure {
        assertEq(E.hashStrings(new string[](0)), keccak256(""));
    }

    // ------------------------------------------------------------------------------------------------ end to end

    /// @dev The proxy accepts a signature over the digest Foundry computes from wallet JSON: no code is shared between
    ///      the signing side and the contract.
    function test_contractAcceptsWalletJsonDigest() public {
        uint256 pk = 0xA11CE;
        address follower = vm.addr(pk);
        // Re-point the JSON vector at this follower, this proxy and a live deadline.
        string memory types = string.concat(
            '"Subscribe":[{"name":"follower","type":"address"},{"name":"venue","type":"uint8"},',
            '{"name":"leader","type":"address"},{"name":"sodexAccountId","type":"uint64"},',
            '{"name":"terms","type":"Terms"},{"name":"stopEpoch","type":"uint64"},{"name":"expectedLastId","type":"uint256"},',
            '{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}],',
            TERMS_TYPE_JSON
        );
        string memory message = string.concat(
            '{"follower":"',
            vm.toString(follower),
            '","venue":2,"leader":"',
            vm.toString(V_LEADER),
            '","sodexAccountId":224678,"terms":',
            _vectorTermsJson(),
            ',"stopEpoch":0,"expectedLastId":0,"nonce":7,"deadline":',
            vm.toString(T0 + 1 days),
            "}"
        );
        bytes32 digest = vm.eip712HashTypedData(_json(types, "Subscribe", CHAIN_ID, address(c), message));
        bytes memory signature = _signDigest(pk, digest);
        vm.prank(relayer);
        uint256 id = c.subscribeWithSig(
            follower,
            C.VENUE_HYPERLIQUID,
            V_LEADER,
            224_678,
            _vectorTerms(),
            0,
            _lastId(follower, 224_678, C.VENUE_HYPERLIQUID, V_LEADER),
            I.SignatureParams(7, T0 + 1 days, signature)
        );
        assertEq(c.getSubscription(id).follower, follower);
        assertEq(c.getSubscription(id).symbolsHash, E.hashStrings(_vectorTerms().symbols));
    }
}
