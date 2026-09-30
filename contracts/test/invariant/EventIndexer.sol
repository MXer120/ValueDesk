// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Vm} from "forge-std/Vm.sol";
import {IValuescanCopyTrading as I} from "../../src/interfaces/IValuescanCopyTrading.sol";
import {CopyTradingEIP712 as E} from "../utils/CopyTradingEIP712.sol";
import {ValuescanCopyTradingV2Mock} from "../mocks/Mocks.sol";

/// @notice A minimal indexer that rebuilds the whole contract state from its event logs alone, following the rebuild
///         rules of the spec (§9). The invariant test compares it with the on-chain views after every call.
///         It also checks, per event, that every subscription change was authorised by that subscription's follower.
contract EventIndexer {
    address public immutable target;

    // subscriptions (stored status, as events describe it)
    uint256 public count;
    mapping(uint256 => I.Subscription) internal _subs;
    mapping(address => uint256[]) internal _followerIds;
    mapping(uint8 => mapping(address => uint256[])) internal _leaderIds;

    // followers
    mapping(address => uint64) public epochOf;
    mapping(address => mapping(uint64 => I.KillSwitch)) internal _kill;
    mapping(address => mapping(uint256 => uint256)) public bitmap;

    // governance and executors
    I.BuilderTerms internal _builder;
    mapping(uint8 => I.Venue) internal _venues;
    mapping(address => I.Executor) internal _executors;
    mapping(address => mapping(uint64 => I.Commitment)) internal _commitments;
    bool public paused;
    address public owner;
    address public pendingOwner;
    address public implementation;
    uint64 public initializedVersion;
    uint256 public v2NewField;

    // checks
    uint256 public unknownEvents;
    uint256 public unauthorisedChanges;
    uint256 public symbolCommitmentMismatches;
    uint256 public nonMonotonicChanges;

    constructor(address target_) {
        target = target_;
    }

    // ------------------------------------------------------------------------------------------------ ingest

    /// @param logs Logs recorded during one call.
    /// @param authoriser The only follower whose subscriptions this call may change (address(0): none).
    /// @param timestamp The block timestamp of the call (for records that events timestamp implicitly).
    function ingest(Vm.Log[] memory logs, address authoriser, uint256 timestamp) external {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == target) _apply(logs[i], authoriser, uint40(timestamp));
        }
    }

    function _authorised(address follower, address authoriser) internal {
        if (follower != authoriser) ++unauthorisedChanges;
    }

    function _apply(Vm.Log memory l, address authoriser, uint40 ts) internal {
        bytes32 sig = l.topics[0];
        if (sig == I.Subscribed.selector) {
            (I.Subscription memory s, string[] memory symbols) = abi.decode(l.data, (I.Subscription, string[]));
            uint256 id = uint256(l.topics[1]);
            _authorised(s.follower, authoriser);
            if (id != count + 1 || s.version != 1 || s.status != I.Status.ACTIVE) ++nonMonotonicChanges;
            if (E.hashStrings(symbols) != s.symbolsHash) ++symbolCommitmentMismatches;
            count = id;
            _subs[id] = s;
            _followerIds[s.follower].push(id);
            _leaderIds[s.venue][s.leader].push(id);
        } else if (sig == I.SubscriptionUpdated.selector) {
            (I.Subscription memory s, string[] memory symbols) = abi.decode(l.data, (I.Subscription, string[]));
            uint256 id = uint256(l.topics[1]);
            I.Subscription storage old = _subs[id];
            _authorised(old.follower, authoriser);
            if (
                s.version != old.version + 1 || s.follower != old.follower || s.leader != old.leader
                    || s.venue != old.venue || s.sodexAccountId != old.sodexAccountId || s.createdAt != old.createdAt
                    || s.stopEpoch != old.stopEpoch || s.status != old.status
            ) ++nonMonotonicChanges;
            if (E.hashStrings(symbols) != s.symbolsHash) ++symbolCommitmentMismatches;
            _subs[id] = s;
        } else if (sig == I.SubscriptionPaused.selector) {
            _transition(l, I.Status.PAUSED, authoriser);
        } else if (sig == I.SubscriptionResumed.selector) {
            _transition(l, I.Status.ACTIVE, authoriser);
        } else if (sig == I.SubscriptionStopped.selector) {
            uint256 id = uint256(l.topics[1]);
            (bool close, uint32 version, uint40 updatedAt) = abi.decode(l.data, (bool, uint32, uint40));
            I.Subscription storage s = _subs[id];
            _authorised(s.follower, authoriser);
            if (version != s.version + 1 || s.status == I.Status.STOPPED) ++nonMonotonicChanges;
            s.status = I.Status.STOPPED;
            s.closePositions = close;
            s.version = version;
            s.updatedAt = updatedAt;
        } else if (sig == I.KillSwitchTriggered.selector) {
            address follower = address(uint160(uint256(l.topics[1])));
            uint64 epoch = uint64(uint256(l.topics[2]));
            _authorised(follower, authoriser);
            if (epoch != epochOf[follower] + 1) ++nonMonotonicChanges;
            epochOf[follower] = epoch;
            _kill[follower][epoch] = I.KillSwitch(ts, abi.decode(l.data, (bool)));
        } else if (sig == I.NonceUsed.selector) {
            address signer = address(uint160(uint256(l.topics[1])));
            uint256 nonce = uint256(l.topics[2]);
            bitmap[signer][nonce >> 8] |= 1 << (nonce & 0xff);
        } else if (sig == I.NoncesInvalidated.selector) {
            bitmap[address(uint160(uint256(l.topics[1])))][uint256(l.topics[2])] |= abi.decode(l.data, (uint256));
        } else if (sig == I.ExecutorSet.selector) {
            address x = address(uint160(uint256(l.topics[1])));
            _executors[x].authorised = abi.decode(l.data, (bool));
            _executors[x].updatedAt = ts;
        } else if (sig == I.ExecutionsCommitted.selector) {
            address x = address(uint160(uint256(l.topics[1])));
            uint64 epoch = uint64(uint256(l.topics[2]));
            (bytes32 root, uint32 n,) = abi.decode(l.data, (bytes32, uint32, string));
            _executors[x].lastEpoch = epoch;
            _commitments[x][epoch] = I.Commitment(root, n, ts);
        } else if (sig == I.BuilderTermsUpdated.selector) {
            (uint64 id, uint16 perps, uint16 spot) = abi.decode(l.data, (uint64, uint16, uint16));
            _builder = I.BuilderTerms(id, perps, spot, ts);
        } else if (sig == I.VenueUpdated.selector) {
            (bool enabled, string memory name) = abi.decode(l.data, (bool, string));
            _venues[uint8(uint256(l.topics[1]))] = I.Venue(enabled, name);
        } else if (sig == keccak256("Paused(address)")) {
            paused = true;
        } else if (sig == keccak256("Unpaused(address)")) {
            paused = false;
        } else if (sig == keccak256("OwnershipTransferStarted(address,address)")) {
            pendingOwner = address(uint160(uint256(l.topics[2])));
        } else if (sig == keccak256("OwnershipTransferred(address,address)")) {
            owner = address(uint160(uint256(l.topics[2])));
            pendingOwner = address(0);
        } else if (sig == keccak256("Upgraded(address)")) {
            implementation = address(uint160(uint256(l.topics[1])));
        } else if (sig == keccak256("Initialized(uint64)")) {
            initializedVersion = abi.decode(l.data, (uint64));
        } else if (sig == ValuescanCopyTradingV2Mock.NewFieldSet.selector) {
            v2NewField = abi.decode(l.data, (uint256));
        } else {
            ++unknownEvents;
        }
    }

    function _transition(Vm.Log memory l, I.Status to, address authoriser) internal {
        uint256 id = uint256(l.topics[1]);
        (uint32 version, uint40 updatedAt) = abi.decode(l.data, (uint32, uint40));
        I.Subscription storage s = _subs[id];
        _authorised(s.follower, authoriser);
        if (version != s.version + 1 || s.status == I.Status.STOPPED) ++nonMonotonicChanges;
        s.status = to;
        s.version = version;
        s.updatedAt = updatedAt;
    }

    // ------------------------------------------------------------------------------------------------ derived views

    /// @dev The record with its effective status, derived exactly as the spec says.
    function subscription(uint256 id) external view returns (I.Subscription memory s) {
        s = _subs[id];
        s.status = effectiveStatus(id);
    }

    function storedStatus(uint256 id) external view returns (I.Status) {
        return _subs[id].status;
    }

    function effectiveStatus(uint256 id) public view returns (I.Status status) {
        I.Subscription storage s = _subs[id];
        status = s.status;
        bool live = status == I.Status.ACTIVE || status == I.Status.PAUSED;
        if (live && s.stopEpoch < epochOf[s.follower]) status = I.Status.STOPPED;
    }

    function followerIds(address f) external view returns (uint256[] memory) {
        return _followerIds[f];
    }

    function leaderIds(uint8 venue, address leader) external view returns (uint256[] memory) {
        return _leaderIds[venue][leader];
    }

    /// @dev Live ids of `f` in id order (the contract's live set has swap-and-pop order; compare as sets).
    function liveIds(address f) external view returns (uint256[] memory out) {
        uint256[] storage all = _followerIds[f];
        uint256 n;
        for (uint256 i = 0; i < all.length; ++i) {
            I.Status st = effectiveStatus(all[i]);
            if (st == I.Status.ACTIVE || st == I.Status.PAUSED) ++n;
        }
        out = new uint256[](n);
        n = 0;
        for (uint256 i = 0; i < all.length; ++i) {
            I.Status st = effectiveStatus(all[i]);
            if (st == I.Status.ACTIVE || st == I.Status.PAUSED) out[n++] = all[i];
        }
    }

    function killSwitch(address f, uint64 epoch) external view returns (I.KillSwitch memory) {
        return _kill[f][epoch];
    }

    function builderTerms() external view returns (I.BuilderTerms memory) {
        return _builder;
    }

    function venue(uint8 v) external view returns (I.Venue memory) {
        return _venues[v];
    }

    function executor(address x) external view returns (I.Executor memory) {
        return _executors[x];
    }

    function commitment(address x, uint64 epoch) external view returns (I.Commitment memory) {
        return _commitments[x][epoch];
    }
}
