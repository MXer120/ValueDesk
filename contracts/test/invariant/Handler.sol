// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {ValuescanCopyTrading} from "../../src/ValuescanCopyTrading.sol";
import {IValuescanCopyTrading as I, CopyTradingConstants as C} from "../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingEIP712 as E} from "../utils/CopyTradingEIP712.sol";
import {ERC1271WalletMock, ValuescanCopyTradingV2Mock} from "../mocks/Mocks.sol";
import {EventIndexer} from "./EventIndexer.sol";

/// @notice Invariant handler. Drives the proxy with bounded random actions from three EOA followers and one ERC-1271
///         wallet follower (directly and through signatures submitted by a relayer), the owner and two executors, plus
///         time warps and one live upgrade to V2 (attacks live in AttackHandler). After every action it feeds the recorded logs to the
///         indexer, naming the only follower allowed to change subscriptions in that action.
///         It also models which calls must succeed and which must fail, and counts every disagreement.
contract CopyTradingHandler is CommonBase, StdUtils {
    uint256 internal constant NONCE_BASE = 1 << 20; // handler nonces; words 0..3 are left for invalidation

    ValuescanCopyTrading public immutable c;
    EventIndexer public immutable indexer;
    address public immutable owner;
    address public immutable relayer;
    address public immutable attacker;
    ERC1271WalletMock public immutable wallet;
    address internal immutable walletOwner;

    address[4] public followers;
    uint256[4] internal keys; // for the wallet: its owner's key
    address[3] public leaders;
    address[2] public executors;
    uint64[2] public accounts = [uint64(101), uint64(202)];

    mapping(address => uint256) public nextNonce;
    mapping(address => uint256) public killCount;
    mapping(address => uint64) public lastCommitEpoch;
    address public v2;
    bool public upgraded;
    bytes internal lastSignedCall;

    // Disagreements with the model. All must stay 0.
    uint256 public stopFailures; // a stop that must work did not
    uint256 public unexpectedSuccesses; // an invalid or pause-blocked call succeeded (attacks: AttackHandler)
    uint256 public unexpectedFailures; // a valid, authorised call failed
    uint256 public actions;
    // Coverage of the campaign: successful and failed calls per action (reported by afterInvariant with -vv).
    mapping(bytes32 => uint256) public succeeded;
    mapping(bytes32 => uint256) public failed;

    constructor(
        ValuescanCopyTrading c_,
        EventIndexer indexer_,
        address owner_,
        address[2] memory executors_,
        address v2_
    ) {
        c = c_;
        indexer = indexer_;
        owner = owner_;
        executors = executors_;
        relayer = vm.addr(0xBEEF01);
        attacker = vm.addr(0xBAD);
        for (uint256 i = 0; i < 3; ++i) {
            keys[i] = 0xF011 + i;
            followers[i] = vm.addr(keys[i]);
        }
        keys[3] = 0xF0110A;
        walletOwner = vm.addr(keys[3]);
        wallet = new ERC1271WalletMock(walletOwner);
        followers[3] = address(wallet);
        leaders = [vm.addr(0x1EAD1), vm.addr(0x1EAD2), address(0xdead)];
        for (uint256 i = 0; i < 4; ++i) {
            nextNonce[followers[i]] = NONCE_BASE;
        }
        v2 = v2_; // a ValuescanCopyTradingV2Mock, deployed by the test (keeps this contract under EIP-3860)
    }

    // ------------------------------------------------------------------------------------------------ plumbing

    function _begin() internal {
        ++actions;
        vm.recordLogs();
    }

    function _end(address authoriser) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        indexer.ingest(logs, authoriser, vm.getBlockTimestamp());
    }

    /// @dev A direct call as `from` (the wallet acts through its owner, like a Safe transaction).
    function _as(address from, bytes memory data) internal returns (bool ok) {
        if (from == address(wallet)) {
            vm.prank(walletOwner);
            (ok,) = address(wallet).call(abi.encodeCall(wallet.execute, (address(c), data)));
        } else {
            vm.prank(from);
            (ok,) = address(c).call(data);
        }
    }

    function _relay(bytes memory data) internal returns (bool ok) {
        vm.prank(relayer);
        (ok,) = address(c).call(data);
        if (ok) lastSignedCall = data;
    }

    function _sig(uint256 k, bytes32 structHash, uint256 nonce, uint256 deadline)
        internal
        view
        returns (I.SignatureParams memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, E.digest(E.domainSeparator(block.chainid, address(c)), structHash));
        return I.SignatureParams(nonce, deadline, abi.encodePacked(r, s, v));
    }

    function _deadline() internal view returns (uint256) {
        return vm.getBlockTimestamp() + 1 hours;
    }

    function _count(bytes32 action, bool ok) internal {
        if (ok) ++succeeded[action];
        else ++failed[action];
    }

    function _expect(bool ok, bool shouldSucceed) internal {
        if (ok && !shouldSucceed) ++unexpectedSuccesses;
        if (!ok && shouldSucceed) ++unexpectedFailures;
    }

    function _pick(uint256 idSeed) internal view returns (uint256 id, address follower, I.Status status) {
        uint256 n = indexer.count();
        if (n == 0) return (0, address(0), I.Status.NONE);
        id = 1 + idSeed % n;
        I.Subscription memory s = indexer.subscription(id);
        return (id, s.follower, s.status);
    }

    /// @dev Three times in four, the first id at or after the seed whose effective status is `want` (so pause,
    ///      resume and unsubscribe mostly hit a valid target); otherwise, or if none has it, any id.
    function _pickWith(uint256 idSeed, I.Status want) internal view returns (uint256, address, I.Status) {
        uint256 n = indexer.count();
        if (n != 0 && idSeed % 4 != 0) {
            for (uint256 k = 0; k < n; ++k) {
                uint256 id = 1 + (idSeed % n + k) % n;
                if (indexer.effectiveStatus(id) == want) return _pick(id - 1);
            }
        }
        return _pick(idSeed);
    }

    /// @dev Mostly valid terms; one in sixteen has slippage 0 (invalid).
    function _terms(uint256 rawSeed, address follower) internal view returns (I.Terms memory t, bool valid) {
        uint256 seed = uint256(keccak256(abi.encode(rawSeed))); // spread small fuzz values over every field
        t.delegatedKey = address(uint160(uint256(keccak256(abi.encode("key", follower)))));
        t.keyName = seed % 3 == 0 ? "vs-a" : "vs-bcdefghijklmnopqrstuvwxyz-0123456";
        t.marketScope = I.MarketScope(1 + seed % 3);
        t.sizingMode = I.SizingMode(1 + (seed >> 8) % 3);
        t.allocationCap = uint64(1e6 + (seed >> 16) % 1e12);
        t.maxLeverage = t.marketScope == I.MarketScope.SPOT ? 1 : uint8(1 + (seed >> 24) % 50);
        t.maxPositionNotional = t.allocationCap;
        t.sizingValue = t.sizingMode == I.SizingMode.FIXED_NOTIONAL
            ? t.maxPositionNotional / 2 + 1
            : uint64(1 + (seed >> 32) % 5e6);
        t.tradeStopLossBps = uint16((seed >> 40) % 10_001);
        t.maxDrawdownBps = uint16((seed >> 56) % 10_001);
        t.takeProfitBps = uint32(seed >> 72);
        t.slippageBps = uint16(1 + (seed >> 104) % 10_000);
        t.symbolMode = I.SymbolMode((seed >> 120) % 3);
        if (t.symbolMode != I.SymbolMode.ALL) {
            t.symbols = new string[](1 + (seed >> 124) % 3);
            for (uint256 i = 0; i < t.symbols.length; ++i) {
                t.symbols[i] = i == 0 ? "BTC-USD" : (i == 1 ? "ETH-USD" : "SOL-USD");
            }
        }
        t.copyExisting = (seed >> 130) & 1 == 1;
        t.maxBuilderFeePerps = uint16((seed >> 140) % 201);
        t.maxBuilderFeeSpot = uint16((seed >> 152) % 2001);
        t.expiry = (seed >> 170) % 3 == 0 ? 0 : uint40(vm.getBlockTimestamp() + 1 + (seed >> 180) % 5 days);
        valid = true;
        if ((seed >> 200) % 16 == 0) {
            t.slippageBps = 0;
            valid = false;
        }
    }

    function _isLive(I.Status s) internal pure returns (bool) {
        return s == I.Status.ACTIVE || s == I.Status.PAUSED;
    }

    // ------------------------------------------------------------------------------------------------ followers

    function subscribe(uint256 fSeed, uint256 lSeed, uint256 vSeed, uint256 aSeed, uint256 tSeed, bool signed)
        external
    {
        uint256 fi = fSeed % 4;
        address f = followers[fi];
        address leader = leaders[lSeed % 3];
        uint8 venue = uint8(1 + vSeed % 2);
        uint64 account = accounts[aSeed % 2];
        (I.Terms memory t, bool valid) = _terms(tSeed, f);
        bool shouldSucceed = valid && !indexer.paused() && indexer.venue(venue).enabled
            && c.liveSubscriptionFor(f, account, venue, leader) == 0;
        _begin();
        bool ok;
        if (signed) {
            uint64 epoch = c.stopEpochOf(f);
            uint256 last = c.lastSubscriptionFor(f, account, venue, leader);
            uint256 nonce = nextNonce[f]++;
            I.SignatureParams memory sig = _sig(
                keys[fi],
                E.subscribeHash(f, venue, leader, account, t, epoch, last, nonce, _deadline()),
                nonce,
                _deadline()
            );
            ok = _relay(abi.encodeCall(c.subscribeWithSig, (f, venue, leader, account, t, epoch, last, sig)));
        } else {
            ok = _as(f, abi.encodeCall(c.subscribe, (venue, leader, account, t)));
        }
        _end(f);
        _count(signed ? bytes32("subscribeWithSig") : bytes32("subscribe"), ok);
        _expect(ok, shouldSucceed);
    }

    function update(uint256 idSeed, uint256 tSeed, bool signed) external {
        (uint256 id, address f, I.Status status) = _pickWith(idSeed, I.Status.ACTIVE);
        if (id == 0) return;
        uint256 fi = _index(f);
        (I.Terms memory t, bool valid) = _terms(tSeed, f);
        bool shouldSucceed = valid && !indexer.paused() && _isLive(status);
        _begin();
        bool ok;
        if (signed) {
            uint32 version = indexer.subscription(id).version;
            uint256 nonce = nextNonce[f]++;
            I.SignatureParams memory sig =
                _sig(keys[fi], E.updateHash(f, id, version, t, nonce, _deadline()), nonce, _deadline());
            ok = _relay(abi.encodeCall(c.updateSubscriptionWithSig, (id, version, t, sig)));
        } else {
            ok = _as(f, abi.encodeCall(c.updateSubscription, (id, t)));
        }
        _end(f);
        _count("update", ok);
        _expect(ok, shouldSucceed);
    }

    function pauseSubscription(uint256 idSeed, bool signed) external {
        (uint256 id, address f, I.Status status) = _pickWith(idSeed, I.Status.ACTIVE);
        if (id == 0) return;
        _begin();
        bool ok;
        if (signed) {
            uint256 nonce = nextNonce[f]++;
            ok = _relay(
                abi.encodeCall(
                    c.pauseSubscriptionWithSig,
                    (id, _sig(keys[_index(f)], E.pauseHash(f, id, nonce, _deadline()), nonce, _deadline()))
                )
            );
        } else {
            ok = _as(f, abi.encodeCall(c.pauseSubscription, (id)));
        }
        _end(f);
        _count("pause", ok);
        _expect(ok, status == I.Status.ACTIVE);
        if (!ok && status == I.Status.ACTIVE) ++stopFailures;
    }

    function resumeSubscription(uint256 idSeed, bool signed) external {
        (uint256 id, address f, I.Status status) = _pickWith(idSeed, I.Status.PAUSED);
        if (id == 0) return;
        uint40 expiry = indexer.subscription(id).expiry;
        bool expired = expiry != 0 && vm.getBlockTimestamp() >= expiry;
        bool shouldSucceed = status == I.Status.PAUSED && !indexer.paused() && !expired;
        _begin();
        bool ok;
        if (signed) {
            uint32 version = indexer.subscription(id).version;
            uint256 nonce = nextNonce[f]++;
            ok = _relay(
                abi.encodeCall(
                    c.resumeSubscriptionWithSig,
                    (
                        id,
                        version,
                        _sig(keys[_index(f)], E.resumeHash(f, id, version, nonce, _deadline()), nonce, _deadline())
                    )
                )
            );
        } else {
            ok = _as(f, abi.encodeCall(c.resumeSubscription, (id)));
        }
        _end(f);
        _count("resume", ok);
        _expect(ok, shouldSucceed);
    }

    function unsubscribe(uint256 idSeed, bool close, bool signed) external {
        (uint256 id, address f, I.Status status) =
            _pickWith(idSeed, idSeed % 2 == 0 ? I.Status.ACTIVE : I.Status.PAUSED);
        if (id == 0) return;
        _begin();
        bool ok;
        if (signed) {
            uint256 nonce = nextNonce[f]++;
            ok = _relay(
                abi.encodeCall(
                    c.unsubscribeWithSig,
                    (
                        id,
                        close,
                        _sig(keys[_index(f)], E.unsubscribeHash(f, id, close, nonce, _deadline()), nonce, _deadline())
                    )
                )
            );
        } else {
            ok = _as(f, abi.encodeCall(c.unsubscribe, (id, close)));
        }
        _end(f);
        _count("unsubscribe", ok);
        _expect(ok, _isLive(status));
        if (!ok && _isLive(status)) ++stopFailures;
    }

    function unsubscribeAll(uint256 fSeed, bool close, bool signed) external {
        uint256 fi = fSeed % 4;
        address f = followers[fi];
        _begin();
        bool ok;
        if (signed) {
            uint256 nonce = nextNonce[f]++;
            ok = _relay(
                abi.encodeCall(
                    c.unsubscribeAllWithSig,
                    (f, close, _sig(keys[fi], E.unsubscribeAllHash(f, close, nonce, _deadline()), nonce, _deadline()))
                )
            );
        } else {
            ok = _as(f, abi.encodeCall(c.unsubscribeAll, (close)));
        }
        _end(f);
        _count("unsubscribeAll", ok);
        if (ok) ++killCount[f];
        else ++stopFailures;
    }

    function invalidateNonces(uint256 fSeed, uint256 wordSeed, uint256 mask, bool signed) external {
        uint256 fi = fSeed % 4;
        address f = followers[fi];
        uint256 word = wordSeed % 4;
        _begin();
        bool ok;
        if (signed) {
            uint256 nonce = nextNonce[f]++;
            ok = _relay(
                abi.encodeCall(
                    c.invalidateNoncesWithSig,
                    (
                        f,
                        word,
                        mask,
                        _sig(keys[fi], E.invalidateNoncesHash(f, word, mask, nonce, _deadline()), nonce, _deadline())
                    )
                )
            );
        } else {
            ok = _as(f, abi.encodeCall(c.invalidateNonces, (word, mask)));
        }
        _end(f);
        _expect(ok, true);
    }

    // ------------------------------------------------------------------------------------------------ owner, executors

    /// @dev Pauses one time in four, otherwise unpauses, so the contract is mostly (not always) open.
    function ownerPause(uint8 seed) external {
        bool pause_ = seed % 4 == 0;
        bool wasPaused = indexer.paused();
        _begin();
        bool ok = _as(owner, pause_ ? abi.encodeCall(c.pause, ()) : abi.encodeCall(c.unpause, ()));
        _end(address(0));
        _expect(ok, pause_ != wasPaused);
    }

    function ownerSetBuilderTerms(uint64 builderId, uint16 perps, uint16 spot) external {
        builderId = uint64(bound(builderId, 0, 3));
        perps = uint16(bound(perps, 0, 210));
        spot = uint16(bound(spot, 0, 2010));
        _begin();
        bool ok = _as(owner, abi.encodeCall(c.setBuilderTerms, (builderId, perps, spot)));
        _end(address(0));
        _expect(ok, builderId != 0 && perps <= C.PERPS_BUILDER_FEE_CAP && spot <= C.SPOT_BUILDER_FEE_CAP);
    }

    /// @dev Disables one time in four.
    function ownerSetVenue(uint8 vSeed, uint8 eSeed) external {
        uint8 venue = uint8(1 + vSeed % 3);
        bool enabled = eSeed % 4 != 0;
        _begin();
        bool ok = _as(owner, abi.encodeCall(c.setVenue, (venue, enabled, venue == 3 ? "Other" : "Venue")));
        _end(address(0));
        _expect(ok, true);
    }

    /// @dev De-authorises one time in four.
    function ownerSetExecutor(bool second, uint8 aSeed) external {
        bool authorised = aSeed % 4 != 0;
        _begin();
        bool ok = _as(owner, abi.encodeCall(c.setExecutor, (executors[second ? 1 : 0], authorised)));
        _end(address(0));
        _expect(ok, true);
    }

    function executorCommit(bool second, bytes32 root, uint32 n) external {
        address x = second ? executors[1] : executors[0];
        uint64 epoch = lastCommitEpoch[x] + 1;
        bool authorised = indexer.executor(x).authorised;
        _begin();
        bool ok = _as(x, abi.encodeCall(c.commitExecutions, (epoch, root, n, "ipfs://commitment")));
        _end(address(0));
        _count("commit", ok);
        if (ok) lastCommitEpoch[x] = epoch;
        _expect(ok, authorised);
    }

    function upgradeToV2(uint256 value) external {
        if (upgraded) return;
        _begin();
        bool ok = _as(
            owner,
            abi.encodeCall(c.upgradeToAndCall, (v2, abi.encodeCall(ValuescanCopyTradingV2Mock.initializeV2, (value))))
        );
        _end(address(0));
        _count("upgrade", ok);
        _expect(ok, true);
        upgraded = ok;
    }

    function warp(uint32 secs) external {
        vm.warp(vm.getBlockTimestamp() + bound(secs, 1, 3 days));
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _index(address f) internal view returns (uint256) {
        for (uint256 i = 0; i < 4; ++i) {
            if (followers[i] == f) return i;
        }
        revert("unknown follower");
    }

    function keyOf(address f) external view returns (uint256) {
        return keys[_index(f)];
    }

    /// @dev The calldata of the last successful signed call, for the replay attack.
    function lastSigned() external view returns (bytes memory) {
        return lastSignedCall;
    }

    function walletOwnerAddress() external view returns (address) {
        return walletOwner;
    }
}
